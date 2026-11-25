//! The photo reader that looks at the whole photo (owner, 2026-11-21; D165). A small vision model, Qwen3-VL-4B-Instruct (Alibaba Cloud's Qwen team, Apache-2.0 licence),
//! reads a page photo the way a person does, so decorative lettering, white print on black and text printed over pictures are read
//! far better than by the older line-by-line reader. It runs on this computer through llama.cpp's `llama-server` (ggml-org, MIT licence),
//! started on a random port of this computer only for the length of a reading and stopped afterwards.
//!
//! Both are a separate download (about 3 GB), never in the installer, kept in the models folder under `photo-vision`:
//! `model/` holds the model files, which survive program updates untouched; `runtime-<build>/` holds the llama.cpp build the program was
//! made for. When a program update moves to another build only that small runtime is fetched again; the model is fetched again only when
//! its own pinned file changes. Every file is pinned to an exact address, size and SHA-256, a half-finished download is resumed, and a file
//! that does not match is never used.

use crate::drives::{Drives, failure};
use crate::helper::Canceller;
use mediaverse_host::EventSink;
use serde_json::{Value, json};
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// One pinned file.
struct Part {
    name: &'static str,
    url: &'static str,
    size: u64,
    sha256: &'static str,
}

/// The llama.cpp build the program was made for (the Vulkan build for Windows: it runs on NVIDIA, AMD and Intel graphics, and on the
/// processor alone when there is no suitable graphics card). A newer build is adopted by changing this, the address, size and hash.
const RUNTIME_BUILD: &str = "b12613";
const RUNTIME_ZIP: Part = Part {
    name: "llama-server.zip",
    url: "https://github.com/ggml-org/llama.cpp/releases/download/b12613/llama-b12613-bin-win-vulkan-x64.zip",
    size: 38_845_965,
    sha256: "56f1fca056efc933a39226fa767328a0082ebd42ec3c4d2e0193a37ac44abdee",
};
/// Qwen3-VL-4B-Instruct from the Qwen team's own GGUF repository (Apache-2.0), pinned to one revision: the 4-bit model and the 8-bit picture encoder.
const MODEL_PARTS: [Part; 2] = [
    Part {
        name: "Qwen3VL-4B-Instruct-Q4_K_M.gguf",
        url: "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/1cd86afb9a95c410a6038ab3b40d8b578c892266/Qwen3VL-4B-Instruct-Q4_K_M.gguf",
        size: 2_497_281_664,
        sha256: "66358cb18bb6b3b1b6675aa412c7a88ef01d228f481184d13668e5201c730a0a",
    },
    Part {
        name: "mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf",
        url: "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF/resolve/1cd86afb9a95c410a6038ab3b40d8b578c892266/mmproj-Qwen3VL-4B-Instruct-Q8_0.gguf",
        size: 453_974_304,
        sha256: "30ba2c7dd3127a4561b6cba9d13d0f711c91bdb38742e2f56d73c8cb596bd06d",
    },
];

/// The longest side a photo is sent at (the model's own limit on a page is about 6,000 picture tokens at this size).
const READ_SIDE: u32 = 3072;
/// The longest side of the picture kept beside the words in the editor.
const PICTURE_SIDE: u32 = 1800;
/// Most words a page reading may be (a runaway repeat is cut off here and read again with a repeat penalty).
const MAX_TOKENS: u64 = 5000;

pub(crate) fn root(data_dir: &Path) -> PathBuf {
    crate::lyric_ai::load_config(data_dir)
        .models
        .join("photo-vision")
}

fn model_dir(root: &Path) -> PathBuf {
    root.join("model")
}

fn runtime_dir(root: &Path) -> PathBuf {
    root.join(format!("runtime-{RUNTIME_BUILD}"))
}

fn server_exe(root: &Path) -> PathBuf {
    runtime_dir(root).join(if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    })
}

/// Whether this platform has a pinned runtime (Windows only for now).
const SUPPORTED: bool = cfg!(windows);

fn missing_models(root: &Path) -> Vec<&'static Part> {
    MODEL_PARTS
        .iter()
        .filter(|p| {
            std::fs::metadata(model_dir(root).join(p.name)).map_or(true, |m| m.len() != p.size)
        })
        .collect()
}

fn runtime_missing(root: &Path) -> bool {
    !server_exe(root).is_file()
}

/// Whether the reader is complete and ready to read photos.
pub(crate) fn ready(data_dir: &Path) -> bool {
    let root = root(data_dir);
    SUPPORTED && missing_models(&root).is_empty() && !runtime_missing(&root)
}

impl Drives {
    /// The vision reader's part of `lyric_photos_status`: whether it is installed, what a download would fetch (and how much), and
    /// whether this is an update (something was installed by an earlier version and part of it is out of date).
    pub(crate) fn vision_status(&self) -> Value {
        let root = root(&self.data_dir);
        let models = missing_models(&root);
        let runtime = runtime_missing(&root);
        let model_bytes: u64 = models.iter().map(|p| p.size).sum();
        let bytes = model_bytes + if runtime { RUNTIME_ZIP.size } else { 0 };
        // an update: something was installed before (by this or an earlier version) and part of it is missing or out of date now
        let installed_before = models.len() < MODEL_PARTS.len() || any_runtime(&root);
        json!({
            "supported": SUPPORTED,
            "installed": SUPPORTED && models.is_empty() && !runtime,
            "folder": root.display().to_string(),
            "download_mb": (bytes as f64 / 1_000_000.0).ceil() as u64,
            "full_mb": ((MODEL_PARTS.iter().map(|p| p.size).sum::<u64>() + RUNTIME_ZIP.size) as f64 / 1_000_000.0).ceil() as u64,
            "update": installed_before && bytes > 0,
            "model_ready": models.is_empty(),
            "licence": "Apache-2.0",
            "runtime_licence": "MIT",
            "source": "https://huggingface.co/Qwen/Qwen3-VL-4B-Instruct-GGUF",
            "runtime_source": "https://github.com/ggml-org/llama.cpp",
        })
    }

    /// `lyric_photos_download`: a job that fetches whatever of the vision reader is missing or out of date (resuming a half-finished
    /// file), checks each file's size and SHA-256, unpacks the runtime, and removes runtimes of older builds.
    pub(crate) fn vision_download(self: &std::sync::Arc<Self>) -> Result<Value, (String, String)> {
        if !SUPPORTED {
            return Err(failure(
                "unsupported",
                "The photo reader is not available for this system yet.",
            ));
        }
        let root = root(&self.data_dir);
        if missing_models(&root).is_empty() && !runtime_missing(&root) {
            return Err(failure(
                "already_installed",
                "The photo reader is already here and up to date.",
            ));
        }
        Ok(self.start_job(move |this, id| {
            let (canceller, stop) = Canceller::flag();
            if let Ok(mut jobs) = this.jobs.lock() {
                jobs.insert(id.to_owned(), canceller);
            }
            let to_fetch: Vec<(&Part, PathBuf)> = missing_models(&root)
                .into_iter()
                .map(|p| (p, model_dir(&root).join(p.name)))
                .chain(
                    runtime_missing(&root)
                        .then(|| (&RUNTIME_ZIP, root.join(RUNTIME_ZIP.name)))
                        .into_iter(),
                )
                .collect();
            std::fs::create_dir_all(model_dir(&root))
                .map_err(|e| failure("download_failed", format!("Could not make the folder {}: {e}", root.display())))?;
            let total: u64 = to_fetch.iter().map(|(p, _)| p.size).sum();
            let mut done_before = 0u64;
            for (part, target) in &to_fetch {
                let partial = target.with_extension("part");
                let result = fetch(part, &partial, &stop, &mut |got| {
                    this.output.emit("job-progress", json!({ "kind": "lyric_photos_download", "done": done_before + got, "total": total, "file": part.name }));
                });
                if let Err(message) = result {
                    let code = if stop.load(Ordering::SeqCst) { "cancelled" } else { "download_failed" };
                    return Err(failure(code, message));
                }
                std::fs::rename(&partial, target)
                    .map_err(|e| failure("download_failed", format!("Could not save {}: {e}", part.name)))?;
                done_before += part.size;
            }
            if runtime_missing(&root) {
                unpack_runtime(&root).map_err(|m| failure("install_failed", m))?;
            }
            // older builds are no longer needed
            for entry in std::fs::read_dir(&root).into_iter().flatten().flatten() {
                let name = entry.file_name().to_string_lossy().into_owned();
                if name.starts_with("runtime-") && name != format!("runtime-{RUNTIME_BUILD}") {
                    let _ = std::fs::remove_dir_all(entry.path());
                }
            }
            // the licence texts that go with what was fetched
            let _ = std::fs::write(
                runtime_dir(&root).join("LICENSE-llama.cpp.txt"),
                include_str!("../../../third_party/licence-extras/llama.cpp-MIT.txt"),
            );
            let _ = std::fs::write(
                model_dir(&root).join("NOTICE-Qwen3-VL.txt"),
                include_str!("../../../third_party/licence-extras/Qwen3-VL-NOTICE.txt"),
            );
            Ok(json!({ "installed": true, "folder": root.display().to_string() }))
        }))
    }

    /// `lyric_photos_preview {path, turn?}`: a small JPEG of a photo as it will be read (the camera's rotation applied, then turned by the
    /// person's `turn`: 0, 90, 180 or 270 degrees clockwise), as base64, to show beside the rotate buttons.
    pub(crate) fn lyric_photos_preview(&self, args: &Value) -> Result<Value, (String, String)> {
        let path = PathBuf::from(args["path"].as_str().unwrap_or(""));
        let turn = args["turn"].as_u64().unwrap_or(0) as u32;
        if !path.is_file() || turn % 90 != 0 {
            return Err(failure(
                "invalid_arguments",
                "Give a photo that exists and a turn of 0, 90, 180 or 270.",
            ));
        }
        let side = args["max_side"].as_u64().unwrap_or(480).clamp(200, 2400) as u32;
        let bytes = mediaverse_page_reader::prepared_jpeg(&path, turn, side, 82)
            .map_err(|e| failure("read_failed", e))?;
        Ok(json!({ "picture": crate::artist_photos_wiki::base64(&bytes) }))
    }
}

fn any_runtime(root: &Path) -> bool {
    std::fs::read_dir(root)
        .into_iter()
        .flatten()
        .flatten()
        .any(|e| e.file_name().to_string_lossy().starts_with("runtime-"))
}

/// Fetches one pinned file to `partial` (resuming an earlier try), then checks its size and SHA-256.
fn fetch(
    part: &Part,
    partial: &Path,
    stop: &AtomicBool,
    progress: &mut dyn FnMut(u64),
) -> Result<(), String> {
    let tls = native_tls::TlsConnector::new()
        .map_err(|e| format!("Secure connections are not available on this computer: {e}"))?;
    let agent = ureq::AgentBuilder::new()
        .tls_connector(std::sync::Arc::new(tls))
        .redirects(5)
        .timeout_connect(std::time::Duration::from_secs(30))
        .timeout_read(std::time::Duration::from_secs(60))
        .build();
    let mut have = std::fs::metadata(partial).map_or(0, |m| m.len());
    if have > part.size {
        let _ = std::fs::remove_file(partial);
        have = 0;
    }
    if have < part.size {
        let mut request = agent.get(part.url).set("User-Agent", "MediaVerse-Studio");
        if have > 0 {
            request = request.set("Range", &format!("bytes={have}-"));
        }
        let response = request
            .call()
            .map_err(|e| format!("The download did not start: {e}"))?;
        let resumed = have > 0 && response.status() == 206;
        if !resumed {
            have = 0;
        }
        let mut file = std::fs::OpenOptions::new()
            .create(true)
            .write(true)
            .append(resumed)
            .truncate(!resumed)
            .open(partial)
            .map_err(|e| format!("{}: {e}", partial.display()))?;
        let mut body = response.into_reader();
        let mut buffer = vec![0u8; 256 * 1024];
        let mut got = have;
        let mut last = std::time::Instant::now();
        loop {
            if stop.load(Ordering::SeqCst) {
                return Err("Stopped. What was fetched is kept, and the download carries on from there next time.".to_owned());
            }
            let n = body
                .read(&mut buffer)
                .map_err(|e| format!("The download was interrupted: {e}. What was fetched is kept; try again to carry on."))?;
            if n == 0 {
                break;
            }
            file.write_all(&buffer[..n])
                .map_err(|e| format!("{}: {e}", partial.display()))?;
            got += n as u64;
            if last.elapsed() >= std::time::Duration::from_millis(300) {
                progress(got);
                last = std::time::Instant::now();
            }
        }
        file.flush().map_err(|e| e.to_string())?;
        progress(got);
    }
    let size = std::fs::metadata(partial).map_or(0, |m| m.len());
    if size != part.size {
        // keep a short file so the next try resumes; remove a wrong-sized (too long) one
        if size > part.size {
            let _ = std::fs::remove_file(partial);
        }
        return Err(format!(
            "The file is {size} bytes, expected {}: the download is not complete.",
            part.size
        ));
    }
    let hash =
        crate::sha256::file(partial).map_err(|e| format!("Could not check {}: {e}", part.name))?;
    if hash != part.sha256 {
        let _ = std::fs::remove_file(partial);
        return Err(format!(
            "{} does not match the file this program was made for (checksum differs); it was removed. Try again.",
            part.name
        ));
    }
    Ok(())
}

/// Unpacks the runtime zip with the system's own `tar` (Windows 10 and later read zip files with it), into a temporary folder that is renamed
/// when complete.
fn unpack_runtime(root: &Path) -> Result<(), String> {
    let zip = root.join(RUNTIME_ZIP.name);
    let target = runtime_dir(root);
    let temp = root.join(format!("runtime-{RUNTIME_BUILD}.part"));
    let _ = std::fs::remove_dir_all(&temp);
    std::fs::create_dir_all(&temp).map_err(|e| format!("{}: {e}", temp.display()))?;
    let tar = if cfg!(windows) {
        let system = std::env::var_os("SystemRoot").unwrap_or_else(|| "C:\\Windows".into());
        PathBuf::from(system).join("System32").join("tar.exe")
    } else {
        PathBuf::from("tar")
    };
    let mut command = std::process::Command::new(tar);
    command.arg("-xf").arg(&zip).arg("-C").arg(&temp);
    #[cfg(windows)]
    {
        use std::os::windows::process::CommandExt;
        command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
    }
    let output = command
        .output()
        .map_err(|e| format!("Could not unpack the runtime: {e}"))?;
    if !output.status.success() {
        let _ = std::fs::remove_dir_all(&temp);
        return Err(format!(
            "Could not unpack the runtime: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }
    let exe = temp.join(if cfg!(windows) {
        "llama-server.exe"
    } else {
        "llama-server"
    });
    if !exe.is_file() {
        let _ = std::fs::remove_dir_all(&temp);
        return Err("The runtime download did not contain llama-server.".to_owned());
    }
    let _ = std::fs::remove_dir_all(&target);
    std::fs::rename(&temp, &target).map_err(|e| format!("Could not install the runtime: {e}"))?;
    let _ = std::fs::remove_file(zip);
    Ok(())
}

/// A running `llama-server`, stopped when this is dropped.
pub(crate) struct Server {
    child: std::process::Child,
    port: u16,
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

impl Server {
    /// Starts the server (on the graphics card, or on the processor alone with `gpu` false) and waits until the model is loaded. The server
    /// listens on this computer only. Its messages go to `server.log` in the photo reader's folder.
    pub(crate) fn start(data_dir: &Path, gpu: bool, stop: &AtomicBool) -> Result<Server, String> {
        let root = root(data_dir);
        let port = std::net::TcpListener::bind(("127.0.0.1", 0))
            .and_then(|l| l.local_addr())
            .map_err(|e| format!("No free port on this computer: {e}"))?
            .port();
        let log_path = root.join("server.log");
        let log =
            std::fs::File::create(&log_path).map_err(|e| format!("{}: {e}", log_path.display()))?;
        let mut command = std::process::Command::new(server_exe(&root));
        command
            .current_dir(runtime_dir(&root))
            .arg("-m")
            .arg(model_dir(&root).join(MODEL_PARTS[0].name))
            .arg("--mmproj")
            .arg(model_dir(&root).join(MODEL_PARTS[1].name))
            .args(["--host", "127.0.0.1", "--port", &port.to_string()])
            .args(["-ngl", if gpu { "99" } else { "0" }])
            .args([
                "-c",
                "16384",
                "-np",
                "1",
                "--image-max-tokens",
                "6000",
                "--no-webui",
            ])
            .stdin(std::process::Stdio::null())
            .stdout(log.try_clone().map_err(|e| e.to_string())?)
            .stderr(log);
        #[cfg(windows)]
        {
            use std::os::windows::process::CommandExt;
            command.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        let child = command
            .spawn()
            .map_err(|e| format!("Could not start the photo reader: {e}"))?;
        let mut server = Server { child, port };
        let started = std::time::Instant::now();
        loop {
            if stop.load(Ordering::SeqCst) {
                return Err("Stopped.".to_owned());
            }
            if let Ok(Some(status)) = server.child.try_wait() {
                return Err(format!(
                    "The photo reader stopped while starting ({status}). {}",
                    log_tail(&log_path)
                ));
            }
            if server.healthy() {
                return Ok(server);
            }
            if started.elapsed() > std::time::Duration::from_secs(240) {
                return Err(format!(
                    "The photo reader did not start in time. {}",
                    log_tail(&log_path)
                ));
            }
            std::thread::sleep(std::time::Duration::from_millis(400));
        }
    }

    fn healthy(&self) -> bool {
        ureq::get(&format!("http://127.0.0.1:{}/health", self.port))
            .timeout(std::time::Duration::from_secs(2))
            .call()
            .ok()
            .and_then(|r| r.into_string().ok())
            .is_some_and(|body| body.contains("ok"))
    }

    /// Where a song's page is in the photo: the box (left, top, right, bottom as fractions of the photo) around the lyrics of the song
    /// called `title`, or `None` when the reader gives no usable box. The photo is the same JPEG that was read.
    pub(crate) fn locate(&self, jpeg: &[u8], title: &str) -> Option<[f32; 4]> {
        let picture = format!(
            "data:image/jpeg;base64,{}",
            crate::artist_photos_wiki::base64(jpeg)
        );
        let ask = format!(
            "Locate the whole printed lyrics block of the song \"{title}\" (its title and all of its lyric lines) in the image. Output only JSON: [{{\"bbox_2d\":[x1,y1,x2,y2]}}] with coordinates relative to the image on a 0 to 1000 scale."
        );
        let body = json!({
            "messages": [{ "role": "user", "content": [
                { "type": "image_url", "image_url": { "url": picture } },
                { "type": "text", "text": ask },
            ] }],
            "temperature": 0, "max_tokens": 120,
        });
        let answer = ureq::post(&format!(
            "http://127.0.0.1:{}/v1/chat/completions",
            self.port
        ))
        .timeout(std::time::Duration::from_secs(120))
        .set("Content-Type", "application/json")
        .send_string(&body.to_string())
        .ok()?
        .into_string()
        .ok()?;
        let reply: Value = serde_json::from_str(&answer).ok()?;
        parse_box(reply["choices"][0]["message"]["content"].as_str()?)
    }

    /// The words on one page photo (already a JPEG, turned upright). A vision model can get stuck repeating a chorus for ever when it reads with
    /// no randomness at all. The answer is watched as it arrives and a reading that is going round in circles (`is_stuck`) is stopped at once
    /// and begun again with a little randomness, which gets out of the rut most of the time and reads as well; up to eight tries. A repeat
    /// penalty would also end the rut but drops real repeated lines, so it is only the last resort.
    pub(crate) fn read(&self, jpeg: &[u8], stop: &AtomicBool) -> Result<String, String> {
        self.read_with(jpeg, stop, READ_PROMPT)
    }

    /// `read` with another question (the second reading of one song's page asks for its stanzas).
    pub(crate) fn read_with(
        &self,
        jpeg: &[u8],
        stop: &AtomicBool,
        prompt: &str,
    ) -> Result<String, String> {
        let picture = format!(
            "data:image/jpeg;base64,{}",
            crate::artist_photos_wiki::base64(jpeg)
        );
        let sampled = json!({ "temperature": 0.5, "top_k": 40, "top_p": 0.95 });
        let mut tries = vec![json!({ "temperature": 0 })];
        tries.extend(std::iter::repeat_n(sampled, 6));
        tries.push(json!({ "temperature": 0, "repeat_penalty": 1.05 }));
        let mut last = String::new();
        for settings in &tries {
            if stop.load(Ordering::SeqCst) {
                return Err("Stopped.".to_owned());
            }
            let mut body = json!({
                "messages": [{ "role": "user", "content": [
                    { "type": "image_url", "image_url": { "url": picture } },
                    { "type": "text", "text": prompt },
                ] }],
                "max_tokens": MAX_TOKENS,
                "stream": true,
            });
            for (key, value) in settings.as_object().into_iter().flatten() {
                body[key] = value.clone();
            }
            let response = ureq::post(&format!(
                "http://127.0.0.1:{}/v1/chat/completions",
                self.port
            ))
            .timeout(std::time::Duration::from_secs(600))
            .set("Content-Type", "application/json")
            .send_string(&body.to_string())
            .map_err(|e| format!("The photo reader did not answer: {e}"))?;
            let mut text = String::new();
            let mut finished = false;
            let mut stuck = false;
            for line in std::io::BufRead::lines(std::io::BufReader::new(response.into_reader())) {
                if stop.load(Ordering::SeqCst) {
                    return Err("Stopped.".to_owned());
                }
                let line = line.map_err(|e| format!("The photo reader stopped answering: {e}"))?;
                let Some(data) = line.strip_prefix("data: ") else {
                    continue;
                };
                if data.trim() == "[DONE]" {
                    break;
                }
                let Ok(chunk) = serde_json::from_str::<Value>(data) else {
                    continue;
                };
                let piece = chunk["choices"][0]["delta"]["content"]
                    .as_str()
                    .unwrap_or("");
                text.push_str(piece);
                match chunk["choices"][0]["finish_reason"].as_str() {
                    Some("length") => break,
                    Some(_) => finished = true,
                    None => {}
                }
                if piece.contains('\n') && is_stuck(&text) {
                    stuck = true;
                    break;
                }
            }
            last = text;
            if finished && !stuck {
                return Ok(last);
            }
        }
        // still stuck after every try: keep what was read before it went round in circles
        Ok(trim_stuck(&last))
    }
}

/// The four numbers of the first `[x1, y1, x2, y2]` in the reader's answer (0 to 1000), as fractions; `None` unless they make a box of a
/// reasonable size inside the photo.
fn parse_box(answer: &str) -> Option<[f32; 4]> {
    let start = answer.find("bbox_2d")?;
    let rest = &answer[start..];
    let open = rest.find('[')?;
    let close = rest[open..].find(']')? + open;
    let numbers: Vec<f32> = rest[open + 1..close]
        .split(',')
        .filter_map(|n| n.trim().parse::<f32>().ok())
        .collect();
    if numbers.len() != 4 {
        return None;
    }
    let [x1, y1, x2, y2] =
        [numbers[0], numbers[1], numbers[2], numbers[3]].map(|v| (v / 1000.0).clamp(0.0, 1.0));
    ((x2 - x1) >= 0.04 && (y2 - y1) >= 0.04).then_some([x1, y1, x2, y2])
}

/// What the vision model is asked for on one song's cut-out page: the words, with an empty line between stanzas where the page has a gap.
pub(crate) const STANZA_PROMPT: &str = "Transcribe the song lyrics on this page exactly as printed. The title first, then the lyrics in stanzas: put one empty line between stanzas wherever the page has a vertical gap. Keep every line and every repeated chorus. Output only the transcription.";

/// What the vision model is asked for on each photo.
const READ_PROMPT: &str = "Transcribe all the song lyrics on this page exactly as printed, one song after another. Put each song title on its own line before its lyrics. Keep every line and every repeated chorus; do not shorten or summarise. Output only the transcription.";

/// Whether a reading is going round in circles: its last few lines (one to four of them) repeated six times running. A real song repeats a
/// chorus a few times at most.
fn is_stuck(text: &str) -> bool {
    repeats_at_the_end(text) >= 6
}

/// How many times the block of 1 to 4 lines at the end of `text` is repeated one after the other (1: not repeated).
fn repeats_at_the_end(text: &str) -> usize {
    let lines: Vec<String> = text
        .lines()
        .map(|l| l.trim().to_lowercase())
        .filter(|l| !l.is_empty())
        .collect();
    let mut best = 1;
    for size in 1..=4usize {
        if lines.len() < size * 2 {
            continue;
        }
        let block = &lines[lines.len() - size..];
        let mut reps = 1;
        let mut end = lines.len() - size;
        while end >= size && &lines[end - size..end] == block {
            reps += 1;
            end -= size;
        }
        best = best.max(reps);
    }
    best
}

/// A reading that went round in circles, cut back to where the repeating began (one copy of the repeated block is kept).
fn trim_stuck(text: &str) -> String {
    let lines: Vec<&str> = text.lines().collect();
    let reps = repeats_at_the_end(text);
    if reps < 3 {
        // cut off at the last complete line
        return text
            .rfind('\n')
            .map_or(text.to_owned(), |cut| text[..cut].to_owned());
    }
    let nonblank: Vec<usize> = (0..lines.len())
        .filter(|&i| !lines[i].trim().is_empty())
        .collect();
    for size in 1..=4usize {
        let n = nonblank.len();
        if n < size * reps {
            continue;
        }
        let block: Vec<String> = nonblank[n - size..]
            .iter()
            .map(|&i| lines[i].trim().to_lowercase())
            .collect();
        let mut count = 1;
        let mut end = n - size;
        while end >= size
            && nonblank[end - size..end]
                .iter()
                .map(|&i| lines[i].trim().to_lowercase())
                .collect::<Vec<_>>()
                == block
        {
            count += 1;
            end -= size;
        }
        if count == reps {
            // keep everything up to and including the first copy of the block
            let keep_until = nonblank[end + size - 1];
            return lines[..=keep_until].join("\n");
        }
    }
    text.to_owned()
}

fn log_tail(path: &Path) -> String {
    let text = std::fs::read_to_string(path).unwrap_or_default();
    let lines: Vec<&str> = text.lines().filter(|l| !l.trim().is_empty()).collect();
    let tail = &lines[lines.len().saturating_sub(3)..];
    format!("Last message: {}", tail.join(" / "))
}

/// The prepared photo (camera rotation, then the person's turn, at the size it is read at).
pub(crate) fn photo_for_reading(photo: &Path, turn: u32) -> Result<Vec<u8>, String> {
    mediaverse_page_reader::prepared_jpeg(photo, turn, READ_SIDE, 92)
}

/// The picture of one song's page, cut out of the turned photo with `part` (fractions), as base64 (empty when it cannot be made).
pub(crate) fn page_picture(photo: &Path, turn: u32, part: [f32; 4]) -> Vec<u8> {
    mediaverse_page_reader::part_jpeg(photo, turn, part, 0.012, PICTURE_SIDE, 85)
        .unwrap_or_default()
}

/// The picture kept beside the words in the editor, as base64.
pub(crate) fn picture_for_editor(photo: &Path, turn: u32) -> String {
    mediaverse_page_reader::prepared_jpeg(photo, turn, PICTURE_SIDE, 82)
        .map(|b| crate::artist_photos_wiki::base64(&b))
        .unwrap_or_default()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_chorus_sung_a_few_times_is_not_stuck_but_endless_repeats_are() {
        let verse = "Let it burn out\nIf we go out\n";
        let mut song = String::from("Intro line\n");
        for _ in 0..4 {
            song.push_str(verse);
        }
        assert!(!is_stuck(&song));
        for _ in 0..3 {
            song.push_str(verse);
        }
        assert!(is_stuck(&song));
        assert!(is_stuck(&"la la la\n".repeat(7)));
        assert!(!is_stuck("one\ntwo\nthree\n"));
    }

    #[test]
    fn a_stuck_reading_is_cut_back_to_one_copy_of_the_repeated_block() {
        let mut text = String::from("Title\nFirst line\nSecond line\n");
        for _ in 0..9 {
            text.push_str("Let it burn out\nIf we go out\n");
        }
        assert_eq!(
            trim_stuck(&text),
            "Title\nFirst line\nSecond line\nLet it burn out\nIf we go out"
        );
    }

    #[test]
    fn the_readers_box_is_read_and_checked() {
        let box_ = parse_box("```json\n[\n\t{\"bbox_2d\": [288, 340, 472, 867]}\n]\n```").unwrap();
        assert_eq!(box_, [0.288, 0.34, 0.472, 0.867]);
        assert!(parse_box("[{\"bbox_2d\": [10, 10, 12, 900]}]").is_none());
        assert!(parse_box("no box here").is_none());
        assert!(parse_box("[{\"bbox_2d\": [1, 2, 3]}]").is_none());
    }
}
