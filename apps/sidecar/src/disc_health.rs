//! Telling the person how a disc read (D102). A scratched or smudged disc is the one job where the program must neither
//! pretend nor give up: tracks that read badly are read again (more re-reads per block, up to three passes), the
//! better read is kept, and what is left is described in plain words per track: fine, recovered by re-reading,
//! unconfirmed (no reference to compare with), or damaged (blocks could not be read, or the copy did not match
//! AccurateRip) with where in the track and what to do about it. Pure functions over the helper's JSON, tested alone.

use serde_json::{Value, json};
use std::collections::BTreeMap;

/// How many times a suspect track is read in all (the first pass included).
pub const MAX_PASSES: u32 = 3;
/// At most this many tracks are re-read on one disc, so a badly damaged disc does not run for hours.
pub const MAX_RETRIED_TRACKS: usize = 12;

fn kind(track: &Value) -> &str {
    track["verification"]["kind"]
        .as_str()
        .unwrap_or("unavailable")
}

fn quality(track: &Value, key: &str) -> u64 {
    track["quality"][key].as_u64().unwrap_or(0)
}

/// Whether a track is worth reading again: blocks the reader gave up on, a copy that did not match AccurateRip, or a
/// drive cache the reader did not trust.
pub fn is_suspect(track: &Value) -> bool {
    kind(track) == "no_match"
        || quality(track, "skipped_sectors") > 0
        || quality(track, "cache_errors") > 0
}

/// Whether `new` is a better read of the same track than `old`: matching AccurateRip first, then fewer blocks given
/// up on, fewer cache doubts, fewer repairs.
pub fn better(new: &Value, old: &Value) -> bool {
    let key = |t: &Value| {
        (
            kind(t) == "matched",
            std::cmp::Reverse(quality(t, "skipped_sectors")),
            std::cmp::Reverse(quality(t, "cache_errors")),
            std::cmp::Reverse(quality(t, "repair_events")),
        )
    };
    key(new) > key(old)
}

/// "1:12" for 72 000 ms.
pub fn clock(ms: u64) -> String {
    format!("{}:{:02}", ms / 60_000, (ms / 1000) % 60)
}

fn span_text(track: &Value) -> Option<String> {
    let span = track["problem_span_ms"].as_array()?;
    let (from, to) = (span.first()?.as_u64()?, span.get(1)?.as_u64()?);
    Some(if to / 1000 <= from / 1000 {
        format!("near {}", clock(from))
    } else {
        format!("between {} and {}", clock(from), clock(to))
    })
}

/// What the person is told about one track after all passes. `passes` is how many times it was read.
pub fn describe_track(track: &Value, passes: u32) -> (String, Vec<String>) {
    let skipped = quality(track, "skipped_sectors");
    let repairs = quality(track, "repair_events");
    let matched = kind(track) == "matched";
    let read_again = passes > 1;
    if matched {
        let state = if read_again { "recovered" } else { "ok" };
        let mut reasons = Vec::new();
        if read_again {
            reasons.push(format!("The first read had problems, but read {passes} times it now matches AccurateRip, so the audio is right."));
        }
        return (state.to_owned(), reasons);
    }
    let mut reasons = Vec::new();
    let after = if read_again {
        format!(" even after {passes} reads")
    } else {
        String::new()
    };
    if skipped > 0 {
        let place = span_text(track).map_or(String::new(), |p| format!(" {p}"));
        reasons.push(format!("{} block{} of audio could not be read{place}{after}; silence or a glitch stands in for {}.", skipped, if skipped == 1 { "" } else { "s" }, if skipped == 1 { "it" } else { "them" }));
        return ("damaged".to_owned(), reasons);
    }
    if kind(track) == "no_match" {
        if let Some(shift) = track["pressing_shift"]["samples"].as_i64() {
            reasons.push(format!(
                "It matches AccurateRip once moved {} samples ({} ms), so this disc is a different pressing from the first one in the database. The audio was read correctly.",
                shift.abs(),
                (shift.abs() * 1000 / 44_100).max(if shift != 0 { 1 } else { 0 })
            ));
            return ("shifted".to_owned(), reasons);
        }
        let disagreed = track["read_agreement"]["identical"] == false;
        if quality(track, "cache_errors") == 0 && !disagreed {
            // Nothing went wrong while reading, and where it was read again the reads came out identical.
            let reads = track["read_agreement"]["reads"].as_u64().unwrap_or(1);
            reasons.push(if reads > 1 {
                format!("It read the same all {reads} times with no problems, but does not match AccurateRip's copy. This is usually another pressing of the album, so it cannot be confirmed either way.")
            } else {
                "It read with no problems, but does not match AccurateRip's copy (usually another pressing), and it was not read again to compare.".to_owned()
            });
            return ("unmatched".to_owned(), reasons);
        }
        reasons.push(if disagreed {
            format!("It did not match AccurateRip, and the reads did not agree with each other{after}: the read may hold errors.")
        } else {
            format!("It did not match AccurateRip{after}, and the reader doubted its drive cache: the read may hold errors.")
        });
        if repairs > 0 {
            reasons.push(format!(
                "The reader had to repair {repairs} spot{} while reading it.",
                if repairs == 1 { "" } else { "s" }
            ));
        }
        return ("damaged".to_owned(), reasons);
    }
    // No reference to compare with.
    if repairs >= 20 {
        reasons.push(format!("AccurateRip has no copy to compare with, and the reader repaired {repairs} spots in it; listen to it."));
        return ("suspect".to_owned(), reasons);
    }
    (
        "unconfirmed".to_owned(),
        vec!["AccurateRip has no copy to compare with; the read itself was clean.".to_owned()],
    )
}

/// The disc's health for the page and the log, from the final per-track results and how often each was read.
pub fn assess(result: &Value, passes: &BTreeMap<u8, u32>) -> Value {
    let mut tracks = Vec::new();
    let (mut damaged, mut suspect, mut recovered, mut unconfirmed) =
        (Vec::new(), Vec::new(), Vec::new(), Vec::new());
    let (mut shifted, mut unmatched) = (Vec::new(), Vec::new());
    for track in result["tracks"].as_array().into_iter().flatten() {
        let number = track["number"].as_u64().unwrap_or(0) as u8;
        let times = passes.get(&number).copied().unwrap_or(1);
        let (state, reasons) = describe_track(track, times);
        match state.as_str() {
            "damaged" => damaged.push(number),
            "suspect" => suspect.push(number),
            "recovered" => recovered.push(number),
            "unconfirmed" => unconfirmed.push(number),
            "shifted" => shifted.push(number),
            "unmatched" => unmatched.push(number),
            _ => {}
        }
        if state != "ok" {
            tracks.push(json!({ "number": number, "state": state, "reasons": reasons, "passes": times, "problem_span_ms": track["problem_span_ms"] }));
        }
    }
    let list = |numbers: &[u8]| {
        numbers
            .iter()
            .map(u8::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    };
    let plural = |n: usize| if n == 1 { "track" } else { "tracks" };
    let (state, headline) = if !damaged.is_empty() {
        (
            "damaged",
            format!(
                "{} could not be read cleanly: {} {}. They are saved, but they may have gaps or glitches.",
                if damaged.len() == 1 {
                    "One track"
                } else {
                    "Some tracks"
                },
                plural(damaged.len()),
                list(&damaged)
            ),
        )
    } else if !suspect.is_empty() {
        (
            "suspect",
            format!(
                "The disc read, but {} {} {} worth a listen.",
                plural(suspect.len()),
                list(&suspect),
                if suspect.len() == 1 { "is" } else { "are" }
            ),
        )
    } else if !recovered.is_empty() {
        (
            "good",
            format!(
                "The disc had trouble spots, but re-reading fixed {} {} {}; every track now matches AccurateRip.",
                plural(recovered.len()),
                list(&recovered),
                if recovered.len() == 1 {
                    "(it)"
                } else {
                    "(them)"
                }
            ),
        )
    } else if !shifted.is_empty() || !unmatched.is_empty() {
        let mut text = Vec::new();
        if !shifted.is_empty() {
            text.push(format!("{} {} {} AccurateRip once shifted by a few samples, so this disc is a different pressing from the first one in the database; the audio was read correctly.", if shifted.len() == 1 { "Track" } else { "Tracks" }, list(&shifted), if shifted.len() == 1 { "matches" } else { "match" }));
        }
        if !unmatched.is_empty() {
            text.push(format!("{} {} read cleanly and the same every time, but AccurateRip's copy differs (usually another pressing), so {} cannot be confirmed that way.", if unmatched.len() == 1 { "Track" } else { "Tracks" }, list(&unmatched), if unmatched.len() == 1 { "it" } else { "they" }));
        }
        ("good", format!("The disc read cleanly. {}", text.join(" ")))
    } else if !unconfirmed.is_empty() {
        (
            "good",
            format!(
                "The disc read cleanly. AccurateRip had no copy to compare {} {} with.",
                plural(unconfirmed.len()),
                list(&unconfirmed)
            ),
        )
    } else {
        (
            "good",
            "Every track read cleanly and matches AccurateRip.".to_owned(),
        )
    };
    let advice: Vec<&str> = if state == "damaged" || state == "suspect" {
        vec![
            "Clean the disc: wipe it with a soft, lint-free cloth from the centre straight out to the edge (never in circles), then rip those tracks again.",
            "If you have another disc drive, try it: drives differ a lot in how they cope with scratches.",
            "Tracks that still fail are kept, flagged in Review > Flagged tracks with where the trouble is, and can be replaced later from another copy of the album.",
        ]
    } else {
        Vec::new()
    };
    json!({
        "state": state, "headline": headline, "tracks": tracks, "advice": advice,
        "damaged": damaged, "suspect": suspect, "recovered": recovered, "unconfirmed": unconfirmed,
        "shifted": shifted, "unmatched": unmatched,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(
        number: u8,
        kind: &str,
        skipped: u64,
        repairs: u64,
        span: Option<(u64, u64)>,
    ) -> Value {
        json!({ "number": number, "verification": { "kind": kind }, "quality": { "skipped_sectors": skipped, "repair_events": repairs, "cache_errors": 0 }, "problem_span_ms": span })
    }

    #[test]
    fn tracks_are_read_again_only_when_something_is_wrong() {
        assert!(
            !is_suspect(&track(1, "matched", 0, 40, None)),
            "repairs alone are normal"
        );
        assert!(!is_suspect(&track(1, "unavailable", 0, 0, None)));
        assert!(is_suspect(&track(1, "no_match", 0, 0, None)));
        assert!(is_suspect(&track(
            1,
            "unavailable",
            2,
            0,
            Some((1000, 2000))
        )));
    }

    #[test]
    fn the_better_read_wins_by_match_then_fewer_skipped_blocks() {
        let bad = track(5, "no_match", 9, 3, None);
        assert!(better(&track(5, "matched", 0, 0, None), &bad));
        assert!(
            better(&track(5, "no_match", 2, 3, None), &bad),
            "fewer blocks given up on"
        );
        assert!(!better(&bad, &track(5, "no_match", 2, 3, None)));
        assert!(
            !better(&track(5, "no_match", 9, 3, None), &bad),
            "equal is not better"
        );
    }

    #[test]
    fn each_track_is_described_in_plain_words_with_its_place() {
        let (state, reasons) =
            describe_track(&track(5, "no_match", 12, 0, Some((72_000, 75_500))), 3);
        assert_eq!(state, "damaged");
        assert!(
            reasons[0].contains("12 blocks")
                && reasons[0].contains("between 1:12 and 1:15")
                && reasons[0].contains("after 3 reads"),
            "{reasons:?}"
        );
        let (state, reasons) = describe_track(&track(5, "matched", 4, 0, None), 2);
        assert_eq!(state, "recovered");
        assert!(reasons[0].contains("now matches AccurateRip"));
        assert_eq!(describe_track(&track(1, "matched", 0, 0, None), 1).0, "ok");
        assert_eq!(
            describe_track(&track(1, "unavailable", 0, 3, None), 1).0,
            "unconfirmed"
        );
        assert_eq!(
            describe_track(&track(1, "unavailable", 0, 60, None), 1).0,
            "suspect"
        );
        // A clean read that does not match is not damage: it is unconfirmed, and says so.
        let (state, reasons) = describe_track(&track(2, "no_match", 0, 5, None), 1);
        assert_eq!(state, "unmatched");
        assert!(reasons[0].contains("not read again"), "{reasons:?}");
        let mut agreed = track(2, "no_match", 0, 0, None);
        agreed["read_agreement"] = json!({ "reads": 2, "identical": true });
        let (state, reasons) = describe_track(&agreed, 2);
        assert_eq!(state, "unmatched");
        assert!(reasons[0].contains("same all 2 times"), "{reasons:?}");
        // Reads that disagree with each other are a real problem.
        let mut disagreed = track(2, "no_match", 0, 5, None);
        disagreed["read_agreement"] = json!({ "reads": 3, "identical": false });
        let (state, reasons) = describe_track(&disagreed, 3);
        assert_eq!(state, "damaged");
        assert!(
            reasons[0].contains("did not agree") && reasons[1].contains("repair 5 spots"),
            "{reasons:?}"
        );
        // Matching at a shifted position proves the read and names the cause.
        let mut other_pressing = track(3, "no_match", 0, 0, None);
        other_pressing["pressing_shift"] = json!({ "samples": -441, "confidence": 4 });
        let (state, reasons) = describe_track(&other_pressing, 1);
        assert_eq!(state, "shifted");
        assert!(
            reasons[0].contains("441 samples (10 ms)") && reasons[0].contains("different pressing"),
            "{reasons:?}"
        );
    }

    #[test]
    fn a_disc_of_another_pressing_is_good_not_damaged() {
        let mut shifted = track(1, "no_match", 0, 0, None);
        shifted["pressing_shift"] = json!({ "samples": 12, "confidence": 3 });
        let mut same = track(2, "no_match", 0, 0, None);
        same["read_agreement"] = json!({ "reads": 2, "identical": true });
        let health = assess(
            &json!({ "tracks": [shifted, same] }),
            &BTreeMap::from([(2, 2)]),
        );
        assert_eq!(health["state"], "good");
        assert_eq!(health["damaged"], json!([]));
        assert!(
            health["headline"]
                .as_str()
                .unwrap()
                .contains("Track 1 matches AccurateRip once shifted"),
            "{health}"
        );
        assert!(
            health["headline"]
                .as_str()
                .unwrap()
                .contains("Track 2 read cleanly and the same every time"),
            "{health}"
        );
        assert_eq!(health["advice"], json!([]));
    }

    #[test]
    fn the_disc_is_good_suspect_or_damaged_and_says_what_to_do() {
        let clean =
            json!({ "tracks": [track(1, "matched", 0, 0, None), track(2, "matched", 0, 0, None)] });
        let health = assess(&clean, &BTreeMap::new());
        assert_eq!(health["state"], "good");
        assert!(
            health["headline"]
                .as_str()
                .unwrap()
                .contains("Every track read cleanly")
        );
        assert_eq!(health["advice"], json!([]));

        let rough = json!({ "tracks": [track(1, "matched", 0, 0, None), track(2, "matched", 3, 0, None), track(3, "no_match", 7, 0, Some((10_000, 12_000)))] });
        let health = assess(&rough, &BTreeMap::from([(2, 2), (3, 3)]));
        assert_eq!(health["state"], "damaged");
        assert_eq!(health["damaged"], json!([3]));
        assert_eq!(health["recovered"], json!([2]));
        assert!(
            health["headline"]
                .as_str()
                .unwrap()
                .contains("One track could not be read cleanly: track 3")
        );
        assert_eq!(
            health["tracks"].as_array().unwrap().len(),
            2,
            "tracks that are fine are not listed"
        );
        assert!(
            health["advice"][0]
                .as_str()
                .unwrap()
                .contains("soft, lint-free cloth")
        );

        let healed = json!({ "tracks": [track(2, "matched", 3, 0, None)] });
        let health = assess(&healed, &BTreeMap::from([(2, 2)]));
        assert_eq!(health["state"], "good");
        assert!(
            health["headline"]
                .as_str()
                .unwrap()
                .contains("re-reading fixed")
        );
    }
}
