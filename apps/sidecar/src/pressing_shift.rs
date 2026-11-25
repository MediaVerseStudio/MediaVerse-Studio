//! Telling "another pressing" apart from "a bad read" (D104). AccurateRip compares a rip with other people's copies of
//! the same pressing. A disc made at another plant, or from a remastered file, holds the same audio shifted by some
//! samples, so every track fails the comparison although the read was perfect. This searches a few thousand samples
//! either side of each track (using the neighbouring tracks' audio for the margin) for a shift at which the rip does
//! match a database entry. A track that matches only when shifted is an intact copy of a different pressing.

use mediaverse_accuraterip::{Pressing, TrackPosition, find_offsets_fast, parse_response};
use mediaverse_ripper::wav;
use serde_json::{Value, json};

/// How far either way to look: ten sectors, about a quarter of a hundredth of a second.
pub const MAX_SHIFT: usize = 5_880;
/// Silence added before the first track and after the last, safely inside the 2,940 samples AccurateRip leaves out.
const EDGE_PAD: usize = 2_000;

/// Decodes the hex text the helper protocol uses for the AccurateRip response and parses it.
pub fn parse_pressings(hex: &str) -> Vec<Pressing> {
    let digits = hex.as_bytes();
    if digits.len() % 2 != 0 {
        return Vec::new();
    }
    let value = |c: u8| (c as char).to_digit(16);
    let mut bytes = Vec::with_capacity(digits.len() / 2);
    for pair in digits.chunks_exact(2) {
        match (value(pair[0]), value(pair[1])) {
            (Some(high), Some(low)) => bytes.push((high * 16 + low) as u8),
            _ => return Vec::new(),
        }
    }
    parse_response(&bytes).unwrap_or_default()
}

fn load(result: &Value, number: u64) -> Option<Vec<u32>> {
    let index = result["tracks"]
        .as_array()?
        .iter()
        .position(|t| t["number"].as_u64() == Some(number))?;
    let path = result["files"].get(index)?.as_str()?;
    wav::read_wav(&std::fs::read(path).ok()?).ok()
}

/// For every track that did not match, looks for a shift at which it does, and records
/// `pressing_shift: {samples, confidence}` on the track when it finds one.
pub fn find_shifts(result: &mut Value, pressings: &[Pressing]) {
    let total = pressings.iter().map(|p| p.tracks.len()).max().unwrap_or(0);
    let unmatched: Vec<(usize, u64)> = result["tracks"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
        .filter(|(_, t)| t["verification"]["kind"] == "no_match")
        .map(|(i, t)| (i, t["number"].as_u64().unwrap_or(0)))
        .collect();
    for (index, number) in unmatched {
        if number == 0 {
            continue;
        }
        let expected: Vec<_> = pressings
            .iter()
            .enumerate()
            .filter_map(|(i, p)| p.tracks.get(number as usize - 1).map(|e| (i, *e)))
            .collect();
        if !expected.iter().any(|(_, e)| e.frame450 != 0) {
            continue; // the quick search needs the sector-450 checksum; a full search over this range would take too long
        }
        let Some(track) = load(result, number) else {
            continue;
        };
        let before = if number > 1 {
            load(result, number - 1)
        } else {
            None
        };
        let after = load(result, number + 1);
        let position = match (number as usize, total) {
            (1, 1) => TrackPosition::Only,
            (1, _) => TrackPosition::First,
            (n, t) if n == t => TrackPosition::Last,
            _ => TrackPosition::Middle,
        };
        // Before the first track and after the last there is no audio to borrow. AccurateRip's checksum leaves out the
        // first and last 5 sectors there, so padding with silence inside that stretch cannot change a checksum.
        let pad_before = matches!(position, TrackPosition::First | TrackPosition::Only);
        let pad_after = matches!(position, TrackPosition::Last | TrackPosition::Only);
        let margin_before = if pad_before {
            EDGE_PAD
        } else {
            before.as_ref().map_or(0, |b| b.len().min(MAX_SHIFT))
        };
        let margin_after = if pad_after {
            EDGE_PAD
        } else {
            after.as_ref().map_or(0, |a| a.len().min(MAX_SHIFT))
        };
        let mut samples = Vec::with_capacity(margin_before + track.len() + margin_after);
        match (&before, pad_before) {
            (_, true) => samples.extend(std::iter::repeat_n(0u32, EDGE_PAD)),
            (Some(before), false) => {
                samples.extend_from_slice(&before[before.len() - margin_before..])
            }
            _ => {}
        }
        samples.extend_from_slice(&track);
        match (&after, pad_after) {
            (_, true) => samples.extend(std::iter::repeat_n(0u32, EDGE_PAD)),
            (Some(after), false) => samples.extend_from_slice(&after[..margin_after]),
            _ => {}
        }
        let found = find_offsets_fast(
            &samples,
            margin_before,
            track.len(),
            position,
            &expected,
            -(margin_before as i32)..=margin_after as i32,
        );
        if let Some(best) = found
            .iter()
            .filter(|m| m.offset != 0)
            .max_by_key(|m| m.confidence)
        {
            result["tracks"][index]["pressing_shift"] =
                json!({ "samples": best.offset, "confidence": best.confidence });
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mediaverse_accuraterip::{TrackEntry, checksums};

    fn audio(len: usize, seed: u32) -> Vec<u32> {
        let mut state = seed;
        (0..len)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                state
            })
            .collect()
    }

    fn write_wav(path: &std::path::Path, samples: &[u32]) {
        let mut bytes = Vec::new();
        let data = (samples.len() * 4) as u32;
        bytes.extend_from_slice(b"RIFF");
        bytes.extend_from_slice(&(36 + data).to_le_bytes());
        bytes.extend_from_slice(b"WAVEfmt ");
        bytes.extend_from_slice(&16u32.to_le_bytes());
        bytes.extend_from_slice(&1u16.to_le_bytes());
        bytes.extend_from_slice(&2u16.to_le_bytes());
        bytes.extend_from_slice(&44_100u32.to_le_bytes());
        bytes.extend_from_slice(&(44_100u32 * 4).to_le_bytes());
        bytes.extend_from_slice(&4u16.to_le_bytes());
        bytes.extend_from_slice(&16u16.to_le_bytes());
        bytes.extend_from_slice(b"data");
        bytes.extend_from_slice(&data.to_le_bytes());
        for s in samples {
            bytes.extend_from_slice(&s.to_le_bytes());
        }
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn a_track_that_matches_only_when_shifted_is_another_pressing() {
        let dir = std::env::temp_dir().join(format!("mv-shift-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // A disc of three tracks; the database knows a pressing whose audio starts 37 samples later than ours.
        let len = 600 * 588;
        let disc = audio(3 * len + 200, 7);
        let ours = |n: usize| disc[n * len..(n + 1) * len].to_vec();
        let theirs = |n: usize| disc[n * len + 37..(n + 1) * len + 37].to_vec();
        let entry = |n: usize, position| {
            let sums = checksums(&theirs(n), position);
            let frame450 = mediaverse_accuraterip::frame450_checksum(&theirs(n)).unwrap();
            TrackEntry {
                confidence: 9,
                checksum: sums.v2,
                frame450,
            }
        };
        let pressing = Pressing {
            id1: 1,
            id2: 2,
            cddb_id: 3,
            tracks: vec![
                entry(0, TrackPosition::First),
                entry(1, TrackPosition::Middle),
                entry(2, TrackPosition::Last),
            ],
        };
        let mut files = Vec::new();
        for n in 0..3 {
            let path = dir.join(format!("{n}.wav"));
            write_wav(&path, &ours(n));
            files.push(path.to_string_lossy().into_owned());
        }
        let tracks: Vec<Value> = (1..=3)
            .map(|n| json!({ "number": n, "verification": { "kind": "no_match" } }))
            .collect();
        let mut result = json!({ "tracks": tracks, "files": files });
        find_shifts(&mut result, &[pressing]);
        assert_eq!(
            result["tracks"][1]["pressing_shift"]["samples"], 37,
            "{result}"
        );
        assert_eq!(result["tracks"][1]["pressing_shift"]["confidence"], 9);
        // The first and last tracks have no audio beyond them; the skipped edge of their checksums lets them be checked too.
        assert_eq!(
            result["tracks"][0]["pressing_shift"]["samples"], 37,
            "{result}"
        );
        assert_eq!(
            result["tracks"][2]["pressing_shift"]["samples"], 37,
            "{result}"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_rip_that_matches_nothing_gets_no_shift_and_bad_hex_is_ignored() {
        let dir = std::env::temp_dir().join(format!("mv-noshift-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("1.wav");
        write_wav(&path, &audio(600 * 588, 3));
        let other = audio(600 * 588, 4);
        let entry = TrackEntry {
            confidence: 2,
            checksum: checksums(&other, TrackPosition::Only).v2,
            frame450: mediaverse_accuraterip::frame450_checksum(&other).unwrap(),
        };
        let mut result = json!({ "tracks": [{ "number": 1, "verification": { "kind": "no_match" } }], "files": [path.to_string_lossy()] });
        find_shifts(
            &mut result,
            &[Pressing {
                id1: 1,
                id2: 2,
                cddb_id: 3,
                tracks: vec![entry],
            }],
        );
        assert!(result["tracks"][0].get("pressing_shift").is_none());
        assert!(parse_pressings("xyz").is_empty() && parse_pressings("abc").is_empty());
        let _ = std::fs::remove_dir_all(&dir);
    }
}
