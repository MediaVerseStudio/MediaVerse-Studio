//! A stand-in for `mediaverse_cd_helper`, used only by the sidecar's tests. Speaks the same
//! protocol with canned answers. Set FAKE_HELPER_HANG=1 to make `calibrate` wait for `cancel`.

use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, mpsc};
use std::time::Duration;

const STARTS: [u32; 12] = [
    0, 15770, 32932, 48082, 64527, 79350, 93247, 109050, 125150, 143145, 162400, 182457,
];

/// Deterministic fake audio for a track; the tests regenerate it to check the archived FLAC.
fn fake_samples(track: u8) -> Vec<u32> {
    (0..20_000u32)
        .map(|i| {
            // Music-like (two tones per channel, different in each) so lossy copies can be compared with it.
            let t = f64::from(i) / 44_100.0;
            let f = 200.0 + f64::from(track) * 37.0;
            let left = 9_000.0 * (t * f * std::f64::consts::TAU).sin()
                + 3_000.0 * (t * f * 7.0 * std::f64::consts::TAU).sin();
            let right = 8_000.0 * (t * f * 1.5 * std::f64::consts::TAU).sin()
                + 2_500.0 * (t * f * 9.0 * std::f64::consts::TAU).sin();
            u32::from(left as i16 as u16) | (u32::from(right as i16 as u16) << 16)
        })
        .collect()
}

fn wav_bytes(samples: &[u32]) -> Vec<u8> {
    let data = (samples.len() * 4) as u32;
    let mut out = Vec::new();
    out.extend_from_slice(b"RIFF");
    out.extend_from_slice(&(36 + data).to_le_bytes());
    out.extend_from_slice(b"WAVEfmt ");
    out.extend_from_slice(&16u32.to_le_bytes());
    out.extend_from_slice(&1u16.to_le_bytes());
    out.extend_from_slice(&2u16.to_le_bytes());
    out.extend_from_slice(&44_100u32.to_le_bytes());
    out.extend_from_slice(&176_400u32.to_le_bytes());
    out.extend_from_slice(&4u16.to_le_bytes());
    out.extend_from_slice(&16u16.to_le_bytes());
    out.extend_from_slice(b"data");
    out.extend_from_slice(&data.to_le_bytes());
    for sample in samples {
        out.extend_from_slice(&sample.to_le_bytes());
    }
    out
}

fn send(message: Value) {
    let mut out = std::io::stdout().lock();
    let _ = writeln!(out, "{message}").and_then(|()| out.flush());
}

fn main() {
    send(json!({ "type": "ready", "protocol": 1, "helper": "fake", "commands": [] }));

    let cancelled = Arc::new(AtomicBool::new(false));
    let (sender, requests) = mpsc::channel::<Value>();
    let flag = cancelled.clone();
    std::thread::spawn(move || {
        for line in std::io::stdin().lock().lines().map_while(Result::ok) {
            let Ok(request) = serde_json::from_str::<Value>(&line) else {
                continue;
            };
            if request["command"] == "cancel" {
                flag.store(true, Ordering::Relaxed);
            } else if sender.send(request).is_err() {
                break;
            }
        }
        flag.store(true, Ordering::Relaxed);
    });

    while let Ok(request) = requests.recv() {
        let id = request["id"].clone();
        let args = &request["args"];
        let respond = |result: Value| {
            send(json!({ "type": "response", "id": id, "ok": true, "result": result }))
        };
        match request["command"].as_str() {
            Some("list_drives") => respond(json!([
                { "device": "Z:", "vendor": "FAKE", "model": "Fake Drive", "revision": "1.0" }
            ])),
            Some("read_toc") => {
                let tracks: Vec<Value> = STARTS
                    .iter()
                    .enumerate()
                    .map(|(i, &start)| {
                        let end = STARTS.get(i + 1).map_or(198_076, |next| next - 1);
                        json!({ "number": i + 1, "start_lsn": start, "end_lsn": end, "audio": true })
                    })
                    .collect();
                respond(json!({ "tracks": tracks, "leadout_lsn": 198_077 }));
            }
            Some("calibrate") => {
                for done in 0..3 {
                    send(json!({
                        "type": "event", "event": "calibration-progress",
                        "payload": { "step": "read_test", "done": done, "total": 3 },
                    }));
                }
                if std::env::var_os("FAKE_HELPER_HANG").is_some() {
                    while !cancelled.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    send(json!({
                        "type": "response", "id": id, "ok": false,
                        "error": { "code": "cancelled", "message": "Calibration was cancelled." },
                    }));
                    continue;
                }
                let existing_offset = args["existing"]["read_offset"]["value"].clone();
                let pressings_len = args["pressings_hex"].as_str().map_or(0, str::len);
                respond(json!({
                    "profile": {
                        "identity": { "vendor": "FAKE", "model": "Fake Drive", "revision": "1.0", "connection": "unknown" },
                        "read_offset": { "value": 6, "provenance": "measured" },
                        "offset_evidence": null, "cache": null, "max_transfer_sectors": null,
                        "repeat_reads_agree": true, "app_version": "fake", "notes": "",
                    },
                    "offset": { "kind": "measured", "offset": 6, "tracks": [2, 3], "versions": [2] },
                    "cache": null,
                    "warnings": [],
                    "echo": { "existing_offset": existing_offset, "pressings_hex_len": pressings_len,
                              "disc": args["disc"], "date_len": args["date"].as_str().map_or(0, str::len) },
                }));
            }
            Some("rip_disc") => {
                for done in [0, 750] {
                    send(json!({
                        "type": "event", "event": "rip-progress",
                        "payload": { "track": 2, "tracks_done": 0, "tracks_total": 1, "done": done, "total": 1500 },
                    }));
                }
                if std::env::var_os("FAKE_HELPER_HANG").is_some() {
                    while !cancelled.load(Ordering::Relaxed) {
                        std::thread::sleep(Duration::from_millis(20));
                    }
                    send(json!({
                        "type": "response", "id": id, "ok": false,
                        "error": { "code": "cancelled", "message": "cancelled" },
                    }));
                    continue;
                }
                let numbers: Vec<u8> = args["tracks"]
                    .as_array()
                    .map(|list| {
                        list.iter()
                            .filter_map(|n| n.as_u64().map(|n| n as u8))
                            .collect()
                    })
                    .unwrap_or_else(|| vec![2]);
                let dir = std::path::PathBuf::from(args["output_dir"].as_str().unwrap_or("."));
                let _ = std::fs::create_dir_all(&dir);
                let mut files = Vec::new();
                let mut reports = Vec::new();
                for &number in &numbers {
                    let path = dir.join(format!("{number:02}.wav"));
                    std::fs::write(&path, wav_bytes(&fake_samples(number))).unwrap();
                    files.push(path.to_string_lossy().into_owned());
                    // Track 3 plays the part of a track that did not match AccurateRip.
                    // With FAKE_HELPER_RECOVER the drive reads track 3 right when it is asked again (a retry pass).
                    let retry_pass = args["output_dir"]
                        .as_str()
                        .is_some_and(|d| d.contains("retry-"));
                    let kind = if number == 3
                        && !(std::env::var_os("FAKE_HELPER_RECOVER").is_some() && retry_pass)
                    {
                        "no_match"
                    } else {
                        "matched"
                    };
                    reports.push(json!({ "number": number, "verification": { "kind": kind } }));
                }
                respond(json!({
                    "tracks": reports, "files": files, "summary": ["fake"],
                    "echo": {
                        "offset": args["offset"], "max_transfer": args["max_transfer"],
                        "output_dir": args["output_dir"], "tracks": args["tracks"],
                        "secure": args["secure"],
                        "pressings_hex_len": args["pressings_hex"].as_str().map_or(0, str::len),
                    },
                }));
            }
            Some("shutdown") => {
                respond(Value::Null);
                return;
            }
            _ => {}
        }
    }
}
