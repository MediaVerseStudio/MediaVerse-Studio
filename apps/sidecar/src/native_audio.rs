//! Exclusive-mode (WASAPI) playback for the PC program, switched on in Settings > Sound (D186). One playback thread owns
//! the sound card: the page asks it to open a song, queue the next one, pause, seek or set the volume, and reads its
//! status a few times a second. Nothing is mixed, resampled, levelled or equalized on the way: with the volume at full the
//! bits in the file are the bits the card receives (see `native_pcm.rs`). Whatever cannot be played this way (a card that
//! refuses the song's rate or depth, another program holding the card, a song that is not a local FLAC, MP3 or WAV file)
//! is reported as an error, and the page plays it the ordinary way instead, so a song never fails to play because of it.

use serde_json::Value;
use std::path::PathBuf;

#[cfg(windows)]
mod engine {
    use crate::native_pcm::{self, Format, Renderer, Track, candidate_formats};
    use crate::native_wasapi::{self, Stream};
    use serde_json::{Value, json};
    use std::path::PathBuf;
    use std::sync::{Arc, Mutex, OnceLock, mpsc};
    use std::time::{Duration, Instant};

    /// How long the card is kept (and so unavailable to other programs) after the song is paused.
    const KEEP_WHILE_PAUSED: Duration = Duration::from_secs(20);

    #[derive(Clone, Copy, PartialEq, Eq, Debug)]
    enum State {
        Idle,
        Playing,
        /// Faded out, waiting for the last of the sound to leave the card; seen from outside as paused.
        Pausing(u32),
        Paused,
        /// The last song has been written; waiting for its last moments to play.
        Ending(u32),
        Ended,
        Failed,
    }

    impl State {
        fn name(self) -> &'static str {
            match self {
                State::Idle => "idle",
                State::Playing => "playing",
                State::Pausing(_) | State::Paused => "paused",
                State::Ending(_) => "playing",
                State::Ended => "ended",
                State::Failed => "error",
            }
        }
    }

    #[derive(Clone)]
    struct Shared {
        state: State,
        token: u64,
        position_frames: u64,
        rate: u32,
        duration_ms: Option<u64>,
        source_bits: u16,
        format: Option<Format>,
        device: Option<String>,
        volume: f64,
        muted: bool,
        error: Option<String>,
        updated: Instant,
    }

    pub enum Cmd {
        Open {
            path: PathBuf,
            token: u64,
            start_ms: u64,
            play: bool,
            device: Option<String>,
            reply: mpsc::Sender<Result<Value, String>>,
        },
        Next {
            path: Option<PathBuf>,
            token: u64,
            reply: mpsc::Sender<Result<Value, String>>,
        },
        Play,
        Pause,
        Stop,
        Seek(u64),
        Volume {
            volume: f64,
            muted: bool,
        },
    }

    struct Handle {
        commands: Mutex<mpsc::Sender<Cmd>>,
        shared: Arc<Mutex<Shared>>,
    }

    static HANDLE: OnceLock<Handle> = OnceLock::new();

    fn handle() -> &'static Handle {
        HANDLE.get_or_init(|| {
            let (tx, rx) = mpsc::channel();
            let shared = Arc::new(Mutex::new(Shared {
                state: State::Idle,
                token: 0,
                position_frames: 0,
                rate: 44_100,
                duration_ms: None,
                source_bits: 16,
                format: None,
                device: None,
                volume: 1.0,
                muted: false,
                error: None,
                updated: Instant::now(),
            }));
            let thread_shared = Arc::clone(&shared);
            std::thread::Builder::new()
                .name("native-audio".to_owned())
                .spawn(move || Playback::new(rx, thread_shared).run())
                .ok();
            Handle {
                commands: Mutex::new(tx),
                shared,
            }
        })
    }

    pub fn send(command: Cmd) -> Result<(), String> {
        handle()
            .commands
            .lock()
            .map_err(|_| "The sound output stopped working.".to_owned())?
            .send(command)
            .map_err(|_| "The sound output stopped working.".to_owned())
    }

    pub fn ask(
        make: impl FnOnce(mpsc::Sender<Result<Value, String>>) -> Cmd,
    ) -> Result<Value, String> {
        let (reply, answer) = mpsc::channel();
        send(make(reply))?;
        answer
            .recv_timeout(Duration::from_secs(10))
            .map_err(|_| "The sound card took too long to answer.".to_owned())?
    }

    pub fn status() -> Value {
        let Ok(shared) = handle().shared.lock() else {
            return json!({ "state": "error", "error": "The sound output stopped working." });
        };
        let shared = shared.clone();
        let rate = u64::from(shared.rate.max(1));
        let mut value = json!({
            "state": shared.state.name(),
            "token": shared.token,
            "position_ms": shared.position_frames * 1000 / rate,
            "age_ms": shared.updated.elapsed().as_millis() as u64,
            "duration_ms": shared.duration_ms,
            "error": shared.error,
        });
        if let Some(format) = shared.format {
            value["rate"] = json!(format.rate);
            value["bits"] = json!(shared.source_bits);
            value["container_bits"] = json!(format.container_bits);
            value["valid_bits"] = json!(format.valid_bits);
            value["channels"] = json!(format.channels);
            value["device"] = json!(shared.device);
            value["bit_perfect"] = json!(is_bit_perfect(
                shared.source_bits,
                &format,
                shared.volume,
                shared.muted
            ));
        }
        value
    }

    /// Whether what reaches the card is the file's own sound: the card's slots hold every bit, and nothing scales the volume.
    pub fn is_bit_perfect(source_bits: u16, format: &Format, volume: f64, muted: bool) -> bool {
        native_pcm::depth_class(u32::from(source_bits)) <= format.valid_bits
            && volume >= 1.0
            && !muted
    }

    struct Playback {
        commands: mpsc::Receiver<Cmd>,
        shared: Arc<Mutex<Shared>>,
        stream: Option<Stream>,
        renderer: Option<Renderer>,
        state: State,
        /// The song the person has chosen, whether or not the card is open for it right now.
        loaded: Option<(u64, Arc<Track>)>,
        queued_next: Option<(u64, Arc<Track>)>,
        paused_at_frame: u64,
        paused_since: Option<Instant>,
        requested_device: Option<String>,
        volume: f64,
        muted: bool,
    }

    impl Playback {
        fn new(commands: mpsc::Receiver<Cmd>, shared: Arc<Mutex<Shared>>) -> Self {
            Self {
                commands,
                shared,
                stream: None,
                renderer: None,
                state: State::Idle,
                loaded: None,
                queued_next: None,
                paused_at_frame: 0,
                paused_since: None,
                requested_device: None,
                volume: 1.0,
                muted: false,
            }
        }

        fn run(mut self) {
            native_wasapi::init_thread();
            native_wasapi::boost_thread();
            loop {
                let busy = matches!(
                    self.state,
                    State::Playing | State::Pausing(_) | State::Ending(_)
                );
                let command = if busy {
                    self.commands.try_recv().ok()
                } else {
                    match self.commands.recv_timeout(Duration::from_millis(100)) {
                        Ok(command) => Some(command),
                        Err(mpsc::RecvTimeoutError::Timeout) => None,
                        Err(mpsc::RecvTimeoutError::Disconnected) => return,
                    }
                };
                if let Some(command) = command {
                    self.handle(command);
                    continue;
                }
                if busy {
                    let ready = self.stream.as_ref().is_some_and(|s| s.wait(10));
                    if ready {
                        self.fill();
                    }
                } else {
                    self.release_if_idle_too_long();
                }
            }
        }

        fn effective_volume(&self) -> f64 {
            if self.muted { 0.0 } else { self.volume }
        }

        fn publish(&self) {
            let Ok(mut shared) = self.shared.lock() else {
                return;
            };
            shared.state = self.state;
            shared.volume = self.volume;
            shared.muted = self.muted;
            shared.format = self.stream.as_ref().map(|s| s.format);
            shared.device = self.stream.as_ref().map(|s| s.device_name.clone());
            if let Some((token, track)) = &self.loaded {
                shared.token = *token;
                shared.rate = track.rate;
                shared.source_bits = track.bits;
                shared.duration_ms = track.duration_ms();
            }
            shared.position_frames = match self.state {
                State::Playing | State::Ending(_) => self.position_frames(),
                State::Pausing(_) | State::Paused | State::Failed => self.paused_at_frame,
                State::Idle | State::Ended => 0,
            };
            shared.updated = Instant::now();
        }

        /// Where the sound reaching the ears has got to: what has been written, less the buffer still waiting in the card.
        fn position_frames(&self) -> u64 {
            let written = self.renderer.as_ref().map_or(0, Renderer::cursor);
            let queued = self
                .stream
                .as_ref()
                .map_or(0, |s| u64::from(s.buffer_frames));
            written.saturating_sub(queued)
        }

        fn fail(&mut self, message: String) {
            if let Some(stream) = self.stream.as_mut() {
                stream.stop();
            }
            self.stream = None;
            self.renderer = None;
            self.state = State::Failed;
            if let Ok(mut shared) = self.shared.lock() {
                shared.error = Some(message);
            }
            self.publish();
        }

        fn clear_error(&self) {
            if let Ok(mut shared) = self.shared.lock() {
                shared.error = None;
            }
        }

        fn handle(&mut self, command: Cmd) {
            match command {
                Cmd::Open {
                    path,
                    token,
                    start_ms,
                    play,
                    device,
                    reply,
                } => {
                    let _ = reply.send(self.open(&path, token, start_ms, play, device));
                }
                Cmd::Next { path, token, reply } => {
                    let _ = reply.send(self.queue_next(path, token));
                }
                Cmd::Play => self.resume(),
                Cmd::Pause => self.pause(),
                Cmd::Stop => self.stop(),
                Cmd::Seek(ms) => self.seek(ms),
                Cmd::Volume { volume, muted } => {
                    self.volume = volume.clamp(0.0, 1.0);
                    self.muted = muted;
                    if self.state == State::Playing {
                        let volume = self.effective_volume();
                        if let Some(renderer) = self.renderer.as_mut() {
                            renderer.set_target(volume, false);
                        }
                    }
                    self.publish();
                }
            }
        }

        fn open(
            &mut self,
            path: &std::path::Path,
            token: u64,
            start_ms: u64,
            play: bool,
            device: Option<String>,
        ) -> Result<Value, String> {
            let track = native_pcm::open(path)?;
            self.clear_error();
            self.queued_next = None;
            if let Some(renderer) = self.renderer.as_mut() {
                renderer.set_next(None);
            }
            if device != self.requested_device {
                // another card was chosen: the old one is let go
                self.stream = None;
                self.renderer = None;
            }
            self.requested_device = device;
            let start_frame = start_ms * u64::from(track.rate) / 1000;
            self.loaded = Some((token, Arc::clone(&track)));
            self.paused_at_frame = start_frame;
            if !play {
                // nothing is opened until the song is played, so a paused song restored at start-up does not take the card
                if let Some(stream) = self.stream.as_mut() {
                    stream.stop();
                }
                self.state = State::Paused;
                self.paused_since = Some(Instant::now());
                self.publish();
                return Ok(
                    json!({ "rate": track.rate, "bits": track.bits, "channels": track.channels, "duration_ms": track.duration_ms(), "deferred": true }),
                );
            }
            self.begin(start_frame)?;
            Ok(self.info())
        }

        fn info(&self) -> Value {
            let status = status();
            json!({
                "rate": status["rate"],
                "bits": status["bits"],
                "container_bits": status["container_bits"],
                "valid_bits": status["valid_bits"],
                "channels": status["channels"],
                "device": status["device"],
                "bit_perfect": status["bit_perfect"],
                "duration_ms": status["duration_ms"],
            })
        }

        /// Opens the card for the loaded song (or keeps the open one if it suits) and starts playing from `start_frame`.
        fn begin(&mut self, start_frame: u64) -> Result<(), String> {
            let Some((token, track)) = self.loaded.clone() else {
                return Err("No song is loaded.".to_owned());
            };
            // a song starts once its first half second is decoded (or all of it, if it is shorter)
            let wanted = u64::from(track.rate / 2);
            let deadline = Instant::now() + Duration::from_secs(5);
            while track.ready_frames() < wanted && !track.is_done() && Instant::now() < deadline {
                std::thread::sleep(Duration::from_millis(5));
            }
            if track.ready_frames() == 0 {
                return Err(track
                    .error()
                    .unwrap_or_else(|| "The song holds no sound.".to_owned()));
            }
            let candidates = candidate_formats(track.rate, track.channels, track.bits);
            if let Some(stream) = self.stream.as_mut() {
                stream.stop();
            }
            let reusable = self
                .stream
                .as_ref()
                .is_some_and(|s| candidates.contains(&s.format));
            if !reusable {
                self.stream = None;
                self.renderer = None;
                self.stream = Some(Stream::open_exclusive(
                    self.requested_device.as_deref(),
                    &candidates,
                )?);
            }
            let volume = self.effective_volume();
            let stream = self.stream.as_mut().expect("the card was just opened");
            let mut renderer = Renderer::new(stream.format);
            renderer.set_current(
                token,
                Arc::clone(&track),
                start_frame.min(track.total_frames().max(1) - 1),
            );
            renderer.set_target(volume, false);
            renderer.set_next(self.queued_next.clone());
            // the card's buffer is filled before it starts
            let mut report = native_pcm::Report::default();
            stream
                .write(|bytes, frames| report = renderer.render(bytes, frames))
                .map_err(|e| format!("The sound card could not be filled: {e}"))?;
            stream.start()?;
            self.renderer = Some(renderer);
            self.paused_since = None;
            self.state = State::Playing;
            self.after_render(report);
            self.publish();
            Ok(())
        }

        fn resume(&mut self) {
            match self.state {
                State::Pausing(_) => {
                    // the fade-out had not finished: the sound simply comes back up
                    self.state = State::Playing;
                    let volume = self.effective_volume();
                    if let Some(renderer) = self.renderer.as_mut() {
                        renderer.set_target(volume, false);
                    }
                    self.publish();
                }
                State::Paused | State::Ended | State::Failed if self.loaded.is_some() => {
                    let frame = if self.state == State::Ended {
                        0
                    } else {
                        self.paused_at_frame
                    };
                    if let Err(message) = self.begin(frame) {
                        self.fail(message);
                    }
                }
                _ => {}
            }
        }

        fn pause(&mut self) {
            if !matches!(self.state, State::Playing | State::Ending(_)) {
                return;
            }
            self.paused_at_frame = self.position_frames();
            if let Some(renderer) = self.renderer.as_mut() {
                renderer.set_target(0.0, false);
            }
            // a few buffers of fade and silence run before the card is stopped, so the sound does not click off
            self.state = State::Pausing(4);
            self.publish();
        }

        fn stop(&mut self) {
            self.stream = None;
            self.renderer = None;
            self.loaded = None;
            self.queued_next = None;
            self.state = State::Idle;
            self.paused_since = None;
            self.clear_error();
            self.publish();
        }

        fn seek(&mut self, ms: u64) {
            let Some((_, track)) = self.loaded.clone() else {
                return;
            };
            let mut frame = ms * u64::from(track.rate) / 1000;
            let total = track.total_frames();
            if total > 0 {
                frame = frame.min(total - 1);
            }
            match self.state {
                State::Playing | State::Ending(_) => {
                    if let Some(renderer) = self.renderer.as_mut() {
                        renderer.seek(frame);
                    }
                    self.state = State::Playing;
                }
                _ => self.paused_at_frame = frame,
            }
            self.publish();
        }

        fn queue_next(&mut self, path: Option<PathBuf>, token: u64) -> Result<Value, String> {
            let Some(path) = path else {
                self.queued_next = None;
                if let Some(renderer) = self.renderer.as_mut() {
                    renderer.set_next(None);
                }
                return Ok(json!({ "queued": false }));
            };
            let track = native_pcm::open(&path)?;
            self.queued_next = Some((token, Arc::clone(&track)));
            if matches!(self.state, State::Playing | State::Ending(_)) {
                if let Some(renderer) = self.renderer.as_mut() {
                    renderer.set_next(Some((token, Arc::clone(&track))));
                }
            }
            let joins = self.stream.as_ref().is_some_and(|s| track.joins(&s.format));
            Ok(json!({ "queued": true, "gapless": joins }))
        }

        /// One buffer's worth: asks the renderer for the next stretch of sound.
        fn fill(&mut self) {
            let (Some(stream), Some(renderer)) = (self.stream.as_mut(), self.renderer.as_mut())
            else {
                return;
            };
            let mut report = native_pcm::Report::default();
            if let Err(message) =
                stream.write(|bytes, frames| report = renderer.render(bytes, frames))
            {
                self.fail(format!("The sound card stopped answering: {message}"));
                return;
            }
            self.after_render(report);
            match self.state {
                State::Pausing(left) => {
                    if left <= 1 {
                        if let Some(stream) = self.stream.as_mut() {
                            stream.stop();
                        }
                        self.state = State::Paused;
                        self.paused_since = Some(Instant::now());
                    } else {
                        self.state = State::Pausing(left - 1);
                    }
                }
                State::Ending(left) => {
                    if left <= 1 {
                        self.finish_song();
                    } else {
                        self.state = State::Ending(left - 1);
                    }
                }
                _ => {}
            }
            self.publish();
        }

        fn after_render(&mut self, report: native_pcm::Report) {
            if let Some(token) = report.advanced_to {
                // the next song took over inside the buffer, exactly on its first sample
                if let Some((queued, track)) = self.queued_next.take() {
                    if queued == token {
                        self.loaded = Some((token, track));
                    }
                }
                if let Some(track) = self.renderer.as_ref().and_then(Renderer::current_track) {
                    self.loaded = Some((token, track));
                }
            }
            if report.finished && self.state == State::Playing {
                self.state = State::Ending(3);
            }
        }

        /// The last song has played out. A following song that could not share the open card starts now on a fresh one.
        fn finish_song(&mut self) {
            let next = self
                .renderer
                .as_mut()
                .and_then(Renderer::take_next)
                .or_else(|| self.queued_next.take());
            if let Some((token, track)) = next {
                self.queued_next = None;
                self.loaded = Some((token, track));
                if let Err(message) = self.begin(0) {
                    self.fail(message);
                }
                return;
            }
            if let Some(stream) = self.stream.as_mut() {
                stream.stop();
            }
            self.state = State::Ended;
            self.paused_since = Some(Instant::now());
            self.publish();
        }

        fn release_if_idle_too_long(&mut self) {
            if self.stream.is_some()
                && matches!(self.state, State::Paused | State::Ended)
                && self
                    .paused_since
                    .is_some_and(|t| t.elapsed() > KEEP_WHILE_PAUSED)
            {
                // other programs may use the card again; playing resumes by opening it afresh
                self.stream = None;
                self.renderer = None;
                self.publish();
            }
        }
    }

    pub use native_wasapi::list_devices;
}

#[cfg(windows)]
pub fn devices() -> Result<Value, String> {
    let list = engine::list_devices()?;
    Ok(serde_json::json!({
        "available": true,
        "devices": list.iter().map(|d| serde_json::json!({ "id": d.id, "name": d.name, "default": d.is_default })).collect::<Vec<_>>(),
    }))
}

#[cfg(windows)]
pub fn open(
    path: PathBuf,
    token: u64,
    start_ms: u64,
    play: bool,
    device: Option<String>,
) -> Result<Value, String> {
    engine::ask(|reply| engine::Cmd::Open {
        path,
        token,
        start_ms,
        play,
        device,
        reply,
    })
}

#[cfg(windows)]
pub fn queue_next(path: Option<PathBuf>, token: u64) -> Result<Value, String> {
    engine::ask(|reply| engine::Cmd::Next { path, token, reply })
}

#[cfg(windows)]
pub fn control(
    action: &str,
    ms: Option<u64>,
    volume: Option<f64>,
    muted: Option<bool>,
) -> Result<Value, String> {
    let command = match action {
        "play" => engine::Cmd::Play,
        "pause" => engine::Cmd::Pause,
        "stop" => engine::Cmd::Stop,
        "seek" => engine::Cmd::Seek(ms.ok_or("A place to go to is needed.")?),
        "volume" => engine::Cmd::Volume {
            volume: volume.unwrap_or(1.0),
            muted: muted.unwrap_or(false),
        },
        _ => return Err("Unknown sound output action.".to_owned()),
    };
    engine::send(command)?;
    Ok(Value::Null)
}

#[cfg(windows)]
pub fn status() -> Value {
    engine::status()
}

#[cfg(not(windows))]
const ONLY_WINDOWS: &str = "Exclusive sound output is only available in the Windows program.";

#[cfg(not(windows))]
pub fn devices() -> Result<Value, String> {
    Ok(serde_json::json!({ "available": false, "devices": [] }))
}

#[cfg(not(windows))]
pub fn open(
    _path: PathBuf,
    _token: u64,
    _start_ms: u64,
    _play: bool,
    _device: Option<String>,
) -> Result<Value, String> {
    Err(ONLY_WINDOWS.to_owned())
}

#[cfg(not(windows))]
pub fn queue_next(_path: Option<PathBuf>, _token: u64) -> Result<Value, String> {
    Err(ONLY_WINDOWS.to_owned())
}

#[cfg(not(windows))]
pub fn control(
    _action: &str,
    _ms: Option<u64>,
    _volume: Option<f64>,
    _muted: Option<bool>,
) -> Result<Value, String> {
    Err(ONLY_WINDOWS.to_owned())
}

#[cfg(not(windows))]
pub fn status() -> Value {
    serde_json::json!({ "state": "idle" })
}

#[cfg(all(test, windows))]
mod device_tests {
    use super::*;
    use std::time::Duration;

    fn wait(ms: u64) {
        std::thread::sleep(Duration::from_millis(ms));
    }

    fn wait_for(what: &str, mut ok: impl FnMut(&Value) -> bool) -> Value {
        for _ in 0..200 {
            let now = status();
            if ok(&now) {
                return now;
            }
            wait(25);
        }
        panic!("timed out waiting for {what}: {}", status());
    }

    /// A quiet WAV: 24-bit stereo at 96 kHz, `seconds` long, holding a very low tone.
    fn write_hires(path: &std::path::Path, seconds: u32) {
        let rate = 96_000u32;
        let frames = rate * seconds;
        let mut data = Vec::new();
        for i in 0..frames {
            let v = ((i as f64 * 440.0 * std::f64::consts::TAU / f64::from(rate)).sin() * 4000.0)
                as i32;
            for _ in 0..2 {
                data.extend_from_slice(&v.to_le_bytes()[0..3]);
            }
        }
        let mut file = Vec::new();
        file.extend_from_slice(b"RIFF");
        file.extend_from_slice(&((36 + data.len()) as u32).to_le_bytes());
        file.extend_from_slice(b"WAVEfmt ");
        file.extend_from_slice(&16u32.to_le_bytes());
        file.extend_from_slice(&1u16.to_le_bytes());
        file.extend_from_slice(&2u16.to_le_bytes());
        file.extend_from_slice(&rate.to_le_bytes());
        file.extend_from_slice(&(rate * 6).to_le_bytes());
        file.extend_from_slice(&6u16.to_le_bytes());
        file.extend_from_slice(&24u16.to_le_bytes());
        file.extend_from_slice(b"data");
        file.extend_from_slice(&(data.len() as u32).to_le_bytes());
        file.extend_from_slice(&data);
        std::fs::write(path, file).unwrap();
    }

    /// Opens the real sound card exclusively but plays at volume 0 (nothing is heard). Run on purpose:
    /// `MV_SMOKE_MP3=<an mp3 file> cargo test -p mediaverse_sidecar --lib device_tests -- --ignored --nocapture`
    #[test]
    #[ignore = "opens the real sound card"]
    fn plays_silently_through_the_real_card() {
        let devices = devices().unwrap();
        println!("devices: {devices}");
        control("volume", None, Some(0.0), Some(false)).unwrap();
        let dir = std::env::temp_dir().join(format!("mv-device-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();

        // a hi-res file, then a second one of the same kind, joined without a gap
        let a = dir.join("a.wav");
        let b = dir.join("b.wav");
        write_hires(&a, 3);
        write_hires(&b, 2);
        let info =
            open(a.clone(), 1, 0, true, None).expect("exclusive open of a 24-bit 96 kHz file");
        println!("opened hi-res: {info}");
        assert_eq!(info["rate"], 96_000);
        let queued = queue_next(Some(b.clone()), 2).unwrap();
        println!("queued: {queued}");
        assert_eq!(queued["gapless"], true);
        let playing = wait_for("playback to move", |s| {
            s["state"] == "playing" && s["position_ms"].as_u64().unwrap_or(0) > 500
        });
        println!("playing: {playing}");
        control("seek", Some(2500), None, None).unwrap();
        let second = wait_for("the second song to take over", |s| s["token"] == 2);
        println!("took over: {second}");
        control("pause", None, None, None).unwrap();
        let paused = wait_for("pause", |s| s["state"] == "paused");
        let held = paused["position_ms"].as_u64().unwrap();
        wait(400);
        assert_eq!(
            status()["position_ms"].as_u64().unwrap(),
            held,
            "a paused song stays where it is"
        );
        control("play", None, None, None).unwrap();
        wait_for("resume", |s| s["state"] == "playing");
        wait_for("the end", |s| s["state"] == "ended");
        control("stop", None, None, None).unwrap();

        if let Ok(mp3) = std::env::var("MV_SMOKE_MP3") {
            let info = open(PathBuf::from(&mp3), 3, 20_000, true, None)
                .expect("exclusive open of the mp3");
            println!("opened mp3: {info}");
            wait_for("mp3 playback", |s| {
                s["state"] == "playing" && s["position_ms"].as_u64().unwrap_or(0) > 20_500
            });
            println!("mp3 status: {}", status());
            control("stop", None, None, None).unwrap();
        }
        let _ = std::fs::remove_dir_all(&dir);
    }
}
