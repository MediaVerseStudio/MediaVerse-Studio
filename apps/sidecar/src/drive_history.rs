//! A drive's track record (D104). Every finished rip adds one line per disc to `<data dir>/drive-history.json`: how many
//! tracks matched AccurateRip (also at a shifted position), how many blocks could not be read, how often the drive's
//! cache was doubted, and whether the drive lost the disc or failed mid-rip. The summary puts the recent discs beside
//! the earlier ones, so a drive that is slowly getting worse shows as a trend instead of one confusing evening. It says what
//! was counted and never claims more: a damaged disc and a failing drive look alike on one disc and different over ten.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};

/// Events kept (the oldest are dropped).
const KEEP: usize = 300;
/// How many of the latest discs the summary compares with all the earlier ones.
const RECENT: usize = 8;

pub struct DriveHistory {
    path: PathBuf,
}

fn number(value: &Value, key: &str) -> u64 {
    value[key].as_u64().unwrap_or(0)
}

/// One line for a finished rip, from the rip result.
pub fn rip_event(drive: &str, name: &str, result: &Value, now: u64) -> Value {
    let mut event = json!({
        "at": now, "drive": drive, "name": name, "kind": "rip",
        "tracks": 0, "matched": 0, "shifted": 0, "differing": 0, "unconfirmed": 0,
        "skipped_blocks": 0, "cache_doubts": 0, "reread_tracks": 0, "damaged_tracks": 0,
    });
    let bump = |event: &mut Value, key: &str, by: u64| event[key] = json!(number(event, key) + by);
    for track in result["tracks"].as_array().into_iter().flatten() {
        bump(&mut event, "tracks", 1);
        match track["verification"]["kind"].as_str() {
            Some("matched") => bump(&mut event, "matched", 1),
            Some("no_match") if track["pressing_shift"].is_object() => {
                bump(&mut event, "shifted", 1)
            }
            Some("no_match") => bump(&mut event, "differing", 1),
            _ => bump(&mut event, "unconfirmed", 1),
        }
        bump(
            &mut event,
            "skipped_blocks",
            number(&track["quality"], "skipped_sectors"),
        );
        bump(
            &mut event,
            "cache_doubts",
            number(&track["quality"], "cache_errors"),
        );
        if track["read_agreement"]["reads"].as_u64().unwrap_or(1) > 1 {
            bump(&mut event, "reread_tracks", 1);
        }
    }
    event["damaged_tracks"] = json!(
        result["disc_health"]["damaged"]
            .as_array()
            .map_or(0, Vec::len)
    );
    event
}

impl DriveHistory {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("drive-history.json"),
        }
    }

    fn load(&self) -> Vec<Value> {
        std::fs::read(&self.path)
            .ok()
            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default()
    }

    fn append(&self, event: Value) {
        let mut events = self.load();
        events.push(event);
        if events.len() > KEEP {
            events.drain(..events.len() - KEEP);
        }
        let _ = std::fs::write(&self.path, Value::Array(events).to_string());
    }

    pub fn record_rip(&self, drive: &str, name: &str, result: &Value, now: u64) {
        self.append(rip_event(drive, name, result, now));
    }

    /// The drive failed or lost the disc after the rip had started.
    pub fn record_failure(&self, drive: &str, name: &str, code: &str, message: &str, now: u64) {
        self.append(json!({ "at": now, "drive": drive, "name": name, "kind": "failed", "code": code, "message": message }));
    }

    pub fn clear(&self) {
        let _ = std::fs::remove_file(&self.path);
    }

    /// The summary of every drive that has a record, the one used most recently first.
    pub fn overview(&self) -> Value {
        let events = self.load();
        let mut seen: Vec<(String, String)> = Vec::new();
        for event in events.iter().rev() {
            let key = event["drive"].as_str().unwrap_or_default().to_owned();
            if !seen.iter().any(|(k, _)| *k == key) {
                seen.push((
                    key,
                    event["name"].as_str().unwrap_or("Disc drive").to_owned(),
                ));
            }
        }
        Value::Array(
            seen.into_iter()
                .map(|(key, name)| {
                    let mut summary = self.summary(Some(&key));
                    summary["name"] = json!(name);
                    summary
                })
                .collect(),
        )
    }

    /// Totals, the latest discs against the earlier ones, and plain notes. `drive` limits it to one drive when given.
    pub fn summary(&self, drive: Option<&str>) -> Value {
        let events: Vec<Value> = self
            .load()
            .into_iter()
            .filter(|e| drive.is_none_or(|d| e["drive"] == d))
            .collect();
        let rips: Vec<&Value> = events.iter().filter(|e| e["kind"] == "rip").collect();
        let failures = events.iter().filter(|e| e["kind"] == "failed").count();
        let sum = |set: &[&Value], key: &str| set.iter().map(|e| number(e, key)).sum::<u64>();
        let split = rips.len().saturating_sub(RECENT);
        let (earlier, recent) = rips.split_at(split);
        // The share of tracks confirmed against AccurateRip (directly or at a shifted position), of those it could be compared on.
        let verified = |set: &[&Value]| {
            let confirmed = sum(set, "matched") + sum(set, "shifted");
            let comparable = confirmed + sum(set, "differing");
            (comparable > 0).then(|| (confirmed * 100 / comparable) as u32)
        };
        let trouble = |set: &[&Value]| {
            sum(set, "skipped_blocks") + sum(set, "cache_doubts") + sum(set, "damaged_tracks")
        };
        let recent_failures = events
            .iter()
            .rev()
            .take(RECENT + 2)
            .filter(|e| e["kind"] == "failed")
            .count();
        let mut notes: Vec<String> = Vec::new();
        if rips.is_empty() && failures == 0 {
            notes.push("No discs have been ripped with this drive yet. The record starts with the next rip.".to_owned());
        } else {
            if failures > 0 {
                notes.push(format!(
                    "The drive failed or lost the disc during {failures} rip{}.",
                    if failures == 1 { "" } else { "s" }
                ));
            }
            if recent_failures >= 2 {
                notes.push("It has failed more than once lately. Try another disc you know is clean; if that fails too, clean the drive's lens or have the drive looked at.".to_owned());
            }
            if earlier.len() >= 3 && recent.len() >= 3 {
                let (before, now) = (verified(earlier), verified(recent));
                if let (Some(before), Some(now)) = (before, now)
                    && now + 15 <= before
                {
                    notes.push(format!("Fewer tracks are confirmed by AccurateRip lately ({now}% of the last {} discs, against {before}% before). Discs differ, so this is only a hint; a clean disc that used to rip well is the real test.", recent.len()));
                }
                let rate = |set: &[&Value]| trouble(set) as f64 / set.len().max(1) as f64;
                if trouble(recent) > 0 && rate(recent) >= 3.0 * rate(earlier).max(0.5) {
                    notes.push("Read problems (unreadable blocks or cache doubts) are more frequent in the last few discs than before.".to_owned());
                }
            }
            if notes.is_empty() {
                notes.push("Nothing worrying in the record.".to_owned());
            }
        }
        json!({
            "discs": rips.len(),
            "failures": failures,
            "tracks": sum(&rips, "tracks"),
            "matched": sum(&rips, "matched"),
            "shifted": sum(&rips, "shifted"),
            "differing": sum(&rips, "differing"),
            "unconfirmed": sum(&rips, "unconfirmed"),
            "skipped_blocks": sum(&rips, "skipped_blocks"),
            "cache_doubts": sum(&rips, "cache_doubts"),
            "verified_percent": verified(&rips),
            "recent": { "discs": recent.len(), "verified_percent": verified(recent), "trouble": trouble(recent) },
            "notes": notes,
            "last": rips.last().map(|e| (*e).clone()),
        })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mv-drive-history-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn result(matched: usize, differing: usize, skipped: u64) -> Value {
        let mut tracks: Vec<Value> = (0..matched).map(|n| json!({ "number": n + 1, "verification": { "kind": "matched" }, "quality": { "skipped_sectors": 0, "cache_errors": 0 } })).collect();
        for n in 0..differing {
            tracks.push(json!({ "number": matched + n + 1, "verification": { "kind": "no_match" }, "quality": { "skipped_sectors": skipped, "cache_errors": 0 }, "read_agreement": { "reads": 2, "identical": true } }));
        }
        json!({ "tracks": tracks, "disc_health": { "damaged": if skipped > 0 { json!([1]) } else { json!([]) } } })
    }

    #[test]
    fn a_rip_is_counted_by_how_its_tracks_checked_out() {
        let mut shifted = result(2, 2, 0);
        shifted["tracks"][2]["pressing_shift"] = json!({ "samples": -6, "confidence": 1 });
        let event = rip_event("d", "Drive", &shifted, 5);
        assert_eq!(
            (
                event["tracks"].as_u64(),
                event["matched"].as_u64(),
                event["shifted"].as_u64(),
                event["differing"].as_u64()
            ),
            (Some(4), Some(2), Some(1), Some(1))
        );
        assert_eq!(event["reread_tracks"], 2, "tracks that were read again");
    }

    #[test]
    fn the_history_is_kept_summarised_and_can_be_cleared() {
        let dir = temp_dir("keep");
        let history = DriveHistory::new(&dir);
        assert!(
            history.summary(None)["notes"][0]
                .as_str()
                .unwrap()
                .contains("No discs")
        );
        for n in 0..10 {
            history.record_rip("d", "Drive", &result(10, 0, 0), n);
        }
        let summary = history.summary(Some("d"));
        assert_eq!(
            (
                summary["discs"].as_u64(),
                summary["verified_percent"].as_u64(),
                summary["failures"].as_u64()
            ),
            (Some(10), Some(100), Some(0))
        );
        assert_eq!(summary["notes"][0], "Nothing worrying in the record.");
        assert_eq!(
            history.summary(Some("other"))["discs"],
            0,
            "other drives are not mixed in"
        );
        // Lately: trouble and failures.
        for n in 0..4 {
            history.record_rip("d", "Drive", &result(2, 8, 5), 100 + n);
        }
        history.record_failure("d", "Drive", "no_disc", "gone", 200);
        history.record_failure("d", "Drive", "read_failed", "bad", 201);
        let notes: Vec<String> = history.summary(Some("d"))["notes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|n| n.as_str().unwrap().to_owned())
            .collect();
        assert!(
            notes
                .iter()
                .any(|n| n.contains("failed or lost the disc during 2 rips")),
            "{notes:?}"
        );
        assert!(
            notes
                .iter()
                .any(|n| n.contains("failed more than once lately")),
            "{notes:?}"
        );
        assert!(
            notes
                .iter()
                .any(|n| n.contains("Fewer tracks are confirmed")),
            "{notes:?}"
        );
        assert!(
            notes.iter().any(|n| n.contains("Read problems")),
            "{notes:?}"
        );
        history.clear();
        assert_eq!(history.summary(None)["discs"], 0);
    }

    #[test]
    fn the_file_stays_a_bounded_size() {
        let dir = temp_dir("bound");
        let history = DriveHistory::new(&dir);
        for n in 0..(KEEP as u64 + 20) {
            history.record_rip("d", "Drive", &result(1, 0, 0), n);
        }
        assert_eq!(history.load().len(), KEEP);
        assert_eq!(history.load()[0]["at"], 20, "the oldest are dropped");
    }
}
