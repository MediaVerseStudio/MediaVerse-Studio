//! MediaVerse sidecar protocol v1: newline-delimited JSON over stdin/stdout.
//! See `docs/architecture/0003-sidecar-protocol.md`.

pub mod album_align;
pub mod album_level;
pub mod archive_job;
pub mod artist_names_mb;
pub mod artist_photos_wiki;
pub mod artist_rename;
pub mod artwork_search;
pub mod audio_check;
pub mod audio_folder;
pub mod convert_job;
pub mod cover_art;
pub mod defect_results;
pub mod disc_health;
pub mod drive_history;
pub mod drives;
pub mod favorites;
pub mod fingerprint;
pub mod flags;
pub mod gnudb_submit;
pub mod helper;
pub mod history;
pub mod levelling_tags;
pub mod library_cover;
pub mod library_defects;
pub mod library_gaps;
pub mod library_media;
pub mod library_organize;
pub mod library_recent;
pub mod library_scan;
pub mod lookup;
pub mod loudness;
pub mod loudness_job;
pub mod loudness_store;
pub mod lyric_ai;
pub mod lyrics_instrumental;
pub mod lyrics_lookup;
pub mod lyrics_photos;
pub mod lyrics_review;
pub mod mb_ids;
pub mod mp3_job;
pub mod native_audio;
pub mod native_pcm;
#[cfg(windows)]
pub mod native_wasapi;
pub mod organize_apply;
pub mod os_priority;
pub mod path_move;
pub mod pins;
pub mod playlists;
pub mod pressing_shift;
pub mod profiles;
pub mod release_compare;
pub mod rerip;
pub mod rip_job;
pub mod scheduler;
pub mod settings;
pub mod sha256;
pub mod tag_repair;
pub mod tag_standard;
pub mod title_tidy;
pub mod vision_reader;
pub mod windows_decode;

use drives::Drives;
use mediaverse_host::{EventSink, Host};
use serde_json::{Value, json};
use std::io::{BufRead, Write};
use std::sync::{Arc, Mutex};

pub const PROTOCOL_VERSION: u32 = 1;

/// Serialises every outgoing message (responses and events) onto one writer, one line each.
#[derive(Clone)]
pub struct Output(Arc<Mutex<Box<dyn Write + Send>>>);

impl Output {
    pub fn new(writer: impl Write + Send + 'static) -> Self {
        Self(Arc::new(Mutex::new(Box::new(writer))))
    }

    pub fn send(&self, message: &Value) {
        if let Ok(mut writer) = self.0.lock() {
            // A closed pipe means the parent is gone; the read loop will observe EOF and exit.
            let _ = writeln!(writer, "{message}").and_then(|()| writer.flush());
        }
    }
}

impl EventSink for Output {
    fn emit(&self, event: &str, payload: Value) {
        self.send(&json!({ "type": "event", "event": event, "payload": payload }));
    }
}

pub fn ready_message() -> Value {
    json!({
        "type": "ready",
        "protocol": PROTOCOL_VERSION,
        "sidecar": env!("CARGO_PKG_VERSION"),
        "commands": Host::commands().iter().chain(drives::COMMANDS.iter()).collect::<Vec<_>>(),
    })
}

fn error_response(id: Value, code: &str, message: String) -> Value {
    json!({
        "type": "response",
        "id": id,
        "ok": false,
        "error": { "code": code, "message": message },
    })
}

/// Handles one input line. Returns `false` when the client asked the sidecar to shut down.
pub fn handle_line(host: &Host, drives: &Arc<Drives>, output: &Output, line: &str) -> bool {
    let request: Value = match serde_json::from_str(line) {
        Ok(request) => request,
        Err(error) => {
            output.send(&error_response(
                Value::Null,
                "invalid_request",
                format!("Request is not valid JSON: {error}"),
            ));
            return true;
        }
    };
    let id = request.get("id").cloned().unwrap_or(Value::Null);
    let Some(command) = request.get("command").and_then(Value::as_str) else {
        output.send(&error_response(
            id,
            "invalid_request",
            "Request needs a string 'command'.".to_owned(),
        ));
        return true;
    };

    if command == "shutdown" {
        output.send(&json!({ "type": "response", "id": id, "ok": true, "result": null }));
        return false;
    }

    let args = request.get("args").cloned().unwrap_or(Value::Null);
    if Drives::handles(command) {
        match drives.dispatch(command, &args) {
            Ok(result) => {
                output.send(&json!({ "type": "response", "id": id, "ok": true, "result": result }))
            }
            Err((code, message)) => output.send(&error_response(id, &code, message)),
        }
        return true;
    }
    match host.dispatch(command, args) {
        Ok(result) => {
            output.send(&json!({ "type": "response", "id": id, "ok": true, "result": result }))
        }
        Err(error) => output.send(&error_response(id, error.code, error.message)),
    }
    true
}

/// Whether a request is one the player waits on while music plays (its volume-levelling gain, its cover, the exclusive output, the song's lyrics), or one a
/// person waits on in the lyrics editor: such requests get their own lane so they are never stuck behind a slow one (a cover read over the network share, a
/// long scan step; the owner's lyrics editor once sat minutes on "Loading", 2026-11-26). Anything else can ask for it with `"urgent": true`.
fn is_urgent(line: &str) -> bool {
    let Ok(request) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    let command = request.get("command").and_then(Value::as_str).unwrap_or("");
    matches!(
        command,
        "loudness_gains" | "track_lyrics" | "lookup_lyrics" | "get_lyrics_review"
    ) || command.starts_with("native_audio_")
        || request
            .get("args")
            .and_then(|a| a.get("urgent"))
            .and_then(Value::as_bool)
            == Some(true)
}

/// Whether a request only reads a picture (an album cover, an artist's photo or a picture offered for a song, often over the network share; the last
/// used to wait behind a long picture run and showed as broken pictures meanwhile, 2026-11-26). Home, the library and the cover wall ask for
/// dozens at once; one after another they took seconds, so they get a small lane of their own, apart from the player's (owner, 2026-11-24: slow Home page).
fn is_picture_read(line: &str) -> bool {
    let Ok(request) = serde_json::from_str::<Value>(line) else {
        return false;
    };
    matches!(
        request.get("command").and_then(Value::as_str),
        Some("track_cover" | "track_artist_photo" | "art_source")
    )
}

/// True when the request is the `shutdown` command itself (a song or tag that merely contains the word is ordinary).
fn is_shutdown(line: &str) -> bool {
    serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|r| {
            r.get("command")
                .and_then(Value::as_str)
                .map(|c| c == "shutdown")
        })
        .unwrap_or(false)
}

/// A request that waits or runs this long in the one-at-a-time queue is written down.
const SLOW_AFTER: std::time::Duration = std::time::Duration::from_secs(10);
const SLOW_LOG_BYTES: u64 = 256 * 1024;

/// Writes down, in `slow-requests.log` among the program's records, a request that held the one-at-a-time queue up or was held up in it: when, the
/// command's name and the seconds, nothing about songs or files. A stall used to leave nothing to find its cause by (2026-11-26).
fn note_slow(
    data_dir: &std::path::Path,
    line: &str,
    waited: std::time::Duration,
    ran: std::time::Duration,
) {
    use std::io::Write;
    if waited < SLOW_AFTER && ran < SLOW_AFTER {
        return;
    }
    let command: String = serde_json::from_str::<Value>(line)
        .ok()
        .and_then(|r| r.get("command").and_then(Value::as_str).map(str::to_owned))
        .unwrap_or_default()
        .chars()
        .filter(|c| c.is_ascii_alphanumeric() || *c == '_')
        .take(64)
        .collect();
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let file = data_dir.join("slow-requests.log");
    if std::fs::metadata(&file).is_ok_and(|m| m.len() > SLOW_LOG_BYTES) {
        let _ = std::fs::remove_file(&file);
    }
    if let Ok(mut out) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(file)
    {
        let _ = writeln!(
            out,
            "{now}\t{command}\tran {}s\twaited {}s",
            ran.as_secs(),
            waited.as_secs()
        );
    }
}

/// Reads requests until EOF or `shutdown`. Urgent requests (see `is_urgent`) are answered by a small pool of their own; every other request is answered
/// one after another, in the order sent, as before. The answers carry the request's id, so their order does not matter to the caller.
pub fn serve(host: &Arc<Host>, drives: &Arc<Drives>, output: &Output, input: impl BufRead) {
    use std::sync::mpsc;
    let (slow_tx, slow_rx) = mpsc::channel::<(std::time::Instant, String)>();
    let (fast_tx, fast_rx) = mpsc::channel::<String>();
    let fast_rx = Arc::new(Mutex::new(fast_rx));
    let (picture_tx, picture_rx) = mpsc::channel::<String>();
    let picture_rx = Arc::new(Mutex::new(picture_rx));
    let mut workers = Vec::new();
    for _ in 0..4 {
        let (host, drives, output, rx) = (
            host.clone(),
            drives.clone(),
            output.clone(),
            picture_rx.clone(),
        );
        workers.push(std::thread::spawn(move || {
            loop {
                let line = match rx.lock() {
                    Ok(rx) => rx.recv(),
                    Err(_) => return,
                };
                let Ok(line) = line else { return };
                handle_line(&host, &drives, &output, &line);
            }
        }));
    }
    {
        let (host, drives, output) = (host.clone(), drives.clone(), output.clone());
        workers.push(std::thread::spawn(move || {
            while let Ok((asked, line)) = slow_rx.recv() {
                let started = std::time::Instant::now();
                handle_line(&host, &drives, &output, &line);
                note_slow(
                    &drives.data_dir,
                    &line,
                    started.duration_since(asked),
                    started.elapsed(),
                );
            }
        }));
    }
    for _ in 0..4 {
        let (host, drives, output, rx) = (
            host.clone(),
            drives.clone(),
            output.clone(),
            fast_rx.clone(),
        );
        workers.push(std::thread::spawn(move || {
            loop {
                let line = match rx.lock() {
                    Ok(rx) => rx.recv(),
                    Err(_) => return,
                };
                let Ok(line) = line else { return };
                handle_line(&host, &drives, &output, &line);
            }
        }));
    }
    for line in input.lines() {
        let Ok(line) = line else { break };
        if line.trim().is_empty() {
            continue;
        }
        if is_shutdown(&line) {
            handle_line(host, drives, output, &line);
            break;
        }
        let sent = if is_urgent(&line) {
            fast_tx.send(line).is_ok()
        } else if is_picture_read(&line) {
            picture_tx.send(line).is_ok()
        } else {
            slow_tx.send((std::time::Instant::now(), line)).is_ok()
        };
        if !sent {
            break;
        }
    }
    // Everything asked is answered before the program ends.
    drop(slow_tx);
    drop(fast_tx);
    drop(picture_tx);
    for worker in workers {
        let _ = worker.join();
    }
}

#[cfg(test)]
mod lane_tests {
    use super::*;

    #[test]
    fn pictures_get_their_own_lane_and_the_player_keeps_its_fast_one() {
        let cover = r#"{"id":1,"command":"track_cover","args":{"path":"M:\\a\\b.mp3"}}"#;
        let player_cover =
            r#"{"id":2,"command":"track_cover","args":{"path":"M:\\a\\b.mp3","urgent":true}}"#;
        let other = r#"{"id":3,"command":"library_snapshot","args":{}}"#;
        assert!(is_picture_read(cover) && !is_urgent(cover));
        assert!(is_urgent(player_cover));
        assert!(!is_picture_read(other) && !is_urgent(other));
        assert!(is_picture_read(
            r#"{"id":4,"command":"track_artist_photo"}"#
        ));
        assert!(is_picture_read(r#"{"id":5,"command":"art_source"}"#));
        for lyrics in ["track_lyrics", "lookup_lyrics", "get_lyrics_review"] {
            assert!(is_urgent(&format!(r#"{{"id":6,"command":"{lyrics}"}}"#)));
        }
        // Saving stays in the one-at-a-time queue: two writers must never meet on a file.
        assert!(!is_urgent(r#"{"id":7,"command":"update_track_media"}"#));
    }

    #[test]
    fn only_slow_requests_are_written_down_and_without_their_songs() {
        let dir = std::env::temp_dir().join(format!("mv-slow-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let log = dir.join("slow-requests.log");
        let _ = std::fs::remove_file(&log);
        let request =
            r#"{"id":1,"command":"update_track_media","args":{"paths":["M:\\Private\\song.mp3"]}}"#;
        let quick = std::time::Duration::from_secs(1);
        note_slow(&dir, request, quick, quick);
        assert!(!log.exists());
        note_slow(&dir, request, quick, std::time::Duration::from_secs(200));
        let written = std::fs::read_to_string(&log).unwrap();
        assert!(written.contains("\tupdate_track_media\tran 200s\twaited 1s"));
        assert!(!written.contains("Private"));
        let _ = std::fs::remove_dir_all(&dir);
    }
}
