//! Shared helpers for the sidecar's end-to-end tests: the client that talks to the real sidecar
//! binary, the fake CD helper, and fake web services.
#![allow(dead_code)]

use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Child, ChildStdin, ChildStdout, Command, Stdio};

/// Cache file names for the fake helper's 12-track disc (The Watchmen, "Brand New Day").
pub const AR_NAME: &str = "dBAR-012-0013232b-00b35ece-860a510c.bin";

pub struct Client {
    pub child: Child,
    pub input: ChildStdin,
    pub output: BufReader<ChildStdout>,
    pub events: Vec<Value>,
}

pub fn fake_helper() -> PathBuf {
    // The test exe sits at target/<profile>/deps/x.exe (older Cargo) or deep under
    // target/<profile>/build/<crate>/<hash>/out/x.exe (Rust 1.100+), so walk up until a folder
    // holds examples/fake_helper.exe instead of assuming a fixed depth.
    let exe = std::env::current_exe().unwrap();
    let found = exe
        .ancestors()
        .skip(1)
        .map(|dir| dir.join("examples").join("fake_helper.exe"))
        .find(|path| path.is_file());
    found.unwrap_or_else(|| {
        panic!(
            "build the example first: no examples/fake_helper.exe above {}",
            exe.display()
        )
    })
}

pub fn temp_dir(name: &str) -> PathBuf {
    let dir = std::env::temp_dir().join(format!("mv-drives-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

impl Client {
    pub fn start(data: &std::path::Path, hang: bool) -> Self {
        Self::start_with(data, hang, false)
    }

    /// `recover`: the fake drive reads track 3 correctly when it is asked again (a retry pass over a damaged track).
    pub fn start_with(data: &std::path::Path, hang: bool, recover: bool) -> Self {
        let mut command = Command::new(env!("CARGO_BIN_EXE_mediaverse_sidecar"));
        command
            .arg("--data-dir")
            .arg(data)
            .env("MEDIAVERSE_CD_HELPER_PATH", fake_helper())
            .env("MEDIAVERSE_LAME_PATH", dev_lame().unwrap_or_default())
            .stdin(Stdio::piped())
            .stdout(Stdio::piped());
        if hang {
            command.env("FAKE_HELPER_HANG", "1");
        }
        if recover {
            command.env("FAKE_HELPER_RECOVER", "1");
        }
        let mut child = command.spawn().expect("sidecar starts");
        let input = child.stdin.take().unwrap();
        let output = BufReader::new(child.stdout.take().unwrap());
        let mut client = Self {
            child,
            input,
            output,
            events: Vec::new(),
        };
        assert_eq!(client.read()["type"], "ready");
        client
    }

    pub fn read(&mut self) -> Value {
        let mut line = String::new();
        self.output.read_line(&mut line).expect("sidecar line");
        serde_json::from_str(&line).expect("sidecar emits JSON")
    }

    /// Sends a request and returns its response, collecting any events seen on the way.
    pub fn request(&mut self, id: u64, command: &str, args: Value) -> Value {
        writeln!(
            self.input,
            "{}",
            json!({ "id": id, "command": command, "args": args })
        )
        .unwrap();
        loop {
            let message = self.read();
            match message["type"].as_str() {
                Some("response") if message["id"] == id => return message,
                Some("event") => self.events.push(message),
                _ => {}
            }
        }
    }

    /// Waits for an event with this name, returning it.
    pub fn wait_for_event(&mut self, name: &str) -> Value {
        if let Some(position) = self.events.iter().position(|e| e["event"] == name) {
            return self.events.remove(position);
        }
        loop {
            let message = self.read();
            if message["type"] == "event" {
                if message["event"] == name {
                    return message;
                }
                self.events.push(message);
            }
        }
    }
}

impl Drop for Client {
    fn drop(&mut self) {
        let _ = self.child.kill();
    }
}

pub fn seed_accuraterip(data: &std::path::Path, answer: &str) {
    let dir = data.join("accuraterip");
    std::fs::create_dir_all(&dir).unwrap();
    match answer {
        "found" => std::fs::write(dir.join(AR_NAME), [1u8, 2, 3]).unwrap(),
        _ => std::fs::write(dir.join(format!("{AR_NAME}.none")), b"").unwrap(),
    }
}

pub fn rip_dir(name: &str) -> PathBuf {
    std::env::temp_dir().join(format!("mv-rips-{name}-{}", std::process::id()))
}

pub fn fake_samples(track: u8) -> Vec<u32> {
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

/// A calibrated fake drive, a cached AccurateRip answer, and a sidecar ready to rip.
pub fn ready_to_rip(name: &str) -> (PathBuf, Client) {
    use mediaverse_ripper::profile::{DriveProfile, Field};
    let data = temp_dir(name);
    seed_accuraterip(&data, "found");
    let mut profile = DriveProfile::new(fake_identity(), "test");
    profile.read_offset = Some(Field::measured(6));
    mediaverse_sidecar::profiles::ProfileStore::new(&data)
        .save(&profile)
        .unwrap();
    let client = Client::start(&data, false);
    (data, client)
}

pub fn fake_identity() -> mediaverse_ripper::profile::DriveIdentity {
    mediaverse_ripper::profile::DriveIdentity {
        vendor: "FAKE".to_owned(),
        model: "Fake Drive".to_owned(),
        revision: "1.0".to_owned(),
        connection: mediaverse_ripper::profile::Connection::Unknown,
    }
}

// ---- metadata lookup: fake MusicBrainz, gnudb (HTTP) and a CDDBP mirror ----

pub mod fakes {
    use std::io::{BufRead, BufReader, Read, Write};
    use std::net::{TcpListener, TcpStream};
    use std::sync::{Arc, Mutex};
    use std::time::Instant;

    #[derive(Clone, Debug)]
    pub struct Seen {
        pub target: String,
        pub user_agent: String,
        pub at: Instant,
    }

    pub struct Reply {
        pub status: u16,
        pub headers: Vec<(&'static str, String)>,
        pub body: Vec<u8>,
    }

    pub fn ok(body: impl Into<Vec<u8>>) -> Reply {
        Reply {
            status: 200,
            headers: Vec::new(),
            body: body.into(),
        }
    }

    /// A tiny HTTP server on a free local port. `answer` decides each reply from the request target.
    pub struct Http {
        pub port: u16,
        pub seen: Arc<Mutex<Vec<Seen>>>,
    }

    impl Http {
        pub fn start(answer: impl Fn(&str) -> Reply + Send + 'static) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let seen = Arc::new(Mutex::new(Vec::new()));
            let log = seen.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    let mut reader = BufReader::new(stream);
                    let mut request_line = String::new();
                    if reader.read_line(&mut request_line).unwrap_or(0) == 0 {
                        continue;
                    }
                    let target = request_line
                        .split_whitespace()
                        .nth(1)
                        .unwrap_or("")
                        .to_owned();
                    let mut user_agent = String::new();
                    loop {
                        let mut line = String::new();
                        if reader.read_line(&mut line).unwrap_or(0) == 0 || line.trim().is_empty() {
                            break;
                        }
                        if let Some(value) = line.to_ascii_lowercase().strip_prefix("user-agent:") {
                            user_agent = value.trim().to_owned();
                            let original = line
                                .split_once(':')
                                .map(|(_, v)| v.trim().to_owned())
                                .unwrap_or_default();
                            user_agent = if original.is_empty() {
                                user_agent
                            } else {
                                original
                            };
                        }
                    }
                    log.lock().unwrap().push(Seen {
                        target: target.clone(),
                        user_agent,
                        at: Instant::now(),
                    });
                    let reply = answer(&target);
                    let mut head = format!(
                        "HTTP/1.1 {} X\r\nContent-Length: {}\r\nConnection: close\r\n",
                        reply.status,
                        reply.body.len()
                    );
                    for (name, value) in &reply.headers {
                        head.push_str(&format!("{name}: {value}\r\n"));
                    }
                    head.push_str("\r\n");
                    let mut stream = reader.into_inner();
                    let _ = stream
                        .write_all(head.as_bytes())
                        .and_then(|()| stream.write_all(&reply.body));
                }
            });
            Self { port, seen }
        }

        pub fn url(&self) -> String {
            format!("http://127.0.0.1:{}", self.port)
        }
    }

    /// A CDDBP (plain TCP) server that answers `cddb query` and `cddb read` with fixed text.
    pub struct Cddbp {
        pub port: u16,
        pub commands: Arc<Mutex<Vec<String>>>,
    }

    impl Cddbp {
        pub fn start(query_reply: String, record_reply: String) -> Self {
            let listener = TcpListener::bind("127.0.0.1:0").unwrap();
            let port = listener.local_addr().unwrap().port();
            let commands = Arc::new(Mutex::new(Vec::new()));
            let log = commands.clone();
            std::thread::spawn(move || {
                for stream in listener.incoming().flatten() {
                    handle(stream, &query_reply, &record_reply, &log);
                }
            });
            Self { port, commands }
        }
    }

    pub fn handle(
        stream: TcpStream,
        query_reply: &str,
        record_reply: &str,
        log: &Arc<Mutex<Vec<String>>>,
    ) {
        let mut writer = stream.try_clone().unwrap();
        let mut reader = BufReader::new(stream);
        let _ = writer.write_all(b"200 fake CDDBP server ready\r\n");
        let mut line = String::new();
        while reader.read_line(&mut line).unwrap_or(0) > 0 {
            let command = line.trim().to_owned();
            line.clear();
            log.lock().unwrap().push(command.clone());
            let reply = if command.starts_with("cddb hello") {
                "200 hello and welcome".to_owned()
            } else if let Some(level) = command.strip_prefix("proto ") {
                format!("201 OK, CDDB protocol level now: {level}")
            } else if command.starts_with("cddb query") {
                query_reply.to_owned()
            } else if command.starts_with("cddb read") {
                record_reply.to_owned()
            } else if command == "quit" {
                let _ = writer.write_all(b"230 goodbye\r\n");
                return;
            } else {
                "500 Unknown command".to_owned()
            };
            let _ = writer.write_all(reply.replace('\n', "\r\n").as_bytes());
            let _ = writer.write_all(b"\r\n");
        }
        let _ = reader.read(&mut []);
    }
}

pub fn watchmen_record(tracks: usize) -> String {
    let mut text = String::from(
        "210 rock 860a510c CD database entry follows (until terminating `.')\nDTITLE=The Watchmen / Brand New Day\nDYEAR=1996\nDGENRE=Rock\n",
    );
    for n in 0..tracks {
        text.push_str(&format!("TTITLE{n}=Song {}\n", n + 1));
    }
    text.push_str(".\n");
    text
}

pub const MB_WATCHMEN: &str =
    include_str!("../../../../crates/disc-metadata/tests/fixtures/musicbrainz-watchmen.json");

pub fn metadata_settings(mb: &str, servers: Vec<Value>) -> Value {
    json!({
        "identity": { "contact": "alex@myhost.example" },
        "musicbrainz": { "enabled": true, "base_url": mb, "min_interval_ms": 50 },
        "cddb_servers": servers,
        "cover_art": { "enabled": false },
    })
}

pub fn http_server_entry(name: &str, port: u16) -> Value {
    json!({ "name": name, "transport": "http", "host": "127.0.0.1", "port": port, "path": "/~cddb/cddb.cgi",
            "client_name": "MyRegisteredApp", "client_version": "9.9", "min_interval_ms": 0 })
}

pub fn lookup(client: &mut Client, id: u64) -> Value {
    client.events.clear();
    client.request(id, "lookup_disc", json!({ "device": "Z:" }));
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], true, "{finished}");
    finished["payload"]["result"].clone()
}

// ---- chosen lookup results become tags ----

pub fn candidate(tracks: usize, extra: Value) -> Value {
    let mut album = json!({
        "source": "musicbrainz", "source_id": "r", "album": "Brand New Day", "album_artist": "The Watchmen",
        "year": 1996, "genre": "Rock", "quality": "exact", "cover_art_release": "rel-1",
        "tracks": (1..=tracks).map(|n| json!({ "number": n, "title": format!("Song {n}"), "artist": null })).collect::<Vec<_>>(),
    });
    for (key, value) in extra.as_object().unwrap() {
        album[key] = value.clone();
    }
    album
}

// ---- cover art ----

pub const RELEASE: &str = "7a5c73ca-9819-49dc-baec-bb99573720c8";

pub fn jpeg(width: u16, height: u16, progressive: bool) -> Vec<u8> {
    let mut out = vec![0xFF, 0xD8, 0xFF, 0xE0, 0x00, 0x10];
    out.extend_from_slice(b"JFIF\0\x01\x01\x00\x00\x01\x00\x01\x00\x00");
    out.extend_from_slice(&[
        0xFF,
        if progressive { 0xC2 } else { 0xC0 },
        0x00,
        0x11,
        0x08,
    ]);
    out.extend_from_slice(&height.to_be_bytes());
    out.extend_from_slice(&width.to_be_bytes());
    out.extend_from_slice(&[
        0x03, 0x01, 0x22, 0x00, 0x02, 0x11, 0x01, 0x03, 0x11, 0x01, 0xFF, 0xD9,
    ]);
    out
}

/// Sets up a calibrated fake drive, an archive, and a cover art server that answers with `answer`.
pub fn with_cover_server(
    name: &str,
    answer: impl Fn(&str) -> fakes::Reply + Send + 'static,
) -> (Client, fakes::Http, PathBuf) {
    let (_data, mut client) = ready_to_rip(name);
    let server = fakes::Http::start(answer);
    let archive = temp_dir(&format!("{name}-archive"));
    client.request(
        1,
        "set_archive_dir",
        json!({ "path": archive.to_string_lossy() }),
    );
    let saved = client.request(
        2,
        "set_metadata_settings",
        json!({ "settings": { "cover_art": { "enabled": true, "base_url": server.url() } } }),
    );
    assert_eq!(saved["ok"], true, "{saved}");
    (client, server, archive)
}

pub fn rip_with_cover(client: &mut Client, id: u64, work: &str) -> Value {
    client.events.clear();
    client.request(id, "rip_disc", json!({
        "device": "Z:", "output_dir": rip_dir(work).to_string_lossy(), "tracks": [2], "mp3": false,
        "candidate": candidate(12, json!({ "cover_art_release": RELEASE })),
    }));
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], true, "{finished}");
    finished["payload"]["result"].clone()
}

pub fn warnings_of(result: &Value) -> Vec<String> {
    result["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_str().unwrap().to_owned())
        .collect()
}

// ---- MP3 copies (real LAME; skipped if it has not been built) ----

/// The LAME built by tools/build-lame-4.0.ps1, if it exists.
pub fn dev_lame() -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../third_party/build/lame-4.0/x64/Release/lame.exe");
    path.is_file().then_some(path)
}

pub fn lame_or_skip() -> bool {
    if dev_lame().is_none() {
        eprintln!("SKIPPED: LAME has not been built (run tools/build-lame-4.0.ps1)");
        return false;
    }
    true
}

/// A calibrated fake drive, an archive folder, and a separate music library folder.
pub fn mp3_setup(name: &str) -> (Client, PathBuf, PathBuf) {
    let (_data, mut client) = ready_to_rip(name);
    let archive = temp_dir(&format!("{name}-archive"));
    let library = temp_dir(&format!("{name}-library"));
    assert_eq!(
        client.request(
            1,
            "set_archive_dir",
            json!({ "path": archive.to_string_lossy() })
        )["ok"],
        true
    );
    assert_eq!(
        client.request(
            2,
            "import_collection",
            json!({ "root": library.to_string_lossy() })
        )["ok"],
        true
    );
    client.request(
        3,
        "set_metadata_settings",
        json!({ "settings": { "cover_art": { "enabled": false } } }),
    );
    (client, archive, library)
}

pub fn rip_all(client: &mut Client, id: u64, work: &str, extra: Value) -> Value {
    client.events.clear();
    let mut args = json!({
        "device": "Z:", "output_dir": rip_dir(work).to_string_lossy(), "tracks": [2, 3],
        "candidate": candidate(12, json!({ "disc_number": 1, "disc_count": 2 })),
    });
    for (key, value) in extra.as_object().unwrap() {
        args[key] = value.clone();
    }
    client.request(id, "rip_disc", args);
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], true, "{finished}");
    finished["payload"]["result"].clone()
}
