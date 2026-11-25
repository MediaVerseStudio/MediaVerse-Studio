//! MP3 library copies (ADR 0005): the settings given to LAME, and the checks applied to what it
//! makes. An MP3 is lossy, so it is never described as "bit-perfect"; the checks prove it is a
//! well-formed file of the right length that sounds like the verified source.
//!
//! LAME itself is a separate program (`lame.exe`, run by the sidecar). Nothing here links to it.

use crate::id3;
use std::ffi::OsString;
use std::fmt;
use std::path::Path;

pub const SAMPLES_PER_FRAME: u64 = 1152;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Quality {
    /// LAME `-V0`: the highest-quality variable bitrate, the project default.
    V0,
    /// Constant 320 kbps (`-b 320`), the highest the format allows.
    Cbr320,
}

impl Quality {
    pub fn parse(text: &str) -> Option<Self> {
        match text.to_ascii_lowercase().as_str() {
            "v0" | "-v0" => Some(Self::V0),
            "cbr320" | "320" | "cbr 320" => Some(Self::Cbr320),
            _ => None,
        }
    }

    fn lame_options(self) -> &'static [&'static str] {
        match self {
            Self::V0 => &["-V0"],
            Self::Cbr320 => &["-b", "320", "--cbr"],
        }
    }
}

/// The arguments for `lame.exe` to encode a CD-audio WAV to MP3: quiet, no tags of its own (the
/// tag is written afterwards by this program), and the chosen quality.
pub fn lame_arguments(quality: Quality, wav: &Path, mp3: &Path) -> Vec<OsString> {
    let mut args: Vec<OsString> = vec!["-S".into(), "--noreplaygain".into()];
    args.extend(quality.lame_options().iter().map(OsString::from));
    args.push(wav.into());
    args.push(mp3.into());
    args
}

#[derive(Debug, Eq, PartialEq)]
pub struct Mp3Error(pub String);

impl fmt::Display for Mp3Error {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(f, "the MP3 file is not valid: {}", self.0)
    }
}

impl std::error::Error for Mp3Error {}

fn bad<T>(message: impl Into<String>) -> Result<T, Mp3Error> {
    Err(Mp3Error(message.into()))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Mp3Info {
    /// Bytes of ID3 tag at the start (0 if none).
    pub tag_bytes: usize,
    /// Audio frames, not counting the Xing/Info header frame.
    pub audio_frames: u64,
    pub encoder_delay: u64,
    pub encoder_padding: u64,
    /// Samples a gapless decoder produces: frames x 1152 minus delay and padding.
    pub playable_samples: u64,
    /// True if the file declares variable bitrate ("Xing") rather than constant ("Info").
    pub variable_bitrate: bool,
}

const BITRATES_KBPS: [u32; 16] = [
    0, 32, 40, 48, 56, 64, 80, 96, 112, 128, 160, 192, 224, 256, 320, 0,
];

/// Length in bytes of the MPEG-1 Layer III frame whose 4-byte header is `header`, if it is one at
/// 44.1 kHz.
fn frame_length(header: [u8; 4]) -> Option<usize> {
    if header[0] != 0xFF || header[1] & 0xFE != 0xFA {
        return None; // not the sync word, MPEG-1, Layer III
    }
    let bitrate = BITRATES_KBPS[usize::from(header[2] >> 4)];
    let sample_rate_index = (header[2] >> 2) & 3;
    if bitrate == 0 || sample_rate_index != 0 {
        return None; // free-format or reserved bitrate, or not 44.1 kHz
    }
    let padding = usize::from((header[2] >> 1) & 1);
    Some((144_000 * bitrate as usize) / 44_100 + padding)
}

/// Checks an MP3 made by LAME and tagged by [`with_tag`]: any ID3v2.3 tag is well formed and ends
/// exactly where the audio starts; the audio is a continuous chain of MPEG-1 Layer III frames at
/// 44.1 kHz ending exactly at the end of the file; the first frame is the Xing/Info header whose
/// frame count matches the frames present; and the playable length (frames minus the encoder delay
/// and padding recorded by LAME) equals the source's length exactly.
pub fn check_structure(bytes: &[u8], source_samples: usize) -> Result<Mp3Info, Mp3Error> {
    let info = inspect(bytes)?;
    if info.playable_samples != source_samples as u64 {
        return bad(format!(
            "the file plays {} samples but the source has {source_samples}",
            info.playable_samples
        ));
    }
    Ok(info)
}

/// The same structural checks as [`check_structure`] without comparing the length to a source: used to
/// read the playing time of a file made by this program (an MP3 from LAME with its Xing/Info header).
pub fn inspect(bytes: &[u8]) -> Result<Mp3Info, Mp3Error> {
    let tag_bytes = if bytes.starts_with(b"ID3") {
        let length = id3::tag_length(bytes).map_err(|e| Mp3Error(e.to_string()))?;
        id3::read_frames(bytes).map_err(|e| Mp3Error(e.to_string()))?;
        length
    } else {
        0
    };

    // Walk every frame from the end of the tag; each must start exactly where the last one ended.
    let mut at = tag_bytes;
    let mut frames = 0u64;
    let mut first: Option<(usize, usize)> = None;
    while at < bytes.len() {
        let Some(header) = bytes.get(at..at + 4) else {
            return bad("the file ends in the middle of a frame header");
        };
        let Some(length) = frame_length([header[0], header[1], header[2], header[3]]) else {
            return bad(format!(
                "there is no valid MPEG-1 Layer III frame at byte {at} (a damaged frame, or data that does not belong)"
            ));
        };
        if at + length > bytes.len() {
            return bad(format!(
                "the frame at byte {at} runs past the end of the file (the file is cut short)"
            ));
        }
        if first.is_none() {
            first = Some((at, length));
        }
        frames += 1;
        at += length;
    }
    let Some((first_at, first_length)) = first else {
        return bad("the file has no audio frames");
    };
    if frames < 2 {
        return bad("the file has only the header frame and no audio");
    }

    // The first frame is the Xing/Info header written by LAME.
    let head = &bytes[first_at..first_at + first_length];
    if head.len() < 192 || !(&head[36..40] == b"Xing" || &head[36..40] == b"Info") {
        return bad("the first frame is not a Xing/Info header, so the length cannot be checked");
    }
    let variable_bitrate = &head[36..40] == b"Xing";
    let flags = u32::from_be_bytes([head[40], head[41], head[42], head[43]]);
    if flags & 0b1111 != 0b1111 {
        return bad(
            "the Xing/Info header lacks the frame count, size, seek table or quality fields",
        );
    }
    let declared_frames = u64::from(u32::from_be_bytes([head[44], head[45], head[46], head[47]]));
    let audio_frames = frames - 1;
    if declared_frames != audio_frames {
        return bad(format!(
            "the header says {declared_frames} frames but the file holds {audio_frames}"
        ));
    }
    let lame = &head[156..192];
    if &lame[..4] != b"LAME" {
        return bad("the header is not a LAME header, so the encoder delay is unknown");
    }
    let encoder_delay = (u64::from(lame[21]) << 4) | u64::from(lame[22] >> 4);
    let encoder_padding = (u64::from(lame[22] & 0x0F) << 8) | u64::from(lame[23]);
    let total = audio_frames * SAMPLES_PER_FRAME;
    if encoder_delay + encoder_padding > total {
        return bad("the recorded encoder delay and padding exceed the length of the audio");
    }
    let playable_samples = total - encoder_delay - encoder_padding;
    Ok(Mp3Info {
        tag_bytes,
        audio_frames,
        encoder_delay,
        encoder_padding,
        playable_samples,
        variable_bitrate,
    })
}

/// Puts an ID3v2 tag in front of LAME's output. LAME was run without tags, so the file must not
/// already start with one.
pub fn with_tag(mp3: &[u8], tag: &[u8]) -> Result<Vec<u8>, Mp3Error> {
    if mp3.starts_with(b"ID3") {
        return bad("the encoder output already has a tag");
    }
    let mut out = Vec::with_capacity(tag.len() + mp3.len());
    out.extend_from_slice(tag);
    out.extend_from_slice(mp3);
    Ok(out)
}

/// Signal-to-noise ratio, in decibels, of `decoded` against `source` (both packed stereo samples),
/// over the shorter of the two. Lossy encoding is expected to give a high figure for music; a
/// shifted, silent or garbled decode gives a very low one.
pub fn snr_db(source: &[u32], decoded: &[u32]) -> f64 {
    let (mut signal, mut noise) = (0f64, 0f64);
    for (&a, &b) in source.iter().zip(decoded) {
        for (x, y) in [
            (i32::from(a as u16 as i16), i32::from(b as u16 as i16)),
            (
                i32::from((a >> 16) as u16 as i16),
                i32::from((b >> 16) as u16 as i16),
            ),
        ] {
            signal += f64::from(x) * f64::from(x);
            noise += f64::from(x - y) * f64::from(x - y);
        }
    }
    if noise == 0.0 {
        f64::INFINITY
    } else if signal == 0.0 {
        f64::NEG_INFINITY
    } else {
        10.0 * (signal / noise).log10()
    }
}

/// Lowest signal-to-noise ratio, in decibels, accepted between the source and the decoded MP3.
/// Good MP3s of music are far above this; a shifted, silent or garbled file is far below.
pub const MIN_SNR_DB: f64 = 15.0;

/// Decodes the MP3 with an independent decoder (nanomp3, a port of minimp3; LAME's own decoder is
/// not part of the encoder-only build) and compares it with the verified source: same number of
/// samples (gapless, encoder delay and padding removed), 44.1 kHz stereo, and a signal-to-noise
/// ratio of at least [`MIN_SNR_DB`]. Returns the ratio.
pub fn decode_check(mp3: &[u8], source: &[u32]) -> Result<f64, Mp3Error> {
    let decoded = nanomp3::decode_all::<i16>(mp3);
    if decoded.sample_rate != 44_100 || decoded.channels != Some(nanomp3::Channels::Stereo) {
        return bad(format!(
            "it decodes as {} Hz with {:?} channels, not 44.1 kHz stereo",
            decoded.sample_rate, decoded.channels
        ));
    }
    let pairs: Vec<u32> = decoded
        .samples
        .chunks_exact(2)
        .map(|c| u32::from(c[0] as u16) | (u32::from(c[1] as u16) << 16))
        .collect();
    if pairs.len() != source.len() {
        return bad(format!(
            "it decodes to {} samples but the source has {}",
            pairs.len(),
            source.len()
        ));
    }
    let snr = snr_db(source, &pairs);
    if snr < MIN_SNR_DB {
        return bad(format!(
            "the decoded audio does not match the source (signal-to-noise {snr:.1} dB, needs at least {MIN_SNR_DB} dB)"
        ));
    }
    Ok(snr)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn inspect_reports_the_length_without_a_source_to_compare_with() {
        assert!(inspect(b"").is_err());
        assert!(inspect(b"not an mp3 at all, just text").is_err());
    }

    #[test]
    fn quality_names_and_lame_options() {
        assert_eq!(Quality::parse("V0"), Some(Quality::V0));
        assert_eq!(Quality::parse("cbr320"), Some(Quality::Cbr320));
        assert_eq!(Quality::parse("320"), Some(Quality::Cbr320));
        assert_eq!(Quality::parse("v2"), None);
        let args: Vec<String> =
            lame_arguments(Quality::V0, Path::new("in.wav"), Path::new("out.mp3"))
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
        assert_eq!(args, ["-S", "--noreplaygain", "-V0", "in.wav", "out.mp3"]);
        let cbr: Vec<String> =
            lame_arguments(Quality::Cbr320, Path::new("a.wav"), Path::new("b.mp3"))
                .iter()
                .map(|a| a.to_string_lossy().into_owned())
                .collect();
        assert_eq!(
            cbr,
            [
                "-S",
                "--noreplaygain",
                "-b",
                "320",
                "--cbr",
                "a.wav",
                "b.mp3"
            ]
        );
    }

    #[test]
    fn frame_lengths_follow_the_format() {
        // 128 kbps at 44.1 kHz: 417 bytes, or 418 with padding.
        assert_eq!(frame_length([0xFF, 0xFB, 0x90, 0x00]), Some(417));
        assert_eq!(frame_length([0xFF, 0xFB, 0x92, 0x00]), Some(418));
        assert_eq!(
            frame_length([0xFF, 0xFB, 0xE0, 0x00]),
            Some(144_000 * 320 / 44_100)
        );
        assert_eq!(
            frame_length([0xFF, 0xFB, 0x94, 0x00]),
            None,
            "48 kHz is not accepted"
        );
        assert_eq!(frame_length([0xFF, 0xFB, 0x00, 0x00]), None, "free format");
        assert_eq!(frame_length([0xFF, 0xF3, 0x90, 0x00]), None, "MPEG-2");
        assert_eq!(frame_length([0x00, 0xFB, 0x90, 0x00]), None);
    }

    #[test]
    fn snr_rewards_fidelity_and_punishes_garbage() {
        let source: Vec<u32> = (0..10_000i32)
            .map(|i| {
                let v = ((i as f64 * 0.05).sin() * 8000.0) as i16;
                u32::from(v as u16) | (u32::from(v as u16) << 16)
            })
            .collect();
        assert_eq!(snr_db(&source, &source), f64::INFINITY);
        let noisy: Vec<u32> = source
            .iter()
            .map(|&s| {
                let v = (s as u16 as i16).saturating_add(40);
                u32::from(v as u16) | (u32::from(v as u16) << 16)
            })
            .collect();
        assert!(snr_db(&source, &noisy) > 40.0);
        let shifted: Vec<u32> = source
            .iter()
            .cycle()
            .skip(300)
            .take(source.len())
            .copied()
            .collect();
        assert!(snr_db(&source, &shifted) < 10.0);
        assert!(
            snr_db(&source, &vec![0; source.len()]) < 1.0,
            "a silent decode"
        );
    }

    #[test]
    fn a_tag_cannot_be_added_twice_and_garbage_is_not_an_mp3() {
        assert!(with_tag(b"ID3....", b"tag").is_err());
        assert_eq!(with_tag(b"audio", b"tag").unwrap(), b"tagaudio");
        assert!(check_structure(b"", 100).is_err());
        assert!(
            check_structure(b"not an mp3 at all, just text", 100)
                .unwrap_err()
                .0
                .contains("no valid MPEG-1")
        );
    }
}
