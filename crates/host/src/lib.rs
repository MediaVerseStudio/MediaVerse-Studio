//! Transport-independent MediaVerse host: owns the library state and exposes the command set that
//! the sidecar (and any future shell) dispatches into. Shells supply an `EventSink` for events.

use mediaverse_application::LibraryRepository;
use mediaverse_application::{
    ApplicationError, ImportTrack, LibraryService, SequentialTrackIdGenerator,
};
use mediaverse_library_filesystem::{ScanError, scan_music_collection};
use mediaverse_metadata_tags::{
    FileFacts, TrackMetadata, read_track_details, write_track_metadata,
};
use mediaverse_persistence_sqlite::{FileRecord, SqliteLibraryRepository};
use notify::{Config, PollWatcher, RecommendedWatcher, RecursiveMode, Watcher};
use serde::{Deserialize, Serialize};
use serde_json::Value;
use std::collections::{BTreeSet, HashMap};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{Arc, Mutex};
use std::time::Duration;

type AppLibrary = LibraryService<SqliteLibraryRepository, SequentialTrackIdGenerator>;

/// Receives events (`library-updated`, `collection-sync-failed`) raised by background work.
pub trait EventSink: Send + Sync + 'static {
    fn emit(&self, event: &str, payload: Value);
}

struct AppState {
    collection_root: Mutex<Option<PathBuf>>,
    database_path: PathBuf,
    library: Mutex<AppLibrary>,
    sync_pending: AtomicBool,
    /// A folder change was reported that no sync has covered yet (see `schedule_collection_sync`).
    sync_requested: AtomicBool,
    watcher: Mutex<Option<Box<dyn Watcher + Send>>>,
    /// What each library file looked like when its tags were last read, so a resync reads only files that
    /// changed (ADR 0008). Cleared when a different library folder is chosen.
    known_files: Mutex<HashMap<String, KnownFile>>,
}

#[derive(Clone)]
struct KnownFile {
    size: u64,
    modified_nanos: u128,
    import: ImportTrack,
    /// Length, bitrate and disc number, read with the tags; size and creation time come from the file system.
    facts: FileFacts,
    created_secs: Option<u64>,
    read_ok: bool,
    title_from_file_name: bool,
}

/// Raise this when the tag reading changes what it finds in an unchanged file (a new fact, a fixed rule): the
/// stored file records of older versions are then ignored and every file is read once more.
const FILE_READ_VERSION: u32 = 1;

impl KnownFile {
    fn record(&self) -> FileRecord {
        FileRecord {
            source_uri: self.import.source_uri.clone(),
            size: self.size,
            modified_nanos: self.modified_nanos,
            length_ms: self.facts.length_ms,
            bitrate_kbps: self.facts.bitrate_kbps,
            disc_number: self.facts.disc_number,
            created_secs: self.created_secs,
            read_ok: self.read_ok,
            title_from_file_name: self.title_from_file_name,
        }
    }
}

/// The file records kept from the last run, joined with the stored library, so the first sync after a start
/// reads only files that changed while the program was closed. Empty (every file is read, as on a first run)
/// unless there is a record for every track: a partly recorded library is not trusted.
fn stored_known_files(repository: &SqliteLibraryRepository) -> HashMap<String, KnownFile> {
    let (Ok(records), Ok(tracks)) = (
        repository.file_records(FILE_READ_VERSION),
        repository.list_tracks(),
    ) else {
        return HashMap::new();
    };
    let mut records: HashMap<String, FileRecord> = records
        .into_iter()
        .map(|record| (record.source_uri.clone(), record))
        .collect();
    let total = tracks.len();
    let known: HashMap<String, KnownFile> = tracks
        .into_iter()
        .filter_map(|track| {
            let record = records.remove(track.source_uri())?;
            Some((
                record.source_uri,
                KnownFile {
                    size: record.size,
                    modified_nanos: record.modified_nanos,
                    facts: FileFacts {
                        length_ms: record.length_ms,
                        bitrate_kbps: record.bitrate_kbps,
                        disc_number: record.disc_number,
                    },
                    created_secs: record.created_secs,
                    read_ok: record.read_ok,
                    title_from_file_name: record.title_from_file_name,
                    import: ImportTrack {
                        album: track.album().map(ToOwned::to_owned),
                        album_artist: track.album_artist().map(ToOwned::to_owned),
                        artist: track.artist().map(ToOwned::to_owned),
                        genre: track.genre().map(ToOwned::to_owned),
                        release_year: track.release_year(),
                        source_uri: track.source_uri().to_owned(),
                        track_number: track.track_number(),
                        title: track.title().to_owned(),
                    },
                },
            ))
        })
        .collect();
    if known.len() == total {
        known
    } else {
        HashMap::new()
    }
}

fn file_stamp(path: &Path) -> Option<(u64, u128)> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((meta.len(), modified))
}
#[derive(Deserialize)]
struct ImportTrackRequest {
    source_uri: String,
    title: String,
}

#[derive(Deserialize)]
struct TagEditRequest {
    album: Option<String>,
    album_artist: Option<String>,
    artist: Option<String>,
    genre: Option<String>,
    release_year: Option<u32>,
    source_uri: String,
    title: Option<String>,
    track_number: Option<u32>,
    /// The compilation flag: true sets it, false removes it, absent leaves the file as it is.
    #[serde(default)]
    compilation: Option<bool>,
}

#[derive(Clone, Serialize)]
struct TrackView {
    album: Option<String>,
    album_artist: Option<String>,
    artist: Option<String>,
    genre: Option<String>,
    id: String,
    release_year: Option<u32>,
    title: String,
    source_uri: String,
    suggestions: Vec<String>,
    track_number: Option<u32>,
    /// File facts for the library's columns (absent until the file has been read).
    length_ms: Option<u64>,
    bitrate_kbps: Option<u32>,
    disc_number: Option<u32>,
    size_bytes: Option<u64>,
    /// When the file came into the library: its creation time on disk, in seconds since 1970.
    added_secs: Option<u64>,
}

#[derive(Clone, Serialize)]
struct LibrarySnapshotView {
    tracks: Vec<TrackView>,
}

#[derive(Clone, Serialize)]
struct CollectionImportView {
    filename_title_fallbacks: usize,
    metadata_failures: usize,
    root: String,
    track_count: usize,
    tracks: Vec<TrackView>,
}

#[derive(Serialize)]
struct CollectionStatusView {
    root: Option<String>,
}

#[derive(Clone, Serialize)]
struct AlbumChoiceView {
    album: String,
    album_artist: String,
    release_year: Option<u32>,
}

#[derive(Clone, Serialize)]
struct TagEditorChoicesView {
    albums: Vec<AlbumChoiceView>,
    artists: Vec<String>,
    genres: Vec<String>,
}

struct CollectionSync {
    filename_title_fallbacks: usize,
    metadata_failures: usize,
    snapshot: LibrarySnapshotView,
}

#[derive(Debug, Default, PartialEq, Eq)]
struct FileNameMetadata {
    album: Option<String>,
    artist: Option<String>,
    title: Option<String>,
    track_number: Option<u32>,
}

#[derive(Clone, Serialize)]
pub struct ApiError {
    pub code: &'static str,
    pub message: String,
}

impl From<ApplicationError> for ApiError {
    fn from(error: ApplicationError) -> Self {
        let code = match error {
            ApplicationError::UnsupportedAudioSource(_) => "unsupported_audio_source",
            ApplicationError::InvalidTrack(_) => "invalid_track",
            ApplicationError::DuplicateTrackId(_) => "duplicate_track",
            ApplicationError::Repository(_) => "repository_error",
        };

        Self {
            code,
            message: error.to_string(),
        }
    }
}

impl From<ScanError> for ApiError {
    fn from(error: ScanError) -> Self {
        Self {
            code: "collection_scan_failed",
            message: error.to_string(),
        }
    }
}

/// The library as the page sees it. `root` is the music library folder, used to suggest fixes for missing
/// tags from the folder layout; every reply that carries tracks goes through `track_view`, so the Review
/// page's list of tag issues is the same after a restart as right after an import.
fn snapshot_view(
    library: &AppLibrary,
    root: Option<&Path>,
    known: &HashMap<String, KnownFile>,
) -> Result<LibrarySnapshotView, ApiError> {
    let snapshot = library.snapshot().map_err(ApiError::from)?;

    Ok(LibrarySnapshotView {
        tracks: snapshot
            .tracks
            .iter()
            .map(|track| track_view(track, root, known.get(track.source_uri())))
            .collect(),
    })
}

fn track_view(
    track: &mediaverse_domain::Track,
    root: Option<&Path>,
    file: Option<&KnownFile>,
) -> TrackView {
    TrackView {
        length_ms: file.and_then(|f| f.facts.length_ms),
        bitrate_kbps: file.and_then(|f| f.facts.bitrate_kbps),
        disc_number: file.and_then(|f| f.facts.disc_number),
        size_bytes: file.map(|f| f.size).filter(|s| *s > 0),
        added_secs: file.and_then(|f| f.created_secs),
        album: track.album().map(ToOwned::to_owned),
        album_artist: track.album_artist().map(ToOwned::to_owned),
        artist: track.artist().map(ToOwned::to_owned),
        genre: track.genre().map(ToOwned::to_owned),
        id: track.id().as_str().to_owned(),
        release_year: track.release_year(),
        title: track.title().to_owned(),
        source_uri: track.source_uri().to_owned(),
        suggestions: root.map_or_else(Vec::new, |root| {
            path_suggestions(
                root,
                track.source_uri(),
                track.title(),
                track.artist(),
                track.album(),
                track.album_artist(),
                track.genre(),
                track.track_number(),
            )
        }),
        track_number: track.track_number(),
    }
}

fn path_suggestions(
    root: &Path,
    source_uri: &str,
    title: &str,
    artist: Option<&str>,
    album: Option<&str>,
    album_artist: Option<&str>,
    genre: Option<&str>,
    track_number: Option<u32>,
) -> Vec<String> {
    let path = Path::new(source_uri);
    let file_name_metadata = path
        .file_stem()
        .and_then(|stem| stem.to_str())
        .map(parse_file_name_metadata)
        .unwrap_or_default();
    let album_from_path = path
        .parent()
        .filter(|parent| *parent != root)
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str());
    let artist_from_path = path
        .parent()
        .and_then(Path::parent)
        .and_then(|parent| parent.file_name())
        .and_then(|name| name.to_str())
        .filter(|name| {
            path.parent()
                .and_then(Path::parent)
                .is_some_and(|parent| parent != root || !is_generic_collection_root(name))
        });
    let suggested_artist = artist_from_path.or(file_name_metadata.artist.as_deref());
    let suggested_album = album_from_path.or(file_name_metadata.album.as_deref());
    let mut suggestions = Vec::new();

    if is_missing_or_unknown(Some(title))
        && let Some(suggested_title) = file_name_metadata.title
    {
        suggestions.push(format!("Suggested title: {suggested_title}"));
    }
    if is_missing_or_unknown(artist)
        && let Some(artist) = suggested_artist
    {
        suggestions.push(format!("Suggested artist: {artist}"));
    }
    if is_missing_or_unknown(album)
        && let Some(album) = suggested_album
    {
        suggestions.push(format!("Suggested album: {album}"));
    }
    if is_missing_or_unknown(album_artist)
        && let Some(album_artist) = suggested_artist
    {
        suggestions.push(format!("Suggested album artist: {album_artist}"));
    }
    if track_number.is_none()
        && let Some(track_number) = file_name_metadata.track_number
    {
        suggestions.push(format!("Suggested track number: {track_number:02}"));
    }
    if is_missing_or_unknown(genre) {
        suggestions.push("Genre needs review.".to_owned());
    }

    suggestions
}

fn is_missing_or_unknown(value: Option<&str>) -> bool {
    let Some(value) = value else {
        return true;
    };
    let normalized = value.trim().to_ascii_lowercase();

    normalized.is_empty()
        || normalized.starts_with("unknown")
        || normalized.strip_prefix("track ").is_some_and(|number| {
            number
                .trim()
                .chars()
                .all(|character| character.is_ascii_digit())
        })
}

fn is_generic_collection_root(name: &str) -> bool {
    matches!(
        name.trim().to_ascii_lowercase().as_str(),
        "audio" | "music" | "music collection" | "music library" | "my music"
    )
}

fn tag_editor_choices(library: &AppLibrary) -> Result<TagEditorChoicesView, ApiError> {
    let snapshot = library.snapshot().map_err(ApiError::from)?;
    let mut artists = BTreeSet::new();
    let mut genres = BTreeSet::new();
    let mut albums = BTreeSet::new();

    for track in snapshot.tracks {
        for artist in [track.artist(), track.album_artist()]
            .into_iter()
            .flatten()
            .filter(|value| !is_missing_or_unknown(Some(value)))
        {
            artists.insert(artist.to_owned());
        }
        if let Some(genre) = track
            .genre()
            .filter(|value| !is_missing_or_unknown(Some(value)))
        {
            genres.insert(genre.to_owned());
        }
        if let (Some(album_artist), Some(album)) = (
            track.album_artist().or(track.artist()),
            track
                .album()
                .filter(|value| !is_missing_or_unknown(Some(value))),
        ) && !is_missing_or_unknown(Some(album_artist))
        {
            albums.insert((
                album_artist.to_owned(),
                album.to_owned(),
                track.release_year(),
            ));
        }
    }

    Ok(TagEditorChoicesView {
        albums: albums
            .into_iter()
            .map(|(album_artist, album, release_year)| AlbumChoiceView {
                album,
                album_artist,
                release_year,
            })
            .collect(),
        artists: artists.into_iter().collect(),
        genres: genres.into_iter().collect(),
    })
}

fn parse_file_name_metadata(file_name: &str) -> FileNameMetadata {
    let digits = file_name
        .chars()
        .take_while(|character| character.is_ascii_digit())
        .collect::<String>();
    let remainder = file_name[digits.len()..]
        .trim_start_matches([' ', '-', '_', '.'])
        .trim();

    if !digits.is_empty() && !remainder.is_empty() && !file_name.contains(" - ") {
        return FileNameMetadata {
            title: Some(remainder.to_owned()),
            track_number: digits.parse::<u32>().ok(),
            ..Default::default()
        };
    }

    let parts = file_name
        .split(" - ")
        .map(str::trim)
        .filter(|part| !part.is_empty())
        .collect::<Vec<_>>();
    if parts.len() < 2 {
        return FileNameMetadata::default();
    }

    let component_number = |index: usize| parts.get(index)?.parse::<u32>().ok();
    let title_from = |index: usize| Some(parts[index..].join(" - "));

    if let Some(track_number) = component_number(0) {
        return match parts.len() {
            2 => FileNameMetadata {
                title: title_from(1),
                track_number: Some(track_number),
                ..Default::default()
            },
            3 => FileNameMetadata {
                artist: Some(parts[1].to_owned()),
                title: title_from(2),
                track_number: Some(track_number),
                ..Default::default()
            },
            _ => FileNameMetadata {
                artist: Some(parts[1].to_owned()),
                album: Some(parts[2].to_owned()),
                title: title_from(3),
                track_number: Some(track_number),
            },
        };
    }

    if parts.len() > 3
        && let Some(track_number) = component_number(2)
    {
        return FileNameMetadata {
            artist: Some(parts[0].to_owned()),
            album: Some(parts[1].to_owned()),
            title: title_from(3),
            track_number: Some(track_number),
        };
    }

    if let Some(track_number) = component_number(1) {
        return FileNameMetadata {
            artist: Some(parts[0].to_owned()),
            title: title_from(2),
            track_number: Some(track_number),
            ..Default::default()
        };
    }

    match parts.len() {
        2 => FileNameMetadata {
            artist: Some(parts[0].to_owned()),
            title: title_from(1),
            ..Default::default()
        },
        _ => FileNameMetadata {
            artist: Some(parts[0].to_owned()),
            album: Some(parts[1].to_owned()),
            title: title_from(2),
            ..Default::default()
        },
    }
}

/// Reads the library folder into the library. Only files that are new or changed since the last read have
/// their tags read again. With `only_if_changed`, nothing is written or sent when no file changed (the
/// folder watcher also reports changes to covers, lyrics files and other non-audio files).
fn sync_collection_if_changed(
    state: &AppState,
    root: &Path,
    only_if_changed: bool,
) -> Result<Option<CollectionSync>, ApiError> {
    let mut filename_title_fallbacks = 0;
    let mut metadata_failures = 0;
    let previous = state
        .known_files
        .lock()
        .map_err(|_| state_error("The library state is unavailable."))?
        .clone();
    let mut known = HashMap::with_capacity(previous.len());
    let mut changed = false;
    let mut read_again: Vec<String> = Vec::new();
    let imports: Vec<ImportTrack> = scan_music_collection(root)?
        .into_iter()
        .map(|track| {
            let stamp = file_stamp(Path::new(&track.source_uri));
            let cached = previous
                .get(&track.source_uri)
                .filter(|known| stamp == Some((known.size, known.modified_nanos)));
            let entry = match cached {
                Some(entry) => entry.clone(),
                None => {
                    changed = true;
                    read_again.push(track.source_uri.clone());
                    let (metadata, facts, read_ok) =
                        match read_track_details(Path::new(&track.source_uri)) {
                            Ok((metadata, facts)) => (metadata, facts, true),
                            Err(_) => (Default::default(), FileFacts::default(), false),
                        };
                    let created_secs = std::fs::metadata(&track.source_uri)
                        .and_then(|m| m.created())
                        .ok()
                        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                        .map(|d| d.as_secs());
                    KnownFile {
                        size: stamp.map_or(0, |s| s.0),
                        modified_nanos: stamp.map_or(0, |s| s.1),
                        facts,
                        created_secs,
                        read_ok,
                        title_from_file_name: read_ok && metadata.title.is_none(),
                        import: ImportTrack {
                            album: metadata.album,
                            album_artist: metadata.album_artist,
                            artist: metadata.artist,
                            genre: metadata.genre,
                            release_year: metadata.release_year,
                            source_uri: track.source_uri.clone(),
                            track_number: metadata.track_number,
                            title: metadata.title.unwrap_or(track.title),
                        },
                    }
                }
            };
            if !entry.read_ok {
                metadata_failures += 1;
            }
            if entry.title_from_file_name {
                filename_title_fallbacks += 1;
            }
            let import = entry.import.clone();
            known.insert(track.source_uri, entry);
            import
        })
        .collect();
    if known.len() != previous.len() {
        changed = true; // files were removed (or added; added ones are already counted)
    }
    if only_if_changed && !changed {
        return Ok(None);
    }
    let mut library = state.library.lock().map_err(|_| ApiError {
        code: "state_unavailable",
        message: "The library state is unavailable.".to_owned(),
    })?;
    let snapshot = library.replace_library(imports).map_err(ApiError::from)?;
    // Remember what was read only once it is in the library, so a failed write is read again next time.
    // The reply is made from the file record before it is stored (no copy of thousands of entries).
    let tracks = snapshot
        .tracks
        .iter()
        .map(|track| track_view(track, Some(root), known.get(track.source_uri())))
        .collect();
    // Kept in the database too, so the next start reads only what changed meanwhile. A failure here costs
    // nothing but that: those files are read again after the next start.
    let changed_records: Vec<FileRecord> = read_again
        .iter()
        .filter_map(|uri| known.get(uri))
        .map(KnownFile::record)
        .collect();
    let removed: Vec<String> = previous
        .keys()
        .filter(|uri| !known.contains_key(*uri))
        .cloned()
        .collect();
    if let Err(error) =
        SqliteLibraryRepository::open(&state.database_path).and_then(|mut repository| {
            repository.update_file_records(FILE_READ_VERSION, &changed_records, &removed)
        })
    {
        eprintln!("MediaVerse: the file records were not saved: {error}");
    }
    *state
        .known_files
        .lock()
        .map_err(|_| state_error("The library state is unavailable."))? = known;

    Ok(Some(CollectionSync {
        filename_title_fallbacks,
        metadata_failures,
        snapshot: LibrarySnapshotView { tracks },
    }))
}

/// Reads the library folder now (for an import or a requested rescan), whether or not anything changed.
fn sync_collection(state: &AppState, root: &Path) -> Result<CollectionSync, ApiError> {
    sync_collection_if_changed(state, root, false)?
        .ok_or_else(|| state_error("The library could not be read."))
}

fn state_error(message: &str) -> ApiError {
    ApiError {
        code: "state_unavailable",
        message: message.to_owned(),
    }
}

fn to_value<T: Serialize>(value: T) -> Result<Value, ApiError> {
    serde_json::to_value(value).map_err(|error| ApiError {
        code: "serialization_failed",
        message: error.to_string(),
    })
}

fn emit_error(events: &dyn EventSink, error: ApiError) {
    if let Ok(payload) = serde_json::to_value(error) {
        events.emit("collection-sync-failed", payload);
    }
}

fn schedule_collection_sync(state: Arc<AppState>, events: Arc<dyn EventSink>) {
    // A change reported while a sync is already running may be to a file that sync has passed (the last files
    // of a long batch of tag writes, for one): it is noted here and the running thread syncs once more.
    state.sync_requested.store(true, Ordering::Release);
    if state.sync_pending.swap(true, Ordering::AcqRel) {
        return;
    }

    std::thread::spawn(move || {
        loop {
            // Changes come in bursts (a tag write is several events): wait for the burst, then read once.
            std::thread::sleep(Duration::from_millis(500));
            state.sync_requested.store(false, Ordering::Release);
            sync_collection_for_watcher(&state, events.as_ref());
            if state.sync_requested.load(Ordering::Acquire) {
                continue;
            }
            state.sync_pending.store(false, Ordering::Release);
            // A change reported between that check and the line above found a sync "pending" and left it to
            // this thread: take the work back unless another thread has already been started for it.
            if !state.sync_requested.load(Ordering::Acquire)
                || state.sync_pending.swap(true, Ordering::AcqRel)
            {
                break;
            }
        }
    });
}

fn sync_collection_for_watcher(state: &AppState, events: &dyn EventSink) {
    let root = match state.collection_root.lock() {
        Ok(root) => root.clone(),
        Err(_) => {
            emit_error(
                events,
                state_error("The selected collection is unavailable."),
            );
            return;
        }
    };
    if let Some(root) = root {
        match sync_collection_if_changed(state, &root, true) {
            Ok(None) => {} // nothing in the library changed
            Ok(Some(result)) => {
                if let Ok(payload) = serde_json::to_value(result.snapshot) {
                    events.emit("library-updated", payload);
                }
            }
            Err(error) => emit_error(events, error),
        }
    }
}

fn monitor_collection(
    root: &Path,
    state: Arc<AppState>,
    events: Arc<dyn EventSink>,
) -> Result<Box<dyn Watcher + Send>, ApiError> {
    fn failure(error: notify::Error) -> ApiError {
        ApiError {
            code: "collection_monitor_failed",
            message: error.to_string(),
        }
    }
    let handler = |state: Arc<AppState>, events: Arc<dyn EventSink>| {
        move |event: notify::Result<notify::Event>| match event {
            Ok(_) => schedule_collection_sync(state.clone(), events.clone()),
            Err(error) => emit_error(events.as_ref(), failure(error)),
        }
    };
    // The system's own change notifications cost nothing while nothing changes. Checking every file every
    // two seconds instead used about 11% of a processor core all the time with 100,000 songs (ADR 0008), so
    // polling is only the fallback (for example for network folders that do not send notifications), and slow.
    let native = RecommendedWatcher::new(handler(state.clone(), events.clone()), Config::default())
        .and_then(|mut watcher| {
            watcher.watch(root, RecursiveMode::Recursive)?;
            Ok(watcher)
        });
    if let Ok(watcher) = native {
        return Ok(Box::new(watcher));
    }
    let mut watcher = PollWatcher::new(
        handler(state, events),
        Config::default().with_poll_interval(Duration::from_secs(30)),
    )
    .map_err(failure)?;
    watcher
        .watch(root, RecursiveMode::Recursive)
        .map_err(failure)?;
    Ok(Box::new(watcher))
}

/// The library command surface shared by every shell. Command and event names are part of the
/// sidecar protocol (ADR 0003); renaming one is a breaking change.
pub struct Host {
    events: Arc<dyn EventSink>,
    state: Arc<AppState>,
}

impl Host {
    /// Opens (creating if needed) the library database in `data_dir` and resumes monitoring the
    /// previously selected collection.
    pub fn open(data_dir: &Path, events: Arc<dyn EventSink>) -> Result<Self, ApiError> {
        let failure = |error: &dyn std::fmt::Display| ApiError {
            code: "host_start_failed",
            message: error.to_string(),
        };
        std::fs::create_dir_all(data_dir).map_err(|error| failure(&error))?;
        let database_path = data_dir.join("library.sqlite");
        let repository = SqliteLibraryRepository::open(&database_path).map_err(ApiError::from)?;
        let collection_root = repository
            .collection_root()
            .map_err(ApiError::from)?
            .map(PathBuf::from);
        let known_files = stored_known_files(&repository);
        let state = Arc::new(AppState {
            collection_root: Mutex::new(collection_root.clone()),
            database_path,
            library: Mutex::new(LibraryService::new(
                repository,
                SequentialTrackIdGenerator::default(),
            )),
            sync_pending: AtomicBool::new(false),
            sync_requested: AtomicBool::new(false),
            watcher: Mutex::new(None),
            known_files: Mutex::new(known_files),
        });

        if let Some(root) = collection_root.filter(|root| root.is_dir()) {
            let watcher = monitor_collection(&root, state.clone(), events.clone())?;
            *state
                .watcher
                .lock()
                .map_err(|_| state_error("The collection monitor is unavailable."))? =
                Some(watcher);
            // Read every file once in the background after start: the library itself comes from the database,
            // but the file facts the song list shows (length, bitrate, disc, size, date added) are only known
            // once each file has been read. The page is sent the fuller library when this finishes.
            schedule_collection_sync(state.clone(), events.clone());
        }

        Ok(Self { events, state })
    }

    pub fn commands() -> &'static [&'static str] {
        &[
            "collection_status",
            "import_collection",
            "import_track",
            "library_snapshot",
            "rescan_collection",
            "tag_editor_choices_command",
            "write_track_tags",
        ]
    }

    /// Runs one command. `args` is the JSON object the renderer passed (or `null`).
    pub fn dispatch(&self, command: &str, args: Value) -> Result<Value, ApiError> {
        match command {
            "collection_status" => to_value(self.collection_status()?),
            "import_collection" => to_value(self.import_collection(arg(&args, "root")?)?),
            "import_track" => to_value(self.import_track(arg(&args, "request")?)?),
            "library_snapshot" => to_value(self.library_snapshot()?),
            "rescan_collection" => to_value(self.rescan_collection()?),
            "tag_editor_choices_command" => to_value(self.tag_editor_choices()?),
            "write_track_tags" => to_value(self.write_track_tags(arg(&args, "request")?)?),
            _ => Err(ApiError {
                code: "unknown_command",
                message: format!("Unknown command: {command}"),
            }),
        }
    }

    fn selected_root(&self, missing_message: &str) -> Result<PathBuf, ApiError> {
        self.state
            .collection_root
            .lock()
            .map_err(|_| state_error("The selected collection is unavailable."))?
            .clone()
            .ok_or_else(|| ApiError {
                code: "collection_not_selected",
                message: missing_message.to_owned(),
            })
    }

    fn library_snapshot(&self) -> Result<LibrarySnapshotView, ApiError> {
        let root = self
            .state
            .collection_root
            .lock()
            .map_err(|_| state_error("The selected collection is unavailable."))?
            .clone();
        let library = self
            .state
            .library
            .lock()
            .map_err(|_| state_error("The library state is unavailable."))?;
        let known = self
            .state
            .known_files
            .lock()
            .map_err(|_| state_error("The library state is unavailable."))?;
        snapshot_view(&library, root.as_deref(), &known)
    }

    fn collection_status(&self) -> Result<CollectionStatusView, ApiError> {
        let root = self
            .state
            .collection_root
            .lock()
            .map_err(|_| state_error("The selected collection is unavailable."))?;

        Ok(CollectionStatusView {
            root: root
                .as_ref()
                .map(|root| root.to_string_lossy().into_owned()),
        })
    }

    fn tag_editor_choices(&self) -> Result<TagEditorChoicesView, ApiError> {
        let library = self
            .state
            .library
            .lock()
            .map_err(|_| state_error("The library state is unavailable."))?;
        tag_editor_choices(&library)
    }

    fn rescan_collection(&self) -> Result<LibrarySnapshotView, ApiError> {
        let root = self.selected_root("Choose a music collection before scanning.")?;

        Ok(sync_collection(&self.state, &root)?.snapshot)
    }

    fn write_track_tags(&self, request: TagEditRequest) -> Result<LibrarySnapshotView, ApiError> {
        let root = self
            .selected_root("Choose a music collection before editing tags.")?
            .canonicalize()
            .map_err(|error| ApiError {
                code: "collection_unavailable",
                message: error.to_string(),
            })?;
        let source = PathBuf::from(&request.source_uri)
            .canonicalize()
            .map_err(|error| ApiError {
                code: "source_unavailable",
                message: error.to_string(),
            })?;
        if !source.starts_with(&root) {
            return Err(ApiError {
                code: "source_outside_collection",
                message: "Only files in the selected music collection can be edited.".to_owned(),
            });
        }

        write_track_metadata(
            &source,
            &TrackMetadata {
                album: request.album,
                album_artist: request.album_artist,
                artist: request.artist,
                genre: request.genre,
                release_year: request.release_year,
                title: request.title,
                track_number: request.track_number,
                compilation: request.compilation,
            },
        )
        .map_err(|error| ApiError {
            code: "tag_write_failed",
            message: error.to_string(),
        })?;

        Ok(sync_collection(&self.state, &root)?.snapshot)
    }

    fn import_track(&self, request: ImportTrackRequest) -> Result<TrackView, ApiError> {
        let mut library = self
            .state
            .library
            .lock()
            .map_err(|_| state_error("The library state is unavailable."))?;
        let track = library
            .import_track(ImportTrack {
                album: None,
                album_artist: None,
                artist: None,
                genre: None,
                release_year: None,
                source_uri: request.source_uri,
                track_number: None,
                title: request.title,
            })
            .map_err(ApiError::from)?;

        Ok(TrackView {
            album: track.album().map(ToOwned::to_owned),
            album_artist: track.album_artist().map(ToOwned::to_owned),
            artist: track.artist().map(ToOwned::to_owned),
            genre: track.genre().map(ToOwned::to_owned),
            id: track.id().as_str().to_owned(),
            release_year: track.release_year(),
            title: track.title().to_owned(),
            source_uri: track.source_uri().to_owned(),
            suggestions: Vec::new(),
            track_number: track.track_number(),
            length_ms: None,
            bitrate_kbps: None,
            disc_number: None,
            size_bytes: None,
            added_secs: None,
        })
    }

    fn import_collection(&self, root: String) -> Result<CollectionImportView, ApiError> {
        let root = PathBuf::from(root);
        let same_folder = self
            .state
            .collection_root
            .lock()
            .ok()
            .and_then(|r| r.clone())
            .as_deref()
            == Some(root.as_path());
        if !same_folder && let Ok(mut known) = self.state.known_files.lock() {
            known.clear(); // a different folder: read every file
            let _ = SqliteLibraryRepository::open(&self.state.database_path)
                .and_then(|repository| repository.clear_file_records());
        }
        let watcher = monitor_collection(&root, self.state.clone(), self.events.clone())?;
        let result = sync_collection(&self.state, &root)?;
        SqliteLibraryRepository::open(&self.state.database_path)
            .and_then(|repository| repository.set_collection_root(&root.to_string_lossy()))
            .map_err(ApiError::from)?;

        *self
            .state
            .collection_root
            .lock()
            .map_err(|_| state_error("The selected collection is unavailable."))? =
            Some(root.clone());
        *self
            .state
            .watcher
            .lock()
            .map_err(|_| state_error("The collection monitor is unavailable."))? = Some(watcher);

        Ok(CollectionImportView {
            filename_title_fallbacks: result.filename_title_fallbacks,
            metadata_failures: result.metadata_failures,
            root: root.to_string_lossy().into_owned(),
            track_count: result.snapshot.tracks.len(),
            tracks: result.snapshot.tracks,
        })
    }
}

fn arg<T: serde::de::DeserializeOwned>(args: &Value, name: &str) -> Result<T, ApiError> {
    let value = args.get(name).cloned().unwrap_or(Value::Null);
    serde_json::from_value(value).map_err(|error| ApiError {
        code: "invalid_arguments",
        message: format!("Invalid argument '{name}': {error}"),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    struct NoEvents;
    impl EventSink for NoEvents {
        fn emit(&self, _event: &str, _payload: Value) {}
    }

    #[test]
    fn a_resync_with_nothing_changed_sends_nothing_and_ids_stay_put() {
        let base = std::env::temp_dir().join(format!("mv-host-incremental-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let album = base.join("music").join("Band").join("Album");
        std::fs::create_dir_all(&album).unwrap();
        std::fs::write(album.join("01 One.mp3"), b"first").unwrap();
        std::fs::write(album.join("02 Two.mp3"), b"second").unwrap();
        let data = base.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let root = base.join("music");
        let host =
            Host::open(&data, Arc::new(NoEvents)).unwrap_or_else(|e| panic!("{}", e.message));
        let first = host
            .dispatch(
                "import_collection",
                serde_json::json!({ "root": root.to_string_lossy() }),
            )
            .unwrap_or_else(|e| panic!("{}", e.message));
        let id_of = |reply: &Value, name: &str| {
            reply["tracks"]
                .as_array()
                .unwrap()
                .iter()
                .find(|t| t["source_uri"].as_str().unwrap().ends_with(name))
                .unwrap()["id"]
                .clone()
        };
        let one = id_of(&first, "01 One.mp3");

        // Nothing changed, and a non-audio file (a cover) appearing is not a library change either.
        assert!(
            sync_collection_if_changed(&host.state, &root, true)
                .unwrap_or_else(|e| panic!("{}", e.message))
                .is_none()
        );
        std::fs::write(album.join("cover.jpg"), b"picture").unwrap();
        assert!(
            sync_collection_if_changed(&host.state, &root, true)
                .unwrap_or_else(|e| panic!("{}", e.message))
                .is_none()
        );

        // A changed song and a new song are; the unchanged song keeps its ID.
        std::fs::write(album.join("02 Two.mp3"), b"second, now longer").unwrap();
        std::fs::write(album.join("03 Three.mp3"), b"third").unwrap();
        let changed = sync_collection_if_changed(&host.state, &root, true)
            .unwrap_or_else(|e| panic!("{}", e.message))
            .expect("a change was found");
        assert_eq!(changed.snapshot.tracks.len(), 3);
        let after = serde_json::to_value(&changed.snapshot).unwrap();
        assert_eq!(id_of(&after, "01 One.mp3"), one);
        // A removed song is a change too.
        std::fs::remove_file(album.join("03 Three.mp3")).unwrap();
        let removed = sync_collection_if_changed(&host.state, &root, true)
            .unwrap_or_else(|e| panic!("{}", e.message))
            .expect("a removal was found");
        assert_eq!(removed.snapshot.tracks.len(), 2);
        drop(host);
        let _ = std::fs::remove_dir_all(&base);
    }
    #[test]
    fn a_restart_reads_only_the_files_that_changed_while_the_program_was_closed() {
        let base = std::env::temp_dir().join(format!("mv-host-restart-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let album = base.join("music").join("Band").join("Album");
        std::fs::create_dir_all(&album).unwrap();
        std::fs::write(album.join("01 One.mp3"), b"first").unwrap();
        std::fs::write(album.join("02 Two.mp3"), b"second").unwrap();
        let data = base.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let root = base.join("music");
        {
            let host =
                Host::open(&data, Arc::new(NoEvents)).unwrap_or_else(|e| panic!("{}", e.message));
            host.dispatch(
                "import_collection",
                serde_json::json!({ "root": root.to_string_lossy() }),
            )
            .unwrap_or_else(|e| panic!("{}", e.message));
        }
        {
            // Started again with nothing changed: every file is already known, so nothing is read or sent.
            let host =
                Host::open(&data, Arc::new(NoEvents)).unwrap_or_else(|e| panic!("{}", e.message));
            assert_eq!(host.state.known_files.lock().unwrap().len(), 2);
            assert!(
                sync_collection_if_changed(&host.state, &root, true)
                    .unwrap_or_else(|e| panic!("{}", e.message))
                    .is_none()
            );
        }
        // One song changes and one arrives while the program is closed.
        std::fs::write(album.join("02 Two.mp3"), b"second, now longer").unwrap();
        std::fs::write(album.join("03 Three.mp3"), b"third").unwrap();
        {
            let host =
                Host::open(&data, Arc::new(NoEvents)).unwrap_or_else(|e| panic!("{}", e.message));
            let changed = sync_collection_if_changed(&host.state, &root, true)
                .unwrap_or_else(|e| panic!("{}", e.message))
                .expect("the changes were found");
            assert_eq!(changed.snapshot.tracks.len(), 3);
        }
        // And those are remembered in turn; a song deleted meanwhile leaves the library.
        std::fs::remove_file(album.join("01 One.mp3")).unwrap();
        {
            let host =
                Host::open(&data, Arc::new(NoEvents)).unwrap_or_else(|e| panic!("{}", e.message));
            assert_eq!(host.state.known_files.lock().unwrap().len(), 3);
            let changed = sync_collection_if_changed(&host.state, &root, true)
                .unwrap_or_else(|e| panic!("{}", e.message))
                .expect("the removal was found");
            assert_eq!(changed.snapshot.tracks.len(), 2);
        }
        let host =
            Host::open(&data, Arc::new(NoEvents)).unwrap_or_else(|e| panic!("{}", e.message));
        assert_eq!(host.state.known_files.lock().unwrap().len(), 2);
        drop(host);
        let _ = std::fs::remove_dir_all(&base);
    }

    #[test]
    fn tag_issues_are_the_same_after_a_restart_as_right_after_an_import() {
        // A file with no tags in Artist\Album: the folder layout suggests the artist and album. The Review page
        // reads its list from library_snapshot when the program starts, so that reply must carry the same
        // suggestions as the import did (it used to carry none, so Review was empty after every restart).
        let base = std::env::temp_dir().join(format!("mv-host-suggest-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let album = base.join("music").join("Some Band").join("First Album");
        std::fs::create_dir_all(&album).unwrap();
        std::fs::write(album.join("01 Opening.mp3"), b"not really audio").unwrap();
        let data = base.join("data");
        std::fs::create_dir_all(&data).unwrap();
        let root = base.join("music").to_string_lossy().into_owned();
        {
            let host =
                Host::open(&data, Arc::new(NoEvents)).unwrap_or_else(|e| panic!("{}", e.message));
            let imported = host
                .dispatch("import_collection", serde_json::json!({ "root": root }))
                .unwrap_or_else(|e| panic!("{}", e.message));
            let suggested = imported["tracks"][0]["suggestions"].clone();
            assert!(
                suggested
                    .as_array()
                    .is_some_and(|s| s.iter().any(|x| x.as_str().unwrap().contains("Some Band"))),
                "{imported}"
            );
            let same_session = host
                .dispatch("library_snapshot", Value::Null)
                .unwrap_or_else(|e| panic!("{}", e.message));
            assert_eq!(same_session["tracks"][0]["suggestions"], suggested);
        }
        let restarted =
            Host::open(&data, Arc::new(NoEvents)).unwrap_or_else(|e| panic!("{}", e.message));
        let snapshot = restarted
            .dispatch("library_snapshot", Value::Null)
            .unwrap_or_else(|e| panic!("{}", e.message));
        assert!(
            snapshot["tracks"][0]["suggestions"]
                .as_array()
                .is_some_and(|s| s
                    .iter()
                    .any(|x| x.as_str().unwrap().contains("First Album"))),
            "{snapshot}"
        );
        let _ = std::fs::remove_dir_all(&base);
    }
    #[test]
    fn parses_a_two_digit_track_number_and_title() {
        assert_eq!(
            parse_file_name_metadata("01 Rotten Apple"),
            FileNameMetadata {
                title: Some("Rotten Apple".to_owned()),
                track_number: Some(1),
                ..Default::default()
            }
        );
    }

    #[test]
    fn parses_a_dashed_track_number_and_title() {
        assert_eq!(
            parse_file_name_metadata("01 - Rotten Apple"),
            FileNameMetadata {
                title: Some("Rotten Apple".to_owned()),
                track_number: Some(1),
                ..Default::default()
            }
        );
    }

    #[test]
    fn parses_artist_and_title_from_a_common_file_name() {
        assert_eq!(
            parse_file_name_metadata("Alice In Chains - Rotten Apple"),
            FileNameMetadata {
                artist: Some("Alice In Chains".to_owned()),
                title: Some("Rotten Apple".to_owned()),
                ..Default::default()
            }
        );
    }

    #[test]
    fn parses_artist_album_track_and_title_from_a_file_name() {
        assert_eq!(
            parse_file_name_metadata("Alice In Chains - Jar Of Flies - 01 - Rotten Apple"),
            FileNameMetadata {
                album: Some("Jar Of Flies".to_owned()),
                artist: Some("Alice In Chains".to_owned()),
                title: Some("Rotten Apple".to_owned()),
                track_number: Some(1),
            }
        );
    }

    #[test]
    fn suggests_artist_from_a_file_name_when_the_path_has_no_artist_folder() {
        let suggestions = path_suggestions(
            Path::new(r"C:\Music"),
            r"C:\Music\Miscellaneous\Alice In Chains - Rotten Apple.mp3",
            "Track 1",
            Some("Unknown artist"),
            None,
            None,
            None,
            None,
        );

        assert!(suggestions.contains(&"Suggested artist: Alice In Chains".to_owned()));
        assert!(suggestions.contains(&"Suggested title: Rotten Apple".to_owned()));
    }

    #[test]
    fn suggests_artist_when_the_selected_root_is_an_artist_folder() {
        let suggestions = path_suggestions(
            Path::new(r"C:\Music\Alice In Chains"),
            r"C:\Music\Alice In Chains\Dirt\01 Them Bones.mp3",
            "Track 1",
            Some("Unknown artist"),
            Some("Unknown album"),
            None,
            None,
            None,
        );

        assert!(suggestions.contains(&"Suggested artist: Alice In Chains".to_owned()));
    }

    #[test]
    fn suggests_missing_metadata_from_a_standard_library_path() {
        let suggestions = path_suggestions(
            Path::new(r"C:\Music"),
            r"C:\Music\Alice In Chains\Jar Of Flies [EP]\01 Rotten Apple.mp3",
            "Track 1",
            Some("Unknown artist"),
            Some("Unknown album"),
            None,
            Some("Unknown genre"),
            None,
        );

        assert_eq!(
            suggestions,
            vec![
                "Suggested title: Rotten Apple",
                "Suggested artist: Alice In Chains",
                "Suggested album: Jar Of Flies [EP]",
                "Suggested album artist: Alice In Chains",
                "Suggested track number: 01",
                "Genre needs review."
            ]
        );
    }
}
