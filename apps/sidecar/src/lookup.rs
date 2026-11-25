//! Disc metadata lookup (ADR 0006): asks every enabled source what the disc in a drive is, then
//! merges the answers.
//!
//! Commands: `get_metadata_settings`, `set_metadata_settings {settings}`, `lookup_disc {device}`
//! (a job). Sources: MusicBrainz, and any number of CDDB-compatible servers (gnudb by default,
//! over HTTP or CDDBP), each with user-editable server, port and identity. A source that fails
//! never hides the others; its failure is reported by name.

use crate::drives::{Drives, failure};
use crate::helper::{Helper, HelperError};
use mediaverse_disc_metadata::cddb::{self, Hello, QueryReply};
use mediaverse_disc_metadata::merge::{automatic_choice, consolidate};
use mediaverse_disc_metadata::settings::{CddbServer, MetadataSettings, Transport};
use mediaverse_disc_metadata::{AlbumInfo, DiscToc, SourceError, TrackInfo, discid, musicbrainz};
use mediaverse_host::EventSink;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Read, Write};
use std::net::{TcpStream, ToSocketAddrs};
use std::path::{Path, PathBuf};
use std::sync::{Mutex, OnceLock};
use std::time::Duration;

const APP_NAME: &str = "MediaVerseStudio";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
/// Most records fetched from one CDDB server per lookup, so a vague match cannot cause a flood.
const MAX_RECORDS_PER_SERVER: usize = 5;
const MAX_REPLY_BYTES: u64 = 1 << 20;

pub(crate) type SourceResult<T> = Result<T, (String, String)>;

pub(crate) fn fail<T>(code: &str, message: impl ToString) -> SourceResult<T> {
    Err((code.to_owned(), message.to_string()))
}

/// Metadata settings on disk, and the per-source politeness state shared by all lookups.
pub struct MetadataState {
    path: PathBuf,
    settings: Mutex<MetadataSettings>,
    scheduler: crate::scheduler::Scheduler,
}

impl MetadataState {
    pub fn new(data_dir: &Path) -> Self {
        let path = data_dir.join("metadata-settings.json");
        let settings = std::fs::read(&path)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default();
        Self {
            path,
            settings: Mutex::new(settings),
            scheduler: crate::scheduler::Scheduler::new(),
        }
    }

    pub(crate) fn current(&self) -> MetadataSettings {
        self.settings.lock().map(|s| s.clone()).unwrap_or_default()
    }

    /// The settings as the interface may see them: credentials are shown only as set / not set.
    pub fn public_settings(&self) -> Value {
        self.current().public_view()
    }

    /// Applies a partial update; nothing is saved unless the whole result is valid.
    pub fn update(&self, update: &Value) -> SourceResult<Value> {
        let merged = self
            .current()
            .with_update(update)
            .map_err(|problems| ("invalid_settings".to_owned(), problems.join("\n")))?;
        let stored = serde_json::to_vec_pretty(&merged)
            .map_err(|e| ("settings_save_failed".to_owned(), e.to_string()))?;
        if let Some(parent) = self.path.parent() {
            let _ = std::fs::create_dir_all(parent);
        }
        let temp = self.path.with_extension("json.tmp");
        std::fs::write(&temp, stored)
            .and_then(|()| std::fs::rename(&temp, &self.path))
            .map_err(|e| {
                (
                    "settings_save_failed".to_owned(),
                    format!("Could not save the settings: {e}"),
                )
            })?;
        let view = merged.public_view();
        if let Ok(mut current) = self.settings.lock() {
            *current = merged;
        }
        Ok(view)
    }

    /// Waits until this source's turn comes (see `scheduler`), and records the request. Whoever is waiting on the
    /// answer goes first; library-wide work waits its turn behind them.
    pub(crate) fn wait_turn(&self, source: &str, min_interval: Duration) {
        self.scheduler.wait(source, min_interval);
    }

    /// For requests the person is waiting on: the same, but if the source is not ready within a few seconds this says so
    /// (`rate_limited`) instead of leaving the page waiting; the page asks again by itself. Other work waits as long as it takes.
    pub(crate) fn wait_turn_for_person(
        &self,
        source: &str,
        min_interval: Duration,
    ) -> SourceResult<()> {
        self.scheduler
            .wait_for_person(source, min_interval)
            .map_err(|busy| {
                let seconds = busy.retry_in.as_secs().max(1);
                (
                    "rate_limited".to_owned(),
                    format!(
                        "{} is busy right now; trying again in about {seconds} seconds.",
                        source_label(source)
                    ),
                )
            })
    }

    pub(crate) fn outcome(&self, source: &str, refused: bool, retry_after: Option<Duration>) {
        self.scheduler.outcome(source, refused, retry_after);
    }

    /// How each outside service is doing, for the status line on the pages.
    pub fn source_status(&self) -> Value {
        self.scheduler.status()
    }
}

/// The name a source is shown under.
pub(crate) fn source_label(source: &str) -> String {
    match source {
        "musicbrainz" => "MusicBrainz".to_owned(),
        "coverart" => "Cover Art Archive".to_owned(),
        "wikimedia" => "Wikimedia".to_owned(),
        "discogs" => "Discogs".to_owned(),
        "itunes" => "iTunes".to_owned(),
        "deezer" => "Deezer".to_owned(),
        "ctdb" => "CUETools Database".to_owned(),
        "lrclib" => "LRCLIB".to_owned(),
        "gnudb" => "gnudb".to_owned(),
        "acoustid" => "AcoustID".to_owned(),
        other => other.to_owned(),
    }
}
fn form_encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' | b'/' => {
                out.push(byte as char)
            }
            b' ' => out.push('+'),
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

pub(crate) struct HttpReply {
    pub(crate) status: u16,
    pub(crate) body: Vec<u8>,
    pub(crate) retry_after: Option<Duration>,
}

/// One HTTP or HTTPS GET. A refusal status (anything but success) is returned, not turned into an
/// error, so the caller can read the server's explanation and the `Retry-After` hint. Secure
/// connections use the operating system's TLS (SChannel on Windows).
pub(crate) fn http_get(url: &str, user_agent: &str, timeout: Duration) -> SourceResult<HttpReply> {
    // MusicBrainz (and the Cover Art Archive behind the Internet Archive) answer 503 "busy" now and then even to a polite client (measured 2026-11-24: about one request
    // in six, at one request a second, the rest fine), so a refusal is tried again a few times, a little later, before it is reported.
    if request_host(url).is_some_and(|host| is_patient_host(&host)) {
        with_patience(
            || http_get_with(url, user_agent, timeout, &[]),
            &RETRY_PAUSES,
            |pause| std::thread::sleep(pause + jitter()),
        )
    } else {
        http_get_with(url, user_agent, timeout, &[])
    }
}

/// How long to wait before each new try after a 503 or 429 (a `Retry-After` from the server replaces it, up to `MAX_RETRY_AFTER`).
const RETRY_PAUSES: [Duration; 3] = [
    Duration::from_millis(1500),
    Duration::from_millis(3000),
    Duration::from_millis(5000),
];
const MAX_RETRY_AFTER: Duration = Duration::from_secs(10);

/// The services that refuse now and then because they are busy, not because of anything this program did.
fn is_patient_host(host: &str) -> bool {
    let host = host.to_ascii_lowercase();
    ["musicbrainz.org", "coverartarchive.org", "archive.org"]
        .iter()
        .any(|name| host == *name || host.ends_with(&format!(".{name}")))
}

/// Up to a second of extra waiting that differs from one run to the next, so many copies of the program do not all come back at the same moment.
fn jitter() -> Duration {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.subsec_nanos());
    Duration::from_millis(u64::from(nanos % 1000))
}

/// Runs `get`; while the answer is a refusal for being busy (503) or too fast (429) it waits (`wait`) and runs it again, once for each pause given. The last
/// answer is returned whatever it is, so the caller still sees and reports a refusal that did not go away.
fn with_patience(
    mut get: impl FnMut() -> SourceResult<HttpReply>,
    pauses: &[Duration],
    mut wait: impl FnMut(Duration),
) -> SourceResult<HttpReply> {
    let mut reply = get()?;
    for pause in pauses {
        if !matches!(reply.status, 429 | 503) {
            break;
        }
        let pause = reply.retry_after.map_or(*pause, |asked| {
            asked.clamp(Duration::from_secs(1), MAX_RETRY_AFTER)
        });
        wait(pause);
        reply = get()?;
    }
    Ok(reply)
}

/// [`http_get`] with extra request headers (Discogs' `Authorization: Discogs token=…`).
pub(crate) fn http_get_with(
    url: &str,
    user_agent: &str,
    timeout: Duration,
    headers: &[(&str, &str)],
) -> SourceResult<HttpReply> {
    http_exchange(url, user_agent, timeout, headers, None)
}

/// One HTTP(S) POST of raw text (a gnudb submission). The reply is returned whatever its status, as with [`http_get`].
/// A submission is not followed if the server redirects: the text is not sent on to another address.
pub(crate) fn http_post_text(
    url: &str,
    user_agent: &str,
    timeout: Duration,
    headers: &[(&str, &str)],
    body: &str,
) -> SourceResult<HttpReply> {
    http_exchange(url, user_agent, timeout, headers, Some(body))
}

const MAX_REDIRECTS: u8 = 3;

struct SharedHttp {
    agent: ureq::Agent,
    tls_error: Option<String>,
}

/// One agent for every lookup. Redirects are off here and followed by hand, so a reply cannot send the next
/// request (or a Discogs token) to a different site.
fn shared_http() -> &'static SharedHttp {
    static HTTP: OnceLock<SharedHttp> = OnceLock::new();
    HTTP.get_or_init(|| {
        let tls = native_tls::TlsConnector::new().map(std::sync::Arc::new);
        let tls_error = tls
            .as_ref()
            .err()
            .map(|e| format!("Secure connections are not available on this computer: {e}"));
        let mut builder = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(60))
            .redirects(0);
        if let Ok(connector) = tls {
            builder = builder.tls_connector(connector);
        }
        SharedHttp {
            agent: builder.build(),
            tls_error,
        }
    })
}

/// `https://host` → `host`, lower case. Rejects a missing scheme, a scheme other than http(s), and userinfo
/// (`user:pass@host`), which would hide the real host.
fn request_host(url: &str) -> Option<String> {
    let rest = url
        .strip_prefix("https://")
        .or_else(|| url.strip_prefix("http://"))?;
    let authority = rest.split(['/', '?', '#']).next()?;
    if authority.is_empty() || authority.contains('@') {
        return None;
    }
    let host = if let Some(v6) = authority.strip_prefix('[') {
        v6.split(']').next()?
    } else {
        authority.split(':').next()?
    };
    (!host.is_empty()).then(|| host.to_ascii_lowercase())
}

fn cover_host(host: &str) -> bool {
    host == "coverartarchive.org"
        || host.ends_with(".coverartarchive.org")
        || host == "archive.org"
        || host.ends_with(".archive.org")
}

/// Same host, or one is a subdomain of the other (and the shorter name has a dot, so `org` is not a parent).
fn related_host(a: &str, b: &str) -> bool {
    if a == b {
        return true;
    }
    let (short, long) = if a.len() <= b.len() { (a, b) } else { (b, a) };
    long.ends_with(&format!(".{short}")) && short.contains('.')
}

/// A redirect may stay on the host we asked, move between that host and its subdomains, or move between the
/// Cover Art Archive and the Internet Archive (that is where cover files actually live). A public host may not
/// redirect to loopback or to any other site.
fn redirect_allowed(from_host: &str, to_host: &str) -> bool {
    from_host == to_host
        || (cover_host(from_host) && cover_host(to_host))
        || related_host(from_host, to_host)
}

fn resolve_location(current: &str, location: &str) -> Option<String> {
    let location = location.trim();
    if location.starts_with("https://") || location.starts_with("http://") {
        return Some(location.to_owned());
    }
    if location.starts_with("//") {
        let scheme = current.split("://").next()?;
        return Some(format!("{scheme}:{location}"));
    }
    let scheme_end = current.find("://")?;
    let rest = &current[scheme_end + 3..];
    let origin_end = rest.find(['/', '?', '#']).unwrap_or(rest.len());
    let origin = &current[..scheme_end + 3 + origin_end];
    if location.starts_with('/') {
        return Some(format!("{origin}{location}"));
    }
    let path = rest.get(origin_end..).unwrap_or("/");
    let path_only = path.split(['?', '#']).next().unwrap_or("/");
    let dir = match path_only.rfind('/') {
        Some(i) => &path_only[..=i],
        None => "/",
    };
    Some(format!("{origin}{dir}{location}"))
}

fn transport_failure(secure: bool, transport: ureq::Transport) -> (String, String) {
    let text = transport.to_string().to_lowercase();
    let tls_problem = secure
        && [
            "tls",
            "ssl",
            "handshake",
            "certificate",
            "schannel",
            "secure",
        ]
        .iter()
        .any(|word| text.contains(word));
    match transport.kind() {
        ureq::ErrorKind::Dns => (
            "connection_failed".to_owned(),
            format!("Could not find the server: {transport}"),
        ),
        _ if tls_problem || (secure && transport.kind() != ureq::ErrorKind::ConnectionFailed) => (
            "tls_failed".to_owned(),
            format!(
                "A secure connection could not be set up with this server ({transport}). Check the address and port, or use an http address if the server does not offer https."
            ),
        ),
        _ => (
            "connection_failed".to_owned(),
            format!("Could not reach the server: {transport}"),
        ),
    }
}

fn http_exchange(
    url: &str,
    user_agent: &str,
    timeout: Duration,
    headers: &[(&str, &str)],
    body: Option<&str>,
) -> SourceResult<HttpReply> {
    let client = shared_http();
    let mut current = url.to_owned();
    let original_host = request_host(&current).ok_or_else(|| {
        (
            "invalid_arguments".to_owned(),
            "That address is not one this program will open.".to_owned(),
        )
    })?;
    for hop in 0..=MAX_REDIRECTS {
        let host = request_host(&current).ok_or_else(|| {
            (
                "bad_reply".to_owned(),
                "The server redirected to an address this program will not open.".to_owned(),
            )
        })?;
        let secure = current.starts_with("https://");
        if secure && let Some(error) = &client.tls_error {
            return fail("tls_failed", error.clone());
        }
        if body.is_some() && hop > 0 {
            return fail(
                "bad_reply",
                "The server redirected a submission. Nothing was sent on.",
            );
        }
        let mut request = if body.is_some() {
            client
                .agent
                .post(&current)
                .set("Content-Type", "text/plain; charset=utf-8")
        } else {
            client.agent.get(&current)
        };
        request = request.timeout(timeout).set("User-Agent", user_agent);
        let same_host = host == original_host;
        for (name, value) in headers {
            if !same_host && name.eq_ignore_ascii_case("authorization") {
                continue;
            }
            request = request.set(name, value);
        }
        let called = if let Some(text) = body {
            request.send_string(text)
        } else {
            request.call()
        };
        let response = match called {
            Ok(response) => response,
            Err(ureq::Error::Status(_, response)) => response,
            Err(ureq::Error::Transport(transport)) => {
                return Err(transport_failure(secure, transport));
            }
        };
        let status = response.status();
        if (300..400).contains(&status) && status != 304 {
            if hop == MAX_REDIRECTS {
                return fail("bad_reply", "The server redirected too many times.");
            }
            let location = response.header("Location").unwrap_or("").trim().to_owned();
            if location.is_empty() {
                return fail("bad_reply", "The server redirected without saying where.");
            }
            let next = resolve_location(&current, &location).ok_or_else(|| {
                (
                    "bad_reply".to_owned(),
                    "The server redirected to an address this program will not open.".to_owned(),
                )
            })?;
            let next_host = request_host(&next).ok_or_else(|| {
                (
                    "bad_reply".to_owned(),
                    "The server redirected to an address this program will not open.".to_owned(),
                )
            })?;
            if !redirect_allowed(&original_host, &next_host) {
                return fail("bad_reply", "The server redirected to a different site.");
            }
            let _ = response.into_reader();
            current = next;
            continue;
        }
        let retry_after = response
            .header("Retry-After")
            .and_then(|v| v.trim().parse::<u64>().ok())
            .map(Duration::from_secs);
        let mut reply = Vec::new();
        response
            .into_reader()
            .take(MAX_REPLY_BYTES)
            .read_to_end(&mut reply)
            .map_err(|e| {
                (
                    "connection_failed".to_owned(),
                    format!("The reply was cut off: {e}"),
                )
            })?;
        return Ok(HttpReply {
            status,
            body: reply,
            retry_after,
        });
    }
    fail("bad_reply", "The server redirected too many times.")
}

#[cfg(test)]
mod redirect_pin {
    use super::{redirect_allowed, request_host, resolve_location};

    #[test]
    fn redirects_stay_on_the_host_we_asked_or_the_cover_archive() {
        assert_eq!(
            request_host("https://musicbrainz.org/ws/2/release"),
            Some("musicbrainz.org".to_owned())
        );
        assert_eq!(request_host("http://User:secret@musicbrainz.org/"), None);
        assert_eq!(request_host("file:///etc/passwd"), None);
        assert!(redirect_allowed("musicbrainz.org", "musicbrainz.org"));
        assert!(redirect_allowed("musicbrainz.org", "www.musicbrainz.org"));
        assert!(redirect_allowed(
            "coverartarchive.org",
            "ia800.us.archive.org"
        ));
        assert!(!redirect_allowed("musicbrainz.org", "127.0.0.1"));
        assert!(!redirect_allowed("musicbrainz.org", "evil.example"));
        assert!(!redirect_allowed("musicbrainz.org", "org"));
        assert_eq!(
            resolve_location("https://coverartarchive.org/release/x", "/release/x/front"),
            Some("https://coverartarchive.org/release/x/front".to_owned())
        );
    }
}

/// gnudb's required identification: the contact email split at the `@`, the application name and
/// version. Fails (so the server is reported as needing setup) if there is no valid email address.
fn identity_hello(settings: &MetadataSettings, server: &CddbServer) -> SourceResult<Hello> {
    Hello::from_email(
        &settings.identity.contact,
        &server.client_name,
        &server.client_version,
    )
    .map_err(|message| {
        (
            "needs_setup".to_owned(),
            format!("{message} Enter one under Identity in Settings."),
        )
    })
}

/// Sends CDDB commands to one server over its configured transport, one connection per lookup.
struct CddbSession<'a> {
    server: &'a CddbServer,
    hello: Hello,
    state: &'a MetadataState,
    tcp: Option<BufReader<TcpStream>>,
}

impl<'a> CddbSession<'a> {
    fn open(
        server: &'a CddbServer,
        settings: &MetadataSettings,
        state: &'a MetadataState,
    ) -> SourceResult<Self> {
        let mut session = Self {
            server,
            hello: identity_hello(settings, server)?,
            state,
            tcp: None,
        };
        if server.transport == Transport::Cddbp {
            session.handshake()?;
        }
        Ok(session)
    }

    fn timeout(&self) -> Duration {
        Duration::from_secs(self.server.timeout_seconds)
    }

    /// Reads one CDDBP reply: the status line, plus text up to a lone `.` for the codes that carry
    /// a body (210 and 211 here; 200 is a single line).
    fn read_reply(&mut self) -> SourceResult<Vec<u8>> {
        let level = self.server.protocol_level;
        let stream = self.tcp.as_mut().expect("connected");
        let mut reply = Vec::new();
        let mut line = Vec::new();
        let n = stream.read_until(b'\n', &mut line).map_err(|e| {
            (
                "connection_failed".to_owned(),
                format!("The server stopped answering: {e}"),
            )
        })?;
        if n == 0 {
            return fail("connection_failed", "The server closed the connection.");
        }
        reply.extend_from_slice(&line);
        let code: u16 = cddb::decode_text(&line, level)
            .trim()
            .get(..3)
            .and_then(|c| c.parse().ok())
            .unwrap_or(0);
        if matches!(code, 210 | 211) {
            loop {
                line.clear();
                let n = stream.read_until(b'\n', &mut line).map_err(|e| {
                    (
                        "connection_failed".to_owned(),
                        format!("The server stopped answering: {e}"),
                    )
                })?;
                if n == 0 {
                    break;
                }
                reply.extend_from_slice(&line);
                if cddb::decode_text(&line, level).trim() == "."
                    || reply.len() as u64 > MAX_REPLY_BYTES
                {
                    break;
                }
            }
        }
        Ok(reply)
    }

    fn send_line(&mut self, text: &str) -> SourceResult<()> {
        let stream = self.tcp.as_mut().expect("connected").get_mut();
        stream
            .write_all(format!("{text}\r\n").as_bytes())
            .and_then(|()| stream.flush())
            .map_err(|e| {
                (
                    "connection_failed".to_owned(),
                    format!("Could not send to the server: {e}"),
                )
            })
    }

    fn handshake(&mut self) -> SourceResult<()> {
        let address = (self.server.host.as_str(), self.server.port)
            .to_socket_addrs()
            .map_err(|e| {
                (
                    "connection_failed".to_owned(),
                    format!("Could not find {}: {e}", self.server.host),
                )
            })?
            .next()
            .ok_or_else(|| {
                (
                    "connection_failed".to_owned(),
                    format!("Could not find {}.", self.server.host),
                )
            })?;
        let stream = TcpStream::connect_timeout(&address, self.timeout()).map_err(|e| {
            (
                "connection_failed".to_owned(),
                format!(
                    "Could not connect to {}:{}: {e}",
                    self.server.host, self.server.port
                ),
            )
        })?;
        let _ = stream.set_read_timeout(Some(self.timeout()));
        let _ = stream.set_write_timeout(Some(self.timeout()));
        self.tcp = Some(BufReader::new(stream));

        let greeting = cddb::decode_text(&self.read_reply()?, self.server.protocol_level);
        if !greeting.trim_start().starts_with("200") && !greeting.trim_start().starts_with("201") {
            return fail(
                "cddb_refused",
                format!(
                    "The server did not accept the connection: {}",
                    greeting.trim()
                ),
            );
        }
        self.send_line(&format!("cddb hello {}", self.hello.fields()))?;
        let hello = cddb::decode_text(&self.read_reply()?, self.server.protocol_level);
        if !(hello.starts_with("200") || hello.starts_with("402")) {
            return fail(
                "cddb_refused",
                format!("The server refused the introduction: {}", hello.trim()),
            );
        }
        if self.server.protocol_level > 1 {
            self.send_line(&format!("proto {}", self.server.protocol_level))?;
            let reply = cddb::decode_text(&self.read_reply()?, self.server.protocol_level);
            // Some servers do not support the level asked for; carry on at theirs.
            if !(reply.starts_with("200") || reply.starts_with("201")) {
                return fail(
                    "cddb_refused",
                    format!(
                        "The server does not support protocol level {}: {}",
                        self.server.protocol_level,
                        reply.trim()
                    ),
                );
            }
        }
        Ok(())
    }

    /// Runs one command and returns the decoded reply text.
    fn command(&mut self, command: &str) -> SourceResult<String> {
        let source = self.server.name.clone();
        self.state
            .wait_turn_for_person(&source, Duration::from_millis(self.server.min_interval_ms))?;
        let level = self.server.protocol_level;
        let reply = match self.server.transport {
            Transport::Cddbp => {
                self.send_line(command)?;
                cddb::decode_text(&self.read_reply()?, level)
            }
            Transport::Http | Transport::Https => {
                let scheme = if self.server.transport == Transport::Https {
                    "https"
                } else {
                    "http"
                };
                let url = format!(
                    "{scheme}://{}:{}{}?cmd={}&hello={}&proto={}",
                    self.server.host,
                    self.server.port,
                    self.server.path,
                    form_encode(command),
                    form_encode(&self.hello.fields()),
                    level
                );
                let ua = musicbrainz::user_agent(
                    APP_NAME,
                    APP_VERSION,
                    "https://github.com/MediaVerseStudio/MediaVerse-Studio",
                );
                let response = http_get(&url, &ua, self.timeout())?;
                if matches!(response.status, 429 | 503) {
                    self.state.outcome(&source, true, response.retry_after);
                    return fail(
                        "rate_limited",
                        format!(
                            "The server is busy (HTTP {}). Try again in a minute.",
                            response.status
                        ),
                    );
                }
                if response.status != 200 {
                    self.state.outcome(&source, false, None);
                    return fail(
                        "http_error",
                        format!("The server answered HTTP {}.", response.status),
                    );
                }
                cddb::decode_text(&response.body, level)
            }
        };
        self.state.outcome(&source, false, None);
        Ok(reply)
    }
}

impl Drop for CddbSession<'_> {
    fn drop(&mut self) {
        if self.tcp.is_some() {
            let _ = self.send_line("quit");
        }
    }
}

fn lookup_cddb(
    server: &CddbServer,
    settings: &MetadataSettings,
    state: &MetadataState,
    toc: &DiscToc,
) -> SourceResult<Vec<AlbumInfo>> {
    let disc_id = discid::cddb_id(toc);
    let mut session = CddbSession::open(server, settings, state)?;
    let query = session.command(&cddb::query_command(toc, &disc_id))?;
    let matches = match cddb::parse_query_reply(&query) {
        QueryReply::Matches(matches) => matches,
        QueryReply::NoMatch => return Ok(Vec::new()),
        QueryReply::Failed { code: 429, .. } => {
            state.outcome(&server.name, true, None);
            return fail(
                "rate_limited",
                "The server says there have been too many requests (429). Wait a minute and try again.",
            );
        }
        QueryReply::Failed { code, message } => {
            return fail(
                &format!("cddb_{code}"),
                if message.is_empty() {
                    format!("The server answered {code}.")
                } else {
                    message
                },
            );
        }
    };

    let mut albums = Vec::new();
    for found in matches.iter().take(MAX_RECORDS_PER_SERVER) {
        let record = session.command(&cddb::read_command(&found.category, &found.disc_id))?;
        match cddb::parse_record(
            &record,
            &server.name,
            &found.category,
            &found.disc_id,
            found.quality,
        ) {
            Ok(album) if album.tracks.len() == toc.track_count() => albums.push(album),
            Ok(_) => {} // a record for a different layout of tracks cannot describe this disc
            Err(_) => {}
        }
    }
    Ok(albums)
}

fn lookup_musicbrainz(
    settings: &MetadataSettings,
    state: &MetadataState,
    toc: &DiscToc,
) -> SourceResult<Vec<AlbumInfo>> {
    let mb = &settings.musicbrainz;
    let disc_id = discid::musicbrainz_id(toc);
    let url = musicbrainz::discid_url(&mb.base_url, &disc_id);
    let ua = musicbrainz::user_agent(APP_NAME, APP_VERSION, settings.identity.contact.trim());
    state.wait_turn_for_person("musicbrainz", Duration::from_millis(mb.min_interval_ms))?;
    let response = http_get(&url, &ua, Duration::from_secs(mb.timeout_seconds))?;
    match response.status {
        200 => {
            state.outcome("musicbrainz", false, None);
            let text = String::from_utf8_lossy(&response.body);
            musicbrainz::parse_discid_response(&text, &disc_id)
                .or_else(|message| fail("bad_reply", message))
        }
        404 => {
            state.outcome("musicbrainz", false, None);
            // This exact disc is not listed (a new pressing, say): ask for releases whose track layout is close. They
            // are offered as "same album, this disc is not listed" and the person confirms them.
            fuzzy_musicbrainz(settings, state, toc, &disc_id, &ua)
        }
        429 | 503 => {
            state.outcome("musicbrainz", true, response.retry_after);
            fail(
                "rate_limited",
                "MusicBrainz is busy or limiting requests right now (it answers 503 when its servers are overloaded, which can last a while). Try again in a few minutes.",
            )
        }
        other => fail("http_error", format!("MusicBrainz answered HTTP {other}.")),
    }
}

/// Releases with a similar table of contents; empty when there are none or the service does not answer.
fn fuzzy_musicbrainz(
    settings: &MetadataSettings,
    state: &MetadataState,
    toc: &DiscToc,
    disc_id: &str,
    ua: &str,
) -> SourceResult<Vec<AlbumInfo>> {
    let mb = &settings.musicbrainz;
    state.wait_turn_for_person("musicbrainz", Duration::from_millis(mb.min_interval_ms))?;
    let Ok(response) = http_get(
        &musicbrainz::toc_search_url(&mb.base_url, toc),
        ua,
        Duration::from_secs(mb.timeout_seconds),
    ) else {
        return Ok(Vec::new());
    };
    let refused = matches!(response.status, 429 | 503);
    state.outcome("musicbrainz", refused, response.retry_after);
    if refused {
        // Not "no match": the second question was never answered, and the page must not pretend it was.
        return fail(
            "rate_limited",
            "MusicBrainz is busy or limiting requests right now, so similar discs could not be checked. Try the lookup again in a few minutes.",
        );
    }
    if response.status != 200 {
        return Ok(Vec::new());
    }
    Ok(
        musicbrainz::parse_discid_response(&String::from_utf8_lossy(&response.body), disc_id)
            .unwrap_or_default(),
    )
}

/// Looks for an album by the name the person typed, among MusicBrainz releases with as many tracks as the disc has.
fn search_musicbrainz(
    settings: &MetadataSettings,
    state: &MetadataState,
    artist: &str,
    album: &str,
    track_count: usize,
    progress: &dyn Fn(usize, usize),
) -> SourceResult<Vec<AlbumInfo>> {
    let mb = &settings.musicbrainz;
    let ua = musicbrainz::user_agent(APP_NAME, APP_VERSION, settings.identity.contact.trim());
    let timeout = Duration::from_secs(mb.timeout_seconds);
    let get = |url: &str| -> SourceResult<String> {
        state.wait_turn_for_person("musicbrainz", Duration::from_millis(mb.min_interval_ms))?;
        let response = http_get(url, &ua, timeout)?;
        match response.status {
            200 => {
                state.outcome("musicbrainz", false, None);
                Ok(String::from_utf8_lossy(&response.body).into_owned())
            }
            429 | 503 => {
                state.outcome("musicbrainz", true, response.retry_after);
                fail(
                    "rate_limited",
                    "MusicBrainz is busy or limiting requests right now (it answers 503 when its servers are overloaded, which can last a while). Try again in a few minutes.",
                )
            }
            other => fail("http_error", format!("MusicBrainz answered HTTP {other}.")),
        }
    };
    let hits = musicbrainz::search_hits(
        &get(&musicbrainz::search_url(&mb.base_url, artist, album))?,
        track_count,
        6,
    )
    .or_else(|m| fail("bad_reply", m))?;
    let mut albums = Vec::new();
    for (index, id) in hits.iter().enumerate() {
        progress(index, hits.len());
        if let Ok(found) = musicbrainz::parse_release_response(
            &get(&musicbrainz::release_url(&mb.base_url, id))?,
            track_count,
        ) {
            albums.extend(found);
        }
    }
    Ok(albums)
}

/// Discogs releases (with the person's own token) for the typed names, as albums for the medium with `track_count` tracks.
/// Discogs asks that its data carry its name and a link, so the source stays "discogs" for the page to say so.
fn search_discogs_albums(
    settings: &MetadataSettings,
    state: &MetadataState,
    artist: &str,
    album: &str,
    track_count: usize,
) -> SourceResult<Vec<AlbumInfo>> {
    let base = settings.discogs.base_url.trim_end_matches('/');
    let encode = crate::tag_repair::url_encode;
    let mut url = format!(
        "{base}/database/search?type=release&per_page=10&release_title={}",
        encode(album)
    );
    if !artist.trim().is_empty() {
        url.push_str(&format!("&artist={}", encode(artist)));
    }
    let Some(body) = crate::tag_repair::discogs_get(&url, settings, state)? else {
        return Ok(Vec::new());
    };
    let ids =
        mediaverse_tag_repair::discogs::search_ids(&body).or_else(|m| fail("bad_reply", m))?;
    let mut albums = Vec::new();
    for id in ids.into_iter().take(6) {
        let Some(text) =
            crate::tag_repair::discogs_get(&format!("{base}/releases/{id}"), settings, state)?
        else {
            continue;
        };
        let Ok(Some(release)) = mediaverse_tag_repair::discogs::parse_release(&text) else {
            continue;
        };
        let Some(medium) = release.media.iter().find(|m| m.tracks.len() == track_count) else {
            continue;
        };
        let year = release.year();
        albums.push(AlbumInfo {
            source: "discogs".to_owned(),
            source_id: id.to_string(),
            album: release.title.clone(),
            album_artist: release.artist.clone(),
            year,
            genre: release.genres.first().cloned(),
            tracks: medium
                .tracks
                .iter()
                .enumerate()
                .map(|(i, t)| mediaverse_disc_metadata::TrackInfo {
                    number: (i + 1) as u8,
                    title: t.title.clone(),
                    artist: (!t.artist.is_empty()).then(|| t.artist.clone()),
                    length_ms: t.length_ms.and_then(|ms| u32::try_from(ms).ok()),
                })
                .collect(),
            quality: mediaverse_disc_metadata::MatchQuality::Inexact,
            cover_art_release: None,
            disc_number: None,
            disc_count: (release.media.len() > 1).then_some(release.media.len() as u32),
            compilation: musicbrainz::is_various_artist(&release.artist),
            release: Some(mediaverse_disc_metadata::ReleaseInfo {
                date: release.date.clone(),
                country: release.country.clone(),
                label: release.label.clone(),
                catalog_number: release.catalog_number.clone(),
                barcode: release.barcode.clone(),
                format: medium.format.clone(),
                status: String::new(),
            }),
        });
    }
    Ok(albums)
}

/// (artist, album) for a name search: with only one of the two typed, it is searched as the album title.
fn artist_for_search<'a>(artist: &'a str, album: &'a str) -> (&'a str, &'a str) {
    if album.trim().is_empty() {
        ("", artist)
    } else {
        (artist, album)
    }
}

/// iTunes and Deezer by the typed names (no keys; the owner approved both on 2026-11-16, D106), digital editions with
/// this disc's track count. A failure of one is returned with its name so the other still answers.
fn search_catalogues(
    state: &MetadataState,
    settings: &MetadataSettings,
    artist: &str,
    album: &str,
    track_count: usize,
) -> (Vec<AlbumInfo>, Vec<SourceError>) {
    use mediaverse_disc_metadata::streaming as s;
    let ua = musicbrainz::user_agent(APP_NAME, APP_VERSION, settings.identity.contact.trim());
    let get = |source: &str, gap_ms: u64, url: &str| -> SourceResult<String> {
        state.wait_turn_for_person(source, Duration::from_millis(gap_ms))?;
        let response = http_get(url, &ua, Duration::from_secs(20))?;
        match response.status {
            200 => Ok(String::from_utf8_lossy(&response.body).into_owned()),
            403 | 429 | 503 => {
                state.outcome(source, true, response.retry_after);
                fail(
                    "rate_limited",
                    format!(
                        "{source} is limiting requests from this address. Try again in a few minutes."
                    ),
                )
            }
            other => fail("http_error", format!("{source} answered HTTP {other}.")),
        }
    };
    let mut albums = Vec::new();
    let mut errors = Vec::new();
    let mut note = |source: &str, result: SourceResult<Vec<AlbumInfo>>| match result {
        Ok(found) => albums.extend(found),
        Err((code, message)) => errors.push(SourceError {
            source: source.to_owned(),
            code,
            message,
        }),
    };
    note(
        "itunes",
        (|| {
            let ids = s::itunes_ids(
                &get("itunes", 3_000, &s::itunes_search_url(artist, album))?,
                track_count,
                4,
            )
            .or_else(|m| fail("bad_reply", m))?;
            let mut found = Vec::new();
            for id in ids {
                if let Some(one) = s::parse_itunes_album(
                    &get("itunes", 3_000, &s::itunes_lookup_url(id))?,
                    track_count,
                )
                .or_else(|m| fail("bad_reply", m))?
                {
                    found.push(one);
                }
            }
            Ok(found)
        })(),
    );
    note(
        "deezer",
        (|| {
            let ids = s::deezer_ids(
                &get("deezer", 1_100, &s::deezer_search_url(artist, album))?,
                track_count,
                4,
            )
            .or_else(|m| fail("bad_reply", m))?;
            let mut found = Vec::new();
            for id in ids {
                if let Some(one) = s::parse_deezer_album(
                    &get("deezer", 1_100, &s::deezer_album_url(id))?,
                    track_count,
                )
                .or_else(|m| fail("bad_reply", m))?
                {
                    found.push(one);
                }
            }
            Ok(found)
        })(),
    );
    (albums, errors)
}

impl Drives {
    /// Which disc is in the drive, cheaply (the table of contents only): `{present, id, tracks}`. The Rip page asks every
    /// few seconds so a new disc refreshes the album and track list by itself.
    pub(crate) fn disc_probe(&self, device: &str) -> Result<Value, HelperError> {
        let mut helper = Helper::start()?;
        match helper.request("read_toc", json!({ "device": device }), &mut |_, _| {}) {
            Ok(reply) => match toc_from(&reply) {
                Ok(toc) => Ok(
                    json!({ "present": true, "id": discid::musicbrainz_id(&toc), "tracks": toc.track_count() }),
                ),
                Err(_) => Ok(json!({ "present": true, "id": null, "tracks": 0 })), // a disc, but not an audio CD
            },
            Err(_) => Ok(json!({ "present": false, "id": null, "tracks": 0 })),
        }
    }

    /// Every name-search source for the typed album and artist: MusicBrainz, Discogs (with the person's token), iTunes and
    /// Deezer, each limited to releases with `track_count` tracks. A failing source is reported, the others still answer.
    fn search_everywhere(
        &self,
        job_id: &str,
        artist: &str,
        album: &str,
        track_count: usize,
    ) -> (Vec<AlbumInfo>, Vec<SourceError>, Vec<&'static str>) {
        let settings = self.metadata.current();
        let mut errors: Vec<SourceError> = Vec::new();
        let mut albums = Vec::new();
        if settings.musicbrainz.enabled {
            let progress = |done: usize, total: usize| {
                self.output.emit("job-progress", json!({ "job_id": job_id, "kind": "lookup", "source": "musicbrainz", "done": done, "total": total }));
            };
            let title = if album.trim().is_empty() {
                artist
            } else {
                album
            };
            let who = if album.trim().is_empty() { "" } else { artist };
            match search_musicbrainz(
                &settings,
                &self.metadata,
                who,
                title,
                track_count,
                &progress,
            ) {
                Ok(found) => albums = found,
                Err((code, message)) => errors.push(SourceError {
                    source: "musicbrainz".to_owned(),
                    code,
                    message,
                }),
            }
        }
        let mut tried = vec!["musicbrainz"];
        if crate::tag_repair::discogs_ready(&settings) {
            tried.push("discogs");
            let (who, title) = if album.trim().is_empty() {
                ("", artist)
            } else {
                (artist, album)
            };
            match search_discogs_albums(&settings, &self.metadata, who, title, track_count) {
                Ok(found) => albums.extend(found),
                Err((code, message)) => errors.push(SourceError {
                    source: "discogs".to_owned(),
                    code,
                    message,
                }),
            }
        }
        tried.extend(["itunes", "deezer"]);
        let (who, title) = artist_for_search(artist, album);
        let (catalogue, catalogue_errors) =
            search_catalogues(&self.metadata, &settings, who, title, track_count);
        albums.extend(catalogue);
        errors.extend(catalogue_errors);
        (albums, errors, tried)
    }

    /// The `search_folder_album` job (Review > Fix tags, an album nothing identified): the same name search as the Rip page, for
    /// an album folder on disk. The folder's own song lengths are compared with each result, as the disc's are on the Rip page,
    /// so a result whose lengths all agree stands out. Nothing is written.
    pub(crate) fn run_folder_search(
        &self,
        job_id: &str,
        dir: &std::path::Path,
        artist: &str,
        album: &str,
    ) -> Result<Value, HelperError> {
        if album.trim().is_empty() && artist.trim().is_empty() {
            return Err(failure(
                "invalid_arguments",
                "Type an album title or an artist to search for.",
            ));
        }
        let mut files: Vec<mediaverse_tag_repair::FolderFile> = crate::tag_repair::audio_files(dir)
            .iter()
            .filter_map(|p| crate::tag_repair::read_file(p).ok())
            .collect();
        if files.is_empty() {
            return Err(failure(
                "invalid_arguments",
                "There are no songs in that album folder.",
            ));
        }
        files.sort_by(|a, b| {
            (a.tags.track.unwrap_or(u32::MAX), &a.stem)
                .cmp(&(b.tags.track.unwrap_or(u32::MAX), &b.stem))
        });
        let (albums, errors, tried) = self.search_everywhere(job_id, artist, album, files.len());
        let lengths: Vec<u32> = files
            .iter()
            .map(|f| u32::try_from(f.length_ms).unwrap_or(u32::MAX))
            .collect();
        let candidates = with_length_fit_ms(consolidate(albums), &lengths);
        Ok(
            json!({ "sources_tried": tried, "candidates": candidates, "errors": errors, "files": files.iter().map(|f| f.path.clone()).collect::<Vec<_>>() }),
        )
    }
    /// The `search_albums` job: the person typed the album (and artist); offer MusicBrainz releases with this disc's track count.
    pub(crate) fn run_search(
        &self,
        job_id: &str,
        device: &str,
        artist: &str,
        album: &str,
    ) -> Result<Value, HelperError> {
        if album.trim().is_empty() && artist.trim().is_empty() {
            return Err(failure(
                "invalid_arguments",
                "Type an album title or an artist to search for.",
            ));
        }
        let toc = {
            let mut helper = Helper::start()?;
            let reply = helper.request("read_toc", json!({ "device": device }), &mut |_, _| {})?;
            toc_from(&reply)?
        };
        let (albums, errors, tried) =
            self.search_everywhere(job_id, artist, album, toc.track_count());
        let candidates = with_length_fit(consolidate(albums), &toc);
        Ok(json!({
            "disc_ids": { "musicbrainz": discid::musicbrainz_id(&toc), "cddb": discid::cddb_id(&toc) },
            "toc": { "track_starts": toc.track_starts, "leadout": toc.leadout },
            "sources_tried": tried,
            "candidates": candidates,
            "automatic_choice": null,
            "errors": errors,
            "searched": true,
        }))
    }

    /// The `lookup_disc` job: read the table of contents, ask each enabled source, merge.
    pub(crate) fn run_lookup(&self, job_id: &str, device: &str) -> Result<Value, HelperError> {
        let (toc, on_disc) = {
            let mut helper = Helper::start()?;
            let reply = helper.request("read_toc", json!({ "device": device }), &mut |_, _| {})?;
            (toc_from(&reply)?, album_from_cdtext(&reply))
        };
        let settings = self.metadata.current();
        let ids =
            json!({ "musicbrainz": discid::musicbrainz_id(&toc), "cddb": discid::cddb_id(&toc) });

        let mut albums: Vec<AlbumInfo> = Vec::new();
        let mut errors: Vec<SourceError> = Vec::new();
        let mut tried: Vec<String> = Vec::new();
        let mut note = |source: &str, result: SourceResult<Vec<AlbumInfo>>| {
            tried.push(source.to_owned());
            match result {
                Ok(found) => albums.extend(found),
                Err((code, message)) => errors.push(SourceError {
                    source: source.to_owned(),
                    code,
                    message,
                }),
            }
        };

        let total = usize::from(settings.musicbrainz.enabled)
            + settings.cddb_servers.iter().filter(|s| s.enabled).count()
            + 1;
        let mut done = 0;
        let progress = |source: &str, done: usize| {
            self.output.emit("job-progress", json!({ "job_id": job_id, "kind": "lookup", "source": source, "done": done, "total": total }));
        };

        let gaps = settings.incomplete();
        if settings.musicbrainz.enabled {
            progress("musicbrainz", done);
            match gaps.iter().find(|(source, _)| *source == "musicbrainz") {
                Some((_, message)) => note("musicbrainz", fail("needs_setup", message)),
                None => note(
                    "musicbrainz",
                    lookup_musicbrainz(&settings, &self.metadata, &toc),
                ),
            }
            done += 1;
        }
        for server in settings.cddb_servers.iter().filter(|s| s.enabled) {
            progress(&server.name, done);
            match gaps.iter().find(|(source, _)| *source == "cddb") {
                Some((_, message)) => note(&server.name, fail("needs_setup", message)),
                None => note(
                    &server.name,
                    lookup_cddb(server, &settings, &self.metadata, &toc),
                ),
            }
            done += 1;
        }
        // The CUETools Database (D107): free, keyless, asked about this layout and similar ones. A failure is not shown (the
        // service is run by volunteers and is sometimes down); what it adds is a second chance for pressings the others lack.
        // (A MusicBrainz server of the person's own, or a test server, means no public services are wanted.)
        let public_services = settings.musicbrainz.base_url.contains("musicbrainz.org");
        progress("ctdb", done);
        let ua = musicbrainz::user_agent(APP_NAME, APP_VERSION, settings.identity.contact.trim());
        // (If the CUETools Database is busy it is simply skipped: it is only ever a second chance.)
        let ctdb_ready = public_services
            && self
                .metadata
                .wait_turn_for_person("ctdb", Duration::from_millis(1_000))
                .is_ok();
        if let Some(reply) = ctdb_ready
            .then(|| {
                http_get(
                    &mediaverse_disc_metadata::ctdb::lookup_url(&toc),
                    &ua,
                    Duration::from_secs(20),
                )
            })
            .and_then(Result::ok)
        {
            if reply.status == 200 {
                tried.push("ctdb".to_owned());
                let known: Vec<(String, String)> = albums
                    .iter()
                    .map(|a| (a.source.clone(), a.source_id.clone()))
                    .collect();
                for album in mediaverse_disc_metadata::ctdb::parse_reply(
                    &String::from_utf8_lossy(&reply.body),
                    toc.track_count(),
                ) {
                    if !known.contains(&(album.source.clone(), album.source_id.clone())) {
                        albums.push(album);
                    }
                }
            } else if reply.status == 404 {
                tried.push("ctdb".to_owned());
            }
        }
        done += 1;
        let _ = done;
        if settings.gracenote.enabled {
            errors.push(SourceError {
                source: "gracenote".to_owned(),
                code: "not_available".to_owned(),
                message: "Gracenote lookups are not available in this version of the app."
                    .to_owned(),
            });
        }
        progress("done", total);

        // What the disc says about itself (CD-Text) is the base (owner, 2026-11-20: the gold standard; the databases fill the
        // gaps: year, genre, cover art, ids). A new release no database knows yet (MxPx "Living in the Chaos") still comes
        // out complete. See `with_cdtext_first`.
        if let Some(album) = on_disc {
            tried.push("cd-text".to_owned());
            albums = with_cdtext_first(album, albums);
        }

        let candidates = with_length_fit(consolidate(albums), &toc);
        let choice = automatic_choice(&candidates);
        Ok(json!({
            "disc_ids": ids,
            "toc": { "track_starts": toc.track_starts, "leadout": toc.leadout },
            "sources_tried": tried,
            "candidates": candidates,
            "automatic_choice": choice,
            "errors": errors,
        }))
    }
}

/// Compares each candidate's track lengths with the disc in the drive, and puts those that agree on every track ahead of
/// the others of the same kind. A match on this exact disc ID still comes first.
fn with_length_fit(
    candidates: Vec<mediaverse_disc_metadata::merge::Candidate>,
    toc: &DiscToc,
) -> Vec<mediaverse_disc_metadata::merge::Candidate> {
    with_length_fit_ms(
        candidates,
        &mediaverse_disc_metadata::fit::disc_lengths_ms(&toc.track_starts, toc.leadout),
    )
}

/// The same, for a list of song lengths in milliseconds (an album folder on disk).
fn with_length_fit_ms(
    mut candidates: Vec<mediaverse_disc_metadata::merge::Candidate>,
    disc: &[u32],
) -> Vec<mediaverse_disc_metadata::merge::Candidate> {
    use mediaverse_disc_metadata::{MatchQuality, fit};
    for candidate in &mut candidates {
        candidate.length_fit = fit::length_fit(disc, &candidate.album.tracks);
    }
    candidates.sort_by_key(|c| {
        (
            c.album.quality != MatchQuality::Exact,
            !c.length_fit.is_some_and(|f| f.strong()),
        )
    });
    candidates
}

/// Capitals-only CD-Text ("THE GOOD DAYS", "DON'T SAY GOODBYE TO ME") as a title: first letter of each word up, the rest down,
/// small joining words down unless first. Text that already has lower-case letters ("MxPx", "Living in the Chaos") is left alone.
pub(crate) fn tidy_cdtext_case(text: &str) -> String {
    let has_lower = text.chars().any(char::is_lowercase);
    let letters = text.chars().filter(|c| c.is_alphabetic()).count();
    if has_lower || letters < 4 {
        return text.to_owned();
    }
    const SMALL: [&str; 14] = [
        "a", "an", "and", "as", "at", "but", "by", "for", "in", "of", "on", "or", "the", "to",
    ];
    text.split(' ')
        .enumerate()
        .map(|(index, word)| {
            let lower = word.to_lowercase();
            if index > 0 && SMALL.contains(&lower.as_str()) {
                return lower;
            }
            let mut chars = lower.chars();
            match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            }
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// A name reduced to its letters and digits in lower case, to tell "Don't Say Goodbye To Me" from "DON'T SAY GOODBYE TO ME"
/// (the same name) without caring about capitals or punctuation.
fn plain_name(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// The disc's own text is the base and the online releases fill the gaps (owner, 2026-11-20). A release with this disc's
/// number of tracks whose titles agree with the disc's is kept, wearing the disc's names (the album, the artist, each title
/// and track artist the disc states; where an online name is only the same name set better, with capitals and punctuation,
/// the online spelling is kept) and keeping what the disc cannot say: year, genre, cover, edition, ids. When every title
/// agrees, the disc has said it is this release, so it counts as this exact disc. A release that disagrees is another album
/// and stays as it was, behind. When no release agrees with the disc, the disc's own album comes first, alone.
fn with_cdtext_first(disc: AlbumInfo, online: Vec<AlbumInfo>) -> Vec<AlbumInfo> {
    use mediaverse_disc_metadata::MatchQuality;
    let (mut agreeing, mut others) = (Vec::new(), Vec::new());
    for release in online {
        let comparable = release.tracks.len() == disc.tracks.len();
        let stated: Vec<_> = disc
            .tracks
            .iter()
            .zip(&release.tracks)
            .filter(|(d, _)| !d.title.is_empty())
            .collect();
        let same = stated
            .iter()
            .filter(|(d, r)| plain_name(&d.title) == plain_name(&r.title))
            .count();
        if comparable && !stated.is_empty() && same * 5 >= stated.len() * 4 {
            let all = same == stated.len();
            let mut merged = release;
            let keep_online = |disc_name: &str, online_name: &str| {
                if disc_name.is_empty() || plain_name(disc_name) == plain_name(online_name) {
                    online_name.to_owned()
                } else {
                    disc_name.to_owned()
                }
            };
            merged.album = keep_online(&disc.album, &merged.album);
            merged.album_artist = keep_online(&disc.album_artist, &merged.album_artist);
            for (track, on_disc) in merged.tracks.iter_mut().zip(&disc.tracks) {
                track.title = keep_online(&on_disc.title, &track.title);
                if let Some(artist) = &on_disc.artist {
                    let same_artist = track
                        .artist
                        .as_deref()
                        .is_some_and(|a| plain_name(a) == plain_name(artist));
                    if !same_artist {
                        track.artist = Some(artist.clone());
                    }
                }
            }
            if all {
                merged.quality = MatchQuality::Exact;
            }
            agreeing.push(merged);
        } else {
            others.push(release);
        }
    }
    let mut result = Vec::new();
    if !agreeing.iter().any(|a| a.quality == MatchQuality::Exact) {
        result.push(disc);
    }
    result.extend(agreeing);
    result.extend(others);
    result
}

/// The album the disc itself describes (the helper's `cdtext` entry in its table-of-contents reply), or `None`.
fn album_from_cdtext(reply: &Value) -> Option<AlbumInfo> {
    let text = reply.get("cdtext")?;
    let tracks = text["tracks"].as_array()?;
    let album_artist = text["artist"]
        .as_str()
        .map(tidy_cdtext_case)
        .unwrap_or_default();
    let infos: Vec<TrackInfo> = tracks
        .iter()
        .enumerate()
        .map(|(index, track)| TrackInfo {
            number: u8::try_from(index + 1).unwrap_or(u8::MAX),
            title: track["title"]
                .as_str()
                .map(tidy_cdtext_case)
                .unwrap_or_default(),
            artist: track["artist"]
                .as_str()
                .map(tidy_cdtext_case)
                .filter(|artist| *artist != album_artist),
            length_ms: None,
        })
        .collect();
    if infos.iter().all(|t| t.title.is_empty()) {
        return None;
    }
    Some(AlbumInfo {
        source: "cd-text".to_owned(),
        source_id: "disc".to_owned(),
        album: text["album"]
            .as_str()
            .map(tidy_cdtext_case)
            .unwrap_or_default(),
        album_artist,
        year: None,
        genre: None,
        tracks: infos,
        quality: mediaverse_disc_metadata::MatchQuality::Exact,
        cover_art_release: None,
        disc_number: None,
        disc_count: None,
        compilation: false,
        release: None,
    })
}

fn toc_from(reply: &Value) -> SourceResult<DiscToc> {
    let tracks = reply["tracks"].as_array().ok_or_else(|| {
        (
            "helper_failed".to_owned(),
            "The helper sent no track list.".to_owned(),
        )
    })?;
    let track_starts: Vec<u32> = tracks
        .iter()
        .filter(|track| track["audio"] == true)
        .filter_map(|track| track["start_lsn"].as_u64().map(|lsn| lsn as u32))
        .collect();
    if track_starts.is_empty() {
        return fail(
            "no_audio",
            "There are no audio tracks on this disc to look up.",
        );
    }
    Ok(DiscToc {
        track_starts,
        leadout: reply["leadout_lsn"].as_u64().unwrap_or(0) as u32,
    })
}

#[cfg(test)]
mod gate_tests {
    use super::*;
    use std::sync::Arc;
    use std::time::Instant;

    /// Several threads asking for the same source at once (a library scan and a lookup, say) must come out
    /// one gap apart, not together. Before the check and the record were one step, they all fired at once.
    #[test]
    fn threads_sharing_a_source_are_spaced_by_its_gap() {
        let dir = std::env::temp_dir().join(format!("mediaverse-gate-test-{}", std::process::id()));
        let state = Arc::new(MetadataState::new(&dir));
        let gap = Duration::from_millis(120);
        let times: Arc<Mutex<Vec<Instant>>> = Arc::new(Mutex::new(Vec::new()));
        let handles: Vec<_> = (0..4)
            .map(|_| {
                let (state, times) = (state.clone(), times.clone());
                std::thread::spawn(move || {
                    state.wait_turn("test-source", gap);
                    times.lock().unwrap().push(Instant::now());
                })
            })
            .collect();
        for handle in handles {
            handle.join().unwrap();
        }
        let mut times = times.lock().unwrap().clone();
        times.sort();
        assert_eq!(times.len(), 4);
        for pair in times.windows(2) {
            assert!(
                pair[1] - pair[0] >= gap - Duration::from_millis(15),
                "two requests went out only {:?} apart",
                pair[1] - pair[0]
            );
        }
    }

    #[test]
    fn different_sources_do_not_wait_for_each_other() {
        let dir =
            std::env::temp_dir().join(format!("mediaverse-gate-test-b-{}", std::process::id()));
        let state = MetadataState::new(&dir);
        let started = Instant::now();
        state.wait_turn("one", Duration::from_secs(5));
        state.wait_turn("two", Duration::from_secs(5));
        assert!(started.elapsed() < Duration::from_secs(1));
    }

    #[test]
    fn a_waiting_caller_notices_a_refusal_recorded_while_it_slept() {
        let dir =
            std::env::temp_dir().join(format!("mediaverse-gate-test-c-{}", std::process::id()));
        let state = Arc::new(MetadataState::new(&dir));
        state.wait_turn("busy", Duration::from_millis(100));
        let waiter = {
            let state = state.clone();
            std::thread::spawn(move || {
                let started = Instant::now();
                state.wait_turn("busy", Duration::from_millis(100));
                started.elapsed()
            })
        };
        std::thread::sleep(Duration::from_millis(20));
        state.outcome("busy", true, Some(Duration::from_millis(600)));
        let waited = waiter.join().unwrap();
        assert!(
            waited >= Duration::from_millis(500),
            "the waiter went out after only {waited:?}, ignoring the refusal"
        );
    }
}

#[cfg(test)]
mod cdtext_tests {
    use super::*;

    #[test]
    fn capitals_only_text_becomes_a_title_and_mixed_case_is_left_alone() {
        assert_eq!(tidy_cdtext_case("THE GOOD DAYS"), "The Good Days");
        assert_eq!(
            tidy_cdtext_case("DON'T SAY GOODBYE TO ME"),
            "Don't Say Goodbye to Me"
        );
        assert_eq!(
            tidy_cdtext_case("ONCE IN A LIFETIMES"),
            "Once in a Lifetimes"
        );
        assert_eq!(tidy_cdtext_case("MxPx"), "MxPx");
        assert_eq!(
            tidy_cdtext_case("Living in the Chaos"),
            "Living in the Chaos"
        );
        assert_eq!(tidy_cdtext_case("U2"), "U2"); // too short to tell
    }

    fn release(source: &str, artist: &str, titles: &[&str], quality: MatchQuality) -> AlbumInfo {
        AlbumInfo {
            source: source.to_owned(),
            source_id: format!("{source}-id"),
            album: "Living In The Chaos".to_owned(),
            album_artist: artist.to_owned(),
            year: Some(2026),
            genre: Some("Punk".to_owned()),
            tracks: titles
                .iter()
                .enumerate()
                .map(|(i, t)| TrackInfo {
                    number: i as u8 + 1,
                    title: (*t).to_owned(),
                    artist: None,
                    length_ms: None,
                })
                .collect(),
            quality,
            cover_art_release: Some("cover".to_owned()),
            disc_number: None,
            disc_count: None,
            compilation: false,
            release: None,
        }
    }

    use mediaverse_disc_metadata::MatchQuality;

    fn disc(titles: &[&str]) -> AlbumInfo {
        let mut album = release("cd-text", "MxPx", titles, MatchQuality::Exact);
        album.year = None;
        album.genre = None;
        album.cover_art_release = None;
        album.album = "Living in the Chaos".to_owned();
        album
    }

    #[test]
    fn a_release_that_agrees_with_the_disc_fills_its_gaps_and_the_disc_is_not_listed_twice() {
        let on_disc = disc(&["The Good Days", "Mind Control", "Don't Say Goodbye To Me"]);
        let online = release(
            "musicbrainz",
            "MxPx",
            &["The Good Days", "Mind Control", "Don’t Say Goodbye to Me"],
            MatchQuality::Inexact,
        );
        let result = with_cdtext_first(on_disc, vec![online]);
        assert_eq!(result.len(), 1, "one album: the disc's, completed");
        let album = &result[0];
        assert_eq!(album.year, Some(2026));
        assert_eq!(album.cover_art_release.as_deref(), Some("cover"));
        assert_eq!(album.source, "musicbrainz");
        assert_eq!(album.quality, MatchQuality::Exact, "every title agrees");
        // the same name set better keeps the online spelling (the typographic apostrophe)
        assert_eq!(album.tracks[2].title, "Don’t Say Goodbye to Me");
    }

    #[test]
    fn the_discs_names_win_where_a_release_says_something_else() {
        let on_disc = disc(&[
            "The Good Days",
            "Mind Control",
            "Panic Attack",
            "On Saturday",
            "Wrecked My Day",
        ]);
        let online = release(
            "musicbrainz",
            "MxPx",
            &[
                "The Good Days",
                "Mind Control",
                "Panic Attack",
                "On Saturday",
                "Wrecked My Day (Remastered)",
            ],
            MatchQuality::Exact,
        );
        let result = with_cdtext_first(on_disc, vec![online]);
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].tracks[4].title, "Wrecked My Day");
        assert_eq!(result[0].quality, MatchQuality::Exact);
        assert_eq!(result[0].year, Some(2026));
    }

    #[test]
    fn a_release_that_disagrees_is_another_album_and_the_disc_comes_first() {
        let on_disc = disc(&["The Good Days", "Mind Control"]);
        let other = release("itunes", "Someone", &["Aaa", "Bbb"], MatchQuality::Inexact);
        let wrong_count = release("deezer", "MxPx", &["The Good Days"], MatchQuality::Inexact);
        let result = with_cdtext_first(on_disc, vec![other, wrong_count]);
        assert_eq!(result.len(), 3);
        assert_eq!(result[0].source, "cd-text");
        assert_eq!(result[1].source, "itunes");
    }

    #[test]
    fn a_disc_with_nothing_online_is_still_offered() {
        let result = with_cdtext_first(disc(&["A track"]), Vec::new());
        assert_eq!(result.len(), 1);
        assert_eq!(result[0].source, "cd-text");
    }

    #[test]
    fn a_disc_that_says_what_it_holds_becomes_an_exact_album() {
        let reply = json!({
            "tracks": [],
            "cdtext": {
                "album": "LIVING IN THE CHAOS", "artist": "MxPx",
                "tracks": [ { "title": "THE GOOD DAYS", "artist": "MxPx" }, { "title": "MIND CONTROL", "artist": null } ]
            }
        });
        let album = album_from_cdtext(&reply).expect("an album");
        assert_eq!(album.album, "Living in the Chaos");
        assert_eq!(album.album_artist, "MxPx");
        assert_eq!(album.tracks.len(), 2);
        assert_eq!(album.tracks[0].title, "The Good Days");
        assert_eq!(album.tracks[0].artist, None, "same as the album artist");
        assert_eq!(album.quality, mediaverse_disc_metadata::MatchQuality::Exact);
        assert!(album_from_cdtext(&json!({ "tracks": [] })).is_none());
        assert!(
            album_from_cdtext(&json!({ "cdtext": { "tracks": [ { "title": null } ] } })).is_none()
        );
    }
}

#[cfg(test)]
mod fit_tests {
    use super::*;
    use mediaverse_disc_metadata::{AlbumInfo, MatchQuality, TrackInfo, merge::consolidate};

    fn album(source: &str, title: &str, quality: MatchQuality, lengths: &[u32]) -> AlbumInfo {
        AlbumInfo {
            source: source.to_owned(),
            source_id: format!("{source}-{title}"),
            album: title.to_owned(),
            album_artist: "Band".to_owned(),
            year: None,
            genre: None,
            tracks: lengths
                .iter()
                .enumerate()
                .map(|(i, ms)| TrackInfo {
                    number: i as u8 + 1,
                    title: format!("T{}", i + 1),
                    artist: None,
                    length_ms: (*ms > 0).then_some(*ms),
                })
                .collect(),
            quality,
            cover_art_release: None,
            disc_number: None,
            disc_count: None,
            compilation: false,
            release: None,
        }
    }

    #[test]
    fn candidates_get_their_fit_and_a_strong_fit_leads_the_inexact_ones() {
        // A disc of five tracks, each about 200 s (15 000 sectors).
        let toc = DiscToc {
            track_starts: vec![0, 15_000, 30_000, 45_000, 60_000],
            leadout: 75_000,
        };
        let same = [200_500, 199_000, 200_000, 201_000, 200_000];
        let other = [100_000, 300_000, 150_000, 120_000, 90_000];
        let found = with_length_fit(
            consolidate(vec![
                album("itunes", "Other Album", MatchQuality::Inexact, &other),
                album("deezer", "Right Album", MatchQuality::Inexact, &same),
                album(
                    "musicbrainz",
                    "No Lengths",
                    MatchQuality::Inexact,
                    &[0, 0, 0, 0, 0],
                ),
            ]),
            &toc,
        );
        assert_eq!(found[0].album.album, "Right Album");
        assert!(found[0].length_fit.unwrap().strong());
        let by_name = |name: &str| found.iter().find(|c| c.album.album == name).unwrap();
        assert!(by_name("Other Album").length_fit.unwrap().weak());
        assert!(
            by_name("No Lengths").length_fit.is_none(),
            "a source with no lengths says nothing"
        );
    }

    #[test]
    fn an_exact_disc_match_still_comes_first() {
        let toc = DiscToc {
            track_starts: vec![0, 15_000, 30_000, 45_000],
            leadout: 60_000,
        };
        let found = with_length_fit(
            consolidate(vec![
                album("deezer", "Digital", MatchQuality::Inexact, &[200_000; 4]),
                album(
                    "musicbrainz",
                    "Pressing",
                    MatchQuality::Exact,
                    &[0, 0, 0, 0],
                ),
            ]),
            &toc,
        );
        assert_eq!(found[0].album.album, "Pressing");
    }
}

#[cfg(test)]
mod patience_tests {
    use super::*;

    fn reply(status: u16, retry_after: Option<u64>) -> SourceResult<HttpReply> {
        Ok(HttpReply {
            status,
            body: Vec::new(),
            retry_after: retry_after.map(Duration::from_secs),
        })
    }

    #[test]
    fn only_the_busy_services_are_asked_again() {
        for host in [
            "musicbrainz.org",
            "MusicBrainz.org",
            "coverartarchive.org",
            "ia800000.us.archive.org",
            "archive.org",
        ] {
            assert!(is_patient_host(host), "{host}");
        }
        for host in [
            "127.0.0.1",
            "lrclib.net",
            "api.discogs.com",
            "notmusicbrainz.org",
            "musicbrainz.org.example.com",
        ] {
            assert!(!is_patient_host(host), "{host}");
        }
    }

    #[test]
    fn a_busy_answer_is_tried_again_after_the_pauses_and_a_good_one_ends_it() {
        let mut answers = vec![503, 503, 200].into_iter();
        let mut tries = 0;
        let mut waited = Vec::new();
        let got = with_patience(
            || {
                tries += 1;
                reply(answers.next().unwrap(), None)
            },
            &RETRY_PAUSES,
            |pause| waited.push(pause),
        )
        .unwrap();
        assert_eq!(got.status, 200);
        assert_eq!(tries, 3);
        assert_eq!(waited, vec![RETRY_PAUSES[0], RETRY_PAUSES[1]]);
    }

    #[test]
    fn a_refusal_that_does_not_go_away_is_returned_after_every_pause_has_been_used() {
        let mut tries = 0;
        let got = with_patience(
            || {
                tries += 1;
                reply(503, None)
            },
            &RETRY_PAUSES,
            |_| {},
        )
        .unwrap();
        assert_eq!(got.status, 503);
        assert_eq!(tries, 1 + RETRY_PAUSES.len());
    }

    #[test]
    fn other_answers_are_never_repeated_and_a_retry_after_is_followed_but_capped() {
        let mut tries = 0;
        let got = with_patience(
            || {
                tries += 1;
                reply(404, None)
            },
            &RETRY_PAUSES,
            |_| panic!("a 404 is final"),
        )
        .unwrap();
        assert_eq!((got.status, tries), (404, 1));

        let mut answers = vec![(429, Some(4)), (503, Some(600)), (200, None)].into_iter();
        let mut waited = Vec::new();
        let got = with_patience(
            || {
                let (status, after) = answers.next().unwrap();
                reply(status, after)
            },
            &RETRY_PAUSES,
            |pause| waited.push(pause),
        )
        .unwrap();
        assert_eq!(got.status, 200);
        assert_eq!(waited, vec![Duration::from_secs(4), MAX_RETRY_AFTER]);
    }
}

#[cfg(test)]
mod live_patience_check {
    use super::*;

    /// Asks the real MusicBrainz 12 times, 1.2 s apart, the way the program does, and counts how many ended as a refusal after the retries (and how many first
    /// answers were refusals without them). Run on purpose: `cargo test -p mediaverse_sidecar --lib live_patience_check -- --ignored --nocapture`.
    #[test]
    #[ignore = "uses the real MusicBrainz"]
    fn musicbrainz_answers_after_the_retries() {
        let ua = "MediaVerseStudio/0.9.0 ( contact@mediaverse.studio )";
        let url =
            "https://musicbrainz.org/ws/2/artist/5b11f4ce-a62d-471e-81fc-a69a8278c7da?fmt=json";
        let (mut first_refused, mut final_refused) = (0, 0);
        for _ in 0..12 {
            let once = http_get_with(url, ua, Duration::from_secs(20), &[]).unwrap();
            if matches!(once.status, 429 | 503) {
                first_refused += 1;
            }
            std::thread::sleep(Duration::from_millis(1200));
            let patient = http_get(url, ua, Duration::from_secs(20)).unwrap();
            if matches!(patient.status, 429 | 503) {
                final_refused += 1;
            }
            std::thread::sleep(Duration::from_millis(1200));
        }
        println!(
            "single tries refused: {first_refused} of 12; after the retries still refused: {final_refused} of 12"
        );
        assert!(final_refused <= first_refused);
    }
}
