//! Review > Fix tags (ADR 0009): a library-wide, read-only scan that recognises album folders with missing or
//! placeholder tags and keeps the proposals for the review page. Nothing in this module writes to the user's
//! files; the only thing written is the results database in the app's data folder.
//!
//! For each folder: read every audio file's tags and exact length (lofty), skip folders with nothing to fill,
//! rebuild the disc's table of contents from the lengths and ask MusicBrainz for releases with that layout; if
//! that finds nothing, search MusicBrainz by the artist and album the tags or folder names give and look up the
//! releases with the same number of tracks. The matcher (`mediaverse_tag_repair`) scores each release and
//! proposes values for empty or placeholder fields only. Results are kept per folder with a signature of its
//! files, so a later scan skips folders that have not changed and resumes after a stop.

use crate::lookup::{MetadataState, SourceResult, fail, http_get};
use lofty::file::{AudioFile, TaggedFileExt};
use lofty::tag::{Accessor, ItemKey};
use mediaverse_disc_metadata::musicbrainz;
use mediaverse_disc_metadata::settings::MetadataSettings;
use mediaverse_tag_repair::{Folder, FolderFile, Proposal, Release, Tags, parse_releases, rank};
use rusqlite::{Connection, params};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicUsize, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

const AUDIO: [&str; 7] = ["mp3", "m4a", "flac", "ogg", "opus", "wma", "aac"];
/// Fewer files than this are left to fingerprints (a later step): a TOC of one or two tracks fits too much.
const MIN_FILES: usize = 3;
const MAX_PROPOSALS: usize = 6;
/// Below this a candidate is not offered at all: a fuzzy TOC search always returns something, and a release
/// whose lengths and names do not fit (for example Kenny Rogers for a 10,000 Maniacs album) is noise.
const MIN_CONFIDENCE: u8 = 50;
/// Raised when the checks change in a way that can change a folder's result without its files changing (2: titles
/// their file names also give, 2026-11-05). See `run`.
const SCAN_VERSION: u32 = 2;
const APP_NAME: &str = "MediaVerseStudio";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");

/// Every album folder under `root`: folders holding audio files, with those files sorted by name.
pub fn album_folders(root: &Path) -> Vec<(PathBuf, Vec<PathBuf>)> {
    let mut folders: BTreeMap<PathBuf, Vec<PathBuf>> = BTreeMap::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            if mediaverse_library_filesystem::is_system_clutter(
                &entry.file_name().to_string_lossy(),
            ) {
                continue;
            }
            let Ok(kind) = entry.file_type() else {
                continue;
            };
            if kind.is_dir() {
                pending.push(path);
            } else if kind.is_file()
                && path
                    .extension()
                    .and_then(|e| e.to_str())
                    .is_some_and(|e| AUDIO.contains(&e.to_ascii_lowercase().as_str()))
            {
                folders.entry(dir.clone()).or_default().push(path);
            }
        }
    }
    folders
        .into_iter()
        .map(|(dir, mut files)| {
            files.sort();
            (dir, files)
        })
        .collect()
}

/// A folder's signature: its files' names, sizes and modification times, so changed folders are scanned again.
pub(crate) fn signature(files: &[PathBuf]) -> String {
    let mut total: u64 = 0;
    let mut latest: u64 = 0;
    for file in files {
        if let Ok(meta) = std::fs::metadata(file) {
            total = total.wrapping_add(meta.len());
            let modified = meta
                .modified()
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs());
            latest = latest.max(modified);
        }
    }
    format!("{}:{}:{}", files.len(), total, latest)
}

/// One file's tags and exact length, read without changing anything.
pub fn read_file(path: &Path) -> Result<FolderFile, String> {
    let tagged = mediaverse_metadata_tags::read_tagged(path).map_err(|e| e.to_string())?;
    let length_ms = tagged.properties().duration().as_millis() as u64;
    let tag = tagged.primary_tag().or_else(|| tagged.first_tag());
    let tags = tag.map_or_else(Tags::default, |tag| Tags {
        title: tag.title().map(|v| v.into_owned()),
        artist: tag.artist().map(|v| v.into_owned()),
        album: tag.album().map(|v| v.into_owned()),
        album_artist: tag.get_string(&ItemKey::AlbumArtist).map(ToOwned::to_owned),
        genre: tag.genre().map(|v| v.into_owned()),
        year: tag.year(),
        track: tag.track(),
        disc: tag.disk(),
    });
    Ok(FolderFile {
        path: path.to_string_lossy().into_owned(),
        stem: path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default(),
        tags,
        length_ms,
    })
}

/// The folder names from `dir` up to (not including) the library root.
pub(crate) fn parents(dir: &Path, root: &Path) -> Vec<String> {
    let mut names = Vec::new();
    let mut at = Some(dir);
    while let Some(folder) = at {
        if folder == root || !folder.starts_with(root) {
            break;
        }
        if let Some(name) = folder.file_name() {
            names.push(name.to_string_lossy().into_owned());
        }
        at = folder.parent();
    }
    names
}

/// Where scan results are kept: `tag-repair.sqlite` in the app's data folder.
pub struct TagRepairStore {
    path: PathBuf,
}

impl TagRepairStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("tag-repair.sqlite"),
        }
    }

    fn open(&self) -> rusqlite::Result<Connection> {
        let connection = Connection::open(&self.path)?;
        connection.busy_timeout(Duration::from_secs(10))?;
        connection.execute_batch(
            "PRAGMA journal_mode = WAL;
             PRAGMA synchronous = NORMAL;
             CREATE TABLE IF NOT EXISTS folders (
               path TEXT PRIMARY KEY, signature TEXT NOT NULL, status TEXT NOT NULL,
               confidence INTEGER NOT NULL DEFAULT 0, scanned_at INTEGER NOT NULL, result TEXT NOT NULL);
             CREATE INDEX IF NOT EXISTS folders_status ON folders (status, confidence);
             -- The undo journal: each press of Apply is a batch; for every album its row before, and for every
             -- field written its value before and after.
             CREATE TABLE IF NOT EXISTS batches (
               id INTEGER PRIMARY KEY AUTOINCREMENT, at INTEGER NOT NULL, albums INTEGER NOT NULL,
               files INTEGER NOT NULL, undone INTEGER NOT NULL DEFAULT 0);
             CREATE TABLE IF NOT EXISTS batch_folders (
               batch INTEGER NOT NULL, path TEXT NOT NULL, status TEXT NOT NULL, confidence INTEGER NOT NULL, result TEXT NOT NULL);
             CREATE TABLE IF NOT EXISTS batch_changes (
               batch INTEGER NOT NULL, path TEXT NOT NULL, field TEXT NOT NULL, old TEXT, new TEXT);
             -- MusicBrainz's genre for an artist (NULL: it has none), looked up once and remembered.
             CREATE TABLE IF NOT EXISTS artist_genre_hints (
               artist TEXT PRIMARY KEY, genre TEXT, looked_up_at INTEGER NOT NULL);
             -- Placeholder-looking values the person confirmed as right (a song called \"Untitled\"), per file and
             -- field; a check does not list them again while the file still has that value.
             CREATE TABLE IF NOT EXISTS confirmed_values (
               path TEXT NOT NULL, field TEXT NOT NULL, value TEXT NOT NULL, at INTEGER NOT NULL,
               PRIMARY KEY (path, field));",
        )?;
        Ok(connection)
    }

    /// Every confirmed value: (file path, field) → value.
    fn confirmed_values(&self) -> rusqlite::Result<BTreeMap<(String, String), String>> {
        let connection = self.open()?;
        let mut statement =
            connection.prepare("SELECT path, field, value FROM confirmed_values")?;
        let rows = statement.query_map([], |r| {
            Ok((
                (r.get::<_, String>(0)?, r.get::<_, String>(1)?),
                r.get::<_, String>(2)?,
            ))
        })?;
        rows.collect()
    }

    fn confirm_value(&self, path: &str, field: &str, value: &str) -> rusqlite::Result<()> {
        self.open()?.execute(
            "INSERT INTO confirmed_values (path, field, value, at) VALUES (?1, ?2, ?3, ?4) ON CONFLICT(path, field) DO UPDATE SET value = ?3, at = ?4",
            params![path, field, value, now_secs() as i64],
        )?;
        Ok(())
    }

    /// One folder's stored row: (signature, status, confidence, result).
    fn row(&self, path: &str) -> rusqlite::Result<Option<(String, String, i64, Value)>> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare("SELECT signature, status, confidence, result FROM folders WHERE path = ?1")?;
        let mut rows = statement.query_map(params![path], |r| {
            let result: String = r.get(3)?;
            Ok((
                r.get(0)?,
                r.get(1)?,
                r.get(2)?,
                serde_json::from_str(&result).unwrap_or(Value::Null),
            ))
        })?;
        rows.next().transpose()
    }

    /// The most recent batch that has not been undone: `{id, at, albums, files}`, or null.
    pub fn last_batch(&self) -> rusqlite::Result<Value> {
        let connection = self.open()?;
        let mut statement = connection.prepare(
            "SELECT id, at, albums, files FROM batches WHERE undone = 0 ORDER BY id DESC LIMIT 1",
        )?;
        let mut rows = statement.query_map([], |r| Ok(json!({ "id": r.get::<_, i64>(0)?, "at": r.get::<_, i64>(1)?, "albums": r.get::<_, i64>(2)?, "files": r.get::<_, i64>(3)? })))?;
        Ok(rows.next().transpose()?.unwrap_or(Value::Null))
    }

    /// Each artist's usual genre in the library: the genre most of their songs have (at least three songs, and
    /// more than any other genre), from every folder checked, with genres written by Apply since counted too.
    fn library_genres(&self) -> rusqlite::Result<BTreeMap<String, String>> {
        let connection = self.open()?;
        let written: BTreeMap<String, String> = connection
            .prepare("SELECT c.path, c.new FROM batch_changes c JOIN batches b ON b.id = c.batch WHERE b.undone = 0 AND c.field = 'genre' AND c.new IS NOT NULL ORDER BY c.batch")?
            .query_map([], |r| Ok((r.get::<_, String>(0)?, r.get::<_, String>(1)?)))?
            .collect::<rusqlite::Result<_>>()?;
        let mut counts: BTreeMap<String, BTreeMap<String, usize>> = BTreeMap::new();
        let mut statement = connection.prepare("SELECT result FROM folders")?;
        for result in statement.query_map([], |r| r.get::<_, String>(0))? {
            let Ok(result) = serde_json::from_str::<Value>(&result?) else {
                continue;
            };
            for file in result["files"].as_array().into_iter().flatten() {
                let tags = &file["tags"];
                let Some(artist) =
                    tag_text(&tags["album_artist"]).or_else(|| tag_text(&tags["artist"]))
                else {
                    continue;
                };
                if mediaverse_tag_repair::names::is_various(&artist) {
                    continue;
                }
                let genre = file["path"]
                    .as_str()
                    .and_then(|p| written.get(p).cloned())
                    .or_else(|| tag_text(&tags["genre"]));
                if let Some(genre) = genre {
                    *counts
                        .entry(artist_key(&artist))
                        .or_default()
                        .entry(genre)
                        .or_default() += 1;
                }
            }
        }
        Ok(counts
            .into_iter()
            .filter_map(|(artist, genres)| {
                let mut ranked: Vec<(String, usize)> = genres.into_iter().collect();
                ranked.sort_by(|a, b| b.1.cmp(&a.1));
                let (top, n) = ranked.first()?.clone();
                (n >= 3 && ranked.get(1).is_none_or(|(_, second)| *second < n))
                    .then_some((artist, top))
            })
            .collect())
    }

    /// MusicBrainz's genre for an artist if looked up before: Some(None) when it has none.
    fn cached_artist_genre(&self, key: &str) -> Option<Option<String>> {
        self.open()
            .ok()?
            .query_row(
                "SELECT genre FROM artist_genre_hints WHERE artist = ?1",
                params![key],
                |r| r.get(0),
            )
            .ok()
    }

    fn save_artist_genre(&self, key: &str, genre: Option<&str>) -> rusqlite::Result<()> {
        self.open()?.execute(
            "INSERT INTO artist_genre_hints (artist, genre, looked_up_at) VALUES (?1, ?2, ?3) ON CONFLICT(artist) DO UPDATE SET genre = ?2, looked_up_at = ?3",
            params![key, genre, now_secs() as i64],
        )?;
        Ok(())
    }

    /// Each folder's (signature, status, confidence, whether some files could not be read, whether it was checked by
    /// this version of the checks: see [`SCAN_VERSION`]).
    fn signatures(&self) -> rusqlite::Result<BTreeMap<String, (String, String, i64, bool, bool)>> {
        let connection = self.open()?;
        let current = format!("\"scan_version\":{SCAN_VERSION}");
        let mut statement = connection.prepare("SELECT path, signature, status, confidence, instr(result, '\"unreadable\":[{') > 0, instr(result, ?1) > 0 FROM folders")?;
        let rows = statement.query_map(params![current], |row| {
            Ok((
                row.get::<_, String>(0)?,
                (
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, i64>(3)?,
                    row.get::<_, bool>(4)?,
                    row.get::<_, bool>(5)?,
                ),
            ))
        })?;
        rows.collect()
    }

    fn save(
        &self,
        path: &str,
        signature: &str,
        status: &str,
        confidence: u8,
        result: &Value,
    ) -> rusqlite::Result<()> {
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        self.open()?.execute(
            "INSERT INTO folders (path, signature, status, confidence, scanned_at, result) VALUES (?1, ?2, ?3, ?4, ?5, ?6)
             ON CONFLICT(path) DO UPDATE SET signature = ?2, status = ?3, confidence = ?4, scanned_at = ?5, result = ?6",
            params![path, signature, status, confidence, now as i64, result.to_string()],
        )?;
        Ok(())
    }

    fn signature_of(&self, path: &str) -> rusqlite::Result<String> {
        self.open()?.query_row(
            "SELECT signature FROM folders WHERE path = ?1",
            params![path],
            |r| r.get(0),
        )
    }

    /// Albums the person has looked at and wants left as they are (owner, 2026-11-16: Wagon Christ's Studio Session 1,
    /// really "Track 1" to "Track 11", kept coming back). A left-alone album keeps its stored result, is not listed with
    /// the albums needing a fix, and is not checked again by any scan. Only albums already checked can be set aside.
    pub fn leave_alone(&self, paths: &[String]) -> rusqlite::Result<usize> {
        let connection = self.open()?;
        let mut changed = 0;
        for path in paths {
            changed += connection.execute("UPDATE folders SET status = 'left_alone' WHERE path = ?1 AND status <> 'left_alone'", params![path])?;
        }
        Ok(changed)
    }

    /// Takes albums back into the checks: their rows are forgotten, so the next check reads them as new.
    pub fn stop_leaving_alone(&self, paths: &[String]) -> rusqlite::Result<usize> {
        let connection = self.open()?;
        let mut changed = 0;
        for path in paths {
            changed += connection.execute(
                "DELETE FROM folders WHERE path = ?1 AND status = 'left_alone'",
                params![path],
            )?;
        }
        Ok(changed)
    }

    /// Records fields written outside Apply (the Album IDs comparison) as one batch, so "Undo it" can put them back.
    /// `changes`: (file, field, value before, value after). Returns the batch number, or none when nothing was written.
    pub(crate) fn journal(
        &self,
        changes: &[(String, String, Option<String>, Option<String>)],
        albums: usize,
        files: usize,
    ) -> rusqlite::Result<Option<i64>> {
        if changes.is_empty() {
            return Ok(None);
        }
        let connection = self.open()?;
        connection.execute(
            "INSERT INTO batches (at, albums, files) VALUES (?1, ?2, ?3)",
            params![now_secs() as i64, albums as i64, files as i64],
        )?;
        let batch = connection.last_insert_rowid();
        for (path, field, old, new) in changes {
            connection.execute("INSERT INTO batch_changes (batch, path, field, old, new) VALUES (?1, ?2, ?3, ?4, ?5)", params![batch, path, field, old, new])?;
        }
        Ok(Some(batch))
    }

    /// Forgets folders no longer in the library.
    fn forget_except(&self, keep: &std::collections::HashSet<String>) -> rusqlite::Result<()> {
        let connection = self.open()?;
        let known: Vec<String> = connection
            .prepare("SELECT path FROM folders")?
            .query_map([], |r| r.get(0))?
            .collect::<rusqlite::Result<_>>()?;
        for path in known.into_iter().filter(|p| !keep.contains(p)) {
            connection.execute("DELETE FROM folders WHERE path = ?1", params![path])?;
        }
        Ok(())
    }

    /// Counts per review group, and one page of folders: `filter` is "ready" (90 or more), "choose" (identified
    /// below 90), "none" (needs fixing, not identified) or "all" (every folder that needs fixing); best first.
    pub fn page(&self, filter: &str, offset: usize, limit: usize) -> rusqlite::Result<Value> {
        let connection = self.open()?;
        let count =
            |sql: &str| -> rusqlite::Result<i64> { connection.query_row(sql, [], |r| r.get(0)) };
        let summary = json!({
            "ready": count("SELECT COUNT(*) FROM folders WHERE status = 'identified' AND confidence >= 90")?,
            "choose": count("SELECT COUNT(*) FROM folders WHERE status = 'identified' AND confidence < 90")?,
            "none": count("SELECT COUNT(*) FROM folders WHERE status IN ('no_match', 'too_few', 'error')")?,
            "complete": count("SELECT COUNT(*) FROM folders WHERE status = 'complete'")?,
            "applied": count("SELECT COUNT(*) FROM folders WHERE status = 'applied'")?,
            "left_alone": count("SELECT COUNT(*) FROM folders WHERE status = 'left_alone'")?,
            "scanned": count("SELECT COUNT(*) FROM folders")?,
        });
        // "applied": fixed here and waiting for the next check, which reads the folder again.
        let condition = match filter {
            "ready" => "status = 'identified' AND confidence >= 90",
            "choose" => "status = 'identified' AND confidence < 90",
            "none" => "status IN ('no_match', 'too_few', 'error')",
            "left_alone" => "status = 'left_alone'",
            _ => "status IN ('identified', 'no_match', 'too_few', 'error')",
        };
        let sql = format!(
            "SELECT path, status, confidence, result FROM folders WHERE {condition} ORDER BY status = 'identified' DESC, confidence DESC, path LIMIT ?1 OFFSET ?2"
        );
        let mut statement = connection.prepare(&sql)?;
        let rows = statement.query_map(params![limit as i64, offset as i64], |row| {
            let result: String = row.get(3)?;
            let mut result = serde_json::from_str::<Value>(&result).unwrap_or(Value::Null);
            prepare(&mut result);
            Ok(json!({
                "path": row.get::<_, String>(0)?,
                "status": row.get::<_, String>(1)?,
                "confidence": row.get::<_, i64>(2)?,
                "result": result,
            }))
        })?;
        let folders: Vec<Value> = rows.collect::<rusqlite::Result<_>>()?;
        let total: i64 = connection.query_row(
            &format!("SELECT COUNT(*) FROM folders WHERE {condition}"),
            [],
            |r| r.get(0),
        )?;
        drop(statement);
        drop(connection);
        Ok(
            json!({ "summary": summary, "total": total, "offset": offset, "folders": folders, "last_batch": self.last_batch()? }),
        )
    }
}

/// Progress of a running scan, for `tag_repair_status` and the `job-progress` events.
pub struct ScanState {
    pub job_id: String,
    pub total: AtomicUsize,
    pub done: AtomicUsize,
    pub identified: AtomicUsize,
    pub unmatched: AtomicUsize,
    pub current: Mutex<String>,
}

impl ScanState {
    pub fn new(job_id: &str) -> Arc<Self> {
        Arc::new(Self {
            job_id: job_id.to_owned(),
            total: AtomicUsize::new(0),
            done: AtomicUsize::new(0),
            identified: AtomicUsize::new(0),
            unmatched: AtomicUsize::new(0),
            current: Mutex::new(String::new()),
        })
    }

    pub fn json(&self) -> Value {
        json!({
            "running": true,
            "job_id": self.job_id,
            "total": self.total.load(Ordering::Relaxed),
            "done": self.done.load(Ordering::Relaxed),
            "identified": self.identified.load(Ordering::Relaxed),
            "unmatched": self.unmatched.load(Ordering::Relaxed),
            "current": self.current.lock().map(|c| c.clone()).unwrap_or_default(),
        })
    }
}

/// Asks MusicBrainz (politely: one request per the configured interval, backing off when refused).
pub(crate) fn musicbrainz_get(
    url: &str,
    settings: &MetadataSettings,
    state: &MetadataState,
) -> SourceResult<Option<String>> {
    let mb = &settings.musicbrainz;
    let contact = settings.identity.contact.trim();
    let ua = musicbrainz::user_agent(
        APP_NAME,
        APP_VERSION,
        if contact.is_empty() {
            "https://mediaverse.studio"
        } else {
            contact
        },
    );
    for attempt in 0..3 {
        state.wait_turn(
            "musicbrainz",
            Duration::from_millis(mb.min_interval_ms.max(1_000)),
        );
        let reply = http_get(url, &ua, Duration::from_secs(mb.timeout_seconds.max(10)))?;
        match reply.status {
            200 => {
                state.outcome("musicbrainz", false, None);
                return Ok(Some(String::from_utf8_lossy(&reply.body).into_owned()));
            }
            404 => {
                state.outcome("musicbrainz", false, None);
                return Ok(None);
            }
            429 | 503 if attempt < 2 => {
                state.outcome("musicbrainz", true, reply.retry_after);
                std::thread::sleep(
                    reply
                        .retry_after
                        .unwrap_or(Duration::from_secs(5 * (attempt + 1) as u64)),
                );
            }
            429 | 503 => {
                return fail(
                    "rate_limited",
                    "MusicBrainz is busy or limiting requests right now. Try again in a few minutes.",
                );
            }
            other => return fail("http_error", format!("MusicBrainz answered HTTP {other}.")),
        }
    }
    fail(
        "rate_limited",
        "MusicBrainz is busy or limiting requests right now. Try again in a few minutes.",
    )
}

/// Lucene-escaped phrase for a MusicBrainz search.
fn phrase(text: &str) -> String {
    let escaped: String = text
        .chars()
        .flat_map(|c| {
            if "+-&|!(){}[]^\"~*?:\\/".contains(c) {
                vec!['\\', c]
            } else {
                vec![c]
            }
        })
        .collect();
    format!("\"{escaped}\"")
}

pub(crate) fn url_encode(text: &str) -> String {
    mediaverse_disc_metadata::musicbrainz::percent_encode(text)
}

const RELEASE_INC: &str = "artist-credits+labels+recordings+release-groups+genres";

/// Releases found by name: a search by album and artist, then a full lookup of up to three results that have a
/// disc with as many tracks as the folder has files.
/// The album and artist a folder's tags (unless placeholders) or folder names give.
fn names_for(folder: &Folder) -> (Option<String>, Option<String>) {
    let clues = folder.clues();
    let known = |pick: fn(&Tags) -> Option<String>| {
        folder
            .files
            .iter()
            .find_map(|f| pick(&f.tags).filter(|v| !mediaverse_tag_repair::is_placeholder(Some(v))))
    };
    let album = known(|t| t.album.clone()).or(clues.album);
    let artist = known(|t| t.album_artist.clone())
        .or_else(|| known(|t| t.artist.clone()))
        .or(clues.artist);
    (album, artist)
}

/// Discogs may be used: switched on, with the person's token.
pub(crate) fn discogs_ready(settings: &MetadataSettings) -> bool {
    settings.discogs.enabled && settings.discogs.token.is_set()
}

/// Asks Discogs with the person's token, at most once a second (60 a minute), backing off when refused.
pub(crate) fn discogs_get(
    url: &str,
    settings: &MetadataSettings,
    state: &MetadataState,
) -> SourceResult<Option<String>> {
    let auth = format!("Discogs token={}", settings.discogs.token.expose());
    let ua = format!("{APP_NAME}/{APP_VERSION} +https://mediaverse.studio");
    for attempt in 0..3 {
        state.wait_turn(
            "discogs",
            Duration::from_millis(settings.discogs.min_interval_ms.max(1_000)),
        );
        let reply = crate::lookup::http_get_with(
            url,
            &ua,
            Duration::from_secs(20),
            &[("Authorization", &auth)],
        )?;
        match reply.status {
            200 => {
                state.outcome("discogs", false, None);
                return Ok(Some(String::from_utf8_lossy(&reply.body).into_owned()));
            }
            404 => return Ok(None),
            401 | 403 => {
                return fail(
                    "discogs_refused",
                    "Discogs refused the access token: check it in Settings.",
                );
            }
            429 if attempt < 2 => {
                state.outcome("discogs", true, reply.retry_after);
                std::thread::sleep(reply.retry_after.unwrap_or(Duration::from_secs(30)));
            }
            other => return fail("http_error", format!("Discogs answered HTTP {other}.")),
        }
    }
    fail("rate_limited", "Discogs is limiting requests.")
}

fn discogs_release(
    id: u64,
    settings: &MetadataSettings,
    state: &MetadataState,
) -> SourceResult<Option<Release>> {
    let base = settings.discogs.base_url.trim_end_matches('/');
    match discogs_get(&format!("{base}/releases/{id}"), settings, state)? {
        Some(body) => mediaverse_tag_repair::discogs::parse_release(&body)
            .map_err(|e| ("bad_reply".to_owned(), e)),
        None => Ok(None),
    }
}

/// Releases found on Discogs by artist and album (the first three search results, looked up in full).
fn search_discogs(
    folder: &Folder,
    settings: &MetadataSettings,
    state: &MetadataState,
) -> SourceResult<Vec<Release>> {
    let (album, artist) = names_for(folder);
    let Some(album) = album else {
        return Ok(Vec::new());
    };
    let base = settings.discogs.base_url.trim_end_matches('/');
    let mut url = format!(
        "{base}/database/search?type=release&per_page=10&release_title={}",
        url_encode(&album)
    );
    if let Some(artist) = artist {
        url.push_str(&format!("&artist={}", url_encode(&artist)));
    }
    let Some(body) = discogs_get(&url, settings, state)? else {
        return Ok(Vec::new());
    };
    let ids = mediaverse_tag_repair::discogs::search_ids(&body)
        .map_err(|e| ("bad_reply".to_owned(), e))?;
    let mut releases = Vec::new();
    for id in ids.into_iter().take(3) {
        releases.extend(discogs_release(id, settings, state)?);
    }
    Ok(releases)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Discogs' API terms: its data may not be shown when more than six hours older than Discogs. Before a page is
/// shown, folders identified from Discogs longer ago than that are looked up again (and saved); if that is not
/// possible, their suggestions are left out of the page with a note.
const DISCOGS_FRESH_SECS: u64 = 6 * 3600;

/// Genre suggestions for the albums on a page whose release names no genre (see [`GenreHints`]).
pub fn suggest_genres(
    store: &TagRepairStore,
    page: &mut Value,
    settings: &MetadataSettings,
    state: &MetadataState,
) {
    let mut hints = GenreHints::new(store, Some((settings, state)));
    for entry in page["folders"].as_array_mut().into_iter().flatten() {
        hints.fill(&mut entry["result"]);
    }
    // The genres the library's artists mostly have, for the Genre box's list to pick from.
    let genres: std::collections::BTreeSet<&String> = hints.library.values().collect();
    page["genres"] = json!(genres);
}

pub fn refresh_stale_discogs(
    store: &TagRepairStore,
    page: &mut Value,
    settings: &MetadataSettings,
    state: &MetadataState,
) {
    let Some(folders) = page["folders"].as_array_mut() else {
        return;
    };
    for entry in folders {
        let result = &entry["result"];
        if result["method"].as_str() != Some("Discogs")
            || now_secs().saturating_sub(result["fetched_at"].as_u64().unwrap_or(0))
                < DISCOGS_FRESH_SECS
        {
            continue;
        }
        let refreshed = (|| -> Option<(String, u8, Value)> {
            if !discogs_ready(settings) {
                return None;
            }
            let files: Vec<FolderFile> = result["files"]
                .as_array()?
                .iter()
                .map(|f| {
                    Some(FolderFile {
                        path: f["path"].as_str()?.to_owned(),
                        stem: f["stem"].as_str()?.to_owned(),
                        tags: serde_json::from_value(f["tags"].clone()).ok()?,
                        length_ms: f["length_ms"].as_u64()?,
                    })
                })
                .collect::<Option<_>>()?;
            let parents: Vec<String> =
                serde_json::from_value(result["parents"].clone()).unwrap_or_default();
            let folder = Folder { parents, files };
            // Only the leading edition is looked up again (one request, Discogs allows about one a second): this runs
            // while a page of results is being answered, and looking up every edition held every other command up.
            // The other editions are older than six hours and so are not shown (Discogs' terms); a new scan of the
            // folder brings them back.
            let mut releases = Vec::new();
            if let Some(proposal) = result["proposals"].as_array()?.first() {
                let id = proposal["release_id"]
                    .as_str()?
                    .strip_prefix("discogs:")?
                    .parse()
                    .ok()?;
                releases.extend(discogs_release(id, settings, state).ok()?);
            }
            let mut proposals = credible(rank(&folder, &releases));
            if proposals.is_empty() {
                return None;
            }
            proposals.truncate(MAX_PROPOSALS);
            let mut updated = result.clone();
            updated["proposals"] = json!(proposals);
            updated["fetched_at"] = json!(now_secs());
            Some(("identified".into(), proposals[0].confidence, updated))
        })();
        let path = entry["path"].as_str().unwrap_or_default().to_owned();
        match refreshed {
            Some((status, confidence, updated)) => {
                if let Ok(signature) = store.signature_of(&path) {
                    let _ = store.save(&path, &signature, &status, confidence, &updated);
                }
                entry["confidence"] = json!(confidence);
                let mut updated = updated;
                follow_album(&mut updated); // as every other result on the page
                entry["result"] = updated;
            }
            None => {
                if let Some(map) = entry["result"].as_object_mut() {
                    map.remove("proposals");
                    map.insert("note".into(), json!("Discogs suggestions are older than six hours and could not be looked up again; scan this folder again."));
                }
            }
        }
    }
}

pub(crate) fn search_by_name(
    folder: &Folder,
    settings: &MetadataSettings,
    state: &MetadataState,
) -> SourceResult<Vec<Release>> {
    let (album, artist) = names_for(folder);
    let Some(album) = album else {
        return Ok(Vec::new());
    };
    // Edition words in the folder's name ("[Demo]", "(Reissue)", "[EP]") are not in MusicBrainz's titles.
    let album = mediaverse_tag_repair::names::without_qualifiers(&album);
    let artist = artist.filter(|a| !mediaverse_tag_repair::names::is_various(a));
    let base = settings.musicbrainz.base_url.trim_end_matches('/');
    let count = folder.files.len() as u64;
    // First the exact phrases; if they find nothing, the words loosely ("Vol. 2" against "Volume 2").
    let loose = |text: &str| -> String {
        let words: Vec<String> = text
            .split(|c: char| !c.is_alphanumeric())
            .filter(|w| w.len() > 1 || w.chars().all(|c| c.is_ascii_digit()))
            .map(str::to_owned)
            .collect();
        format!("({})", words.join(" "))
    };
    let mut ids: Vec<String> = Vec::new();
    for (exact, min_score) in [(true, 80), (false, 60)] {
        let mut query = format!(
            "release:{}",
            if exact { phrase(&album) } else { loose(&album) }
        );
        if let Some(artist) = &artist {
            query.push_str(&format!(
                " AND artist:{}",
                if exact { phrase(artist) } else { loose(artist) }
            ));
        }
        let url = format!(
            "{base}/ws/2/release/?query={}&limit=25&fmt=json",
            url_encode(&query)
        );
        let Some(body) = musicbrainz_get(&url, settings, state)? else {
            continue;
        };
        let found: Value =
            serde_json::from_str(&body).map_err(|e| ("bad_reply".to_owned(), e.to_string()))?;
        ids = found["releases"]
            .as_array()
            .map(|releases| {
                releases
                    .iter()
                    .filter(|r| r["score"].as_u64().unwrap_or(0) >= min_score)
                    .filter(|r| {
                        r["media"].as_array().is_some_and(|media| {
                            media.iter().any(|m| {
                                m["track-count"]
                                    .as_u64()
                                    .is_some_and(|n| n > 0 && n.abs_diff(count) * 4 <= n)
                            }) || media
                                .iter()
                                .filter_map(|m| m["track-count"].as_u64())
                                .sum::<u64>()
                                == count
                        })
                    })
                    .filter_map(|r| r["id"].as_str().map(ToOwned::to_owned))
                    .take(5)
                    .collect()
            })
            .unwrap_or_default();
        if !ids.is_empty() {
            break;
        }
    }
    let mut releases = Vec::new();
    for id in ids {
        if let Some(body) = musicbrainz_get(
            &format!("{base}/ws/2/release/{id}?inc={RELEASE_INC}&fmt=json"),
            settings,
            state,
        )? {
            releases.extend(parse_releases(&body).map_err(|e| ("bad_reply".to_owned(), e))?);
        }
    }
    Ok(releases)
}

pub(crate) fn credible(proposals: Vec<Proposal>) -> Vec<Proposal> {
    proposals
        .into_iter()
        .filter(|p| p.confidence >= MIN_CONFIDENCE)
        .collect()
}

/// One folder: read, decide, look up, match. Returns (status, confidence, result to keep).
fn scan_folder(
    dir: &Path,
    files: &[PathBuf],
    root: &Path,
    settings: &MetadataSettings,
    state: &MetadataState,
    confirmed: &BTreeMap<(String, String), String>,
) -> (String, u8, Value) {
    let mut read = Vec::with_capacity(files.len());
    let mut unreadable = Vec::new();
    for file in files {
        match read_file(file) {
            Ok(entry) => read.push(entry),
            Err(message) => {
                unreadable.push(json!({ "path": file.to_string_lossy(), "message": message }))
            }
        }
    }
    let folder = Folder {
        parents: parents(dir, root),
        files: read,
    };
    let files_json: Vec<Value> = folder
        .files
        .iter()
        .map(|f| json!({ "path": f.path, "stem": f.stem, "tags": f.tags, "length_ms": f.length_ms, "missing": f.tags.missing() }))
        .collect();
    let base = json!({ "scan_version": SCAN_VERSION, "folder": dir.to_string_lossy(), "clues": { "artist": folder.clues().artist, "album": folder.clues().album }, "files": files_json, "unreadable": unreadable });
    let with = |mut value: Value, extra: Value| {
        if let (Some(map), Some(extra)) = (value.as_object_mut(), extra.as_object()) {
            for (k, v) in extra {
                map.insert(k.clone(), v.clone());
            }
        }
        value
    };
    // No file could be read at all: listed with the reason rather than counted as complete (owner, 2026-11-05: such
    // an album showed as "Unknown album" elsewhere but never here).
    if folder.files.is_empty() && !unreadable.is_empty() {
        let reason = unreadable[0]["message"].as_str().unwrap_or("").to_owned();
        return (
            "no_match".into(),
            0,
            with(
                base,
                json!({ "note": format!("The tags of these files could not be read ({reason}).") }),
            ),
        );
    }
    // A gap the person confirmed as right (a song called "Untitled") does not count while the file keeps that value;
    // nor does a placeholder-looking title its own file name says too (owner, 2026-11-05: Wagon Christ's Studio
    // Session 1 really is "Track 1" to "Track 11", in the tags and in "01 - Wagon Christ - Track 1.mp3").
    let artists: Vec<String> = folder
        .files
        .iter()
        .flat_map(|f| [f.tags.album_artist.clone(), f.tags.artist.clone()])
        .flatten()
        .chain(folder.clues().artist)
        .collect();
    let artist_names: Vec<&str> = artists.iter().map(String::as_str).collect();
    let still_missing = folder.files.iter().any(|file| {
        file.tags.missing().into_iter().any(|field| {
            let name = serde_json::to_value(field)
                .ok()
                .and_then(|v| v.as_str().map(str::to_owned))
                .unwrap_or_default();
            let have = file.tags.get(field).map(|v| v.trim().to_owned());
            let named_so = field == mediaverse_tag_repair::matcher::Field::Title
                && have
                    .as_deref()
                    .zip(mediaverse_tag_repair::names::title_from_file_name(
                        &file.stem,
                        &artist_names,
                    ))
                    .is_some_and(|(h, n)| same_value(h, &n));
            have.is_none()
                || (!named_so && confirmed.get(&(file.path.clone(), name)) != have.as_ref())
        })
    });
    if !folder.needs_repair() || !still_missing {
        return ("complete".into(), 0, with(base, json!({})));
    }
    if folder.files.len() < MIN_FILES {
        return (
            "too_few".into(),
            0,
            with(
                base,
                json!({ "note": "Too few files to recognise by their lengths; fingerprints will be needed." }),
            ),
        );
    }
    let mut method = "disc layout";
    let mut proposals: Vec<Proposal> = Vec::new();
    let mut problem: Option<String> = None;
    if let Some(toc) = folder.toc() {
        let url = musicbrainz::toc_search_url(&settings.musicbrainz.base_url, &toc);
        match musicbrainz_get(&url, settings, state) {
            Ok(Some(body)) => match parse_releases(&body) {
                Ok(releases) => proposals = credible(rank(&folder, &releases)),
                Err(message) => problem = Some(message),
            },
            Ok(None) => {}
            Err((_, message)) => problem = Some(message),
        }
    }
    if proposals.is_empty() && problem.is_none() {
        method = "names";
        match search_by_name(&folder, settings, state) {
            Ok(releases) => proposals = credible(rank(&folder, &releases)),
            Err((_, message)) => problem = Some(message),
        }
    }
    // Last, Discogs (with the person's token), for releases MusicBrainz does not know.
    if proposals.is_empty() && problem.is_none() && discogs_ready(settings) {
        method = "Discogs";
        match search_discogs(&folder, settings, state) {
            Ok(releases) => proposals = credible(rank(&folder, &releases)),
            Err((_, message)) => problem = Some(message),
        }
    }
    if let Some(message) = problem {
        return ("error".into(), 0, with(base, json!({ "note": message })));
    }
    if proposals.is_empty() {
        return (
            "no_match".into(),
            0,
            with(
                base,
                json!({ "note": "No release with this many tracks fits these files and names." }),
            ),
        );
    }
    proposals.truncate(MAX_PROPOSALS);
    let confidence = proposals[0].confidence;
    let mut extra = json!({ "method": method, "proposals": proposals, "parents": folder.parents });
    if method == "Discogs" {
        extra["fetched_at"] = json!(now_secs());
    }
    ("identified".into(), confidence, with(base, extra))
}

/// The scan job. Folders scanned before with the same signature are skipped unless `again` is set; folders
/// that failed (`error`) are always tried again, and with `retry` so are folders not identified or identified
/// below the confidence floor. Stops between folders when `stop` is raised.
#[allow(clippy::too_many_arguments)]
pub fn run(
    root: &Path,
    store: &TagRepairStore,
    settings: &MetadataSettings,
    state: &MetadataState,
    again: bool,
    retry: bool,
    stop: &AtomicBool,
    progress: &ScanState,
    emit: &dyn Fn(&ScanState),
) -> Result<Value, String> {
    let folders = album_folders(root);
    let keep: std::collections::HashSet<String> = folders
        .iter()
        .map(|(dir, _)| dir.to_string_lossy().into_owned())
        .collect();
    store.forget_except(&keep).map_err(|e| e.to_string())?;
    let known = store.signatures().map_err(|e| e.to_string())?;
    let confirmed = store.confirmed_values().map_err(|e| e.to_string())?;
    let todo: Vec<(PathBuf, Vec<PathBuf>, String)> = folders
        .into_iter()
        .filter_map(|(dir, files)| {
            let sig = signature(&files);
            let key = dir.to_string_lossy().into_owned();
            // A folder filed as complete although some files could not be read is looked at again: the reader may do
            // better now (it reads damaged tags leniently since 2026-11-05). No lookup is made for it unless needed.
            // Folders not identified or complete are checked again once after the checks change (SCAN_VERSION); identified
            // ones are not, as that would ask MusicBrainz about every album again.
            let fresh =
                known
                    .get(&key)
                    .is_some_and(|(old, status, confidence, unreadable, current)| {
                        status == "left_alone"
                            || *old == sig
                                && (*current || status == "identified")
                                && !(*unreadable && status == "complete")
                                && status != "error"
                                && status != "applied"
                                && !(retry
                                    && (status == "no_match"
                                        || (status == "identified" && *confidence < 70)))
                    });
            (again || !fresh).then_some((dir, files, sig))
        })
        .collect();
    progress.total.store(todo.len(), Ordering::Relaxed);
    emit(progress);
    for (dir, files, sig) in todo {
        if stop.load(Ordering::Relaxed) {
            return Ok(
                json!({ "stopped": true, "done": progress.done.load(Ordering::Relaxed), "total": progress.total.load(Ordering::Relaxed) }),
            );
        }
        if let Ok(mut current) = progress.current.lock() {
            *current = dir
                .strip_prefix(root)
                .unwrap_or(&dir)
                .to_string_lossy()
                .into_owned();
        }
        // A damaged file must not stop the whole scan: a panic while reading one folder is recorded as an error
        // for that folder (tried again next time), and the scan goes on.
        let (status, confidence, result) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| scan_folder(&dir, &files, root, settings, state, &confirmed)))
            .unwrap_or_else(|_| ("error".into(), 0, json!({ "folder": dir.to_string_lossy(), "files": [], "unreadable": [], "clues": {}, "note": "Reading this folder failed unexpectedly." })));
        match status.as_str() {
            "identified" => progress.identified.fetch_add(1, Ordering::Relaxed),
            "no_match" | "too_few" | "error" => progress.unmatched.fetch_add(1, Ordering::Relaxed),
            _ => 0,
        };
        store
            .save(&dir.to_string_lossy(), &sig, &status, confidence, &result)
            .map_err(|e| e.to_string())?;
        progress.done.fetch_add(1, Ordering::Relaxed);
        emit(progress);
    }
    Ok(
        json!({ "stopped": false, "done": progress.done.load(Ordering::Relaxed), "identified": progress.identified.load(Ordering::Relaxed), "unmatched": progress.unmatched.load(Ordering::Relaxed) }),
    )
}

/// Fields that are the same for a whole album, where the album's own files decide the spelling.
const ALBUM_WIDE: [&str; 5] = ["album", "album_artist", "artist", "genre", "year"];

/// The value most of the album's files already share for `field`: at least two files, and more than half of the
/// files that have a real value. Placeholders ("Unknown genre") do not count.
fn consensus(files: &[Value], field: &str) -> Option<String> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    let mut known = 0;
    for file in files {
        let text = match &file["tags"][field] {
            Value::String(s) => s.trim().to_owned(),
            Value::Number(n) => n.to_string(),
            _ => continue,
        };
        if mediaverse_tag_repair::is_placeholder(Some(&text)) {
            continue;
        }
        known += 1;
        *counts.entry(text).or_default() += 1;
    }
    let (value, count) = counts.into_iter().max_by_key(|(_, n)| *n)?;
    (count >= 2 && count * 2 > known).then_some(value)
}

/// Album-wide suggestions follow what the album's other tracks already say (owner, 2026-11-04: track 1 of a rip
/// tagged "Unknown album", the rest "A.F.I." and "Punk"; the gap must be filled with "A.F.I." and "Punk", not the
/// release's own spelling and genre). An album artist nobody has set follows the album's artist. Existing values
/// that only differ from the release by following the album are no longer listed as differences. Applied whenever
/// results are read, so results stored before this rule follow it too; applying it twice changes nothing.
pub fn follow_album(result: &mut Value) {
    let files = result["files"].as_array().cloned().unwrap_or_default();
    let mut agreed: BTreeMap<&str, String> = ALBUM_WIDE
        .iter()
        .filter_map(|field| Some((*field, consensus(&files, field)?)))
        .collect();
    let album_artist_from_artist = !agreed.contains_key("album_artist");
    if album_artist_from_artist && let Some(artist) = agreed.get("artist").cloned() {
        agreed.insert("album_artist", artist);
    }
    if agreed.is_empty() {
        return;
    }
    let current: BTreeMap<String, Value> = files
        .iter()
        .filter_map(|f| Some((f["path"].as_str()?.to_owned(), f["tags"].clone())))
        .collect();
    for proposal in result["proposals"].as_array_mut().into_iter().flatten() {
        // On a compilation each song keeps its own artist.
        let various = proposal["artist"]
            .as_str()
            .is_some_and(mediaverse_tag_repair::names::is_various);
        let rule = |field: &str| {
            agreed
                .get(field)
                .filter(|_| !(various && field == "artist"))
        };
        let mut used = false;
        // A file in the folder that is not on the release (a bonus track) still gets the album-wide values the
        // album's other tracks agree on, so a gap only it has can be filled (owner, 2026-11-05: Orbital's "Speed
        // Freak (Moby Remix)" had no genre or year, and the album stayed on the list with nothing to apply).
        let listed: std::collections::HashSet<String> = proposal["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|f| f["path"].as_str().map(ToOwned::to_owned))
            .collect();
        let mut extras = Vec::new();
        for file in &files {
            let Some(path) = file["path"].as_str() else {
                continue;
            };
            if listed.contains(path) {
                continue;
            }
            let changes: Vec<Value> = ALBUM_WIDE
                .iter()
                // On a compilation the album artist is not guessed from one band's songs.
                .filter(|field| !(various && **field == "album_artist" && album_artist_from_artist))
                .filter_map(|field| {
                    let value = rule(field)?;
                    tag_text(&file["tags"][*field]).is_none().then(|| json!({ "field": field, "from": file["tags"][*field].clone(), "to": value, "album": true }))
                })
                .collect();
            if !changes.is_empty() {
                extras.push(json!({ "path": path, "track": file["tags"]["track"].as_u64().unwrap_or(0), "changes": changes, "differences": [], "fit": 0, "extra": true }));
            }
        }
        if !extras.is_empty() {
            used = true;
            if let Some(list) = proposal["files"].as_array_mut() {
                list.extend(extras);
            }
        }
        for file in proposal["files"].as_array_mut().into_iter().flatten() {
            for change in file["changes"].as_array_mut().into_iter().flatten() {
                if let Some(value) = change["field"].as_str().and_then(rule) {
                    change["to"] = json!(value);
                    change["album"] = json!(true);
                    used = true;
                }
            }
            let tags = file["path"]
                .as_str()
                .and_then(|p| current.get(p))
                .cloned()
                .unwrap_or(Value::Null);
            if let Some(differences) = file["differences"].as_array_mut() {
                differences.retain(|d| {
                    let Some(value) = d["field"].as_str().and_then(rule) else {
                        return true;
                    };
                    let have = match &tags[d["field"].as_str().unwrap_or_default()] {
                        Value::String(s) => s.trim().to_owned(),
                        Value::Number(n) => n.to_string(),
                        _ => String::new(),
                    };
                    have != *value
                });
            }
        }
        let differing: usize = proposal["files"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|f| f["differences"].as_array().map_or(0, Vec::len))
            .sum();
        if let Some(evidence) = proposal["evidence"].as_array_mut() {
            evidence.retain(|e| {
                !e["text"]
                    .as_str()
                    .is_some_and(|t| t.ends_with("differ from this release (not changed)"))
            });
            if differing > 0 {
                evidence.push(json!({ "kind": "info", "text": format!("{differing} existing tag{} differ from this release (not changed)", if differing == 1 { "" } else { "s" }) }));
            }
        }
        let note = "Album-wide values follow the album's other tracks";
        if used
            && !proposal["evidence"]
                .as_array()
                .is_some_and(|e| e.iter().any(|x| x["text"] == note))
        {
            if let Some(evidence) = proposal["evidence"].as_array_mut() {
                evidence.push(json!({ "kind": "good", "text": note }));
            }
        }
    }
}

/// The text of a tag value in a result (strings trimmed, numbers written out); None when empty.
fn value_text(value: &Value) -> Option<String> {
    match value {
        Value::String(s) if !s.trim().is_empty() => Some(s.trim().to_owned()),
        Value::Number(n) => Some(n.to_string()),
        _ => None,
    }
}

/// The note on a suggestion made from the folder and file names (no release found).
const FROM_FOLDER: &str = "folder";

/**
 * Albums no release was found for still get suggestions, from their folder and file names (owner, 2026-11-04:
 * "many of them are in folders and have names that allow for logical suggestions"): the album from the folder,
 * the album artist from the songs or the folder above, each song's artist from the album artist, its track and
 * disc number and title from its file name, and (later, by [`GenreHints`]) the genre. Shown like a release's
 * suggestions, editable, and written only when the person ticks the album and presses Apply. Applied whenever
 * results are read; applying it twice changes nothing.
 */
pub fn local_proposal(result: &mut Value) {
    if result["proposals"]
        .as_array()
        .is_some_and(|p| !p.is_empty())
    {
        return;
    }
    let files = result["files"].as_array().cloned().unwrap_or_default();
    if files.is_empty() {
        return;
    }
    let clue = |name: &str| {
        value_text(&result["clues"][name])
            .filter(|v| !mediaverse_tag_repair::is_placeholder(Some(v)))
    };
    let album = consensus(&files, "album").or_else(|| clue("album"));
    let album_artist = consensus(&files, "album_artist")
        .or_else(|| consensus(&files, "artist"))
        .or_else(|| clue("artist"));
    let various = album_artist
        .as_deref()
        .is_some_and(mediaverse_tag_repair::names::is_various);
    let mut entries = Vec::new();
    for file in &files {
        let Some(path) = file["path"].as_str() else {
            continue;
        };
        let tags = &file["tags"];
        let missing = |field: &str| tag_text(&tags[field]).is_none();
        let stem = file["stem"].as_str().unwrap_or_default();
        let mut name = mediaverse_tag_repair::names::from_file_name(stem);
        // "01 - Wagon Christ - Track 1": the title without the artist in front.
        let artists: Vec<String> = [
            value_text(&tags["artist"]),
            value_text(&tags["album_artist"]),
            album_artist.clone(),
        ]
        .into_iter()
        .flatten()
        .collect();
        let artist_names: Vec<&str> = artists.iter().map(String::as_str).collect();
        name.title =
            mediaverse_tag_repair::names::title_from_file_name(stem, &artist_names).or(name.title);
        let mut changes = Vec::new();
        let mut add = |field: &str, to: Option<String>| {
            if let Some(to) = to.filter(|t| !t.is_empty()) {
                changes.push(json!({ "field": field, "from": tags[field].clone(), "to": to }));
            }
        };
        if missing("title") {
            add("title", name.title.clone());
        }
        if missing("track") {
            add("track", name.track.map(|t| t.to_string()));
        }
        if tags["disc"].is_null() {
            add("disc", name.disc.map(|d| d.to_string()));
        }
        if missing("album") {
            add("album", album.clone());
        }
        if missing("album_artist") {
            add("album_artist", album_artist.clone());
        }
        if missing("artist") && !various {
            add("artist", album_artist.clone());
        }
        entries.push(json!({ "path": path, "track": tags["track"].as_u64().or(name.track.map(u64::from)).unwrap_or(0), "changes": changes, "differences": [], "fit": 0 }));
    }
    result["proposals"] = json!([{
        "release_id": "", "source": FROM_FOLDER, "url": null,
        "artist": album_artist.unwrap_or_default(), "album": album.unwrap_or_default(),
        "edition": "From the folder and file names", "barcode": "", "catalog_number": "", "confidence": 0,
        "evidence": [{ "kind": "info", "text": "No release found: suggestions come from the folder and file names. Type over anything to change it." }],
        "files": entries,
    }]);
}

/**
 * Titles that carry a track number, the artist's name or a web address get a tidied suggestion
 * ([`mediaverse_tag_repair::names::tidy_title`]), marked `cleanup`: unlike the other suggestions it replaces a
 * real value, and Apply writes it only if the title is still what the scan saw. Applying it twice changes nothing.
 */
pub fn clean_titles(result: &mut Value) {
    let files = result["files"].as_array().cloned().unwrap_or_default();
    let tags: BTreeMap<String, Value> = files
        .iter()
        .filter_map(|f| Some((f["path"].as_str()?.to_owned(), f["tags"].clone())))
        .collect();
    for proposal in result["proposals"].as_array_mut().into_iter().flatten() {
        let release_artist = value_text(&proposal["artist"]);
        for file in proposal["files"].as_array_mut().into_iter().flatten() {
            let Some(current) = file["path"].as_str().and_then(|p| tags.get(p)) else {
                continue;
            };
            let Some(title) = tag_text(&current["title"]) else {
                continue;
            };
            let artists: Vec<String> = ["artist", "album_artist"]
                .iter()
                .filter_map(|f| value_text(&current[*f]))
                .chain(release_artist.clone())
                .collect();
            let names: Vec<&str> = artists.iter().map(String::as_str).collect();
            let Some(tidy) = mediaverse_tag_repair::names::tidy_title(&title, &names) else {
                continue;
            };
            let Some(changes) = file["changes"].as_array_mut() else {
                continue;
            };
            if changes.iter().any(|c| c["field"] == "title") {
                continue;
            }
            changes.push(json!({ "field": "title", "from": title, "to": tidy, "cleanup": true }));
            if let Some(differences) = file["differences"].as_array_mut() {
                differences.retain(|d| d["field"] != "title");
            }
        }
    }
}

/// Everything the review page shows for a folder, worked out from the stored scan result.
pub fn prepare(result: &mut Value) {
    local_proposal(result);
    follow_album(result);
    clean_titles(result);
    mark_confirmations(result);
}

/**
 * A suggestion that is what the file already has: a placeholder that is the song's real name, as blink-182's
 * "Untitled" on Dude Ranch. It stays on the page, highlighted as the reason the album is listed, and is marked
 * `confirm`: Apply writes nothing for it but remembers it as right, so the next check does not list it again (owner,
 * 2026-11-05: "they should still be highlighted ... and I should still be able to confirm").
 */
/// Two tag values that say the same: equal ignoring case and leading zeros of numbers ("Track 01" = "Track 1").
fn same_value(a: &str, b: &str) -> bool {
    let key = |text: &str| -> String {
        let mut out = String::new();
        let mut digits = String::new();
        for c in text
            .trim()
            .to_lowercase()
            .chars()
            .chain(std::iter::once(' '))
        {
            if c.is_ascii_digit() {
                digits.push(c);
                continue;
            }
            if !digits.is_empty() {
                let trimmed = digits.trim_start_matches('0');
                out.push_str(if trimmed.is_empty() { "0" } else { trimmed });
                digits.clear();
            }
            out.push(c);
        }
        out
    };
    a == b || key(a) == key(b)
}

fn mark_confirmations(result: &mut Value) {
    let tags: BTreeMap<String, Value> = result["files"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|f| Some((f["path"].as_str()?.to_owned(), f["tags"].clone())))
        .collect();
    for proposal in result["proposals"].as_array_mut().into_iter().flatten() {
        for file in proposal["files"].as_array_mut().into_iter().flatten() {
            let Some(current) = file["path"].as_str().and_then(|p| tags.get(p)).cloned() else {
                continue;
            };
            for c in file["changes"].as_array_mut().into_iter().flatten() {
                let (Some(field), Some(to)) =
                    (c["field"].as_str().map(str::to_owned), value_text(&c["to"]))
                else {
                    continue;
                };
                // The same apart from zero-padding or capitals ("Track 01" for a suggested "Track 1", Wagon Christ's
                // Studio Session 1) is the same too, and the file's own spelling is kept.
                if let Some(have) =
                    value_text(&current[field.as_str()]).filter(|have| same_value(have, &to))
                {
                    c["confirm"] = json!(true);
                    c["to"] = json!(have);
                }
            }
        }
    }
}

/// An artist's name as a key: case, spacing and a leading "The" do not matter.
fn artist_key(name: &str) -> String {
    let words: Vec<String> = name.split_whitespace().map(str::to_lowercase).collect();
    let words = if words.len() > 1 && words[0] == "the" {
        &words[1..]
    } else {
        &words[..]
    };
    words.join(" ")
}

fn tag_text(value: &Value) -> Option<String> {
    let text = match value {
        Value::String(s) => s.trim().to_owned(),
        Value::Number(n) => n.to_string(),
        _ => return None,
    };
    (!mediaverse_tag_repair::is_placeholder(Some(&text))).then_some(text)
}

/// MusicBrainz's main genre for an artist, formatted as a tag. The artist is the matched MusicBrainz release's own
/// artist when there is one; otherwise found by name, and only when exactly one artist has that name (two bands
/// called "Whatever It Takes" exist, and guessing would suggest the other band's genre).
fn musicbrainz_artist_genre(
    name: &str,
    release_id: Option<&str>,
    settings: &MetadataSettings,
    state: &MetadataState,
) -> SourceResult<Option<String>> {
    let base = settings.musicbrainz.base_url.trim_end_matches('/');
    let key = artist_key(name);
    let mut id: Option<String> = None;
    if let Some(release) = release_id.filter(|r| !r.is_empty() && !r.contains(':')) {
        if let Some(body) = musicbrainz_get(
            &format!("{base}/ws/2/release/{release}?inc=artist-credits&fmt=json"),
            settings,
            state,
        )? {
            let found: Value =
                serde_json::from_str(&body).map_err(|e| ("bad_reply".to_owned(), e.to_string()))?;
            id = found["artist-credit"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|c| {
                    c["artist"]["name"]
                        .as_str()
                        .or(c["name"].as_str())
                        .map(artist_key)
                        .as_deref()
                        == Some(key.as_str())
                })
                .and_then(|c| c["artist"]["id"].as_str().map(ToOwned::to_owned));
        }
    }
    if id.is_none() {
        let url = format!(
            "{base}/ws/2/artist/?query={}&limit=10&fmt=json",
            url_encode(&format!("artist:{}", phrase(name)))
        );
        let Some(body) = musicbrainz_get(&url, settings, state)? else {
            return Ok(None);
        };
        let found: Value =
            serde_json::from_str(&body).map_err(|e| ("bad_reply".to_owned(), e.to_string()))?;
        let exact: Vec<String> = found["artists"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|a| a["name"].as_str().map(artist_key).as_deref() == Some(key.as_str()))
            .filter_map(|a| a["id"].as_str().map(ToOwned::to_owned))
            .collect();
        if exact.len() != 1 {
            return Ok(None);
        }
        id = exact.into_iter().next();
    }
    let Some(id) = id else { return Ok(None) };
    let Some(body) = musicbrainz_get(
        &format!("{base}/ws/2/artist/{id}?inc=genres&fmt=json"),
        settings,
        state,
    )?
    else {
        return Ok(None);
    };
    let artist: Value =
        serde_json::from_str(&body).map_err(|e| ("bad_reply".to_owned(), e.to_string()))?;
    let mut genres: Vec<(String, u64)> = artist["genres"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|g| {
            Some((
                g["name"].as_str()?.to_owned(),
                g["count"].as_u64().unwrap_or(0),
            ))
        })
        .filter(|(name, count)| !name.is_empty() && *count > 0)
        .collect();
    genres.sort_by(|a, b| b.1.cmp(&a.1).then_with(|| a.0.cmp(&b.0)));
    Ok(genres
        .first()
        .map(|(g, _)| mediaverse_tag_repair::musicbrainz::genre_tag(g)))
}

/// Genres for albums whose release names none (owner, 2026-11-04: "can the program look up the artist and see
/// what genre their music usually falls into?"). First the genre most of the artist's songs already have in the
/// library (counting genres written by Apply); else MusicBrainz's genre for the artist, looked up once per artist
/// and remembered, a few new artists per page so a page never waits long. Either way it is only a suggestion in an
/// editable box, and Apply only fills empty or placeholder genres.
pub struct GenreHints<'a> {
    store: &'a TagRepairStore,
    library: BTreeMap<String, String>,
    online: Option<(&'a MetadataSettings, &'a MetadataState)>,
    lookups_left: usize,
}

const GENRE_LOOKUPS_PER_PAGE: usize = 2;

impl<'a> GenreHints<'a> {
    /// `online`: may ask MusicBrainz about artists not looked up before (when a page is shown; not while applying,
    /// which uses only what the page showed).
    pub fn new(
        store: &'a TagRepairStore,
        online: Option<(&'a MetadataSettings, &'a MetadataState)>,
    ) -> Self {
        let library = store.library_genres().unwrap_or_default();
        Self {
            store,
            library,
            online,
            lookups_left: GENRE_LOOKUPS_PER_PAGE,
        }
    }

    /// (genre, where it came from) for an artist.
    fn for_artist(
        &mut self,
        name: &str,
        release_id: Option<&str>,
    ) -> Option<(String, &'static str)> {
        let key = artist_key(name);
        if key.is_empty() || mediaverse_tag_repair::names::is_various(name) {
            return None;
        }
        if let Some(genre) = self.library.get(&key) {
            return Some((genre.clone(), "library"));
        }
        match self.store.cached_artist_genre(&key) {
            Some(Some(genre)) => return Some((genre, "musicbrainz")),
            Some(None) => return None,
            None => {}
        }
        let (settings, state) = self.online?;
        if self.lookups_left == 0 {
            return None;
        }
        self.lookups_left -= 1;
        // A failed lookup (no network) is not remembered, so it is tried again later.
        let genre = musicbrainz_artist_genre(name, release_id, settings, state).ok()?;
        let _ = self.store.save_artist_genre(&key, genre.as_deref());
        genre.map(|g| (g, "musicbrainz"))
    }

    /// Adds a genre suggestion for every file of every edition that has no genre and none suggested. With no hint
    /// the suggestion is empty: the page shows an empty Genre box to type into, and nothing is written unless
    /// something is typed. Applying it twice changes nothing.
    pub fn fill(&mut self, result: &mut Value) {
        let files = result["files"].as_array().cloned().unwrap_or_default();
        let current: BTreeMap<String, Value> = files
            .iter()
            .filter_map(|f| Some((f["path"].as_str()?.to_owned(), f["tags"].clone())))
            .collect();
        let needs = |path: &str| {
            current
                .get(path)
                .is_none_or(|tags| tag_text(&tags["genre"]).is_none())
        };
        if !files.iter().any(|f| f["path"].as_str().is_some_and(needs)) {
            return;
        }
        // The names to try: the album artist and artist the files agree on, then the release's artist.
        let names: Vec<String> = ["album_artist", "artist"]
            .iter()
            .filter_map(|f| consensus(&files, f))
            .collect();
        let Some(proposals) = result["proposals"].as_array_mut() else {
            return;
        };
        for proposal in proposals {
            if proposal["files"].as_array().into_iter().flatten().all(|f| {
                f["changes"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .any(|c| c["field"] == "genre")
                    || !f["path"].as_str().is_some_and(needs)
            }) {
                continue;
            }
            let mut tried = names.clone();
            if let Some(artist) = proposal["artist"].as_str() {
                tried.push(artist.to_owned());
            }
            let release_id = proposal["release_id"].as_str().map(ToOwned::to_owned);
            let hint = tried
                .iter()
                .find_map(|name| self.for_artist(name, release_id.as_deref()));
            let to = hint.as_ref().map(|(g, _)| g.clone()).unwrap_or_default();
            for file in proposal["files"].as_array_mut().into_iter().flatten() {
                let Some(path) = file["path"].as_str().map(ToOwned::to_owned) else {
                    continue;
                };
                if !needs(&path) {
                    continue;
                }
                let Some(changes) = file["changes"].as_array_mut() else {
                    continue;
                };
                if changes.iter().any(|c| c["field"] == "genre") {
                    continue;
                }
                let from = current
                    .get(&path)
                    .map(|t| t["genre"].clone())
                    .unwrap_or(Value::Null);
                changes.push(json!({ "field": "genre", "from": from, "to": to, "album": true, "hint": hint.as_ref().map(|(_, s)| *s) }));
            }
            if let Some(evidence) = proposal["evidence"].as_array_mut() {
                evidence.retain(|e| e["text"] != "No genre known for this album");
                let text = match &hint {
                    Some((genre, "library")) => {
                        format!("Genre from this artist's other songs in your library: {genre}")
                    }
                    Some((genre, _)) => {
                        format!("Genre from MusicBrainz's genres for this artist: {genre}")
                    }
                    None => "No genre known for this album: type one in the Genre box".to_owned(),
                };
                if !evidence.iter().any(|e| e["text"] == text.as_str()) {
                    evidence.push(json!({ "kind": "info", "text": text }));
                }
            }
        }
    }
}

/// What the person chose for one album on the review page.
#[derive(Debug, Clone, Default)]
pub struct AlbumChoice {
    pub path: String,
    pub edition: usize,
    pub skip_files: std::collections::HashSet<String>,
    pub skip_fields: std::collections::HashSet<String>,
    /// Values the person typed over suggestions: file path -> field -> value (empty: do not write that field).
    pub edits: std::collections::HashMap<String, std::collections::HashMap<String, String>>,
}

/// The audio files directly in `dir`, sorted: the files the scan grouped as this album.
pub(crate) fn audio_files(dir: &Path) -> Vec<PathBuf> {
    let mut files: Vec<PathBuf> = std::fs::read_dir(dir)
        .map(|entries| {
            entries
                .flatten()
                .filter(|e| e.file_type().is_ok_and(|t| t.is_file()))
                .map(|e| e.path())
                .filter(|p| {
                    p.extension()
                        .and_then(|e| e.to_str())
                        .is_some_and(|e| AUDIO.contains(&e.to_ascii_lowercase().as_str()))
                })
                .collect()
        })
        .unwrap_or_default();
    files.sort();
    files
}

fn current_value(tags: &Tags, field: &str) -> Option<String> {
    match field {
        "title" => tags.title.clone(),
        "artist" => tags.artist.clone(),
        "album" => tags.album.clone(),
        "album_artist" => tags.album_artist.clone(),
        "genre" => tags.genre.clone(),
        "year" => tags.year.map(|v| v.to_string()),
        "track" => tags.track.map(|v| v.to_string()),
        "disc" => tags.disc.map(|v| v.to_string()),
        _ => None,
    }
}

/// Writes the chosen suggestions (the person pressed Apply). Only what the scan proposed is written, only into
/// fields that are still empty or a placeholder when the file is opened, and only for albums whose files have not
/// changed since they were checked. Every value written is journalled first, so the batch can be undone.
/// `progress(done, total)` is called after each file.
pub fn apply(
    store: &TagRepairStore,
    albums: &[AlbumChoice],
    progress: &dyn Fn(usize, usize),
) -> Result<Value, String> {
    use mediaverse_metadata_tags::{TagField, patch_track_metadata};
    let connection = store.open().map_err(|e| e.to_string())?;
    let now = now_secs() as i64;
    connection
        .execute(
            "INSERT INTO batches (at, albums, files) VALUES (?1, 0, 0)",
            params![now],
        )
        .map_err(|e| e.to_string())?;
    let batch = connection.last_insert_rowid();

    // Work out every file's changes first, so progress has a total.
    /// One field to write. `replace`: the person typed it, or it tidies a title, so it may replace a real value,
    /// but only if the file still has the value the scan saw (`from`); a plain suggestion only fills a gap.
    struct Change {
        field: String,
        to: String,
        from: Option<String>,
        replace: bool,
    }
    struct Planned {
        album: usize,
        path: String,
        changes: Vec<Change>,
    }
    let mut plan: Vec<Planned> = Vec::new();
    // Albums with something not written (a bad number, a file that failed): they stay in the review.
    let mut troubled = std::collections::HashSet::new();
    let mut hints = GenreHints::new(store, None);
    let mut skipped: Vec<Value> = Vec::new();
    let mut rows = Vec::new();
    for (index, choice) in albums.iter().enumerate() {
        let Some((signature_then, status, confidence, mut result)) =
            store.row(&choice.path).map_err(|e| e.to_string())?
        else {
            skipped.push(json!({ "path": choice.path, "message": "This album is no longer in the results; check for changes." }));
            continue;
        };
        if !matches!(status.as_str(), "identified" | "no_match" | "too_few") {
            skipped.push(
                json!({ "path": choice.path, "message": "This album has no suggestion to apply." }),
            );
            continue;
        }
        if signature(&audio_files(Path::new(&choice.path))) != signature_then {
            skipped.push(json!({ "path": choice.path, "message": "Its files changed after they were checked, so nothing was written. Press “Check for changes” first." }));
            continue;
        }
        // The same suggestions the page showed (genres from what the page looked up; nothing is asked online now).
        prepare(&mut result);
        hints.fill(&mut result);
        let Some(proposal) = result["proposals"].get(choice.edition) else {
            skipped.push(
                json!({ "path": choice.path, "message": "The chosen edition was not found." }),
            );
            continue;
        };
        let scanned: BTreeMap<String, Value> = result["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|f| Some((f["path"].as_str()?.to_owned(), f["tags"].clone())))
            .collect();
        let suggested: BTreeMap<String, &Value> = proposal["files"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(|f| Some((f["path"].as_str()?.to_owned(), f)))
            .collect();
        let paths: std::collections::BTreeSet<&String> =
            scanned.keys().chain(suggested.keys()).collect();
        for path in paths {
            if choice.skip_files.contains(path) {
                continue;
            }
            let tags = scanned.get(path).unwrap_or(&Value::Null);
            let edits = choice.edits.get(path);
            let typed = |field: &str| {
                edits
                    .and_then(|e| e.get(field))
                    .map(|v| v.trim().to_owned())
            };
            let mut changes: Vec<Change> = Vec::new();
            // The suggestions, or what the person typed over them.
            for c in suggested
                .get(path)
                .and_then(|f| f["changes"].as_array())
                .into_iter()
                .flatten()
            {
                let (Some(field), Some(to)) = (c["field"].as_str(), c["to"].as_str()) else {
                    continue;
                };
                if choice.skip_fields.contains(field) && typed(field).is_none() {
                    continue;
                }
                let edited = typed(field);
                changes.push(Change {
                    field: field.to_owned(),
                    replace: edited.is_some() || c["cleanup"] == true,
                    to: edited.unwrap_or_else(|| to.to_owned()),
                    from: value_text(&c["from"]),
                });
            }
            // Anything else the person typed, over any field of any song (owner, 2026-11-04: "I should be able to
            // change or type over any of the tags").
            for (field, value) in edits.into_iter().flatten() {
                if changes.iter().any(|c| &c.field == field)
                    || TagField::from_name(field).is_none()
                    || field == "compilation"
                {
                    continue;
                }
                changes.push(Change {
                    field: field.clone(),
                    to: value.trim().to_owned(),
                    from: value_text(&tags[field.as_str()]),
                    replace: true,
                });
            }
            changes.retain(|c| !c.to.is_empty());
            for c in &changes {
                if matches!(c.field.as_str(), "year" | "track" | "disc")
                    && c.to.parse::<u32>().map_or(true, |n| n == 0 || n > 9999)
                {
                    troubled.insert(index);
                    skipped.push(json!({ "path": path, "message": format!("“{}” is not a number, so the {} was not written.", c.to, c.field) }));
                }
            }
            changes.retain(|c| {
                !matches!(c.field.as_str(), "year" | "track" | "disc")
                    || c.to.parse::<u32>().is_ok_and(|n| n > 0 && n <= 9999)
            });
            if !changes.is_empty() {
                plan.push(Planned {
                    album: index,
                    path: path.clone(),
                    changes,
                });
            }
        }
        rows.push((index, status, confidence, result));
    }

    let total = plan.len();
    let mut written_files = 0usize;
    let mut written_fields = 0usize;
    let mut problems: Vec<Value> = Vec::new();
    let mut albums_touched = std::collections::HashSet::new();
    let mut confirmations = 0usize;
    for (done, item) in plan.iter().enumerate() {
        // Open the file again now: gaps are filled whatever happened since the scan; a real value is replaced only
        // when the person typed it (or a title is tidied) and the file still has what the scan saw.
        let outcome = (|| -> Result<usize, String> {
            let now = read_file(Path::new(&item.path))?;
            // A placeholder the release (or the person) gives as the real value is confirmed, not written.
            for c in &item.changes {
                let have = current_value(&now.tags, &c.field).map(|v| v.trim().to_owned());
                if have.as_deref() == Some(c.to.as_str())
                    && mediaverse_tag_repair::is_placeholder(have.as_deref())
                {
                    store
                        .confirm_value(&item.path, &c.field, &c.to)
                        .map_err(|e| format!("the confirmation could not be saved: {e}"))?;
                    confirmations += 1;
                }
            }
            let changes: Vec<(TagField, Option<String>)> = item
                .changes
                .iter()
                .filter(|c| {
                    let have = current_value(&now.tags, &c.field).map(|v| v.trim().to_owned());
                    have.as_deref() != Some(c.to.as_str())
                        && (mediaverse_tag_repair::is_placeholder(have.as_deref())
                            || (c.replace && have.filter(|v| !v.is_empty()) == c.from))
                })
                .filter_map(|c| Some((TagField::from_name(&c.field)?, Some(c.to.clone()))))
                .collect();
            if changes.is_empty() {
                return Ok(0);
            }
            let before =
                patch_track_metadata(Path::new(&item.path), &changes).map_err(|e| e.to_string())?;
            for ((field, new), (_, old)) in changes.iter().zip(before) {
                connection
                    .execute("INSERT INTO batch_changes (batch, path, field, old, new) VALUES (?1, ?2, ?3, ?4, ?5)", params![batch, item.path, field.name(), old, new])
                    .map_err(|e| format!("the change was written but could not be journalled: {e}"))?;
            }
            Ok(changes.len())
        })();
        match outcome {
            Ok(0) => {}
            Ok(count) => {
                written_files += 1;
                written_fields += count;
                albums_touched.insert(item.album);
            }
            Err(message) => {
                troubled.insert(item.album);
                problems.push(json!({ "path": item.path, "message": message }))
            }
        }
        progress(done + 1, total);
    }

    // An album chosen whose files already had every suggested value (a song really called "Untitled") is done
    // too: set aside like a written one, without a journal entry, so it leaves the review until the next check.
    for (index, _, confidence, result) in &rows {
        if albums_touched.contains(index) || troubled.contains(index) {
            continue;
        }
        let path = &albums[*index].path;
        store
            .save(
                path,
                &signature(&audio_files(Path::new(path))),
                "applied",
                (*confidence).clamp(0, 100) as u8,
                result,
            )
            .map_err(|e| e.to_string())?;
    }

    // Each album written is set aside as "applied" (its old row journalled for an undo); the next check reads it
    // again and shows whatever is still missing.
    for (index, status, confidence, result) in rows {
        if !albums_touched.contains(&index) {
            continue;
        }
        let path = &albums[index].path;
        connection
            .execute("INSERT INTO batch_folders (batch, path, status, confidence, result) VALUES (?1, ?2, ?3, ?4, ?5)", params![batch, path, status, confidence, result.to_string()])
            .map_err(|e| e.to_string())?;
        store
            .save(
                path,
                &signature(&audio_files(Path::new(path))),
                "applied",
                confidence.clamp(0, 100) as u8,
                &result,
            )
            .map_err(|e| e.to_string())?;
    }
    connection
        .execute(
            "UPDATE batches SET albums = ?2, files = ?3 WHERE id = ?1",
            params![batch, albums_touched.len() as i64, written_files as i64],
        )
        .map_err(|e| e.to_string())?;
    if written_files == 0 {
        connection
            .execute("DELETE FROM batches WHERE id = ?1", params![batch])
            .map_err(|e| e.to_string())?;
    }
    Ok(json!({
        "batch": if written_files > 0 { json!(batch) } else { Value::Null },
        "albums": albums_touched.len(), "files": written_files, "fields": written_fields, "confirmed": confirmations,
        "problems": problems, "skipped": skipped,
    }))
}

/// Undoes one batch: every field goes back to its value from before, unless it has been changed again since (then
/// it is left alone and listed). The albums return to the review as they were.
pub fn undo(store: &TagRepairStore, batch: i64) -> Result<Value, String> {
    use mediaverse_metadata_tags::{TagField, patch_track_metadata};
    let connection = store.open().map_err(|e| e.to_string())?;
    let undone: i64 = connection
        .query_row(
            "SELECT undone FROM batches WHERE id = ?1",
            params![batch],
            |r| r.get(0),
        )
        .map_err(|_| "That change was not found.".to_owned())?;
    if undone != 0 {
        return Err("That change has already been undone.".to_owned());
    }
    let mut by_file: BTreeMap<String, Vec<(String, Option<String>, Option<String>)>> =
        BTreeMap::new();
    {
        let mut statement = connection
            .prepare("SELECT path, field, old, new FROM batch_changes WHERE batch = ?1")
            .map_err(|e| e.to_string())?;
        let rows = statement
            .query_map(params![batch], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, String>(1)?,
                    r.get::<_, Option<String>>(2)?,
                    r.get::<_, Option<String>>(3)?,
                ))
            })
            .map_err(|e| e.to_string())?;
        for row in rows {
            let (path, field, old, new) = row.map_err(|e| e.to_string())?;
            by_file.entry(path).or_default().push((field, old, new));
        }
    }
    let mut restored = 0usize;
    let mut problems: Vec<Value> = Vec::new();
    for (path, fields) in &by_file {
        let outcome = (|| -> Result<(), String> {
            let now = read_file(Path::new(path))?;
            let mut changes = Vec::new();
            for (field, old, new) in fields {
                let current = current_value(&now.tags, field);
                let same = match (field.as_str(), current.as_deref(), new.as_deref()) {
                    ("year" | "track" | "disc", Some(c), Some(n)) => {
                        c.trim().parse::<u32>().ok() == n.trim().parse::<u32>().ok()
                    }
                    (_, Some(c), Some(n)) => c.trim() == n.trim(),
                    _ => false,
                };
                if !same {
                    return Err(format!(
                        "{field} was changed again after it was fixed, so it was left as it is"
                    ));
                }
                if let Some(tag_field) = TagField::from_name(field) {
                    changes.push((tag_field, old.clone()));
                }
            }
            patch_track_metadata(Path::new(path), &changes).map_err(|e| e.to_string())?;
            Ok(())
        })();
        match outcome {
            Ok(()) => restored += 1,
            Err(message) => problems.push(json!({ "path": path, "message": message })),
        }
    }
    // The albums go back to the review with their old suggestions, and the new file signatures.
    let mut statement = connection
        .prepare("SELECT path, status, confidence, result FROM batch_folders WHERE batch = ?1")
        .map_err(|e| e.to_string())?;
    let folders: Vec<(String, String, i64, String)> = statement
        .query_map(params![batch], |r| {
            Ok((r.get(0)?, r.get(1)?, r.get(2)?, r.get(3)?))
        })
        .map_err(|e| e.to_string())?
        .collect::<rusqlite::Result<_>>()
        .map_err(|e| e.to_string())?;
    for (path, status, confidence, result) in folders {
        let result: Value = serde_json::from_str(&result).unwrap_or(Value::Null);
        // A folder where a file could not be put back is read again at the next check instead (no signature).
        let partly = problems.iter().any(|p| {
            p["path"]
                .as_str()
                .and_then(|f| Path::new(f).parent())
                .is_some_and(|d| d == Path::new(&path))
        });
        let signature = if partly {
            String::new()
        } else {
            signature(&audio_files(Path::new(&path)))
        };
        store
            .save(
                &path,
                &signature,
                &status,
                confidence.clamp(0, 100) as u8,
                &result,
            )
            .map_err(|e| e.to_string())?;
    }
    connection
        .execute(
            "UPDATE batches SET undone = 1 WHERE id = ?1",
            params![batch],
        )
        .map_err(|e| e.to_string())?;
    Ok(json!({ "batch": batch, "files": restored, "problems": problems }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn folder_names_run_up_to_the_library_root() {
        let root = Path::new("C:/Music");
        assert_eq!(
            parents(Path::new("C:/Music/A Perfect Circle/eMOTIVe"), root),
            vec!["eMOTIVe".to_owned(), "A Perfect Circle".to_owned()]
        );
        assert!(parents(root, root).is_empty());
    }

    #[test]
    fn search_phrases_are_escaped() {
        assert_eq!(phrase("AC/DC"), "\"AC\\/DC\"");
        assert_eq!(url_encode("a b&c"), "a%20b%26c");
    }

    #[test]
    fn the_results_store_pages_best_first_and_counts_groups() {
        let dir = std::env::temp_dir().join(format!("mv-tag-repair-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = TagRepairStore::new(&dir);
        store
            .save("C:/M/a", "1", "identified", 97, &json!({ "n": 1 }))
            .unwrap();
        store
            .save("C:/M/b", "1", "identified", 72, &json!({ "n": 2 }))
            .unwrap();
        store
            .save("C:/M/c", "1", "no_match", 0, &json!({ "n": 3 }))
            .unwrap();
        store
            .save("C:/M/d", "1", "complete", 0, &json!({ "n": 4 }))
            .unwrap();
        let all = store.page("all", 0, 10).unwrap();
        assert_eq!(all["summary"]["ready"], 1);
        assert_eq!(all["summary"]["choose"], 1);
        assert_eq!(all["summary"]["none"], 1);
        assert_eq!(all["summary"]["complete"], 1);
        let paths: Vec<&str> = all["folders"]
            .as_array()
            .unwrap()
            .iter()
            .map(|f| f["path"].as_str().unwrap())
            .collect();
        assert_eq!(paths, vec!["C:/M/a", "C:/M/b", "C:/M/c"]);
        assert_eq!(store.page("ready", 0, 10).unwrap()["total"], 1);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_album_left_alone_stays_out_of_the_lists_and_the_scans_until_taken_back() {
        let dir = std::env::temp_dir().join(format!("mv-tag-leave-alone-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = TagRepairStore::new(&dir);
        store
            .save("C:/M/wagon", "1", "no_match", 0, &json!({ "n": 1 }))
            .unwrap();
        store
            .save("C:/M/other", "1", "identified", 95, &json!({ "n": 2 }))
            .unwrap();
        assert_eq!(
            store
                .leave_alone(&["C:/M/wagon".to_owned(), "C:/M/never-checked".to_owned()])
                .unwrap(),
            1,
            "only an album that was checked can be set aside"
        );
        let all = store.page("all", 0, 10).unwrap();
        assert_eq!(all["total"], 1);
        assert_eq!(all["summary"]["none"], 0);
        assert_eq!(all["summary"]["left_alone"], 1);
        let left = store.page("left_alone", 0, 10).unwrap();
        assert_eq!(left["folders"][0]["path"], "C:/M/wagon");
        assert_eq!(left["folders"][0]["result"]["n"], 1, "its result is kept");
        // A scan treats it as up to date whatever happened to its files.
        let known = store.signatures().unwrap();
        assert_eq!(known["C:/M/wagon"].1, "left_alone");
        // Taking it back forgets the row, so the next check reads the folder as new.
        assert_eq!(
            store
                .stop_leaving_alone(&["C:/M/wagon".to_owned(), "C:/M/other".to_owned()])
                .unwrap(),
            1,
            "an album not left alone is untouched"
        );
        assert!(store.row("C:/M/wagon").unwrap().is_none());
        assert!(store.row("C:/M/other").unwrap().is_some());
        let _ = std::fs::remove_dir_all(&dir);
    }
    #[test]
    fn album_wide_suggestions_follow_the_albums_other_tracks() {
        // The owner's AFI folder: track 1 "Unknown", the others "A.F.I." / "Punk"; the release says "AFI" and
        // "Alternative Rock".
        let tags = |album: &str, genre: &str| json!({ "album": album, "artist": "AFI", "album_artist": null, "genre": genre, "year": 2004 });
        let mut result = json!({
            "files": [
                { "path": "1.mp3", "tags": tags("Unknown album (2/28/2020)", "Unknown genre") },
                { "path": "2.mp3", "tags": tags("A.F.I.", "Punk") },
                { "path": "3.mp3", "tags": tags("A.F.I.", "Punk") },
                { "path": "4.mp3", "tags": tags("A.F.I.", "Punk") },
            ],
            "proposals": [{
                "artist": "AFI", "evidence": [{ "kind": "info", "text": "3 existing tags differ from this release (not changed)" }],
                "files": [
                    { "path": "1.mp3", "changes": [
                        { "field": "album", "to": "AFI" }, { "field": "genre", "to": "Alternative Rock" },
                        { "field": "album_artist", "to": "AFI" }, { "field": "title", "to": "The Lost Souls" } ], "differences": [] },
                    { "path": "2.mp3", "changes": [], "differences": [{ "field": "album", "from": "A.F.I.", "to": "AFI" }] },
                    { "path": "3.mp3", "changes": [], "differences": [{ "field": "album", "from": "A.F.I.", "to": "AFI" }] },
                    { "path": "4.mp3", "changes": [], "differences": [{ "field": "album", "from": "A.F.I.", "to": "AFI" }] },
                ],
            }],
        });
        follow_album(&mut result);
        let first = &result["proposals"][0]["files"][0]["changes"];
        assert_eq!(first[0]["to"], "A.F.I.");
        assert_eq!(first[1]["to"], "Punk");
        assert_eq!(
            first[2]["to"], "AFI",
            "no album artist anywhere: the album's own artist"
        );
        assert_eq!(
            first[3]["to"], "The Lost Souls",
            "titles are per song: unchanged"
        );
        assert_eq!(
            result["proposals"][0]["files"][1]["differences"]
                .as_array()
                .unwrap()
                .len(),
            0,
            "following the album is not a difference"
        );
        let evidence = result["proposals"][0]["evidence"].to_string();
        assert!(!evidence.contains("differ from this release"), "{evidence}");
        let once = result.clone();
        follow_album(&mut result);
        assert_eq!(result, once, "applying the rule twice changes nothing");
    }

    #[test]
    fn a_missing_genre_comes_from_the_artists_other_songs_or_stays_an_empty_box() {
        let dir = std::env::temp_dir().join(format!("mv-tag-genres-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let store = TagRepairStore::new(&dir);
        // Another album by the artist in the library: three songs tagged "Punk" (artist written with "The").
        let song = |n: u32, genre: &str| json!({ "path": format!("o{n}"), "tags": { "artist": "The Offspring", "genre": genre } });
        store.save("C:/M/other", "1", "complete", 0, &json!({ "files": [song(1, "Punk"), song(2, "Punk"), song(3, "Punk"), song(4, "Rock")] })).unwrap();
        let album = |artist: &str| {
            json!({
                "files": [
                    { "path": "1", "tags": { "artist": artist, "genre": null } },
                    { "path": "2", "tags": { "artist": artist, "genre": "Unknown genre" } },
                    { "path": "3", "tags": { "artist": artist, "genre": "Ska" } },
                ],
                "proposals": [{ "artist": artist, "evidence": [{ "kind": "info", "text": "No genre known for this album" }], "files": [
                    { "path": "1", "changes": [] }, { "path": "2", "changes": [] }, { "path": "3", "changes": [] },
                ] }],
            })
        };
        let mut hints = GenreHints::new(&store, None);
        let mut known = album("Offspring");
        hints.fill(&mut known);
        let proposal = &known["proposals"][0];
        assert_eq!(proposal["files"][0]["changes"][0]["to"], "Punk");
        assert_eq!(proposal["files"][0]["changes"][0]["hint"], "library");
        assert_eq!(proposal["files"][1]["changes"][0]["from"], "Unknown genre");
        assert_eq!(
            proposal["files"][2]["changes"].as_array().unwrap().len(),
            0,
            "a real genre is left alone"
        );
        assert!(
            proposal["evidence"]
                .as_array()
                .unwrap()
                .iter()
                .all(|e| e["text"] != "No genre known for this album")
        );
        let again = known.clone();
        hints.fill(&mut known);
        assert_eq!(known, again, "filling twice changes nothing");

        // Nobody else knows this artist (and offline): an empty box to type into.
        let mut unknown = album("Nobody Knows");
        hints.fill(&mut unknown);
        assert_eq!(unknown["proposals"][0]["files"][0]["changes"][0]["to"], "");
        assert_eq!(artist_key("  The  Offspring "), "offspring");
        assert_eq!(artist_key("The The"), "the");
    }

    #[test]
    fn a_bonus_track_not_on_the_release_gets_the_albums_genre_and_year() {
        // The owner's Orbital (Green Album): 11 tracks on the release, all tagged; track 12, a remix not on the
        // release, has no genre or year.
        let tagged = |n: u32| json!({ "path": format!("{n}.mp3"), "tags": { "album": "Orbital", "artist": "Orbital", "album_artist": "Orbital", "genre": "Electronic", "year": 1993, "track": n } });
        let mut result = json!({
            "files": [tagged(1), tagged(2), tagged(3), { "path": "12.mp3", "tags": { "album": "Orbital", "artist": "Orbital", "album_artist": "Orbital", "genre": null, "year": null, "track": 12 } }],
            "proposals": [{ "artist": "Orbital", "evidence": [], "files": [
                { "path": "1.mp3", "changes": [], "differences": [] }, { "path": "2.mp3", "changes": [], "differences": [] }, { "path": "3.mp3", "changes": [], "differences": [] },
            ] }],
        });
        follow_album(&mut result);
        let files = result["proposals"][0]["files"].as_array().unwrap();
        assert_eq!(files.len(), 4);
        let extra = &files[3];
        assert_eq!(extra["path"], "12.mp3");
        assert_eq!(extra["extra"], true);
        assert_eq!(extra["track"], 12);
        let changes: Vec<(String, String)> = extra["changes"]
            .as_array()
            .unwrap()
            .iter()
            .map(|c| {
                (
                    c["field"].as_str().unwrap().to_owned(),
                    c["to"].as_str().unwrap().to_owned(),
                )
            })
            .collect();
        assert_eq!(
            changes,
            [
                ("genre".to_owned(), "Electronic".to_owned()),
                ("year".to_owned(), "1993".to_owned())
            ],
            "only its gaps, from the album"
        );
        let once = result.clone();
        follow_album(&mut result);
        assert_eq!(result, once, "applying the rule twice changes nothing");
    }

    #[test]
    fn a_split_album_has_no_rule_and_a_compilation_keeps_each_artist() {
        let mut split = json!({
            "files": [{ "path": "1", "tags": { "genre": "Punk" } }, { "path": "2", "tags": { "genre": "Ska" } }, { "path": "3", "tags": {} }],
            "proposals": [{ "artist": "X", "evidence": [], "files": [{ "path": "3", "changes": [{ "field": "genre", "to": "Rock" }], "differences": [] }] }],
        });
        follow_album(&mut split);
        assert_eq!(
            split["proposals"][0]["files"][0]["changes"][0]["to"], "Rock",
            "no majority: the release's value"
        );
        let mut various = json!({
            "files": [{ "path": "1", "tags": { "artist": "Band A" } }, { "path": "2", "tags": { "artist": "Band A" } }, { "path": "3", "tags": {} }],
            "proposals": [{ "artist": "Various Artists", "evidence": [], "files": [{ "path": "3", "changes": [{ "field": "artist", "to": "Band C" }], "differences": [] }] }],
        });
        follow_album(&mut various);
        assert_eq!(
            various["proposals"][0]["files"][0]["changes"][0]["to"],
            "Band C"
        );
    }

    /// A small real MP3: an ID3v2.3 tag with `title` (and nothing else) followed by silent frames.
    fn song(path: &Path, title: &str) {
        let tags = mediaverse_ripper::id3::TagSet {
            title: title.into(),
            ..Default::default()
        };
        let mut bytes = mediaverse_ripper::id3::write_tag(&tags).unwrap();
        for _ in 0..40 {
            bytes.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
            bytes.extend(std::iter::repeat(0u8).take(413));
        }
        std::fs::write(path, bytes).unwrap();
    }

    #[test]
    fn apply_fills_only_gaps_journals_them_and_undo_puts_them_back() {
        let base = std::env::temp_dir().join(format!("mv-tag-apply-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let album = base.join("Band").join("Record");
        std::fs::create_dir_all(&album).unwrap();
        let files: Vec<PathBuf> = (1..=3)
            .map(|n| album.join(format!("0{n} Song {n}.mp3")))
            .collect();
        song(&files[0], "Song 1");
        song(&files[1], "");
        song(&files[2], "Track 3");
        let store = TagRepairStore::new(&base);
        let path = album.to_string_lossy().into_owned();
        let file = |i: usize, changes: Value| json!({ "path": files[i].to_string_lossy(), "track": i + 1, "fit": 99, "changes": changes });
        let proposal = json!({ "files": [
            // "title" for file 1 is proposed although it has one: apply must still leave it alone.
            file(0, json!([{ "field": "title", "to": "Other" }, { "field": "album", "to": "Record" }, { "field": "year", "to": "1999" }])),
            file(1, json!([{ "field": "title", "to": "Song 2" }, { "field": "album", "to": "Record" }, { "field": "year", "to": "1999" }])),
            file(2, json!([{ "field": "title", "to": "Song 3" }, { "field": "album", "to": "Record" }, { "field": "year", "to": "1999" }])),
        ]});
        let result = json!({ "folder": path, "files": [], "proposals": [proposal] });
        store
            .save(
                &path,
                &signature(&audio_files(&album)),
                "identified",
                97,
                &result,
            )
            .unwrap();

        // The person unticked the third file and the year column.
        let choice = AlbumChoice {
            path: path.clone(),
            edition: 0,
            skip_files: [files[2].to_string_lossy().into_owned()].into(),
            skip_fields: ["year".to_owned()].into(),
            // ...and typed over the second file's suggested title.
            edits: [(
                files[1].to_string_lossy().into_owned(),
                [("title".to_owned(), "Second Song".to_owned())].into(),
            )]
            .into(),
        };
        let outcome = apply(&store, std::slice::from_ref(&choice), &|_, _| {}).unwrap();
        assert_eq!(outcome["files"], 2, "{outcome}");
        assert_eq!(
            outcome["fields"], 3,
            "album on two files and one title: {outcome}"
        );
        let read = |i: usize| read_file(&files[i]).unwrap().tags;
        assert_eq!(
            read(0).title.as_deref(),
            Some("Song 1"),
            "a real title is never replaced"
        );
        assert_eq!(read(0).album.as_deref(), Some("Record"));
        assert_eq!(read(0).year, None, "unticked field");
        assert_eq!(
            read(1).title.as_deref(),
            Some("Second Song"),
            "the typed value, not the suggestion"
        );
        assert_eq!(read(2).title.as_deref(), Some("Track 3"), "unticked file");
        assert_eq!(store.row(&path).unwrap().unwrap().1, "applied");
        assert_eq!(
            store.page("all", 0, 10).unwrap()["total"],
            0,
            "applied albums leave the review"
        );
        let batch = store.last_batch().unwrap()["id"].as_i64().unwrap();

        // Undo restores the files and the album's place in the review.
        let undone = undo(&store, batch).unwrap();
        assert_eq!(undone["files"], 2, "{undone}");
        assert_eq!(read(0).album, None);
        assert_eq!(read(1).title, None);
        let row = store.row(&path).unwrap().unwrap();
        assert_eq!((row.1.as_str(), row.2), ("identified", 97));
        assert_eq!(
            row.0,
            signature(&audio_files(&album)),
            "the album is not rescanned for nothing"
        );
        assert!(store.last_batch().unwrap().is_null());
        assert!(undo(&store, batch).is_err(), "a batch is undone once");

        // An album whose files changed after the check is not written at all.
        song(&files[1], "");
        std::fs::write(album.join("04 New.mp3"), b"not audio").unwrap();
        let refused = apply(&store, &[choice], &|_, _| {}).unwrap();
        assert_eq!(refused["files"], 0);
        assert_eq!(refused["skipped"].as_array().unwrap().len(), 1, "{refused}");
        assert_eq!(read(1).album, None);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_title_that_differs_only_by_zero_padding_is_confirmed_as_the_file_has_it() {
        // Wagon Christ's Studio Session 1: the files say "Track 01", the file names suggest "Track 1".
        assert!(
            same_value("Track 01", "Track 1")
                && same_value("untitled", "Untitled")
                && same_value("Track 10", "Track 10")
        );
        assert!(
            !same_value("Track 10", "Track 1")
                && !same_value("Track 01", "Track 2")
                && !same_value("Song", "Songs")
        );
        let mut result = json!({ "files": [{ "path": "a.mp3", "tags": { "title": "Track 01" } }], "proposals": [{ "files": [
            { "path": "a.mp3", "changes": [{ "field": "title", "from": "Track 01", "to": "Track 1" }] },
        ]}]});
        mark_confirmations(&mut result);
        let change = &result["proposals"][0]["files"][0]["changes"][0];
        assert_eq!(
            (change["confirm"].clone(), change["to"].clone()),
            (json!(true), json!("Track 01")),
            "the owner's spelling is kept"
        );
    }

    #[test]
    fn titles_their_file_names_also_give_are_complete() {
        // Wagon Christ's Studio Session 1: "01 - Wagon Christ - Track 1.mp3" titled "Track 1".
        let base =
            std::env::temp_dir().join(format!("mv-tag-filename-title-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let album = base.join("Wagon Christ").join("Studio Session 1");
        std::fs::create_dir_all(&album).unwrap();
        let files: Vec<PathBuf> = (1..=4)
            .map(|n| album.join(format!("0{n} - Wagon Christ - Track {n}.mp3")))
            .collect();
        for (n, f) in files.iter().enumerate() {
            let tags = mediaverse_ripper::id3::TagSet {
                title: format!("Track {}", n + 1),
                artist: "Wagon Christ".into(),
                album: "Studio Session 1".into(),
                album_artist: "Wagon Christ".into(),
                track: Some((n as u32 + 1, None)),
                year: Some(1998),
                genre: Some("Electronica".into()),
                ..Default::default()
            };
            let mut bytes = mediaverse_ripper::id3::write_tag(&tags).unwrap();
            for _ in 0..40 {
                bytes.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
                bytes.extend(std::iter::repeat_n(0u8, 413));
            }
            std::fs::write(f, bytes).unwrap();
        }
        let (status, _, _) = scan_folder(
            &album,
            &files,
            &base,
            &MetadataSettings::default(),
            &MetadataState::new(&base),
            &BTreeMap::new(),
        );
        assert_eq!(status, "complete", "nothing to ask MusicBrainz about");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_folder_whose_files_cannot_be_read_is_not_filed_as_complete() {
        let base = std::env::temp_dir().join(format!("mv-tag-unreadable-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let album = base.join("Band").join("Broken");
        std::fs::create_dir_all(&album).unwrap();
        let files: Vec<PathBuf> = (1..=4).map(|n| album.join(format!("0{n}.mp3"))).collect();
        for f in &files {
            std::fs::write(f, b"not audio at all").unwrap();
        }
        let (status, _, result) = scan_folder(
            &album,
            &files,
            &base,
            &MetadataSettings::default(),
            &MetadataState::new(&base),
            &BTreeMap::new(),
        );
        assert_eq!(status, "no_match");
        assert!(
            result["note"]
                .as_str()
                .unwrap()
                .contains("could not be read"),
            "{result}"
        );
        // AppleDouble files and __MACOSX folders are not albums at all.
        std::fs::create_dir_all(base.join("Band").join("__MACOSX")).unwrap();
        std::fs::write(base.join("Band").join("__MACOSX").join("._01.mp3"), b"x").unwrap();
        std::fs::write(album.join("._05.mp3"), b"x").unwrap();
        let folders = album_folders(&base);
        assert_eq!(folders.len(), 1);
        assert_eq!(folders[0].1.len(), 4, "the ._ file is left out");
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn a_song_really_called_untitled_does_not_keep_its_album_in_the_review() {
        // The owner's blink-182 Dude Ranch: track 8 is "Untitled" on the file and on the release.
        let base = std::env::temp_dir().join(format!("mv-tag-untitled-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let album = base.join("Blink-182").join("Dude Ranch");
        std::fs::create_dir_all(&album).unwrap();
        let file = album.join("08 Untitled.mp3");
        song(&file, "Untitled");
        let store = TagRepairStore::new(&base);
        let path = album.to_string_lossy().into_owned();
        let name = file.to_string_lossy().into_owned();
        let result = json!({ "folder": path, "files": [{ "path": name, "tags": { "title": "Untitled" } }], "proposals": [{ "files": [
            { "path": name, "track": 8, "fit": 99, "changes": [{ "field": "title", "from": "Untitled", "to": "Untitled" }] },
        ]}]});
        let mut shown = result.clone();
        prepare(&mut shown);
        assert_eq!(
            shown["proposals"][0]["files"][0]["changes"][0]["confirm"], true,
            "still shown, as one to confirm"
        );
        store
            .save(
                &path,
                &signature(&audio_files(&album)),
                "identified",
                99,
                &result,
            )
            .unwrap();
        let choice = AlbumChoice {
            path: path.clone(),
            edition: 0,
            skip_files: Default::default(),
            skip_fields: Default::default(),
            edits: Default::default(),
        };
        let outcome = apply(&store, &[choice], &|_, _| {}).unwrap();
        assert_eq!(
            (outcome["files"].as_u64(), outcome["confirmed"].as_u64()),
            (Some(0), Some(1)),
            "{outcome}"
        );
        assert_eq!(
            store
                .confirmed_values()
                .unwrap()
                .get(&(name.clone(), "title".to_owned()))
                .map(String::as_str),
            Some("Untitled"),
            "remembered for the next check"
        );
        assert!(store.last_batch().unwrap().is_null(), "nothing to undo");
        assert_eq!(store.row(&path).unwrap().unwrap().1, "applied");
        assert_eq!(
            store.page("all", 0, 10).unwrap()["total"],
            0,
            "the album leaves the review"
        );
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn an_album_without_a_release_gets_suggestions_from_its_names_and_typed_values_replace_real_tags()
     {
        let base = std::env::temp_dir().join(format!("mv-tag-local-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let album = base.join("Band").join("Live");
        std::fs::create_dir_all(&album).unwrap();
        let files: Vec<PathBuf> = ["01 Opener", "02 Middle", "03 Closer"]
            .iter()
            .map(|n| album.join(format!("{n}.mp3")))
            .collect();
        song(&files[0], "01.Band - Opener - www.example.com");
        song(&files[1], "Middle");
        song(&files[2], "");
        let store = TagRepairStore::new(&base);
        let path = album.to_string_lossy().into_owned();
        let scanned: Vec<Value> = files.iter().map(|f| { let r = read_file(f).unwrap(); json!({ "path": r.path, "stem": r.stem, "tags": r.tags, "length_ms": 0, "missing": r.tags.missing() }) }).collect();
        let result = json!({ "folder": path, "clues": { "artist": "Band", "album": "Live" }, "files": scanned, "unreadable": [], "note": "No release with this many tracks fits these files and names." });
        store
            .save(
                &path,
                &signature(&audio_files(&album)),
                "no_match",
                0,
                &result,
            )
            .unwrap();

        // The page: suggestions from the folder and file names, and a tidied title.
        let mut shown = result.clone();
        prepare(&mut shown);
        let proposal = &shown["proposals"][0];
        assert_eq!(proposal["source"], FROM_FOLDER);
        let change = |i: usize, field: &str| {
            proposal["files"][i]["changes"]
                .as_array()
                .unwrap()
                .iter()
                .find(|c| c["field"] == field)
                .map(|c| c["to"].clone())
        };
        assert_eq!(change(0, "album"), Some(json!("Live")));
        assert_eq!(change(0, "album_artist"), Some(json!("Band")));
        assert_eq!(change(0, "track"), Some(json!("1")));
        assert_eq!(
            change(0, "title"),
            Some(json!("Opener")),
            "tidied: {proposal}"
        );
        assert_eq!(
            change(2, "title"),
            Some(json!("Closer")),
            "from the file name"
        );
        assert_eq!(change(1, "title"), None, "a clean title is left alone");
        let again = shown.clone();
        prepare(&mut shown);
        assert_eq!(shown, again, "preparing twice changes nothing");

        // Apply: the suggestions, plus a year typed for the album and a title typed over a real one.
        let edits = [
            (
                files[0].to_string_lossy().into_owned(),
                [("year".to_owned(), "2001".to_owned())].into(),
            ),
            (
                files[1].to_string_lossy().into_owned(),
                [
                    ("title".to_owned(), "Centre".to_owned()),
                    ("year".to_owned(), "2001".to_owned()),
                    ("track".to_owned(), "two".to_owned()),
                ]
                .into(),
            ),
            // A path outside the album is ignored.
            (
                base.join("elsewhere.mp3").to_string_lossy().into_owned(),
                [("title".to_owned(), "x".to_owned())].into(),
            ),
        ];
        let choice = AlbumChoice {
            path: path.clone(),
            edition: 0,
            edits: edits.into(),
            ..AlbumChoice::default()
        };
        let outcome = apply(&store, &[choice], &|_, _| {}).unwrap();
        assert_eq!(outcome["files"], 3, "{outcome}");
        assert!(
            outcome["skipped"].to_string().contains("not a number"),
            "{outcome}"
        );
        let read = |i: usize| read_file(&files[i]).unwrap().tags;
        assert_eq!(
            (
                read(0).title.as_deref(),
                read(0).album.as_deref(),
                read(0).year
            ),
            (Some("Opener"), Some("Live"), Some(2001))
        );
        assert_eq!(
            (read(1).title.as_deref(), read(1).year, read(1).track),
            (Some("Centre"), Some(2001), None),
            "typed over a real title; a track number typed as a word is refused and reported, not replaced by the suggestion"
        );
        assert_eq!(read(0).track, Some(1), "the track from the file name");
        assert_eq!(
            (read(2).title.as_deref(), read(2).artist.as_deref()),
            (Some("Closer"), Some("Band"))
        );
        assert!(!base.join("elsewhere.mp3").exists());
        let _ = std::fs::remove_dir_all(&base);
    }
}
