//! FLAC master files (ADR 0005): encode verified CD audio, and prove the result is lossless by
//! decoding it back and comparing every sample with the source. A FLAC is only ever accepted after
//! that comparison passes.
//!
//! Encoding uses `flacenc` and the check uses `claxon`, two independent pure-Rust implementations,
//! so an encoder bug cannot also hide inside the check.

use flacenc::component::BitRepr;
use flacenc::error::Verify;
use md5::{Digest, Md5};
use std::fmt;
use std::io::Cursor;

const CHANNELS: usize = 2;
const BITS_PER_SAMPLE: usize = 16;
const SAMPLE_RATE: usize = 44_100;

#[derive(Debug, Eq, PartialEq)]
pub enum FlacError {
    /// The encoder failed.
    Encode(String),
    /// The encoded bytes are not valid FLAC.
    Decode(String),
    /// The file decodes, but not to the audio it was made from.
    Mismatch(String),
}

impl fmt::Display for FlacError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::Encode(message) => write!(f, "FLAC encoding failed: {message}"),
            Self::Decode(message) => write!(f, "the FLAC file could not be decoded: {message}"),
            Self::Mismatch(message) => write!(
                f,
                "the FLAC file does not match the source audio: {message}"
            ),
        }
    }
}

impl std::error::Error for FlacError {}

/// Unpacks `left | right << 16` stereo samples into interleaved signed 32-bit values.
fn interleave(samples: &[u32]) -> Vec<i32> {
    samples
        .iter()
        .flat_map(|&sample| {
            [
                i32::from(sample as u16 as i16),
                i32::from((sample >> 16) as u16 as i16),
            ]
        })
        .collect()
}

/// Smallest block FLAC readers are required to accept as a final block.
const MIN_FINAL_BLOCK: usize = 16;

/// Picks a block size at or just below the usual 4096 so that the last block is either full or at
/// least [`MIN_FINAL_BLOCK`] samples. A final block of a few samples is valid FLAC but strict
/// decoders (including the one used to verify our files) reject it, and CD tracks, being multiples
/// of 588 samples, hit that case about three times in a thousand.
fn block_size_for(sample_count: usize) -> usize {
    (3_840..=4_096)
        .rev()
        .find(|&size| matches!(sample_count % size, 0) || sample_count % size >= MIN_FINAL_BLOCK)
        .unwrap_or(4_096)
}

const BLOCK_STREAMINFO: u8 = 0;
const BLOCK_VORBIS_COMMENT: u8 = 4;
const LAST_BLOCK_FLAG: u8 = 0x80;
const VENDOR: &str = "MediaVerse Studio";
/// Players and converters cope badly with enormous tag blocks; real tags are a few hundred bytes.
pub const MAX_TAG_BLOCK_BYTES: usize = 256 * 1024;
/// Longest tag value we write, in characters.
pub const MAX_TAG_VALUE_CHARS: usize = 1000;

/// Makes text safe to store as a tag value: control characters (newlines, tabs, NUL...) become
/// spaces, runs of spaces collapse, the ends are trimmed, and the length is capped. Applied to every
/// value from outside (lookup results, user input) before it is written.
pub fn clean_tag_value(text: &str) -> String {
    let mut out = String::new();
    let mut last_space = true;
    for c in text.chars() {
        let c = if c.is_control() { ' ' } else { c };
        if c == ' ' {
            if !last_space {
                out.push(' ');
            }
            last_space = true;
        } else {
            out.push(c);
            last_space = false;
        }
    }
    out.trim_end()
        .chars()
        .take(MAX_TAG_VALUE_CHARS)
        .collect::<String>()
        .trim_end()
        .to_owned()
}

/// The encoder records the short final block as the stream's *minimum* block size, but the format
/// says the minimum excludes the last block. With min different from max, readers conclude the
/// stream has variable block sizes and expect sample numbers in the frame headers, while the frames
/// carry frame numbers; the reference decoder (`flac --test`) then warns "sample or frame number does
/// not increase correctly... file might not be seekable" and fails in strict mode, although the audio
/// decodes correctly. Setting the minimum equal to the maximum (the real block size) makes the
/// stream a proper fixed-block-size one. STREAMINFO is outside every frame checksum, so nothing
/// else changes. Found by running the reference decoder on our output (2026-10-31).
fn fix_fixed_blocksize_streaminfo(flac: &mut [u8]) {
    // Bytes 8..10 hold the minimum and 10..12 the maximum block size of the first (STREAMINFO) block.
    if flac.len() >= 12 && &flac[..4] == b"fLaC" {
        let maximum = [flac[10], flac[11]];
        flac[8] = maximum[0];
        flac[9] = maximum[1];
    }
}

/// Adds a Vorbis comment block (the standard FLAC tags: TITLE, ARTIST, ALBUM, ...) to a FLAC stream
/// that has none, such as the output of [`encode`], and returns the new stream.
///
/// This is done here, on the bytes we just made, because the generic tag library inserts new
/// blocks without clearing the "last metadata block" flag that the encoder sets on its single
/// STREAMINFO block, which leaves the file undecodable (found when the archive step's re-check
/// failed). The metadata chain is rebuilt correctly instead: STREAMINFO is no longer last and the
/// new block is. Call [`verify`] on the result.
pub fn with_vorbis_comments(flac: &[u8], comments: &[(&str, &str)]) -> Result<Vec<u8>, FlacError> {
    let bad = |message: &str| FlacError::Decode(message.to_owned());
    if flac.len() < 8 || &flac[..4] != b"fLaC" {
        return Err(bad("not a FLAC stream"));
    }

    // Walk the existing metadata blocks to find the last one.
    let mut position = 4;
    let (last_position, audio_start) = loop {
        let header = *flac
            .get(position)
            .ok_or_else(|| bad("truncated metadata"))?;
        let length_bytes = flac
            .get(position + 1..position + 4)
            .ok_or_else(|| bad("truncated metadata"))?;
        let length =
            u32::from_be_bytes([0, length_bytes[0], length_bytes[1], length_bytes[2]]) as usize;
        if header & !LAST_BLOCK_FLAG == BLOCK_VORBIS_COMMENT {
            return Err(FlacError::Encode("the stream already has tags".to_owned()));
        }
        if position == 4 && header & !LAST_BLOCK_FLAG != BLOCK_STREAMINFO {
            return Err(bad("the first block is not STREAMINFO"));
        }
        let next = position + 4 + length;
        if next > flac.len() {
            return Err(bad("truncated metadata"));
        }
        if header & LAST_BLOCK_FLAG != 0 {
            break (position, next);
        }
        position = next;
    };

    let mut body = Vec::new();
    body.extend_from_slice(&(VENDOR.len() as u32).to_le_bytes());
    body.extend_from_slice(VENDOR.as_bytes());
    body.extend_from_slice(&(comments.len() as u32).to_le_bytes());
    for (key, value) in comments {
        if key.is_empty() || !key.bytes().all(|b| (0x20..=0x7D).contains(&b) && b != b'=') {
            return Err(FlacError::Encode(format!("invalid tag name '{key}'")));
        }
        if value.chars().any(char::is_control) {
            return Err(FlacError::Encode(format!(
                "the value of {key} contains control characters; clean it with clean_tag_value first"
            )));
        }
        let entry = format!("{key}={value}");
        body.extend_from_slice(&(entry.len() as u32).to_le_bytes());
        body.extend_from_slice(entry.as_bytes());
    }
    if body.len() > MAX_TAG_BLOCK_BYTES {
        return Err(FlacError::Encode(format!(
            "the tags are too large ({} bytes; the limit is {MAX_TAG_BLOCK_BYTES})",
            body.len()
        )));
    }

    let mut out = Vec::with_capacity(flac.len() + body.len() + 4);
    out.extend_from_slice(&flac[..audio_start]);
    out[last_position] &= !LAST_BLOCK_FLAG; // the old last block no longer ends the metadata
    out.push(BLOCK_VORBIS_COMMENT | LAST_BLOCK_FLAG);
    out.extend_from_slice(&(body.len() as u32).to_be_bytes()[1..]);
    out.extend_from_slice(&body);
    out.extend_from_slice(&flac[audio_start..]);
    Ok(out)
}
/// Encodes stereo 16-bit 44.1 kHz audio as a FLAC stream. Does not verify; use
/// [`encode_verified`] for anything that will be kept.
pub fn encode(samples: &[u32]) -> Result<Vec<u8>, FlacError> {
    if samples.len() < MIN_FINAL_BLOCK {
        return Err(FlacError::Encode(format!(
            "audio of {} samples is too short to store as FLAC (the format needs at least {MIN_FINAL_BLOCK})",
            samples.len()
        )));
    }
    let mut config = flacenc::config::Encoder::default();
    config.block_size = block_size_for(samples.len());
    let config = config
        .into_verified()
        .map_err(|(_, error)| FlacError::Encode(format!("{error:?}")))?;
    let interleaved = interleave(samples);
    let source = flacenc::source::MemSource::from_samples(
        &interleaved,
        CHANNELS,
        BITS_PER_SAMPLE,
        SAMPLE_RATE,
    );
    let stream = flacenc::encode_with_fixed_block_size(&config, source, config.block_size)
        .map_err(|error| FlacError::Encode(format!("{error:?}")))?;
    let mut sink = flacenc::bitsink::ByteSink::new();
    stream
        .write(&mut sink)
        .map_err(|error| FlacError::Encode(format!("{error:?}")))?;
    let mut bytes = sink.as_slice().to_vec();
    fix_fixed_blocksize_streaminfo(&mut bytes);
    Ok(bytes)
}

/// Decodes `flac` and checks that it holds exactly `samples`, with the expected format. Used for
/// freshly encoded bytes and, after tagging, for the file as it sits on disk.
pub fn verify(flac: &[u8], samples: &[u32]) -> Result<(), FlacError> {
    let mut reader =
        claxon::FlacReader::new(Cursor::new(flac)).map_err(|e| FlacError::Decode(e.to_string()))?;
    let info = reader.streaminfo();
    if info.channels as usize != CHANNELS
        || info.bits_per_sample as usize != BITS_PER_SAMPLE
        || info.sample_rate as usize != SAMPLE_RATE
    {
        return Err(FlacError::Mismatch(format!(
            "expected 2 channels, 16 bits, 44100 Hz but found {} channels, {} bits, {} Hz",
            info.channels, info.bits_per_sample, info.sample_rate
        )));
    }

    let expected = interleave(samples);
    let mut index = 0usize;
    for decoded in reader.samples() {
        let value = decoded.map_err(|e| FlacError::Decode(e.to_string()))?;
        match expected.get(index) {
            Some(&want) if want == value => {}
            Some(&want) => {
                return Err(FlacError::Mismatch(format!(
                    "sample {} differs (expected {want}, decoded {value})",
                    index / CHANNELS
                )));
            }
            None => {
                return Err(FlacError::Mismatch(
                    "the file holds more audio than the source".to_owned(),
                ));
            }
        }
        index += 1;
    }
    if index != expected.len() {
        return Err(FlacError::Mismatch(format!(
            "the file holds {} samples but the source has {}",
            index / CHANNELS,
            expected.len() / CHANNELS
        )));
    }
    Ok(())
}

/// Decodes a CD-quality FLAC (2 channels, 16 bits, 44.1 kHz) to packed stereo samples.
pub fn decode(flac: &[u8]) -> Result<Vec<u32>, FlacError> {
    let mut reader =
        claxon::FlacReader::new(Cursor::new(flac)).map_err(|e| FlacError::Decode(e.to_string()))?;
    let info = reader.streaminfo();
    if info.channels as usize != CHANNELS
        || info.bits_per_sample as usize != BITS_PER_SAMPLE
        || info.sample_rate as usize != SAMPLE_RATE
    {
        return Err(FlacError::Mismatch(format!(
            "expected 2 channels, 16 bits, 44100 Hz but found {} channels, {} bits, {} Hz",
            info.channels, info.bits_per_sample, info.sample_rate
        )));
    }
    let mut values = Vec::new();
    for decoded in reader.samples() {
        values.push(decoded.map_err(|e| FlacError::Decode(e.to_string()))?);
    }
    Ok(values
        .chunks_exact(2)
        .map(|pair| u32::from(pair[0] as i16 as u16) | (u32::from(pair[1] as i16 as u16) << 16))
        .collect())
}

/// MD5 of the audio exactly as the FLAC format defines it: the samples as little-endian 16-bit
/// values, left then right. This is the signature stored in STREAMINFO.
pub fn pcm_md5(samples: &[u32]) -> [u8; 16] {
    let mut hasher = Md5::new();
    for chunk in samples.chunks(16_384) {
        let bytes: Vec<u8> = chunk
            .iter()
            .flat_map(|sample| sample.to_le_bytes())
            .collect();
        hasher.update(&bytes);
    }
    hasher.finalize().into()
}

const BLOCK_SEEKTABLE: u8 = 3;
const BLOCK_PADDING: u8 = 1;
const BLOCK_PICTURE: u8 = 6;
const MAX_METADATA_BYTES: usize = 16 * 1024 * 1024;
const MAX_PICTURE_BYTES: usize = 8 * 1024 * 1024;

fn reject<T>(message: impl Into<String>) -> Result<T, FlacError> {
    Err(FlacError::Mismatch(message.into()))
}

/// Parses a length-prefixed (little-endian) UTF-8 string at `at`, returning it and the next offset.
fn le_string(block: &[u8], at: usize) -> Result<(&str, usize), FlacError> {
    let length = block
        .get(at..at + 4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize);
    let length =
        length.ok_or_else(|| FlacError::Mismatch("a tag entry is cut short".to_owned()))?;
    let bytes = block.get(at + 4..at + 4 + length).ok_or_else(|| {
        FlacError::Mismatch("a tag entry runs past the end of its block".to_owned())
    })?;
    let text = std::str::from_utf8(bytes)
        .map_err(|_| FlacError::Mismatch("a tag is not valid UTF-8".to_owned()))?;
    Ok((text, at + 4 + length))
}

fn check_vorbis_comment(block: &[u8]) -> Result<(), FlacError> {
    let (_vendor, mut at) = le_string(block, 0)?;
    let count = block
        .get(at..at + 4)
        .map(|b| u32::from_le_bytes([b[0], b[1], b[2], b[3]]) as usize)
        .ok_or_else(|| FlacError::Mismatch("the tag block is cut short".to_owned()))?;
    at += 4;
    for _ in 0..count {
        let (entry, next) = le_string(block, at)?;
        at = next;
        let Some((key, value)) = entry.split_once('=') else {
            return reject("a tag has no '=' between its name and value");
        };
        if key.is_empty() || !key.bytes().all(|b| (0x20..=0x7D).contains(&b)) {
            return reject(format!("a tag has an invalid name '{key}'"));
        }
        if value.chars().any(char::is_control) {
            return reject(format!("the value of {key} contains control characters"));
        }
    }
    if at != block.len() {
        return reject("the tag block has extra bytes after its last entry");
    }
    Ok(())
}

fn check_picture(block: &[u8]) -> Result<(), FlacError> {
    let be = |at: usize| {
        block
            .get(at..at + 4)
            .map(|b| u32::from_be_bytes([b[0], b[1], b[2], b[3]]) as usize)
    };
    let cut = || FlacError::Mismatch("the picture block is cut short".to_owned());
    let kind = be(0).ok_or_else(cut)?;
    if kind > 20 {
        return reject("the picture block has an unknown picture type");
    }
    let mime_len = be(4).ok_or_else(cut)?;
    let mut at = 8 + mime_len;
    let desc_len = be(at).ok_or_else(cut)?;
    at += 4 + desc_len;
    at += 16; // width, height, colour depth, colour count
    let data_len = be(at).ok_or_else(cut)?;
    at += 4;
    if data_len > MAX_PICTURE_BYTES {
        return reject(format!(
            "the embedded picture is too large ({data_len} bytes; the limit is {MAX_PICTURE_BYTES})"
        ));
    }
    if at + data_len != block.len() {
        return reject("the picture block's lengths do not add up");
    }
    Ok(())
}

/// A strict check of the file's structure, written to catch the faults that make players and
/// converters fail: anything before the `fLaC` marker (such as an ID3 tag), a metadata chain whose
/// "last block" flag is wrong, duplicate or reserved block types, malformed tag or picture blocks,
/// control characters in tags, a missing or wrong audio signature (MD5), a wrong sample count or
/// format, and a missing first audio frame. It does not decode the audio; use [`check_master`].
pub fn check_structure(flac: &[u8], samples: &[u32]) -> Result<(), FlacError> {
    if flac.len() < 8 || &flac[..4] != b"fLaC" {
        return reject(
            "the file does not start with the fLaC marker (an ID3 tag or other data in front breaks many players)",
        );
    }
    let mut position = 4;
    let mut seen = [0u32; 128];
    let mut index = 0;
    let audio_start = loop {
        let header = *flac
            .get(position)
            .ok_or_else(|| FlacError::Mismatch("the metadata is cut short".to_owned()))?;
        let (last, kind) = (header & 0x80 != 0, header & 0x7F);
        let length_bytes = flac
            .get(position + 1..position + 4)
            .ok_or_else(|| FlacError::Mismatch("the metadata is cut short".to_owned()))?;
        let length =
            u32::from_be_bytes([0, length_bytes[0], length_bytes[1], length_bytes[2]]) as usize;
        let body = flac
            .get(position + 4..position + 4 + length)
            .ok_or_else(|| {
                FlacError::Mismatch("a metadata block runs past the end of the file".to_owned())
            })?;
        // Only the block types this program writes are accepted. Application (2) and cue sheet (5)
        // blocks are legal FLAC but never ours, and a damaged tag-block header turns into one of them,
        // which would make the tags vanish while the file still looked fine.
        if !matches!(
            kind,
            BLOCK_STREAMINFO
                | BLOCK_PADDING
                | BLOCK_SEEKTABLE
                | BLOCK_VORBIS_COMMENT
                | BLOCK_PICTURE
        ) {
            return reject(format!(
                "the file has a metadata block of a type this program does not write ({kind})"
            ));
        }
        if index == 0 && kind != BLOCK_STREAMINFO {
            return reject("the first metadata block is not STREAMINFO");
        }
        seen[kind as usize] += 1;
        if matches!(
            kind,
            BLOCK_STREAMINFO | BLOCK_VORBIS_COMMENT | BLOCK_SEEKTABLE
        ) && seen[kind as usize] > 1
        {
            return reject(format!(
                "the file has more than one metadata block of type {kind}"
            ));
        }
        match kind {
            BLOCK_STREAMINFO => check_streaminfo(body, samples)?,
            BLOCK_VORBIS_COMMENT => check_vorbis_comment(body)?,
            BLOCK_PICTURE => check_picture(body)?,
            _ => {}
        }
        index += 1;
        position += 4 + length;
        if position > MAX_METADATA_BYTES {
            return reject("the metadata is unreasonably large");
        }
        if last {
            break position;
        }
    };
    match flac.get(audio_start..audio_start + 2) {
        Some([0xFF, second]) if second & 0xFC == 0xF8 => Ok(()),
        _ => reject(
            "the first audio frame is missing where the metadata ends (the last-block flag is probably wrong)",
        ),
    }
}

fn check_streaminfo(body: &[u8], samples: &[u32]) -> Result<(), FlacError> {
    if body.len() != 34 {
        return reject("STREAMINFO has the wrong size");
    }
    let min_block = u16::from_be_bytes([body[0], body[1]]);
    let max_block = u16::from_be_bytes([body[2], body[3]]);
    if min_block < 16 || max_block < min_block {
        return reject("STREAMINFO has an invalid block size");
    }
    let total_samples =
        u64::from_be_bytes(body[10..18].try_into().expect("8 bytes")) & 0xF_FFFF_FFFF;
    if total_samples > u64::from(max_block) && min_block != max_block {
        return reject(format!(
            "STREAMINFO says the block size varies (minimum {min_block}, maximum {max_block}) but the frames use fixed-size numbering; the reference decoder rejects this"
        ));
    }
    let packed = u64::from_be_bytes(body[10..18].try_into().expect("8 bytes"));
    let (rate, channels, bits, total) = (
        packed >> 44,
        ((packed >> 41) & 7) + 1,
        ((packed >> 36) & 0x1F) + 1,
        packed & 0xF_FFFF_FFFF,
    );
    if (rate, channels, bits) != (SAMPLE_RATE as u64, CHANNELS as u64, BITS_PER_SAMPLE as u64) {
        return reject(format!(
            "expected 44100 Hz, 2 channels, 16 bits but STREAMINFO says {rate} Hz, {channels} channels, {bits} bits"
        ));
    }
    if total != samples.len() as u64 {
        return reject(format!(
            "STREAMINFO counts {total} samples but the source has {}",
            samples.len()
        ));
    }
    let stored: [u8; 16] = body[18..34].try_into().expect("16 bytes");
    if stored == [0u8; 16] {
        return reject("the file has no audio signature (MD5), so players cannot verify it");
    }
    if stored != pcm_md5(samples) {
        return reject("the audio signature (MD5) in STREAMINFO does not match the audio");
    }
    Ok(())
}

/// The full check for a FLAC master we will keep: the strict structure check, then a complete
/// decode (which also verifies every frame's checksums) compared with the source samples.
pub fn check_master(flac: &[u8], samples: &[u32]) -> Result<(), FlacError> {
    check_structure(flac, samples)?;
    verify(flac, samples)
}

/// Checks that the file carries exactly the tags that were meant to be written: none missing, none
/// extra, same order, same text (names compared ignoring case, as the format specifies).
pub fn check_tags(flac: &[u8], expected: &[(&str, &str)]) -> Result<(), FlacError> {
    let reader =
        claxon::FlacReader::new(Cursor::new(flac)).map_err(|e| FlacError::Decode(e.to_string()))?;
    let found: Vec<(String, String)> = reader
        .tags()
        .map(|(name, value)| (name.to_ascii_uppercase(), value.to_owned()))
        .collect();
    let wanted: Vec<(String, String)> = expected
        .iter()
        .map(|(name, value)| (name.to_ascii_uppercase(), (*value).to_owned()))
        .collect();
    if found == wanted {
        Ok(())
    } else {
        reject(format!(
            "the tags in the file ({} entries) are not the tags that were written ({} entries)",
            found.len(),
            wanted.len()
        ))
    }
}

/// [`check_master`] plus [`check_tags`]: the complete test for a file about to be kept.
pub fn check_master_with_tags(
    flac: &[u8],
    samples: &[u32],
    tags: &[(&str, &str)],
) -> Result<(), FlacError> {
    check_master(flac, samples)?;
    check_tags(flac, tags)
}

/// Encodes and then proves the result decodes back to exactly `samples`.
pub fn encode_verified(samples: &[u32]) -> Result<Vec<u8>, FlacError> {
    let bytes = encode(samples)?;
    check_master(&bytes, samples)?;
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack(left: i16, right: i16) -> u32 {
        u32::from(left as u16) | (u32::from(right as u16) << 16)
    }

    /// Deterministic noise covering the full 16-bit range, including both extremes.
    fn noise(count: usize) -> Vec<u32> {
        let mut state = 0x1234_5678u32;
        (0..count)
            .map(|i| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                match i {
                    0 => pack(i16::MIN, i16::MAX),
                    1 => pack(i16::MAX, i16::MIN),
                    _ => state,
                }
            })
            .collect()
    }

    #[test]
    fn round_trips_noise_exactly() {
        let samples = noise(50_000);
        let flac = encode_verified(&samples).unwrap();
        assert_eq!(&flac[..4], b"fLaC");
        verify(&flac, &samples).unwrap();
    }

    #[test]
    fn round_trips_music_like_signals_and_compresses_them() {
        let samples: Vec<u32> = (0..88_200)
            .map(|i| {
                let t = f64::from(i) / 44_100.0;
                let left = (12_000.0 * (t * 440.0 * std::f64::consts::TAU).sin()) as i16;
                let right = (9_000.0 * (t * 660.0 * std::f64::consts::TAU).sin()) as i16;
                pack(left, right)
            })
            .collect();
        let flac = encode_verified(&samples).unwrap();
        assert!(
            flac.len() < samples.len() * 4 / 2,
            "a sine should compress to under half its PCM size"
        );
    }

    #[test]
    fn round_trips_silence_short_clips_and_odd_lengths() {
        for count in [16usize, 17, 587, 588, 4095, 4096, 4097, 10_001] {
            let silence = vec![0u32; count];
            encode_verified(&silence).unwrap_or_else(|e| panic!("silence of {count}: {e}"));
            let clip = noise(count);
            encode_verified(&clip).unwrap_or_else(|e| panic!("noise of {count}: {e}"));
        }
    }

    #[test]
    fn the_final_block_is_never_a_sliver() {
        // Every length near multiples of the default block size, including every CD-sized remainder.
        for count in (4_090..4_120)
            .chain(8_184..8_220)
            .chain((1..40).map(|n| n * 588))
        {
            let size = block_size_for(count);
            assert!((3_840..=4_096).contains(&size));
            assert!(
                count % size == 0 || count % size >= MIN_FINAL_BLOCK,
                "{count} with block size {size}"
            );
        }
        // And the whole round trip works for the lengths that used to fail.
        for count in [4_097usize, 4_100, 8_193, 8_200] {
            encode_verified(&noise(count)).unwrap_or_else(|e| panic!("{count}: {e}"));
        }
    }

    // ---- strict structure checks: every known way a FLAC master goes bad ----

    fn good_master() -> (Vec<u32>, Vec<u8>) {
        let samples = noise(30_000);
        let plain = encode_verified(&samples).unwrap();
        let tagged = with_vorbis_comments(
            &plain,
            &[("TITLE", "Song"), ("ARTIST", "Band"), ("TRACKNUMBER", "3")],
        )
        .unwrap();
        (samples, tagged)
    }

    fn rejects(flac: &[u8], samples: &[u32], expected: &str) {
        match check_master(flac, samples) {
            Err(error) => assert!(
                error.to_string().contains(expected),
                "expected '{expected}' but got: {error}"
            ),
            Ok(()) => panic!("a faulty file was accepted (expected a complaint about: {expected})"),
        }
    }

    #[test]
    fn a_multi_frame_stream_is_declared_fixed_block_size() {
        // 60,000 samples: fourteen full 4096-sample blocks and a short last one. The minimum block
        // size must still read 4096, because it excludes the last block.
        let flac = encode(&noise(60_000)).unwrap();
        assert_eq!(
            &flac[8..10],
            &flac[10..12],
            "minimum and maximum block size must be equal"
        );
        assert_eq!(u16::from_be_bytes([flac[10], flac[11]]), 4096);
        // The regression itself: put the old value back and the check refuses the file.
        let mut broken = flac.clone();
        broken[8..10].copy_from_slice(&2656u16.to_be_bytes());
        rejects(&broken, &noise(60_000), "block size varies");
        // A stream of a single short block is unaffected.
        let single = encode_verified(&noise(1_000)).unwrap();
        check_master(&single, &noise(1_000)).unwrap();
    }

    #[test]
    fn a_correct_master_passes_every_check() {
        let (samples, tagged) = good_master();
        check_master(&tagged, &samples).unwrap();
        let plain = encode_verified(&samples).unwrap();
        check_master(&plain, &samples).unwrap();
    }

    #[test]
    fn data_in_front_of_the_marker_is_caught() {
        let (samples, tagged) = good_master();
        let mut with_id3 = b"ID3\x04\x00\x00\x00\x00\x00\x00".to_vec();
        with_id3.extend_from_slice(&tagged);
        rejects(&with_id3, &samples, "fLaC marker");
    }

    #[test]
    fn a_wrong_last_block_flag_is_caught_in_both_directions() {
        let (samples, tagged) = good_master();
        // The fault we met in practice: STREAMINFO marked last although a tag block follows.
        let mut early = tagged.clone();
        early[4] |= 0x80;
        rejects(&early, &samples, "first audio frame is missing");
        // Nothing marked last: the chain runs on into the audio.
        let mut never = tagged.clone();
        never[42] &= !0x80;
        assert!(
            check_master(&never, &samples).is_err(),
            "no block marked as the last one"
        );
    }

    #[test]
    fn duplicate_reserved_and_misplaced_blocks_are_caught() {
        let (samples, tagged) = good_master();
        // A second tag block.
        let mut twice = tagged.clone();
        twice[42] &= !0x80;
        let comment_len = u32::from_be_bytes([0, tagged[43], tagged[44], tagged[45]]) as usize;
        let block = tagged[42..46 + comment_len].to_vec();
        let mut second = block.clone();
        second[0] |= 0x80;
        let at = 46 + comment_len;
        twice.splice(at..at, second);
        rejects(&twice, &samples, "more than one metadata block");
        // A reserved block type.
        let mut reserved = tagged.clone();
        reserved[42] = (reserved[42] & 0x80) | 100;
        rejects(&reserved, &samples, "does not write");
        // The invalid type 127.
        let mut invalid = tagged.clone();
        invalid[42] = (invalid[42] & 0x80) | 127;
        rejects(&invalid, &samples, "does not write");
        // A cue sheet or application block: legal FLAC, but a damaged tag header turns into one and
        // the tags would silently disappear.
        for kind in [2u8, 5] {
            let mut lost = tagged.clone();
            lost[42] = (lost[42] & 0x80) | kind;
            rejects(&lost, &samples, "does not write");
        }
        // STREAMINFO not first.
        let mut moved = tagged.clone();
        moved[4] = (moved[4] & 0x80) | BLOCK_VORBIS_COMMENT;
        rejects(&moved, &samples, "not STREAMINFO");
    }

    #[test]
    fn a_missing_or_wrong_audio_signature_is_caught() {
        let (samples, tagged) = good_master();
        let mut zeroed = tagged.clone();
        zeroed[8 + 18..8 + 34].fill(0);
        rejects(&zeroed, &samples, "no audio signature");
        let mut flipped = tagged.clone();
        flipped[8 + 20] ^= 1;
        rejects(&flipped, &samples, "does not match the audio");
        // The same file checked against audio that differs by one sample.
        let mut other = samples.clone();
        other[100] ^= 1;
        rejects(&tagged, &other, "does not match the audio");
        // And against audio of a different length.
        rejects(&tagged, &samples[..samples.len() - 1], "counts");
    }

    #[test]
    fn malformed_tag_blocks_are_caught() {
        let (samples, plain) = {
            let samples = noise(10_000);
            (samples.clone(), encode_verified(&samples).unwrap())
        };
        // Build a tag block by hand so each fault can be injected exactly.
        let tag_block = |entries: &[&[u8]], count: u32, trailing: &[u8]| -> Vec<u8> {
            let mut body = Vec::new();
            body.extend_from_slice(&4u32.to_le_bytes());
            body.extend_from_slice(b"test");
            body.extend_from_slice(&count.to_le_bytes());
            for entry in entries {
                body.extend_from_slice(&(entry.len() as u32).to_le_bytes());
                body.extend_from_slice(entry);
            }
            body.extend_from_slice(trailing);
            let mut out = plain[..42].to_vec();
            out[4] &= !0x80;
            out.push(BLOCK_VORBIS_COMMENT | LAST_BLOCK_FLAG);
            out.extend_from_slice(&(body.len() as u32).to_be_bytes()[1..]);
            out.extend_from_slice(&body);
            out.extend_from_slice(&plain[42..]);
            out
        };
        check_master(&tag_block(&[b"TITLE=ok"], 1, b""), &samples).unwrap();
        rejects(&tag_block(&[b"TITLE=ok"], 2, b""), &samples, "cut short");
        rejects(
            &tag_block(&[b"TITLE=ok"], 1, b"junk"),
            &samples,
            "extra bytes",
        );
        rejects(&tag_block(&[b"NOEQUALSSIGN"], 1, b""), &samples, "no '='");
        rejects(&tag_block(&[b"=value"], 1, b""), &samples, "invalid name");
        rejects(
            &tag_block(&[b"TITLE=bad\x00nul"], 1, b""),
            &samples,
            "control characters",
        );
        rejects(
            &tag_block(&[b"TITLE=line\nbreak"], 1, b""),
            &samples,
            "control characters",
        );
        rejects(&tag_block(&[b"TITLE=\xff\xfe"], 1, b""), &samples, "UTF-8");
        rejects(
            &tag_block(&[b"T\xC3\xA4G=x"], 1, b""),
            &samples,
            "invalid name",
        );
    }

    #[test]
    fn picture_blocks_are_checked_and_size_limited() {
        let (samples, plain) = {
            let samples = noise(10_000);
            (samples.clone(), encode_verified(&samples).unwrap())
        };
        let picture = |declared: u32, actual: usize| -> Vec<u8> {
            let mut body = Vec::new();
            body.extend_from_slice(&3u32.to_be_bytes()); // front cover
            body.extend_from_slice(&10u32.to_be_bytes());
            body.extend_from_slice(b"image/jpeg");
            body.extend_from_slice(&0u32.to_be_bytes()); // no description
            body.extend_from_slice(&[0u8; 16]); // width, height, depth, colours
            body.extend_from_slice(&declared.to_be_bytes());
            body.extend(std::iter::repeat(0xAB).take(actual));
            let mut out = plain[..42].to_vec();
            out[4] &= !0x80;
            out.push(BLOCK_PICTURE | LAST_BLOCK_FLAG);
            out.extend_from_slice(&(body.len() as u32).to_be_bytes()[1..]);
            out.extend_from_slice(&body);
            out.extend_from_slice(&plain[42..]);
            out
        };
        check_master(&picture(1000, 1000), &samples).unwrap();
        rejects(&picture(1000, 900), &samples, "do not add up");
        rejects(
            &picture((MAX_PICTURE_BYTES + 1) as u32, MAX_PICTURE_BYTES + 1),
            &samples,
            "too large",
        );
    }

    #[test]
    fn missing_extra_or_altered_tags_are_caught_by_the_tag_check() {
        let samples = noise(8_000);
        let plain = encode_verified(&samples).unwrap();
        let wanted = [("TITLE", "Song"), ("ARTIST", "Band"), ("TRACKNUMBER", "3")];
        let tagged = with_vorbis_comments(&plain, &wanted).unwrap();
        check_master_with_tags(&tagged, &samples, &wanted).unwrap();
        check_tags(
            &tagged,
            &[("title", "Song"), ("Artist", "Band"), ("tracknumber", "3")],
        )
        .expect("names are case-insensitive");

        assert!(
            check_tags(&plain, &wanted).is_err(),
            "a file with no tags at all"
        );
        assert!(
            check_tags(&tagged, &wanted[..2]).is_err(),
            "an extra tag in the file"
        );
        assert!(
            check_tags(
                &tagged,
                &[wanted[0], wanted[1], wanted[2], ("GENRE", "Rock")]
            )
            .is_err(),
            "a missing tag"
        );
        assert!(
            check_tags(&tagged, &[("TITLE", "Sonc"), wanted[1], wanted[2]]).is_err(),
            "altered text"
        );
        assert!(
            check_tags(&tagged, &[wanted[1], wanted[0], wanted[2]]).is_err(),
            "different order"
        );
        // Tags that are present but the audio changed: the complete check still fails.
        let mut other = samples.clone();
        other[5] ^= 1;
        assert!(check_master_with_tags(&tagged, &other, &wanted).is_err());
    }

    #[test]
    fn tag_text_is_cleaned_and_limited() {
        assert_eq!(
            clean_tag_value("  Hello\tWorld\n\nAgain\0!  "),
            "Hello World Again !"
        );
        assert_eq!(clean_tag_value("\u{0007}\r\n"), "");
        assert_eq!(clean_tag_value("Zürich – 東京 🎵"), "Zürich – 東京 🎵");
        let long = clean_tag_value(&"é".repeat(5_000));
        assert_eq!(long.chars().count(), MAX_TAG_VALUE_CHARS);
        // The writer itself refuses what cleaning would have removed, and absurdly large tag blocks.
        let plain = encode_verified(&noise(5_000)).unwrap();
        assert!(with_vorbis_comments(&plain, &[("TITLE", "a\nb")]).is_err());
        let many: Vec<(&str, String)> = (0..400).map(|_| ("COMMENT", "x".repeat(900))).collect();
        let borrowed: Vec<(&str, &str)> = many.iter().map(|(k, v)| (*k, v.as_str())).collect();
        assert!(
            with_vorbis_comments(&plain, &borrowed).is_err(),
            "a tag block over the size limit is refused"
        );
    }

    #[test]
    fn many_lengths_and_tag_sets_all_produce_files_that_pass_every_check() {
        let mut state = 0xC0FF_EE11u32;
        let mut next = |bound: u32| {
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            (state >> 8) % bound
        };
        let titles = [
            "",
            "A",
            "Zürich – 東京",
            "Track with a very long name "
                .repeat(20)
                .as_str()
                .to_owned()
                .leak() as &str,
            "Quote \" and = sign",
            "emoji 🎵🎶",
        ];
        for round in 0..150 {
            // Lengths include CD-sized ones (multiples of 588) and awkward ones around block boundaries.
            let length = match round % 3 {
                0 => 588 * (1 + next(40) as usize),
                1 => 4_096 * (1 + next(3) as usize) + next(40) as usize,
                _ => 16 + next(9_000) as usize,
            };
            let samples = noise(length);
            let flac = encode_verified(&samples)
                .unwrap_or_else(|e| panic!("round {round}, {length} samples: {e}"));
            let title = clean_tag_value(titles[next(titles.len() as u32) as usize]);
            let tagged = with_vorbis_comments(
                &flac,
                &[
                    ("TITLE", title.as_str()),
                    ("ALBUM", "Album"),
                    ("TRACKNUMBER", "1"),
                ],
            )
            .unwrap_or_else(|e| panic!("round {round}: {e}"));
            check_master(&tagged, &samples).unwrap_or_else(|e| {
                panic!("round {round}, {length} samples, title {title:?}: {e}")
            });
        }
    }

    #[test]
    fn no_single_bit_flip_in_the_metadata_yields_a_file_that_passes_with_wrong_content() {
        let (samples, tagged) = good_master();
        let metadata_len = {
            let comment_len = u32::from_be_bytes([0, tagged[43], tagged[44], tagged[45]]) as usize;
            46 + comment_len
        };
        // Bytes whose damage must always be caught: the marker, both block headers, and the
        // STREAMINFO fields for format, sample count and audio signature.
        let must_catch =
            |byte: usize| byte < 8 || (18..42).contains(&byte) || (42..46).contains(&byte);
        let mut tolerated = 0;
        for byte in 0..metadata_len {
            for bit in 0..8 {
                let mut damaged = tagged.clone();
                damaged[byte] ^= 1 << bit;
                match check_master(&damaged, &samples) {
                    Err(_) => {}
                    Ok(()) => {
                        assert!(
                            !must_catch(byte),
                            "a flip of bit {bit} in byte {byte} (a structural field) was accepted"
                        );
                        // What is accepted must be harmless: still decodes to the source audio. These
                        // are flips inside tag text or advisory size hints, which no check can call wrong.
                        verify(&damaged, &samples)
                            .expect("anything accepted must still decode to the source audio");
                        tolerated += 1;
                    }
                }
            }
        }
        assert!(
            tolerated > 0,
            "tag text edits stay valid text, so some flips are legitimately tolerated"
        );
    }
    #[test]
    fn damage_anywhere_in_the_audio_is_caught() {
        let (samples, tagged) = good_master();
        let first_audio = {
            let comment_len = u32::from_be_bytes([0, tagged[43], tagged[44], tagged[45]]) as usize;
            46 + comment_len
        };
        let mut caught = 0;
        let mut trials = 0;
        for offset in (first_audio..tagged.len()).step_by(997) {
            let mut damaged = tagged.clone();
            damaged[offset] ^= 0x10;
            trials += 1;
            if check_master(&damaged, &samples).is_err() {
                caught += 1;
            }
        }
        assert_eq!(
            caught, trials,
            "every damaged audio byte was caught ({trials} spots tried)"
        );
    }

    #[test]
    fn a_twenty_second_clip_of_music_like_audio_passes() {
        let samples: Vec<u32> = (0..882_000u32)
            .map(|i| {
                let t = f64::from(i) / 44_100.0;
                let l = (9_000.0 * (t * 220.0 * std::f64::consts::TAU).sin()
                    + 3_000.0 * (t * 3_300.0 * std::f64::consts::TAU).sin())
                    as i16;
                let r = (8_000.0 * (t * 330.0 * std::f64::consts::TAU).sin()) as i16;
                pack(l, r)
            })
            .collect();
        let flac = encode_verified(&samples).unwrap();
        let tagged = with_vorbis_comments(&flac, &[("TITLE", "Twenty seconds")]).unwrap();
        check_master(&tagged, &samples).unwrap();
        assert!(tagged.len() < samples.len() * 4 / 2);
    }
    #[test]
    fn clips_too_short_for_flac_are_refused_not_written_badly() {
        // FLAC blocks need at least 16 samples; a CD track is never that short, but the check must
        // refuse such input rather than hand back a file that cannot be read.
        for count in [1usize, 2, 15] {
            assert!(encode_verified(&noise(count)).is_err(), "{count} samples");
        }
    }

    #[test]
    fn tags_are_added_with_a_correct_metadata_chain() {
        let samples = noise(20_000);
        let plain = encode_verified(&samples).unwrap();
        let tagged = with_vorbis_comments(
            &plain,
            &[
                ("TITLE", "Sound System"),
                ("ARTIST", "Operation Ivy"),
                ("ALBUM", "Energy"),
                ("TRACKNUMBER", "5"),
                ("TITLE", "Zürich – 東京"),
            ],
        )
        .unwrap();
        verify(&tagged, &samples)
            .expect("tagging must not disturb the audio or the stream structure");

        let reader = claxon::FlacReader::new(std::io::Cursor::new(&tagged)).unwrap();
        assert_eq!(
            reader.get_tag("ARTIST").collect::<Vec<_>>(),
            ["Operation Ivy"]
        );
        assert_eq!(reader.get_tag("TRACKNUMBER").collect::<Vec<_>>(), ["5"]);
        assert_eq!(
            reader.get_tag("TITLE").collect::<Vec<_>>(),
            ["Sound System", "Zürich – 東京"]
        );
        // Only the metadata grew; the audio frames are byte-for-byte the same.
        assert_eq!(&tagged[tagged.len() - (plain.len() - 42)..], &plain[42..]);
        // STREAMINFO is no longer marked last; the tag block is.
        assert_eq!(tagged[4] & 0x80, 0);
    }

    #[test]
    fn tagging_rejects_bad_input() {
        let plain = encode_verified(&noise(5_000)).unwrap();
        let tagged = with_vorbis_comments(&plain, &[("TITLE", "x")]).unwrap();
        assert!(
            with_vorbis_comments(&tagged, &[("TITLE", "y")]).is_err(),
            "already tagged"
        );
        assert!(with_vorbis_comments(b"RIFF....", &[("TITLE", "y")]).is_err());
        assert!(with_vorbis_comments(&plain[..20], &[("TITLE", "y")]).is_err());
        assert!(with_vorbis_comments(&plain, &[("BAD=KEY", "y")]).is_err());
        assert!(with_vorbis_comments(&plain, &[("", "y")]).is_err());
        assert!(
            with_vorbis_comments(&plain, &[]).is_ok(),
            "an empty tag block is valid"
        );
    }
    #[test]
    fn a_single_changed_sample_is_caught() {
        let samples = noise(20_000);
        let flac = encode(&samples).unwrap();
        let mut altered = samples.clone();
        altered[12_345] ^= 1;
        let error = verify(&flac, &altered).unwrap_err();
        assert!(
            matches!(&error, FlacError::Mismatch(m) if m.contains("sample 12345")),
            "{error}"
        );
    }

    #[test]
    fn a_length_difference_is_caught_both_ways() {
        let samples = noise(20_000);
        let flac = encode(&samples).unwrap();
        assert!(matches!(
            verify(&flac, &samples[..19_999]),
            Err(FlacError::Mismatch(_))
        ));
        let mut longer = samples.clone();
        longer.push(0);
        assert!(matches!(
            verify(&flac, &longer),
            Err(FlacError::Mismatch(_))
        ));
    }

    #[test]
    fn damaged_files_are_rejected() {
        let samples = noise(20_000);
        let mut flac = encode(&samples).unwrap();
        assert!(matches!(
            verify(&flac[..30], &samples),
            Err(FlacError::Decode(_))
        ));
        assert!(matches!(
            verify(b"not a flac file", &samples),
            Err(FlacError::Decode(_))
        ));
        let middle = flac.len() / 2;
        flac[middle] ^= 0xFF;
        assert!(
            verify(&flac, &samples).is_err(),
            "a corrupted frame must not verify"
        );
    }
}
