//! Defect scans for the sidecar: decodes a library file (MP3, FLAC or WAV) and runs the scanner from
//! `mediaverse_ripper::defects`, and describes the answer for the page. Library files only.

use crate::library_cover::resolve_in_library;
use mediaverse_ripper::defects::{self, DefectKind, Report};
use mediaverse_ripper::{flac, wav};
use serde_json::{Value, json};
use std::path::Path;

const MAX_FILE_BYTES: u64 = 400 * 1024 * 1024;

/// Decodes a file to packed stereo 44.1 kHz samples. MP3 is decoded with the same independent decoder
/// used to check new MP3s; anything that is not CD quality stereo is refused rather than guessed at.
pub fn decode_file(file: &Path) -> Result<Vec<u32>, String> {
    let size = std::fs::metadata(file)
        .map_err(|e| format!("could not read the file: {e}"))?
        .len();
    if size > MAX_FILE_BYTES {
        return Err("the file is too large to scan".to_owned());
    }
    let bytes = std::fs::read(file).map_err(|e| format!("could not read the file: {e}"))?;
    match file
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("mp3") => {
            let decoded = nanomp3::decode_all::<i16>(&bytes);
            if decoded.sample_rate != 44_100 {
                return Err(format!(
                    "only 44.1 kHz audio can be scanned (this is {} Hz)",
                    decoded.sample_rate
                ));
            }
            match decoded.channels {
                Some(nanomp3::Channels::Stereo) => Ok(decoded
                    .samples
                    .chunks_exact(2)
                    .map(|c| u32::from(c[0] as u16) | (u32::from(c[1] as u16) << 16))
                    .collect()),
                Some(nanomp3::Channels::Mono) => Ok(decoded
                    .samples
                    .iter()
                    .map(|&s| u32::from(s as u16) | (u32::from(s as u16) << 16))
                    .collect()),
                None => Err("the MP3 holds no readable audio".to_owned()),
            }
        }
        Some("flac") => flac::decode(&bytes).map_err(|e| e.to_string()),
        Some("wav") => wav::read_wav(&bytes).map_err(|e| e.to_string()),
        _ => Err("only MP3, FLAC and WAV files can be scanned".to_owned()),
    }
}

/// The scan result as JSON: verdict, counts and the listed findings with times in milliseconds.
pub fn report_json(report: &Report) -> Value {
    let ms = |samples: u64| samples * 1000 / defects::SAMPLE_RATE;
    json!({
        "verdict": report.verdict.name(),
        "seconds": report.samples / defects::SAMPLE_RATE,
        "counts": {
            "click": report.count(DefectKind::Click),
            "dropout": report.count(DefectKind::Dropout),
            "stuck": report.count(DefectKind::Stuck),
            "clipping": report.count(DefectKind::Clipping),
            "silent": report.count(DefectKind::Silent),
        },
        "truncated": report.truncated,
        "findings": report.defects.iter().map(|d| json!({
            "kind": d.kind.name(),
            "time_ms": ms(d.start_sample),
            "length_ms": ms(d.length_samples).max(if d.length_samples > 0 { 1 } else { 0 }),
            "strength": (d.strength * 100.0).round() / 100.0,
        })).collect::<Vec<_>>(),
    })
}

/// Scans the given library files. One entry per file: `{path, ok, report | error}`.
pub fn scan_files(
    paths: &[String],
    library_root: Option<&Path>,
    progress: &mut dyn FnMut(usize, usize, &str),
) -> Value {
    scan_files_until(paths, library_root, progress, &|| false)
}

/// Like `scan_files`, but checks `stop` before each file and stops there when it says so. The result then
/// holds the files scanned so far and `"stopped": true`.
pub fn scan_files_until(
    paths: &[String],
    library_root: Option<&Path>,
    progress: &mut dyn FnMut(usize, usize, &str),
    stop: &dyn Fn() -> bool,
) -> Value {
    let total = paths.len();
    let mut entries: Vec<Value> = Vec::with_capacity(total);
    for (index, requested) in paths.iter().enumerate() {
        if stop() {
            return json!({ "tracks": entries, "stopped": true });
        }
        progress(index, total, requested);
        entries.push(match resolve_in_library(requested, library_root).and_then(|file| decode_file(&file)) {
            Ok(samples) => json!({ "path": requested, "ok": true, "report": report_json(&defects::analyze(&samples)) }),
            Err(error) => json!({ "path": requested, "ok": false, "error": error }),
        });
    }
    json!({ "tracks": entries })
}

/// "1:05" style time for messages.
fn clock(ms: u64) -> String {
    format!("{}:{:02}", ms / 60_000, ms / 1000 % 60)
}

/// Scans the ripped WAV files of tracks that AccurateRip could not confirm (no reference, or no match):
/// the scan is the only check those tracks get. Returns the per-track results for the page and
/// warnings for tracks that look suspect. Clean tracks are listed but not warned about.
pub fn scan_unconfirmed(result: &Value) -> (Vec<Value>, Vec<String>) {
    let files = result["files"].as_array().cloned().unwrap_or_default();
    let (mut scans, mut warnings) = (Vec::new(), Vec::new());
    for (index, track) in result["tracks"]
        .as_array()
        .into_iter()
        .flatten()
        .enumerate()
    {
        if !matches!(
            track["verification"]["kind"].as_str(),
            Some("unavailable" | "no_match")
        ) || track["pressing_shift"].is_object()
        {
            continue; // confirmed (also when only at a shifted position): the scan is for tracks nothing else checked
        }
        let number = track["number"].as_u64().unwrap_or(0);
        let Some(path) = files.get(index).and_then(Value::as_str) else {
            continue;
        };
        let samples = match std::fs::read(path)
            .map_err(|e| e.to_string())
            .and_then(|bytes| wav::read_wav(&bytes).map_err(|e| e.to_string()))
        {
            Ok(samples) => samples,
            Err(error) => {
                warnings.push(format!(
                    "Track {number} could not be scanned for defects: {error}."
                ));
                continue;
            }
        };
        let report = defects::analyze(&samples);
        let described = report_json(&report);
        if report.count(DefectKind::Silent) > 0 {
            // An empty rip: say so plainly (a silent track on purpose is possible, but a rip with no sound is far more likely).
            warnings.push(format!(
                "Track {number} has no sound at all: it came out silent from start to end. The disc may be scratched or the read failed; rip it again."
            ));
            scans.push(json!({ "track": number, "report": described }));
            continue;
        }
        let (clicks, dropouts, stuck) = (
            report.count(DefectKind::Click),
            report.count(DefectKind::Dropout),
            report.count(DefectKind::Stuck),
        );
        if report.verdict != defects::Verdict::Clean {
            let mut parts = Vec::new();
            if clicks > 0 {
                parts.push(format!(
                    "{clicks} click{}",
                    if clicks == 1 { "" } else { "s" }
                ));
            }
            if dropouts > 0 {
                parts.push(format!(
                    "{dropouts} dropout{}",
                    if dropouts == 1 { "" } else { "s" }
                ));
            }
            if stuck > 0 {
                parts.push(format!(
                    "{stuck} stuck stretch{}",
                    if stuck == 1 { "" } else { "es" }
                ));
            }
            if parts.is_empty() {
                parts.push("heavy clipping".to_owned());
            }
            let first = report
                .defects
                .iter()
                .find(|d| d.kind != DefectKind::Clipping)
                .map(|d| d.start_sample * 1000 / defects::SAMPLE_RATE);
            warnings.push(format!(
                "Track {number}: the defect scan found {}{}. AccurateRip could not confirm this track, so it is worth listening there{}.",
                parts.join(" and "),
                if report.verdict == defects::Verdict::Suspect { " (likely audible)" } else { "" },
                first.map_or(String::new(), |ms| format!(", starting near {}", clock(ms))),
            ));
        }
        scans.push(json!({ "track": number, "report": described }));
    }
    (scans, warnings)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_wav_with_a_pop_is_scanned_and_described() {
        let root = std::env::temp_dir().join(format!("mv-defect-scan-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let mut state = 3u32;
        let mut samples: Vec<u32> = (0..132_300usize)
            .map(|i| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let t = i as f64 / 44_100.0;
                let v = (6000.0 * (t * 330.0 * std::f64::consts::TAU).sin()
                    + f64::from((state >> 22) as i32 - 512)) as i32;
                u32::from(v as i16 as u16) | (u32::from(v as i16 as u16) << 16)
            })
            .collect();
        for &place in &[30_000usize, 60_000, 90_000] {
            samples[place] = 0x4E20_4E20; // +20000 in both channels
        }
        let path = root.join("pop.wav");
        wav::write_wav(std::fs::File::create(&path).unwrap(), &samples).unwrap();
        let reply = scan_files(
            &[
                path.to_string_lossy().into_owned(),
                root.join("missing.wav").to_string_lossy().into_owned(),
            ],
            Some(&root),
            &mut |_, _, _| {},
        );
        let first = &reply["tracks"][0];
        assert_eq!(first["ok"], true, "{reply}");
        assert_eq!(first["report"]["verdict"], "suspect");
        assert_eq!(first["report"]["counts"]["click"], 3);
        assert_eq!(
            first["report"]["findings"][0]["time_ms"],
            30_000u64 * 1000 / 44_100
        );
        assert_eq!(reply["tracks"][1]["ok"], false);
    }

    #[test]
    fn a_stopped_scan_keeps_what_it_finished_and_says_it_stopped() {
        let files: Vec<String> = (0..5).map(|n| format!("C:\\nowhere\\{n}.mp3")).collect();
        let checks = std::cell::Cell::new(0);
        // Stop is asked before the third file: two files are done, the rest are not started.
        let stop = || {
            checks.set(checks.get() + 1);
            checks.get() > 2
        };
        let mut started = Vec::new();
        let reply = scan_files_until(&files, None, &mut |i, _, _| started.push(i), &stop);
        assert_eq!(reply["stopped"], true);
        assert_eq!(reply["tracks"].as_array().unwrap().len(), 2);
        assert_eq!(started, vec![0, 1]);
        // Never stopped: every file gets an entry and there is no "stopped" mark.
        let whole = scan_files(&files, None, &mut |_, _, _| {});
        assert_eq!(whole["tracks"].as_array().unwrap().len(), 5);
        assert!(whole.get("stopped").is_none());
    }

    #[test]
    fn only_unconfirmed_ripped_tracks_are_scanned_and_suspect_ones_are_warned_about() {
        let root = std::env::temp_dir().join(format!("mv-defect-rip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let tone = |pop: bool| -> Vec<u32> {
            let mut state = 11u32;
            let mut s: Vec<u32> = (0..132_300usize)
                .map(|i| {
                    state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                    let v = (6000.0 * (i as f64 / 44_100.0 * 330.0 * std::f64::consts::TAU).sin()
                        + f64::from((state >> 22) as i32 - 512)) as i32;
                    u32::from(v as i16 as u16) | (u32::from(v as i16 as u16) << 16)
                })
                .collect();
            if pop {
                for &p in &[30_000usize, 60_000, 90_000] {
                    s[p] = 0x4E20_4E20;
                }
            }
            s
        };
        let mut files = Vec::new();
        for (name, pop) in [("01.wav", true), ("02.wav", false), ("03.wav", true)] {
            let path = root.join(name);
            wav::write_wav(std::fs::File::create(&path).unwrap(), &tone(pop)).unwrap();
            files.push(path.to_string_lossy().into_owned());
        }
        let result = json!({
            "files": files,
            "tracks": [
                { "number": 1, "verification": { "kind": "matched" } },
                { "number": 2, "verification": { "kind": "unavailable" } },
                { "number": 3, "verification": { "kind": "no_match" } },
            ],
        });
        let (scans, warnings) = scan_unconfirmed(&result);
        assert_eq!(
            scans
                .iter()
                .map(|s| s["track"].as_u64().unwrap())
                .collect::<Vec<_>>(),
            [2, 3],
            "the matched track is not scanned"
        );
        assert_eq!(scans[0]["report"]["verdict"], "clean");
        assert_eq!(scans[1]["report"]["verdict"], "suspect");
        assert_eq!(warnings.len(), 1, "{warnings:?}");
        assert!(
            warnings[0].starts_with("Track 3:")
                && warnings[0].contains("3 clicks")
                && warnings[0].contains("near 0:00"),
            "{warnings:?}"
        );
    }

    #[test]
    fn other_kinds_of_file_and_outside_files_are_refused() {
        let root = std::env::temp_dir().join(format!("mv-defect-refuse-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let text = root.join("notes.txt");
        std::fs::write(&text, "hi").unwrap();
        let outside =
            std::env::temp_dir().join(format!("mv-defect-outside-{}.wav", std::process::id()));
        std::fs::write(&outside, b"RIFF").unwrap();
        let reply = scan_files(
            &[
                text.to_string_lossy().into_owned(),
                outside.to_string_lossy().into_owned(),
            ],
            Some(&root),
            &mut |_, _, _| {},
        );
        assert!(
            reply["tracks"][0]["error"]
                .as_str()
                .unwrap()
                .contains("only MP3, FLAC and WAV")
        );
        assert!(
            reply["tracks"][1]["error"]
                .as_str()
                .unwrap()
                .contains("outside")
        );
    }
}
