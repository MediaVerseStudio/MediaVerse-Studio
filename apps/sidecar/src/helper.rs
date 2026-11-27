//! Client for the native CD helper process (ADR 0004): starts it, checks its handshake, and
//! exchanges line-delimited JSON requests. One helper process per job, so a native crash or hang
//! cannot reach the library or the UI.

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

/// After a cancel request the helper is given this long to stop by itself (it checks between sectors); a helper still running then is stuck in one call to
/// the drive that cannot be interrupted (a damaged spot, a disc taken out mid-read) and is ended, so Cancel never waits for the drive forever (D157).
const CANCEL_GRACE: Duration = Duration::from_secs(15);

/// What a person is told when the helper had to be ended to cancel.
const STOPPED_BY_FORCE: &str = "Stopped. The drive was busy with a read it could not break off (a damaged or dirty spot, or the disc was taken out), so the CD helper was ended. Tracks already ripped are kept.";

const SUPPORTED_PROTOCOL: u64 = 1;
pub type HelperError = (String, String);

fn failure(code: &str, message: impl ToString) -> HelperError {
    (code.to_owned(), message.to_string())
}

/// Finds the helper executable: an explicit override, the development GNU build output, then next to
/// the sidecar (an installed copy). In a development tree the GNU build must come first: a plain
/// `cargo build` of the workspace also leaves a placeholder helper next to the sidecar, which only
/// prints that it needs the GNU build and exits.
pub fn resolve_path() -> Result<PathBuf, HelperError> {
    let mut candidates = Vec::new();
    if let Some(explicit) = std::env::var_os("MEDIAVERSE_CD_HELPER_PATH") {
        candidates.push(PathBuf::from(explicit));
    }
    if let Ok(exe) = std::env::current_exe()
        && let Some(dir) = exe.parent()
    {
        // target/<profile>/mediaverse_sidecar.exe -> target/x86_64-pc-windows-gnu/<profile>/...
        if let (Some(target), Some(profile)) = (dir.parent(), dir.file_name()) {
            candidates.push(
                target
                    .join("x86_64-pc-windows-gnu")
                    .join(profile)
                    .join("mediaverse_cd_helper.exe"),
            );
            candidates.push(
                target
                    .join("x86_64-pc-windows-gnu")
                    .join("release")
                    .join("mediaverse_cd_helper.exe"),
            );
        }
        candidates.push(dir.join("mediaverse_cd_helper.exe"));
    }
    candidates
        .into_iter()
        .find(|path| path.is_file())
        .ok_or_else(|| failure("helper_unavailable", NOT_FOUND))
}

#[cfg(windows)]
const NOT_FOUND: &str = "The CD helper was not found. Build it with tools\\build-cd-helper.ps1 or set MEDIAVERSE_CD_HELPER_PATH.";
#[cfg(not(windows))]
const NOT_FOUND: &str = "Reading CDs is not available on this system yet.";

pub struct Helper {
    child: Arc<Mutex<Child>>,
    stdin: Arc<Mutex<ChildStdin>>,
    stdout: BufReader<ChildStdout>,
    next_id: u64,
    /// Set when the person asked to cancel; a helper that then goes silent is ended and the job reports "cancelled".
    cancelled: Arc<AtomicBool>,
}

impl Helper {
    pub fn start() -> Result<Self, HelperError> {
        let path = resolve_path()?;
        let mut command = Command::new(&path);
        command
            .stdin(Stdio::piped())
            .stdout(Stdio::piped())
            .stderr(Stdio::inherit());
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let mut child = command.spawn().map_err(|e| {
            failure(
                "helper_unavailable",
                format!("Could not start the CD helper: {e}"),
            )
        })?;
        let stdin = child
            .stdin
            .take()
            .ok_or_else(|| failure("helper_unavailable", "no helper stdin"))?;
        let stdout = child
            .stdout
            .take()
            .ok_or_else(|| failure("helper_unavailable", "no helper stdout"))?;
        let mut helper = Self {
            child: Arc::new(Mutex::new(child)),
            stdin: Arc::new(Mutex::new(stdin)),
            stdout: BufReader::new(stdout),
            next_id: 1,
            cancelled: Arc::new(AtomicBool::new(false)),
        };

        let ready = helper.read_message()?;
        if ready["type"] != "ready" || ready["protocol"].as_u64() != Some(SUPPORTED_PROTOCOL) {
            return Err(failure(
                "helper_unavailable",
                format!("Unexpected helper handshake: {ready}"),
            ));
        }
        Ok(helper)
    }

    /// A handle that can ask the running helper to stop, usable from another thread.
    pub fn canceller(&self) -> Canceller {
        Canceller::Helper(HelperHandle {
            stdin: self.stdin.clone(),
            child: self.child.clone(),
            cancelled: self.cancelled.clone(),
            grace: CANCEL_GRACE,
        })
    }

    fn read_message(&mut self) -> Result<Value, HelperError> {
        let mut line = String::new();
        let bytes = self.stdout.read_line(&mut line).map_err(|e| {
            failure(
                "helper_failed",
                format!("Lost contact with the CD helper: {e}"),
            )
        })?;
        if bytes == 0 {
            return Err(failure("helper_failed", "It closed without answering."));
        }
        serde_json::from_str(&line)
            .map_err(|e| failure("helper_failed", format!("Bad helper output: {e}")))
    }

    /// Sends one request and waits for its response, passing helper events to `on_event`.
    pub fn request(
        &mut self,
        command: &str,
        args: Value,
        on_event: &mut dyn FnMut(&str, &Value),
    ) -> Result<Value, HelperError> {
        let id = self.next_id;
        self.next_id += 1;
        let line = json!({ "id": id, "command": command, "args": args }).to_string();
        {
            let mut stdin = self
                .stdin
                .lock()
                .map_err(|_| failure("helper_failed", "helper input unavailable"))?;
            writeln!(stdin, "{line}")
                .and_then(|()| stdin.flush())
                .map_err(|e| {
                    failure(
                        "helper_failed",
                        format!("Could not send to the CD helper: {e}"),
                    )
                })?;
        }

        loop {
            let message = match self.read_message() {
                Ok(message) => message,
                // The person asked to cancel and the helper was ended because the drive would not let go of it: that is a cancel, not a failure.
                Err(_) if self.cancelled.load(Ordering::SeqCst) => {
                    return Err(failure("cancelled", STOPPED_BY_FORCE));
                }
                Err(problem) => return Err(problem),
            };
            match message["type"].as_str() {
                Some("event") => {
                    on_event(message["event"].as_str().unwrap_or(""), &message["payload"])
                }
                Some("response") if message["id"] == id => {
                    return if message["ok"] == true {
                        Ok(message["result"].clone())
                    } else {
                        Err((
                            message["error"]["code"]
                                .as_str()
                                .unwrap_or("helper_error")
                                .to_owned(),
                            message["error"]["message"]
                                .as_str()
                                .unwrap_or("The CD helper reported an error.")
                                .to_owned(),
                        ))
                    };
                }
                _ => {} // a response to something else (such as a cancel acknowledgement)
            }
        }
    }
}

impl Drop for Helper {
    fn drop(&mut self) {
        if let Ok(mut stdin) = self.stdin.lock() {
            let _ = writeln!(stdin, "{}", json!({ "id": 0, "command": "shutdown" }));
            let _ = stdin.flush();
        }
        // Give it a moment to exit cleanly, then make sure it is gone.
        for _ in 0..20 {
            if matches!(self.child.lock().map(|mut c| c.try_wait()), Ok(Ok(Some(_)))) {
                return;
            }
            std::thread::sleep(std::time::Duration::from_millis(50));
        }
        if let Ok(mut child) = self.child.lock() {
            let _ = child.kill();
            let _ = child.wait();
        }
    }
}

/// What `Canceller` needs to stop a helper: ask it to stop, then end the process if it does not.
#[derive(Clone)]
pub struct HelperHandle {
    stdin: Arc<Mutex<ChildStdin>>,
    child: Arc<Mutex<Child>>,
    cancelled: Arc<AtomicBool>,
    grace: Duration,
}

impl HelperHandle {
    fn cancel(&self) {
        self.cancelled.store(true, Ordering::SeqCst);
        if let Ok(mut stdin) = self.stdin.lock() {
            let _ = writeln!(stdin, "{}", json!({ "id": 0, "command": "cancel" }));
            let _ = stdin.flush();
        }
        let (child, grace) = (self.child.clone(), self.grace);
        std::thread::spawn(move || {
            let step = Duration::from_millis(50);
            let mut waited = Duration::ZERO;
            while waited < grace {
                std::thread::sleep(step);
                waited += step;
                // The helper stopped by itself (or the job ended and the process was removed): nothing more to do.
                if matches!(child.lock().map(|mut c| c.try_wait()), Ok(Ok(Some(_)))) {
                    return;
                }
            }
            if let Ok(mut child) = child.lock() {
                let _ = child.kill();
            }
        });
    }
}

/// How `cancel_job` stops a job: by asking the CD helper process to stop, or, for work done inside the
/// sidecar itself (such as a defect scan), by raising a flag the work checks between steps.
#[derive(Clone)]
pub enum Canceller {
    Helper(HelperHandle),
    Flag(Arc<std::sync::atomic::AtomicBool>),
}

impl Canceller {
    /// A flag-based canceller and the flag the work should watch.
    pub fn flag() -> (Self, Arc<std::sync::atomic::AtomicBool>) {
        let flag = Arc::new(std::sync::atomic::AtomicBool::new(false));
        (Canceller::Flag(flag.clone()), flag)
    }

    pub fn cancel(&self) {
        match self {
            Canceller::Helper(handle) => handle.cancel(),
            Canceller::Flag(flag) => flag.store(true, std::sync::atomic::Ordering::SeqCst),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A stand-in for a helper stuck in a drive call: a process that ignores everything it is told and keeps running.
    fn stuck_handle(grace: Duration) -> HelperHandle {
        let (program, args): (&str, &[&str]) = if cfg!(windows) {
            ("ping", &["-n", "60", "127.0.0.1"])
        } else {
            ("sleep", &["60"])
        };
        let mut child = Command::new(program)
            .args(args)
            .stdin(Stdio::piped())
            .stdout(Stdio::null())
            .spawn()
            .expect("start a stand-in process");
        let stdin = child.stdin.take().unwrap();
        HelperHandle {
            stdin: Arc::new(Mutex::new(stdin)),
            child: Arc::new(Mutex::new(child)),
            cancelled: Arc::new(AtomicBool::new(false)),
            grace,
        }
    }

    fn ended(handle: &HelperHandle) -> bool {
        handle.child.lock().unwrap().try_wait().unwrap().is_some()
    }

    #[test]
    fn a_helper_that_does_not_stop_after_cancel_is_ended() {
        let handle = stuck_handle(Duration::from_millis(300));
        assert!(!ended(&handle), "running");
        let started = std::time::Instant::now();
        Canceller::Helper(handle.clone()).cancel();
        assert!(handle.cancelled.load(Ordering::SeqCst));
        while !ended(&handle) {
            assert!(
                started.elapsed() < Duration::from_secs(10),
                "the stuck helper was not ended"
            );
            std::thread::sleep(Duration::from_millis(50));
        }
        assert!(
            started.elapsed() >= Duration::from_millis(250),
            "it is given its grace first"
        );
    }

    #[test]
    fn a_helper_that_stops_by_itself_is_not_troubled_again() {
        let handle = stuck_handle(Duration::from_secs(30));
        handle.cancel();
        // it stops by itself (here: ended by this test) well within the grace
        handle.child.lock().unwrap().kill().unwrap();
        std::thread::sleep(Duration::from_millis(300));
        assert!(ended(&handle));
    }
}
