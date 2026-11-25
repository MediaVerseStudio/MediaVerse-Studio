//! Chromaprint audio fingerprints of ripped WAV files, in the form AcoustID's lookup takes (D35, ADR 0006).
//!
//! The same algorithm as AcoustID's own `fpcalc` (Chromaprint's default, "test2"), over the first two minutes of the
//! track, which is all the service uses. `rusty-chromaprint` is a pure-Rust port, so nothing is installed or run.
//! The fingerprint is compressed and written in URL-safe base64 without padding, as the lookup expects.

use rusty_chromaprint::{Configuration, FingerprintCompressor, Fingerprinter};
use std::fs::File;
use std::io::{BufReader, Read, Seek, SeekFrom};
use std::path::Path;

/// AcoustID only looks at this much of a track.
const MAX_SECONDS: u64 = 120;

/// A track's fingerprint and its full length.
#[derive(Debug, Eq, PartialEq)]
pub struct Print {
    pub duration_seconds: u32,
    pub encoded: String,
}

fn base64_url(bytes: &[u8]) -> String {
    const ALPHABET: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-_";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(ALPHABET[(n >> 18) as usize & 63] as char);
        out.push(ALPHABET[(n >> 12) as usize & 63] as char);
        if chunk.len() > 1 {
            out.push(ALPHABET[(n >> 6) as usize & 63] as char);
        }
        if chunk.len() > 2 {
            out.push(ALPHABET[n as usize & 63] as char);
        }
    }
    out
}

/// Fingerprints interleaved 16-bit samples. `total_seconds` is the track's whole length, which may be more than the samples given.
pub fn from_samples(
    samples: &[i16],
    sample_rate: u32,
    channels: u32,
    total_seconds: u32,
) -> Result<Print, String> {
    let config = Configuration::preset_test2();
    let mut printer = Fingerprinter::new(&config);
    printer
        .start(sample_rate, channels)
        .map_err(|e| format!("this audio format cannot be fingerprinted ({e:?})"))?;
    for chunk in samples.chunks(8192) {
        printer.consume(chunk);
    }
    printer.finish();
    let fingerprint = printer.fingerprint();
    if fingerprint.is_empty() {
        return Err("the track is too short or silent to fingerprint".to_owned());
    }
    Ok(Print {
        duration_seconds: total_seconds,
        encoded: base64_url(&FingerprintCompressor::from(&config).compress(fingerprint)),
    })
}

/// Fingerprints a WAV (read straight from the file, only its first two minutes), or an MP3 or FLAC (decoded first, as
/// the defect scan does; 44.1 kHz stereo or mono only).
pub fn from_file(path: &Path) -> Result<Print, String> {
    if path
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("wav"))
    {
        return from_wav(path);
    }
    let packed = crate::library_defects::decode_file(path)?;
    let total = u32::try_from(packed.len() / 44_100).unwrap_or(u32::MAX);
    let samples: Vec<i16> = packed
        .iter()
        .take(MAX_SECONDS as usize * 44_100)
        .flat_map(|&p| [p as u16 as i16, (p >> 16) as u16 as i16])
        .collect();
    from_samples(&samples, 44_100, 2, total)
}

/// Reads a PCM WAV file (16 bit; what the ripper writes) and fingerprints it.
pub fn from_wav(path: &Path) -> Result<Print, String> {
    let mut file =
        BufReader::new(File::open(path).map_err(|e| format!("could not open the file: {e}"))?);
    let mut header = [0u8; 12];
    file.read_exact(&mut header)
        .map_err(|_| "not a WAV file".to_owned())?;
    if &header[0..4] != b"RIFF" || &header[8..12] != b"WAVE" {
        return Err("not a WAV file".to_owned());
    }
    let (mut channels, mut rate, mut bits) = (0u32, 0u32, 0u32);
    loop {
        let mut chunk = [0u8; 8];
        file.read_exact(&mut chunk)
            .map_err(|_| "the WAV file has no audio".to_owned())?;
        let size = u64::from(u32::from_le_bytes([chunk[4], chunk[5], chunk[6], chunk[7]]));
        match &chunk[0..4] {
            b"fmt " => {
                let mut fmt = vec![0u8; size.min(64) as usize];
                file.read_exact(&mut fmt)
                    .map_err(|_| "the WAV file's format is cut off".to_owned())?;
                if size > 64 {
                    file.seek(SeekFrom::Current(size as i64 - 64))
                        .map_err(|e| e.to_string())?;
                }
                if fmt.len() < 16 {
                    return Err("the WAV file's format is cut off".to_owned());
                }
                let tag = u16::from_le_bytes([fmt[0], fmt[1]]);
                if tag != 1 && tag != 0xFFFE {
                    return Err("the WAV file is not plain PCM".to_owned());
                }
                channels = u32::from(u16::from_le_bytes([fmt[2], fmt[3]]));
                rate = u32::from_le_bytes([fmt[4], fmt[5], fmt[6], fmt[7]]);
                bits = u32::from(u16::from_le_bytes([fmt[14], fmt[15]]));
                if size % 2 == 1 {
                    file.seek(SeekFrom::Current(1)).map_err(|e| e.to_string())?;
                }
            }
            b"data" => {
                if bits != 16 || channels == 0 || rate == 0 {
                    return Err("only 16 bit WAV files can be fingerprinted".to_owned());
                }
                let frame_bytes = u64::from(channels) * 2;
                let frames = size / frame_bytes;
                let wanted = frames.min(MAX_SECONDS * u64::from(rate));
                let mut raw = vec![0u8; (wanted * frame_bytes) as usize];
                file.read_exact(&mut raw)
                    .map_err(|_| "the WAV file is shorter than it says".to_owned())?;
                let samples: Vec<i16> = raw
                    .chunks_exact(2)
                    .map(|b| i16::from_le_bytes([b[0], b[1]]))
                    .collect();
                let total = u32::try_from(frames / u64::from(rate)).unwrap_or(u32::MAX);
                return from_samples(&samples, rate, channels, total);
            }
            _ => {
                file.seek(SeekFrom::Current((size + size % 2) as i64))
                    .map_err(|e| e.to_string())?;
            }
        }
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    #[test]
    fn base64_matches_the_standard_vectors_in_the_url_safe_alphabet() {
        assert_eq!(base64_url(b""), "");
        assert_eq!(base64_url(b"f"), "Zg");
        assert_eq!(base64_url(b"fo"), "Zm8");
        assert_eq!(base64_url(b"foo"), "Zm9v");
        assert_eq!(base64_url(b"foob"), "Zm9vYg");
        assert_eq!(
            base64_url(&[0xFB, 0xFF, 0xBF]),
            "-_-_",
            "'+' and '/' become '-' and '_'"
        );
    }

    pub(crate) fn tone(seconds: u32, rate: u32) -> Vec<i16> {
        // A changing tone, so the fingerprint has something to hold on to.
        (0..seconds * rate)
            .flat_map(|i| {
                let t = f64::from(i) / f64::from(rate);
                let v = ((t * (300.0 + 90.0 * (t * 0.7).sin()) * std::f64::consts::TAU).sin()
                    * 12000.0) as i16;
                [v, v]
            })
            .collect()
    }

    pub(crate) fn write_wav(path: &Path, samples: &[i16], rate: u32) {
        let data_len = (samples.len() * 2) as u32;
        let mut bytes = Vec::new();
        bytes.extend(b"RIFF");
        bytes.extend((36 + data_len).to_le_bytes());
        bytes.extend(b"WAVEfmt ");
        bytes.extend(16u32.to_le_bytes());
        bytes.extend(1u16.to_le_bytes());
        bytes.extend(2u16.to_le_bytes());
        bytes.extend(rate.to_le_bytes());
        bytes.extend((rate * 4).to_le_bytes());
        bytes.extend(4u16.to_le_bytes());
        bytes.extend(16u16.to_le_bytes());
        bytes.extend(b"LIST");
        bytes.extend(3u32.to_le_bytes()); // an odd-sized chunk before the audio, padded
        bytes.extend([1, 2, 3, 0]);
        bytes.extend(b"data");
        bytes.extend(data_len.to_le_bytes());
        for s in samples {
            bytes.extend(s.to_le_bytes());
        }
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn a_wav_file_is_fingerprinted_for_its_first_two_minutes_and_its_whole_length_is_reported() {
        let dir = std::env::temp_dir().join(format!("mv-fingerprint-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("long.wav");
        write_wav(&path, &tone(130, 11_025), 11_025);
        let print = from_wav(&path).unwrap();
        assert_eq!(print.duration_seconds, 130);
        assert!(
            print.encoded.len() > 100
                && print
                    .encoded
                    .bytes()
                    .all(|b| b.is_ascii_alphanumeric() || b == b'-' || b == b'_'),
            "{}",
            print.encoded
        );
        // The same audio gives the same fingerprint; a different one does not.
        assert_eq!(from_wav(&path).unwrap(), print);
        let other = dir.join("other.wav");
        let shifted: Vec<i16> = tone(20, 11_025)
            .iter()
            .map(|s| s.wrapping_neg() / 2)
            .collect();
        write_wav(&other, &shifted, 11_025);
        assert_ne!(from_wav(&other).unwrap().encoded, print.encoded);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn files_that_cannot_be_fingerprinted_say_why() {
        let dir = std::env::temp_dir().join(format!("mv-fingerprint-bad-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let text = dir.join("a.wav");
        std::fs::write(&text, b"this is not audio at all").unwrap();
        assert!(from_wav(&text).unwrap_err().contains("not a WAV"));
        assert!(from_wav(&dir.join("missing.wav")).is_err());
        let silent = dir.join("silent.wav");
        write_wav(&silent, &vec![0i16; 2 * 44_100], 44_100);
        let _ = from_wav(&silent); // silence has no fingerprint to speak of, but must not crash
        let _ = std::fs::remove_dir_all(&dir);
    }
}
