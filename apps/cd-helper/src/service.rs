//! The helper's JSON-lines protocol loop. A reader thread owns stdin so a `cancel` request can
//! interrupt a calibration that is running on the main thread.

use crate::native::{LibcdioDrive, list_devices};
use mediaverse_accuraterip::parse_response;
use mediaverse_ripper::calibrate::{CalibrationError, CalibrationInput, Control, Step, calibrate};
use mediaverse_ripper::profile::DriveProfile;
use mediaverse_ripper::rip::{position_of, read_track, report_for};
use mediaverse_ripper::wav::write_wav;
use mediaverse_ripper::{DriveError, OpticalDrive};
use serde_json::{Value, json};
use std::io::{BufRead, BufWriter, Write};
use std::path::PathBuf;
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::mpsc;
use std::sync::{Arc, Mutex};

const PROTOCOL_VERSION: u32 = 1;
const COMMANDS: [&str; 6] = [
    "list_drives",
    "read_toc",
    "calibrate",
    "rip_disc",
    "cancel",
    "shutdown",
];

#[derive(Clone)]
struct Output(Arc<Mutex<std::io::Stdout>>);

impl Output {
    fn send(&self, message: &Value) {
        if let Ok(mut out) = self.0.lock() {
            let _ = writeln!(out, "{message}").and_then(|()| out.flush());
        }
    }

    fn respond(&self, id: &Value, result: Result<Value, (String, String)>) {
        let message = match result {
            Ok(result) => json!({ "type": "response", "id": id, "ok": true, "result": result }),
            Err((code, message)) => json!({
                "type": "response", "id": id, "ok": false,
                "error": { "code": code, "message": message },
            }),
        };
        self.send(&message);
    }
}

fn error(code: &str, message: impl ToString) -> (String, String) {
    (code.to_owned(), message.to_string())
}

fn drive_error(error: DriveError) -> (String, String) {
    let code = match error {
        DriveError::NoDisc => "no_disc",
        DriveError::TransferTooLarge { .. } => "transfer_too_large",
        DriveError::ReadFailed(_) => "read_failed",
        DriveError::Unsupported(_) => "unsupported",
        DriveError::Cancelled => "cancelled",
    };
    (code.to_owned(), error.to_string())
}

/// A friendly code and message for a failed write: a full disk gets its own code.
fn write_error(path: &std::path::Path, problem: &std::io::Error) -> (String, String) {
    if problem.kind() == std::io::ErrorKind::StorageFull {
        return error(
            "disk_full",
            format!(
                "The disk ran out of space while saving {}. Free some space, or choose another folder, and rip again.",
                path.display()
            ),
        );
    }
    error(
        "output_unavailable",
        format!("Could not write {}: {problem}", path.display()),
    )
}

/// Explains a rip that stopped part-way. A disc that disappears (ejected, tray opened) or stops
/// answering is reported as such, and the tracks already saved are said to be kept.
fn interrupted(
    (code, message): (String, String),
    saved: &[String],
    out_dir: &std::path::Path,
) -> (String, String) {
    let (code, message) = match code.as_str() {
        "read_failed" | "no_disc" => (
            "disc_lost".to_owned(),
            format!(
                "The disc could not be read any more. It may have been ejected or the drive may have stopped responding. ({message})"
            ),
        ),
        _ => (code, message),
    };
    if saved.is_empty() || code == "cancelled" {
        return (code, message);
    }
    (
        code,
        format!(
            "{message} The {} track(s) already ripped were kept in {}.",
            saved.len(),
            out_dir.display()
        ),
    )
}

fn string_arg(args: &Value, name: &str) -> Result<String, (String, String)> {
    args.get(name)
        .and_then(Value::as_str)
        .map(str::to_owned)
        .ok_or_else(|| error("invalid_arguments", format!("'{name}' must be a string")))
}

fn decode_hex(text: &str) -> Result<Vec<u8>, (String, String)> {
    if text.len() % 2 != 0 {
        return Err(error(
            "invalid_arguments",
            "'pressings_hex' has an odd length",
        ));
    }
    (0..text.len())
        .step_by(2)
        .map(|i| {
            u8::from_str_radix(&text[i..i + 2], 16)
                .map_err(|_| error("invalid_arguments", "'pressings_hex' is not hexadecimal"))
        })
        .collect()
}

fn list_drives() -> Result<Value, (String, String)> {
    let drives: Vec<Value> = list_devices()
        .into_iter()
        .map(|device| match LibcdioDrive::open(&device) {
            Ok(drive) => {
                let id = drive.identity();
                json!({ "device": device, "vendor": id.vendor, "model": id.model, "revision": id.revision })
            }
            Err(problem) => json!({ "device": device, "error": problem.to_string() }),
        })
        .collect();
    Ok(Value::Array(drives))
}

fn read_toc(args: &Value) -> Result<Value, (String, String)> {
    let mut drive = LibcdioDrive::open(&string_arg(args, "device")?).map_err(drive_error)?;
    let toc = drive.read_toc().map_err(drive_error)?;
    let mut reply = serde_json::to_value(toc).map_err(|e| error("serialization_failed", e))?;
    // What the disc itself says (CD-Text), when it says anything: a new release no database knows yet may still carry it.
    if let (Some(text), Some(object)) = (drive.read_cdtext(), reply.as_object_mut()) {
        object.insert(
            "cdtext".to_owned(),
            json!({
                "album": text.album,
                "artist": text.artist,
                "tracks": text.tracks.iter().map(|(title, artist)| json!({ "title": title, "artist": artist })).collect::<Vec<_>>(),
            }),
        );
    }
    Ok(reply)
}

fn pressings_from(args: &Value) -> Result<Vec<mediaverse_accuraterip::Pressing>, (String, String)> {
    match args.get("pressings_hex").and_then(Value::as_str) {
        Some(hex) => parse_response(&decode_hex(hex)?).map_err(|e| {
            error(
                "invalid_arguments",
                format!("bad AccurateRip data: {}", e.0),
            )
        }),
        None => Ok(Vec::new()),
    }
}

fn run_rip(
    args: &Value,
    cancel: &Arc<AtomicBool>,
    output: &Output,
) -> Result<Value, (String, String)> {
    let device = string_arg(args, "device")?;
    let out_dir = PathBuf::from(string_arg(args, "output_dir")?);
    let offset = args
        .get("offset")
        .and_then(Value::as_i64)
        .and_then(|value| i32::try_from(value).ok())
        .ok_or_else(|| {
            error(
                "invalid_arguments",
                "'offset' must be an integer number of samples",
            )
        })?;
    let max_transfer = args
        .get("max_transfer")
        .and_then(Value::as_u64)
        .unwrap_or(27)
        .clamp(1, 128) as u32;
    let secure = args.get("secure").and_then(Value::as_bool).unwrap_or(true);
    let wanted: Option<Vec<u8>> = args.get("tracks").and_then(Value::as_array).map(|numbers| {
        numbers
            .iter()
            .filter_map(|n| n.as_u64().map(|n| n as u8))
            .collect()
    });
    let pressings = pressings_from(args)?;

    let mut drive = LibcdioDrive::open(&device).map_err(drive_error)?;
    drive.cancel = Some(cancel.clone());
    drive.cache_sectors = args
        .get("cache_sectors")
        .and_then(Value::as_u64)
        .map(|n| n as u32);
    // A retry pass over a damaged track asks the reader to try harder (more re-reads before it gives up on a block).
    drive.retries = args
        .get("retries")
        .and_then(Value::as_u64)
        .map(|n| n as u32);
    let toc = drive.read_toc().map_err(drive_error)?;
    let tracks: Vec<_> = toc
        .tracks
        .iter()
        .filter(|track| {
            track.audio
                && wanted
                    .as_ref()
                    .is_none_or(|numbers| numbers.contains(&track.number))
        })
        .cloned()
        .collect();
    if tracks.is_empty() {
        return Err(error("no_tracks", "There are no audio tracks to rip."));
    }
    std::fs::create_dir_all(&out_dir).map_err(|e| {
        error(
            "output_unavailable",
            format!("Could not create the output folder: {e}"),
        )
    })?;

    let (mut reports, mut files) = (Vec::new(), Vec::new());
    for (index, track) in tracks.iter().enumerate() {
        let mut progress = |done: u32, total: u32| {
            output.send(&json!({
                "type": "event", "event": "rip-progress",
                "payload": { "track": track.number, "tracks_done": index, "tracks_total": tracks.len(),
                             "done": done, "total": total },
            }));
            !cancel.load(Ordering::Relaxed)
        };
        let audio = read_track(
            &mut drive,
            &toc,
            track,
            offset,
            max_transfer,
            secure,
            &mut progress,
        )
        .map_err(|problem| interrupted(drive_error(problem), &files, &out_dir))?;

        let path = out_dir.join(format!("{:02}.wav", track.number));
        let written = std::fs::File::create(&path)
            .and_then(|file| write_wav(BufWriter::new(file), &audio.samples));
        if let Err(problem) = written {
            let _ = std::fs::remove_file(&path);
            return Err(interrupted(write_error(&path, &problem), &files, &out_dir));
        }
        reports.push(report_for(
            track,
            &audio,
            position_of(&toc, track),
            &pressings,
        ));
        files.push(path.to_string_lossy().into_owned());
    }

    let identity = drive.identity();
    let log = json!({
        "tool": "mediaverse_cd_helper",
        "version": env!("CARGO_PKG_VERSION"),
        "drive": identity,
        "offset_samples": offset,
        "secure": secure,
        "accuraterip_pressings": pressings.len(),
        "tracks": reports,
        "summary": reports.iter().map(|r| r.summary()).collect::<Vec<_>>(),
        "files": files,
    });
    let log_path = out_dir.join("rip-log.json");
    std::fs::write(
        &log_path,
        serde_json::to_vec_pretty(&log).unwrap_or_default(),
    )
    .map_err(|e| {
        error(
            "output_unavailable",
            format!("Could not write the rip log: {e}"),
        )
    })?;
    Ok(log)
}

fn run_calibration(
    args: &Value,
    cancel: &AtomicBool,
    output: &Output,
) -> Result<Value, (String, String)> {
    let mut drive = LibcdioDrive::open(&string_arg(args, "device")?).map_err(drive_error)?;
    let pressings = pressings_from(args)?;
    let existing = match args.get("existing") {
        Some(value) if !value.is_null() => Some(
            serde_json::from_value::<DriveProfile>(value.clone())
                .map_err(|e| error("invalid_arguments", format!("bad existing profile: {e}")))?,
        ),
        _ => None,
    };
    let input = CalibrationInput {
        pressings: &pressings,
        disc: string_arg(args, "disc")?,
        date: string_arg(args, "date")?,
        app_version: env!("CARGO_PKG_VERSION").to_owned(),
        existing,
    };

    let progress_output = output.clone();
    let mut progress = move |step: Step, done: u32, total: u32| {
        progress_output.send(&json!({
            "type": "event", "event": "calibration-progress",
            "payload": { "step": step, "done": done, "total": total },
        }));
    };
    let mut control = Control {
        cancel,
        progress: &mut progress,
    };
    match calibrate(&mut drive, &input, &mut control) {
        Ok(report) => serde_json::to_value(report).map_err(|e| error("serialization_failed", e)),
        Err(CalibrationError::Cancelled) => Err(error("cancelled", "Calibration was cancelled.")),
        Err(CalibrationError::Drive(problem)) => Err(drive_error(problem)),
    }
}

pub fn run() {
    crate::native::route_logs_to_stderr();
    let output = Output(Arc::new(Mutex::new(std::io::stdout())));
    output.send(&json!({
        "type": "ready", "protocol": PROTOCOL_VERSION,
        "helper": env!("CARGO_PKG_VERSION"), "commands": COMMANDS,
    }));

    let cancel = Arc::new(AtomicBool::new(false));
    let (sender, requests) = mpsc::channel::<Value>();
    {
        let (cancel, output) = (cancel.clone(), output.clone());
        std::thread::spawn(move || {
            for line in std::io::stdin().lock().lines().map_while(Result::ok) {
                if line.trim().is_empty() {
                    continue;
                }
                match serde_json::from_str::<Value>(&line) {
                    Ok(request)
                        if request.get("command").and_then(Value::as_str) == Some("cancel") =>
                    {
                        cancel.store(true, Ordering::Relaxed);
                        output.respond(request.get("id").unwrap_or(&Value::Null), Ok(Value::Null));
                    }
                    Ok(request) => {
                        if sender.send(request).is_err() {
                            break;
                        }
                    }
                    Err(problem) => output.respond(
                        &Value::Null,
                        Err(error(
                            "invalid_request",
                            format!("Request is not valid JSON: {problem}"),
                        )),
                    ),
                }
            }
            // stdin closed: ask any running job to stop, then let the main loop end.
            cancel.store(true, Ordering::Relaxed);
        });
    }

    while let Ok(request) = requests.recv() {
        let id = request.get("id").cloned().unwrap_or(Value::Null);
        let args = request.get("args").cloned().unwrap_or(Value::Null);
        let result = match request.get("command").and_then(Value::as_str) {
            Some("list_drives") => list_drives(),
            Some("read_toc") => read_toc(&args),
            Some("calibrate") => {
                cancel.store(false, Ordering::Relaxed);
                run_calibration(&args, &cancel, &output)
            }
            Some("rip_disc") => {
                cancel.store(false, Ordering::Relaxed);
                run_rip(&args, &cancel, &output)
            }
            Some("shutdown") => {
                output.respond(&id, Ok(Value::Null));
                return;
            }
            Some(other) => Err(error(
                "unknown_command",
                format!("Unknown command: {other}"),
            )),
            None => Err(error(
                "invalid_request",
                "Request needs a string 'command'.",
            )),
        };
        output.respond(&id, result);
    }
}

#[cfg(test)]
mod interruption_tests {
    use super::*;

    #[test]
    fn a_lost_disc_or_full_disk_is_explained_and_finished_tracks_are_kept() {
        let dir = std::path::Path::new("C:\\rips");
        let saved = vec!["C:\\rips\\01.wav".to_owned(), "C:\\rips\\02.wav".to_owned()];
        let (code, message) =
            interrupted(error("read_failed", "sector 99 unreadable"), &saved, dir);
        assert_eq!(code, "disc_lost");
        assert!(
            message.contains("ejected") && message.contains("2 track(s) already ripped were kept"),
            "{message}"
        );
        let (code, _) = interrupted(error("no_disc", "no disc"), &[], dir);
        assert_eq!(code, "disc_lost");
        assert_eq!(
            interrupted(error("cancelled", "stopped"), &saved, dir).1,
            "stopped"
        );

        let full = std::io::Error::from(std::io::ErrorKind::StorageFull);
        let (code, message) = write_error(std::path::Path::new("C:\\rips\\03.wav"), &full);
        assert_eq!(code, "disk_full");
        assert!(message.contains("ran out of space") && message.contains("03.wav"));
        assert_eq!(
            write_error(
                std::path::Path::new("x"),
                &std::io::Error::from(std::io::ErrorKind::PermissionDenied)
            )
            .0,
            "output_unavailable"
        );
    }
}
