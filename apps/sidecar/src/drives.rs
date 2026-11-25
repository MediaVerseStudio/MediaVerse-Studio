//! Drive commands for the sidecar protocol (ADR 0004): listing drives with their stored profiles,
//! and calibration as a cancellable background job.
//!
//! Commands: `list_drives`, `list_drive_profiles`, `calibrate_drive {device}` (returns
//! `{job_id}`), `cancel_job {job_id}`. Events: `job-progress` and `job-finished`.

use crate::Output;
use crate::helper::{Canceller, Helper, HelperError};
use crate::profiles::ProfileStore;
use crate::rip_job::RipOptions;
use crate::settings::Settings;
use mediaverse_accuraterip::{database_url, disc_ids};
use mediaverse_host::EventSink;
use mediaverse_ripper::archive::validate_locations;
use mediaverse_ripper::profile::{Connection, DriveIdentity, DriveProfile};
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::{Arc, Mutex};
use std::time::{Duration, SystemTime};

pub const COMMANDS: [&str; 143] = [
    "list_lyrics_instrumental",
    "mark_lyrics_instrumental",
    "unmark_lyrics_instrumental",
    "confirm_lyrics_instrumental",
    "find_tidy_titles",
    "apply_title_tidy",
    "track_artist_photo",
    "rename_artist",
    "scan_mb_ids",
    "scan_album_align",
    "find_wiki_photos",
    "check_artist_names",
    "cover_preview",
    "canonical_artist_names",
    "write_wiki_photos",
    "list_wiki_photos",
    "align_album",
    "undo_album_align",
    "list_mb_ids",
    "apply_mb_ids",
    "undo_mb_ids",
    "dismiss_mb_ids",
    "undo_artist_rename",
    "lyric_ai_status",
    "lyric_ai_configure",
    "lyric_ai_analyse",
    "lyric_ai_judge",
    "lyric_ai_time",
    "lyric_ai_time_lines",
    "lyric_ai_confirm_words",
    "lyric_ai_draft",
    "lyric_ai_results",
    "lyric_ai_apply",
    "lyric_ai_wrong_check",
    "lyric_ai_wrong_results",
    "lyric_ai_wrong_dismiss",
    "lyric_photos_status",
    "lyric_photos_download",
    "lyric_photos_preview",
    "lyric_photos_read",
    "lyric_photos_session_save",
    "lyric_photos_session_load",
    "lyric_photos_session_forget",
    "save_lyrics_review",
    "list_lyrics_review",
    "get_lyrics_review",
    "reject_lyrics_candidate",
    "remove_lyrics_review",
    "tag_untagged",
    "convert_survey",
    "convert_to_mp3",
    "id3_survey",
    "standardize_id3",
    "get_tag_settings",
    "set_tag_settings",
    "scan_tag_repair",
    "apply_tag_repair",
    "undo_tag_repair",
    "tag_repair_status",
    "source_status",
    "search_folder_album",
    "check_folder_audio",
    "scan_audio_check",
    "list_audio_check",
    "dismiss_audio_check",
    "apply_audio_names",
    "compare_album_release",
    "adopt_release_values",
    "flag_rerip",
    "unflag_rerip",
    "list_rerip",
    "leave_albums_alone",
    "stop_leaving_alone",
    "list_tag_repair",
    "find_album_art",
    "fetch_album_art",
    "set_defect_reviewed",
    "scan_library_defects",
    "scan_library_loudness",
    "organize_preview",
    "organize_apply",
    "organize_undo",
    "organize_last",
    "library_loudness_status",
    "loudness_gains",
    "get_loudness_settings",
    "levelling_tags_preview",
    "levelling_tags_write",
    "levelling_tags_undo",
    "levelling_tags_albums",
    "levelling_tags_strip",
    "native_audio_devices",
    "native_audio_open",
    "native_audio_next",
    "native_audio_control",
    "native_audio_status",
    "set_loudness_settings",
    "library_scan_status",
    "list_defect_problems",
    "list_drives",
    "list_drive_profiles",
    "drive_history",
    "clear_drive_history",
    "disc_probe",
    "submit_gnudb",
    "search_albums",
    "calibrate_drive",
    "rip_disc",
    "cancel_job",
    "get_archive_settings",
    "set_archive_dir",
    "set_archive_enabled",
    "track_cover",
    "album_pictures",
    "track_lyrics",
    "scan_defects",
    "list_defect_results",
    "library_gaps",
    "get_listen_settings",
    "set_listen_settings",
    "list_flags",
    "record_play",
    "list_history",
    "create_folder",
    "list_pins",
    "get_lyrics_settings",
    "set_lyrics_settings",
    "lookup_lyrics",
    "set_pin",
    "clear_history",
    "set_history_enabled",
    "recent_files",
    "set_flag",
    "list_favorites",
    "set_favorite",
    "list_playlists",
    "save_playlist",
    "delete_playlist",
    "update_track_media",
    "undo_picture_batch",
    "get_metadata_settings",
    "set_metadata_settings",
    "lookup_disc",
];

/// Tells the drive code where the Main Media Library is, so the archive can be kept apart from it.
pub type LibraryRoot = Arc<dyn Fn() -> Option<PathBuf> + Send + Sync>;

/// How long a "not in the database" answer is remembered before asking AccurateRip again.
const NOT_FOUND_TTL: Duration = Duration::from_secs(7 * 24 * 3600);
const MAX_RESPONSE_BYTES: u64 = 1 << 20;

pub(crate) fn failure(code: &str, message: impl ToString) -> HelperError {
    (code.to_owned(), message.to_string())
}

pub struct Drives {
    pub(crate) data_dir: PathBuf,
    pub(crate) output: Output,
    pub(crate) store: ProfileStore,
    pub(crate) settings: Settings,
    pub(crate) library_root: LibraryRoot,
    pub(crate) jobs: Mutex<HashMap<String, Canceller>>,
    /// The library-wide defect scan, while one runs (only one at a time; ADR 0008).
    pub(crate) library_scan: Mutex<Option<Arc<crate::library_scan::ScanProgress>>>,
    pub(crate) loudness_scan: Mutex<Option<Arc<crate::library_scan::ScanProgress>>>,
    /// The library-wide tag repair scan (ADR 0009), while one runs.
    pub(crate) tag_scan: Mutex<Option<Arc<crate::tag_repair::ScanState>>>,
    /// True while Fix tags is writing to files (one batch at a time, and never during a tag scan).
    pub(crate) tag_write: std::sync::atomic::AtomicBool,
    pub(crate) next_job: AtomicU64,
    /// Settings and politeness state for the metadata services (see `lookup.rs`).
    pub(crate) metadata: crate::lookup::MetadataState,
    /// The lyric AI: model settings and the loaded engine (D127).
    pub(crate) lyric_ai: crate::lyric_ai::LyricAi,
}

pub(crate) struct DiscContext {
    pub(crate) identity: DriveIdentity,
    pub(crate) track_count: usize,
    pub(crate) disc: String,
    pub(crate) pressings_hex: Option<String>,
    pub(crate) notes: Vec<String>,
}

enum Lookup {
    Found(Vec<u8>),
    NotFound,
    Failed(String),
}

impl Drives {
    pub fn new(data_dir: &Path, output: Output, library_root: LibraryRoot) -> Arc<Self> {
        // Every tag this program writes uses the ID3 version chosen in the advanced settings (v2.3 unless changed).
        mediaverse_metadata_tags::set_write_id3v24(Settings::new(data_dir).id3v24());
        Arc::new(Self {
            data_dir: data_dir.to_owned(),
            output,
            store: ProfileStore::new(data_dir),
            settings: Settings::new(data_dir),
            library_root,
            jobs: Mutex::new(HashMap::new()),
            library_scan: Mutex::new(None),
            loudness_scan: Mutex::new(None),
            tag_scan: Mutex::new(None),
            tag_write: std::sync::atomic::AtomicBool::new(false),
            next_job: AtomicU64::new(1),
            metadata: crate::lookup::MetadataState::new(data_dir),
            lyric_ai: crate::lyric_ai::LyricAi::new(data_dir),
        })
    }

    pub fn handles(command: &str) -> bool {
        COMMANDS.contains(&command)
    }

    pub fn dispatch(self: &Arc<Self>, command: &str, args: &Value) -> Result<Value, HelperError> {
        // Whatever this command asks of outside services, it asks with the priority its kind deserves (a lookup the
        // person waits on before a library scan); the jobs it starts inherit it.
        let _priority = crate::scheduler::priority(crate::scheduler::priority_for(command));
        match command {
            "list_drives" => self.list_drives(),
            "list_drive_profiles" => Ok(json!(self.store.list())),
            "calibrate_drive" => {
                let device = args
                    .get("device")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_arguments", "'device' must be a string"))?
                    .to_owned();
                Ok(self.start_calibration(device))
            }
            "rip_disc" => {
                let text = |name: &str| {
                    args.get(name)
                        .and_then(Value::as_str)
                        .map(str::to_owned)
                        .ok_or_else(|| {
                            failure("invalid_arguments", format!("'{name}' must be a string"))
                        })
                };
                let device = text("device")?;
                // Without an explicit working folder the ripped WAV files go to a fresh folder in the
                // program's own data folder (never inside the music library).
                let output_dir = match args.get("output_dir") {
                    None | Some(Value::Null) => {
                        let stamp = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map_or(0, |d| d.as_secs());
                        self.data_dir
                            .join("rip-work")
                            .join(stamp.to_string())
                            .to_string_lossy()
                            .into_owned()
                    }
                    Some(_) => text("output_dir")?,
                };
                let tracks = args.get("tracks").cloned().filter(Value::is_array);
                let secure = args.get("secure").and_then(Value::as_bool).unwrap_or(true);
                // An explicit request value wins; otherwise the saved "keep a FLAC archive" switch decides.
                let archive = args
                    .get("archive")
                    .and_then(Value::as_bool)
                    .unwrap_or_else(|| self.settings.archive_enabled());
                let mp3 = args.get("mp3").and_then(Value::as_bool).unwrap_or(true);
                let keep_wav = args
                    .get("keep_wav")
                    .and_then(Value::as_bool)
                    .unwrap_or(false);
                let mp3_quality = match args.get("mp3_quality").and_then(Value::as_str) {
                    None => mediaverse_ripper::mp3::Quality::V0,
                    Some(name) => {
                        mediaverse_ripper::mp3::Quality::parse(name).ok_or_else(|| {
                            failure(
                                "invalid_arguments",
                                "'mp3_quality' must be \"v0\" or \"cbr320\"",
                            )
                        })?
                    }
                };
                // `candidate` is a lookup result the user has chosen; `metadata` is the manual form.
                let (metadata, expected_tracks) =
                    match args.get("candidate").filter(|c| !c.is_null()) {
                        Some(candidate) => {
                            let metadata =
                                crate::archive_job::metadata_from_candidate(candidate)
                                    .map_err(|message| failure("invalid_candidate", message))?;
                            let count = metadata["track_total"].as_u64().map(|n| n as usize);
                            (metadata, count)
                        }
                        None => (args.get("metadata").cloned().unwrap_or(Value::Null), None),
                    };
                // Rip safety (D105): files that are going to be tagged need an album and an artist that were chosen or typed.
                // Without them the files would be named "Unknown Artist" and need fixing afterwards.
                if (archive || mp3) && args.get("candidate").is_none_or(Value::is_null) {
                    let named =
                        |key: &str| metadata[key].as_str().is_some_and(|v| !v.trim().is_empty());
                    if !named("album") || !(named("album_artist") || named("artist")) {
                        return Err(failure(
                            "tags_required",
                            "Choose the album from the lookup, or type its album and artist, before ripping. Nothing was read from the disc.",
                        ));
                    }
                }
                // Pictures chosen by hand (kind plus file) travel beside the details.
                let mut metadata = metadata;
                if let Some(pictures) = args.get("pictures").filter(|p| p.is_array()) {
                    if !metadata.is_object() {
                        metadata = json!({});
                    }
                    metadata["pictures"] = pictures.clone();
                }
                Ok(self.start_job(move |this, id| {
                    let mut drive = None;
                    let outcome = this.run_rip(
                        id,
                        &device,
                        &output_dir,
                        RipOptions {
                            tracks,
                            secure,
                            archive,
                            metadata,
                            expected_tracks,
                            mp3,
                            mp3_quality,
                            keep_wav,
                        },
                        &mut drive,
                    );
                    // The drive's track record (D104): what this disc was like, or how the drive failed with it.
                    if let Some(identity) = drive {
                        let history = crate::drive_history::DriveHistory::new(&this.data_dir);
                        let now = std::time::SystemTime::now()
                            .duration_since(std::time::UNIX_EPOCH)
                            .map_or(0, |d| d.as_secs());
                        let name = format!("{} {}", identity.vendor.trim(), identity.model.trim());
                        match &outcome {
                            Ok(result) => history.record_rip(&identity.key(), &name, result, now),
                            Err((code, message))
                                if matches!(code.as_str(), "no_disc" | "read_failed") =>
                            {
                                history.record_failure(&identity.key(), &name, code, message, now)
                            }
                            Err(_) => {}
                        }
                    }
                    outcome
                }))
            }
            "drive_history" => {
                Ok(crate::drive_history::DriveHistory::new(&self.data_dir).overview())
            }
            "clear_drive_history" => {
                crate::drive_history::DriveHistory::new(&self.data_dir).clear();
                Ok(json!({ "cleared": true }))
            }
            "get_metadata_settings" => Ok(self.metadata.public_settings()),
            "set_metadata_settings" => self
                .metadata
                .update(args.get("settings").unwrap_or(&Value::Null)),
            "lookup_disc" => {
                let device = args
                    .get("device")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_arguments", "'device' must be a string"))?
                    .to_owned();
                Ok(self.start_job(move |this, id| this.run_lookup(id, &device)))
            }
            "submit_gnudb" => self.submit_gnudb(args),
            "disc_probe" => {
                let device = args
                    .get("device")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_arguments", "'device' must be a string"))?;
                self.disc_probe(device)
            }
            "search_albums" => {
                let text = |name: &str| {
                    args.get(name)
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .to_owned()
                };
                let device = args
                    .get("device")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_arguments", "'device' must be a string"))?
                    .to_owned();
                let (artist, album) = (text("artist"), text("album"));
                Ok(self.start_job(move |this, id| this.run_search(id, &device, &artist, &album)))
            }
            "get_archive_settings" => Ok(self.archive_settings()),
            "set_archive_dir" => self.set_archive_dir(args.get("path")),
            "track_cover" => {
                let path = args
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_arguments", "'path' must be a string"))?;
                crate::library_cover::track_cover_cached(
                    path,
                    (self.library_root)().as_deref(),
                    Some(&self.data_dir.join("cover-cache")),
                )
                .map_err(|message| failure("cover_unavailable", message))
            }
            "track_artist_photo" => {
                let path = args
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_arguments", "'path' must be a string"))?;
                crate::library_cover::track_artist_photo(path, (self.library_root)().as_deref())
                    .map_err(|message| failure("cover_unavailable", message))
            }
            "rename_artist" => crate::artist_rename::rename_artist(
                args,
                (self.library_root)().as_deref(),
                &self.data_dir,
            )
            .map_err(|message| failure("invalid_arguments", message)),
            "undo_artist_rename" => crate::artist_rename::undo_artist_rename(
                args.get("batch").and_then(Value::as_str).unwrap_or(""),
                (self.library_root)().as_deref(),
                &self.data_dir,
            )
            .map_err(|message| failure("undo_failed", message)),
            "album_pictures" => {
                let paths: Vec<String> = args
                    .get("paths")
                    .and_then(Value::as_array)
                    .ok_or_else(|| failure("invalid_arguments", "'paths' must be a list"))?
                    .iter()
                    .filter_map(|p| p.as_str().map(str::to_owned))
                    .collect();
                crate::library_cover::album_pictures(&paths, (self.library_root)().as_deref())
                    .map_err(|message| failure("cover_unavailable", message))
            }
            "get_lyrics_settings" => Ok(
                json!({ "enabled": self.settings.lyrics_lookup_enabled(), "base_url": self.settings.lyrics_base_url() }),
            ),
            "set_lyrics_settings" => {
                let enabled = match args.get("enabled") {
                    None | Some(Value::Null) => None,
                    Some(Value::Bool(on)) => Some(*on),
                    Some(_) => {
                        return Err(failure(
                            "invalid_arguments",
                            "'enabled' must be true or false",
                        ));
                    }
                };
                let base_url = match args.get("base_url") {
                    None | Some(Value::Null) => None,
                    Some(Value::String(url)) if crate::lyrics_lookup::allowed_base_url(url) => {
                        Some(url.as_str())
                    }
                    Some(_) => {
                        return Err(failure(
                            "invalid_arguments",
                            "The lyrics server address must start with https:// (http:// is only allowed on this computer).",
                        ));
                    }
                };
                self.settings.set_lyrics(enabled, base_url).map_err(|e| {
                    failure(
                        "settings_save_failed",
                        format!("Could not save the setting: {e}"),
                    )
                })?;
                Ok(
                    json!({ "enabled": self.settings.lyrics_lookup_enabled(), "base_url": self.settings.lyrics_base_url() }),
                )
            }
            "lookup_lyrics" => {
                if !self.settings.lyrics_lookup_enabled() {
                    return Err(failure(
                        "lookup_disabled",
                        "Online lyrics lookup is switched off in Settings.",
                    ));
                }
                let text = |key: &str| args.get(key).and_then(Value::as_str).map(str::to_owned);
                let path = text("path")
                    .ok_or_else(|| failure("invalid_arguments", "'path' must be a string"))?;
                let file = crate::library_cover::resolve_in_library(
                    &path,
                    (self.library_root)().as_deref(),
                )
                .map_err(|message| failure("invalid_arguments", message))?;
                let (title, artist, album) = (
                    text("title").unwrap_or_default(),
                    text("artist").unwrap_or_default(),
                    text("album"),
                );
                let base_url = self.settings.lyrics_base_url();
                let follow_works = args.get("follow_works").and_then(Value::as_bool) == Some(true);
                // The song's length as the library knows it (every song has one): it lets LRCLIB pick the right
                // recording, and lets the answer count as the same recording (D120).
                let known_seconds = args
                    .get("length_ms")
                    .and_then(Value::as_f64)
                    .map(|ms| ms / 1000.0)
                    .filter(|s| (1.0..=3600.0).contains(s));
                Ok(self.start_job(move |this, _id| {
                    // Without it, the length of an MP3 this program made. Read here, in the job, not on the thread
                    // that answers every other command (a song is several megabytes); not read at all when the
                    // library already gave the length.
                    let seconds = known_seconds.or_else(|| {
                        std::fs::read(&file)
                            .ok()
                            .and_then(|bytes| mediaverse_ripper::mp3::inspect(&bytes).ok())
                            .map(|info| info.playable_samples as f64 / 44_100.0)
                    });
                    let contact = this.metadata.current().identity.contact.trim().to_owned();
                    let agent = mediaverse_disc_metadata::musicbrainz::user_agent(
                        "MediaVerseStudio",
                        env!("CARGO_PKG_VERSION"),
                        if contact.is_empty() {
                            "https://github.com/MediaVerseStudio/MediaVerse-Studio"
                        } else {
                            &contact
                        },
                    );
                    let pause = || {
                        this.metadata
                            .wait_turn("lrclib", Duration::from_millis(500))
                    };
                    let cache = this.data_dir.join("lrclib-cache");
                    if let Some(mut cached) = crate::lyrics_lookup::cached_lyrics(
                        &cache,
                        &title,
                        &artist,
                        album.as_deref(),
                        seconds,
                    ) {
                        cached["song_duration"] = json!(seconds);
                        cached["cached"] = json!(true);
                        return Ok(cached);
                    }
                    let mut outcome = crate::lyrics_lookup::find_lyrics(
                        &base_url,
                        &title,
                        &artist,
                        album.as_deref(),
                        seconds,
                        &agent,
                        &pause,
                    );
                    if follow_works
                        && outcome.as_ref().is_ok_and(|answer| {
                            answer["results"].as_array().is_some_and(Vec::is_empty)
                        })
                    {
                        if let Some(names) = work_artist_names(this, &title, &artist, &agent) {
                            for name in names {
                                let again = crate::lyrics_lookup::find_lyrics(
                                    &base_url,
                                    &title,
                                    &name,
                                    album.as_deref(),
                                    seconds,
                                    &agent,
                                    &pause,
                                );
                                if again.as_ref().is_ok_and(|answer| {
                                    answer["results"].as_array().is_some_and(|r| !r.is_empty())
                                }) {
                                    outcome = again;
                                    break;
                                }
                            }
                        }
                    }
                    if let Ok(answer) = &outcome {
                        crate::lyrics_lookup::store_lyrics(
                            &cache,
                            &title,
                            &artist,
                            album.as_deref(),
                            seconds,
                            answer,
                        );
                    }
                    this.metadata.outcome(
                        "lrclib",
                        matches!(&outcome, Err((code, _)) if code == "rate_limited"),
                        None,
                    );
                    outcome
                        .map(|mut answer| {
                            // So the page can show how far each answer's length is from the song's own.
                            answer["song_duration"] = json!(seconds);
                            answer
                        })
                        .map_err(|(code, message)| failure(&code, message))
                }))
            }
            "lyric_ai_status" => Ok(self.lyric_ai.status()),
            "lyric_ai_configure" => self
                .lyric_ai
                .configure(args)
                .map_err(|m| failure("invalid_arguments", m)),
            "lyric_ai_analyse" => self.lyric_ai_analyse(args),
            "lyric_ai_time" => self.lyric_ai_time(args),
            "lyric_ai_time_lines" => self.lyric_ai_time_lines(args),
            "lyric_ai_confirm_words" => {
                let path = args["path"]
                    .as_str()
                    .ok_or_else(|| failure("invalid_arguments", "Give the song's path."))?;
                crate::lyric_ai::trust::confirm(&self.data_dir, path);
                Ok(json!({ "confirmed": true }))
            }
            "lyric_ai_judge" => self.lyric_ai_judge(args),
            "lyric_ai_draft" => self.lyric_ai_draft(args),
            "lyric_ai_results" => Ok(self.lyric_ai_results()),
            "lyric_ai_apply" => self.lyric_ai_apply(args),
            "lyric_ai_wrong_check" => self.lyric_ai_wrong_check(args),
            "lyric_ai_wrong_results" => Ok(self.lyric_ai_wrong_results()),
            "lyric_ai_wrong_dismiss" => self.lyric_ai_wrong_dismiss(args),
            "lyric_photos_status" => Ok(self.lyric_photos_status()),
            "lyric_photos_download" => self.vision_download(),
            "lyric_photos_preview" => self.lyric_photos_preview(args),
            "lyric_photos_read" => self.lyric_photos_read(args),
            "lyric_photos_session_save" => self.lyric_photos_session_save(args),
            "lyric_photos_session_load" => self.lyric_photos_session_load(args),
            "lyric_photos_session_forget" => self.lyric_photos_session_forget(args),
            "save_lyrics_review" => {
                let path = args
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_arguments", "'path' must be a string"))?;
                crate::library_cover::resolve_in_library(path, (self.library_root)().as_deref())
                    .map_err(|message| failure("invalid_arguments", message))?;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs());
                crate::lyrics_review::LyricsReview::new(&self.data_dir)
                    .save(path, args, now)
                    .map_err(|message| failure("settings_save_failed", message))
            }
            "list_lyrics_review" => {
                Ok(crate::lyrics_review::LyricsReview::new(&self.data_dir).list())
            }
            "list_lyrics_instrumental" => {
                Ok(crate::lyrics_instrumental::Store::new(&self.data_dir).list())
            }
            "mark_lyrics_instrumental" | "unmark_lyrics_instrumental" => {
                let path = args
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_arguments", "'path' must be a string"))?;
                crate::library_cover::resolve_in_library(path, (self.library_root)().as_deref())
                    .map_err(|message| failure("invalid_arguments", message))?;
                let store = crate::lyrics_instrumental::Store::new(&self.data_dir);
                if command == "mark_lyrics_instrumental" {
                    let now = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map_or(0, |d| d.as_secs());
                    store
                        .mark(
                            path,
                            args.get("source")
                                .and_then(Value::as_str)
                                .unwrap_or("LRCLIB"),
                            now,
                        )
                        .map(|()| json!({ "ok": true }))
                } else {
                    // A confirmed song gets its language tag back as it was (or none) before it leaves the confirmed ones.
                    if let Some(before) = store.confirmed_before(path)
                        && let Ok(file) = crate::library_cover::resolve_in_library(
                            path,
                            (self.library_root)().as_deref(),
                        )
                    {
                        let _ = mediaverse_metadata_tags::patch_track_metadata(
                            &file,
                            &[(mediaverse_metadata_tags::TagField::Language, before)],
                        );
                    }
                    store.unmark(path).map(|had| json!({ "ok": had }))
                }
                .map_err(|message| failure("settings_save_failed", message))
            }
            "confirm_lyrics_instrumental" => {
                // The person listened and says these songs are instrumental: the language tag becomes "zxx" (no linguistic content). The genre is left alone.
                let paths: Vec<&str> = args
                    .get("paths")
                    .and_then(Value::as_array)
                    .map(|l| l.iter().filter_map(Value::as_str).collect())
                    .filter(|l: &Vec<&str>| !l.is_empty() && l.len() <= 2000)
                    .ok_or_else(|| {
                        failure("invalid_arguments", "'paths' must be 1 to 2000 songs")
                    })?;
                let store = crate::lyrics_instrumental::Store::new(&self.data_dir);
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs());
                let (mut confirmed, mut problems) = (0usize, Vec::new());
                for path in paths {
                    let outcome = crate::library_cover::resolve_in_library(
                        path,
                        (self.library_root)().as_deref(),
                    )
                    .and_then(|file| {
                        mediaverse_metadata_tags::patch_track_metadata(
                            &file,
                            &[(
                                mediaverse_metadata_tags::TagField::Language,
                                Some("zxx".to_owned()),
                            )],
                        )
                        .map_err(|e| e.to_string())
                    })
                    .and_then(|before| {
                        let was = before.into_iter().next().and_then(|(_, v)| v);
                        store.confirm(path, was.as_deref(), now)
                    });
                    match outcome {
                        Ok(()) => confirmed += 1,
                        Err(message) => problems.push(json!({ "path": path, "message": message })),
                    }
                }
                Ok(json!({ "confirmed": confirmed, "problems": problems }))
            }
            "find_tidy_titles" => {
                let tracks = args
                    .get("tracks")
                    .and_then(Value::as_array)
                    .ok_or_else(|| failure("invalid_arguments", "'tracks' must be a list"))?;
                Ok(crate::title_tidy::find(tracks))
            }
            "apply_title_tidy" => {
                if self.tag_scan.lock().ok().is_some_and(|s| s.is_some())
                    || self.tag_write.load(Ordering::SeqCst)
                {
                    return Err(failure(
                        "busy",
                        "Wait for the library check to finish first.",
                    ));
                }
                let titles: Vec<(String, String, String)> = args
                    .get("titles")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|t| {
                        Some((
                            t.get("path")?.as_str()?.to_owned(),
                            t.get("from")?.as_str()?.to_owned(),
                            t.get("to")?.as_str()?.to_owned(),
                        ))
                    })
                    .collect();
                let tag_store = crate::tag_repair::TagRepairStore::new(&self.data_dir);
                crate::title_tidy::apply(&tag_store, (self.library_root)().as_deref(), &titles)
                    .map_err(|(code, message)| failure(&code, message))
            }
            "get_lyrics_review" | "reject_lyrics_candidate" | "remove_lyrics_review" => {
                // The entry is named by its key, or by the song's path (the automatic lyrics drop the entry of a song
                // they just filled in).
                let by_path = args
                    .get("path")
                    .and_then(Value::as_str)
                    .map(crate::lyrics_review::key_of);
                let key = args
                    .get("key")
                    .and_then(Value::as_str)
                    .or(by_path.as_deref())
                    .unwrap_or("");
                let review = crate::lyrics_review::LyricsReview::new(&self.data_dir);
                match command {
                    "get_lyrics_review" => review.get(key),
                    "reject_lyrics_candidate" => review.reject(
                        key,
                        args.get("index").and_then(Value::as_u64).unwrap_or(0) as usize,
                    ),
                    _ => review.remove(key),
                }
                .map_err(|message| failure("review_failed", message))
            }
            "create_folder" => {
                // Used by Getting Started to make a new library or archive folder inside a folder the person chose.
                let parent = args
                    .get("parent")
                    .and_then(Value::as_str)
                    .map(PathBuf::from)
                    .filter(|p| p.is_absolute() && p.is_dir());
                let name = args
                    .get("name")
                    .and_then(Value::as_str)
                    .map(str::trim)
                    .filter(|n| !n.is_empty());
                let (Some(parent), Some(name)) = (parent, name) else {
                    return Err(failure(
                        "invalid_arguments",
                        "Choose an existing folder and give the new folder a name.",
                    ));
                };
                let safe = mediaverse_ripper::archive::sanitize_component(name, "MediaVerse Music");
                let target = parent.join(&safe);
                if target.exists() && !target.is_dir() {
                    return Err(failure(
                        "invalid_arguments",
                        format!("A file named \"{safe}\" is already there."),
                    ));
                }
                std::fs::create_dir_all(&target).map_err(|e| {
                    failure("folder_failed", format!("Could not create the folder: {e}"))
                })?;
                Ok(json!({ "path": target.to_string_lossy(), "created_name": safe }))
            }
            "list_pins" => Ok(crate::pins::Pins::new(&self.data_dir).list()),
            "set_pin" => {
                let folder = args
                    .get("folder")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_arguments", "'folder' must be a string"))?;
                // Only album folders inside the music library can be pinned.
                let real = crate::library_cover::resolve_in_library(
                    folder,
                    (self.library_root)().as_deref(),
                )
                .map_err(|message| failure("invalid_arguments", message))?;
                if !real.is_dir() {
                    return Err(failure("invalid_arguments", "That is not a folder."));
                }
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs());
                crate::pins::Pins::new(&self.data_dir)
                    .set(folder, &args, now)
                    .map_err(|message| failure("settings_save_failed", message))
            }
            "list_history" => Ok(
                json!({ "enabled": self.settings.history_enabled(), "entries": crate::history::History::new(&self.data_dir).list() }),
            ),
            "set_history_enabled" => {
                let enabled = args
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| {
                        failure("invalid_arguments", "'enabled' must be true or false")
                    })?;
                self.settings.set_history_enabled(enabled).map_err(|e| {
                    failure(
                        "settings_save_failed",
                        format!("Could not save the setting: {e}"),
                    )
                })?;
                Ok(json!({ "enabled": enabled }))
            }
            "clear_history" => {
                crate::history::History::new(&self.data_dir)
                    .clear()
                    .map_err(|e| {
                        failure(
                            "settings_save_failed",
                            format!("Could not clear the history: {e}"),
                        )
                    })?;
                Ok(json!({ "enabled": self.settings.history_enabled(), "entries": [] }))
            }
            "record_play" => {
                if !self.settings.history_enabled() {
                    return Ok(json!({ "recorded": false }));
                }
                let requested = args
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_arguments", "'path' must be a string"))?;
                crate::library_cover::song_allowed(requested, (self.library_root)().as_deref())
                    .map_err(|message| failure("invalid_arguments", message))?;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs());
                crate::history::History::new(&self.data_dir)
                    .record(requested, &args, now)
                    .map_err(|e| {
                        failure(
                            "settings_save_failed",
                            format!("Could not save the history: {e}"),
                        )
                    })?;
                Ok(json!({ "recorded": true }))
            }
            "recent_files" => {
                let limit = args.get("limit").and_then(Value::as_u64).unwrap_or(60) as usize;
                crate::library_recent::recent_files(
                    limit,
                    (self.library_root)().as_deref(),
                    Some(&self.data_dir.join("library.sqlite")),
                )
                .map_err(|message| failure("invalid_arguments", message))
            }
            "list_flags" => Ok(crate::flags::Flags::new(&self.data_dir).list()),
            "set_flag" => {
                let requested = args
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_arguments", "'path' must be a string"))?;
                // Only library files can be flagged. The list keeps the path as the library shows it (not
                // the Windows "\\?\" form of the real path), so the page can match it to its tracks.
                crate::library_cover::song_allowed(requested, (self.library_root)().as_deref())
                    .map_err(|message| failure("invalid_arguments", message))?;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs());
                crate::flags::Flags::new(&self.data_dir)
                    .set(requested, &args, now)
                    .map_err(|message| failure("settings_save_failed", message))
            }
            "list_favorites" => Ok(crate::favorites::Favorites::new(&self.data_dir).list()),
            "list_playlists" => Ok(crate::playlists::Playlists::new(&self.data_dir).list()),
            "save_playlist" => {
                // Only library files go into a playlist (checked one by one, as for favorites).
                let root = (self.library_root)();
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs());
                crate::playlists::Playlists::new(&self.data_dir)
                    .save_one(&args, now, |path| {
                        crate::library_cover::song_allowed(path, root.as_deref()).is_ok()
                    })
                    .map_err(|message| failure("invalid_arguments", message))
            }
            "delete_playlist" => {
                let id = args
                    .get("id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_arguments", "'id' must be a string"))?;
                crate::playlists::Playlists::new(&self.data_dir)
                    .delete(id)
                    .map_err(|message| failure("settings_save_failed", message))
            }
            "set_favorite" => {
                let requested = args
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_arguments", "'path' must be a string"))?;
                crate::library_cover::song_allowed(requested, (self.library_root)().as_deref())
                    .map_err(|message| failure("invalid_arguments", message))?;
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs());
                crate::favorites::Favorites::new(&self.data_dir)
                    .set(requested, &args, now)
                    .map_err(|message| failure("settings_save_failed", message))
            }
            "list_defect_results" => Ok(
                json!({ "results": crate::defect_results::DefectResults::new(&self.data_dir).current() }),
            ),
            "find_album_art" => {
                let text = |key: &str| {
                    args.get(key)
                        .and_then(Value::as_str)
                        .unwrap_or("")
                        .trim()
                        .to_owned()
                };
                let (artist, album) = (text("artist"), text("album"));
                if album.is_empty() || album.len() > 300 || artist.len() > 300 {
                    return Err(failure(
                        "invalid_arguments",
                        "Give the album (and artist) to search for.",
                    ));
                }
                // What the album in the library has, for scoring how well each release fits.
                let wanted = crate::artwork_search::Wanted {
                    tracks: args
                        .get("tracks")
                        .and_then(Value::as_u64)
                        .map(|n| n as usize),
                    year: args.get("year").and_then(Value::as_u64).map(|n| n as u32),
                    previews: args
                        .get("previews")
                        .and_then(Value::as_bool)
                        .unwrap_or(true),
                };
                let clues = crate::artwork_search::ArtClues {
                    paths: args
                        .get("paths")
                        .and_then(Value::as_array)
                        .map(|list| {
                            list.iter()
                                .filter_map(Value::as_str)
                                .take(8)
                                .map(str::to_owned)
                                .collect()
                        })
                        .unwrap_or_default(),
                    release_id: text("release_id"),
                    release_group_id: text("release_group_id"),
                    barcode: text("barcode"),
                    catalog: text("catalog"),
                };
                Ok(self.start_job(move |this, _| {
                    this.run_find_album_art(&artist, &album, wanted, clues)
                }))
            }
            "fetch_album_art" => {
                let release = args
                    .get("release_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let group = args
                    .get("release_group_id")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                let image_url = args
                    .get("image_url")
                    .and_then(Value::as_str)
                    .unwrap_or("")
                    .to_owned();
                Ok(self.start_job(move |this, _| {
                    this.run_fetch_album_art(&release, &group, &image_url)
                }))
            }
            "list_defect_problems" => {
                let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
                let limit = args
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(50)
                    .clamp(1, 500) as usize;
                crate::defect_results::DefectResults::new(&self.data_dir)
                    .problems(offset, limit)
                    .map_err(|e| {
                        failure(
                            "results_unavailable",
                            format!("Could not read the scan results: {e}"),
                        )
                    })
            }
            "library_scan_status" => {
                let running = self
                    .library_scan
                    .lock()
                    .ok()
                    .and_then(|s| s.as_ref().map(|p| p.json()));
                Ok(running.unwrap_or_else(|| json!({ "running": false })))
            }
            "scan_library_defects" => {
                if let Some(running) = self
                    .library_scan
                    .lock()
                    .ok()
                    .and_then(|s| s.as_ref().map(|p| p.job_id.clone()))
                {
                    return Ok(json!({ "job_id": running, "already_running": true }));
                }
                let Some(root) = (self.library_root)() else {
                    return Err(failure(
                        "invalid_arguments",
                        "No music library folder is chosen.",
                    ));
                };
                Ok(self.start_job(move |this, id| {
                    let (canceller, stop) = Canceller::flag();
                    if let Ok(mut jobs) = this.jobs.lock() {
                        jobs.insert(id.to_owned(), canceller);
                    }
                    let progress = crate::library_scan::ScanProgress::new(id);
                    if let Ok(mut slot) = this.library_scan.lock() {
                        *slot = Some(progress.clone());
                    }
                    let store = crate::defect_results::DefectResults::new(&this.data_dir);
                    let outcome = (|| {
                        let files = crate::library_scan::library_files(&root, &store)
                            .map_err(|e| failure("library_unavailable", e))?;
                        let stored = store
                            .fingerprints()
                            .map_err(|e| failure("results_unavailable", e.to_string()))?;
                        let todo = crate::library_scan::still_to_scan(&files, &stored);
                        let emit = |p: &crate::library_scan::ScanProgress| {
                            let mut payload = p.json();
                            payload["kind"] = json!("library_defects");
                            this.output.emit("job-progress", payload);
                        };
                        let mut summary = crate::library_scan::run(
                            &todo,
                            Some(&root),
                            &store,
                            crate::library_scan::worker_count(),
                            &stop,
                            &progress,
                            &emit,
                        );
                        summary["library_files"] = json!(files.len());
                        Ok(summary)
                    })();
                    if let Ok(mut slot) = this.library_scan.lock() {
                        *slot = None;
                    }
                    outcome
                }))
            }
            "scan_library_loudness" => {
                // `again`: every song is read afresh, whatever was measured before (each old result is replaced as its song is done).
                let again = args.get("again").and_then(Value::as_bool) == Some(true);
                if let Some(running) = self
                    .loudness_scan
                    .lock()
                    .ok()
                    .and_then(|s| s.as_ref().map(|p| p.job_id.clone()))
                {
                    return Ok(json!({ "job_id": running, "already_running": true }));
                }
                let Some(root) = (self.library_root)() else {
                    return Err(failure(
                        "invalid_arguments",
                        "No music library folder is chosen.",
                    ));
                };
                Ok(self.start_job(move |this, id| {
                    let (canceller, stop) = Canceller::flag();
                    if let Ok(mut jobs) = this.jobs.lock() {
                        jobs.insert(id.to_owned(), canceller);
                    }
                    let progress = crate::library_scan::ScanProgress::new(id);
                    if let Ok(mut slot) = this.loudness_scan.lock() {
                        *slot = Some(progress.clone());
                    }
                    let store = crate::loudness_store::LoudnessStore::new(&this.data_dir);
                    let outcome = (|| {
                        let (files, todo) =
                            crate::loudness_job::library_and_todo(&root, &store, again)
                                .map_err(|e| failure("library_unavailable", e))?;
                        let emit = |p: &crate::library_scan::ScanProgress| {
                            let mut payload = p.json();
                            payload["kind"] = json!("loudness");
                            this.output.emit("job-progress", payload);
                        };
                        let mut summary = crate::loudness_job::run(
                            &todo,
                            &store,
                            crate::library_scan::worker_count(),
                            &stop,
                            &progress,
                            &emit,
                        );
                        summary["library_files"] = json!(files.len());
                        Ok(summary)
                    })();
                    if let Ok(mut slot) = this.loudness_scan.lock() {
                        *slot = None;
                    }
                    outcome
                }))
            }
            "organize_preview" => {
                let Some(root) = (self.library_root)() else {
                    return Err(failure(
                        "invalid_arguments",
                        "No music library folder is chosen.",
                    ));
                };
                let pattern = organize_pattern(args);
                let options = organize_options(args);
                Ok(self.start_job(move |this, id| {
                    let progress = |done: usize, total: usize| this.output.emit("job-progress", json!({ "job_id": id, "kind": "organize_scan", "tracks_done": done, "tracks_total": total }));
                    let songs = crate::library_organize::read_songs_with(&root, &progress)
                        .map_err(|e| failure("library_unavailable", e))?;
                    Ok(crate::library_organize::preview_json(
                        &root, &songs, &pattern, &options,
                    ))
                }))
            }
            "organize_apply" => {
                let Some(root) = (self.library_root)() else {
                    return Err(failure(
                        "invalid_arguments",
                        "No music library folder is chosen.",
                    ));
                };
                if args.get("confirm").and_then(Value::as_bool) != Some(true) {
                    return Err(failure(
                        "invalid_arguments",
                        "The change must be confirmed.",
                    ));
                }
                let busy = self.tag_scan.lock().ok().is_some_and(|s| s.is_some())
                    || self.library_scan.lock().ok().is_some_and(|s| s.is_some())
                    || self.loudness_scan.lock().ok().is_some_and(|s| s.is_some())
                    || self.tag_write.load(Ordering::SeqCst)
                    || self.jobs.lock().map(|j| !j.is_empty()).unwrap_or(true);
                if busy {
                    return Err(failure(
                        "busy",
                        "Wait until the scan, rip or other work in progress has finished, then try again.",
                    ));
                }
                let pattern = organize_pattern(args);
                let options = organize_options(args);
                let expected = args.get("expected").and_then(Value::as_u64).unwrap_or(0) as usize;
                Ok(self.start_job(move |this, id| {
                    let (canceller, stop) = Canceller::flag();
                    if let Ok(mut jobs) = this.jobs.lock() {
                        jobs.insert(id.to_owned(), canceller);
                    }
                    let outcome = (|| {
                        // The plan is made again here, from the files as they are now: the page only says what it showed.
                        let reading = |done: usize, total: usize| this.output.emit("job-progress", json!({ "job_id": id, "kind": "organize_scan", "tracks_done": done, "tracks_total": total }));
                        let songs = crate::library_organize::read_songs_with(&root, &reading).map_err(|e| failure("library_unavailable", e))?;
                        let plan = crate::library_organize::plan(&root, &songs, &pattern, &options, &|p: &str| std::path::Path::new(p).is_file());
                        if plan.moves.len() != expected {
                            return Err(failure("changed", format!("The library has changed since the preview ({} songs would move now, {} were shown). Preview again.", plan.moves.len(), expected)));
                        }
                        let progress = |done: usize, total: usize| this.output.emit("job-progress", json!({ "job_id": id, "kind": "organize", "tracks_done": done, "tracks_total": total }));
                        let result = crate::organize_apply::execute(&root, &plan.moves, &this.data_dir, &pattern, &progress, &stop);
                        let mut reply = result.json();
                        reply["moved_pairs"] = json!(plan.moves.iter().take(20_000).map(|(a, b)| json!([a, b])).collect::<Vec<_>>());
                        Ok(reply)
                    })();
                    if let Ok(mut jobs) = this.jobs.lock() {
                        jobs.remove(id);
                    }
                    outcome
                }))
            }
            "organize_undo" => {
                let Some(root) = (self.library_root)() else {
                    return Err(failure(
                        "invalid_arguments",
                        "No music library folder is chosen.",
                    ));
                };
                let busy = self.tag_write.load(Ordering::SeqCst)
                    || self.jobs.lock().map(|j| !j.is_empty()).unwrap_or(true);
                if busy {
                    return Err(failure(
                        "busy",
                        "Wait until the work in progress has finished, then try again.",
                    ));
                }
                let result = crate::organize_apply::undo(&root, &self.data_dir)
                    .map_err(|m| failure("undo_failed", m))?;
                let mut reply = result.json();
                reply["last"] = crate::organize_apply::last_batch(&self.data_dir)
                    .map_or(Value::Null, |(at, n)| json!({ "at": at, "moved": n }));
                Ok(reply)
            }
            "organize_last" => Ok(
                json!({ "last": crate::organize_apply::last_batch(&self.data_dir).map_or(Value::Null, |(at, n)| json!({ "at": at, "moved": n })) }),
            ),
            "library_loudness_status" => {
                let store = crate::loudness_store::LoudnessStore::new(&self.data_dir);
                let running = self
                    .loudness_scan
                    .lock()
                    .ok()
                    .and_then(|s| s.as_ref().map(|p| p.json()));
                let mut status = running.unwrap_or_else(|| json!({ "running": false }));
                status["measured"] = json!(store.count());
                status["mode"] = json!(store.mode());
                Ok(status)
            }
            "loudness_gains" => {
                let paths: Vec<String> = args
                    .get("paths")
                    .and_then(Value::as_array)
                    .map(|a| {
                        a.iter()
                            .filter_map(|v| v.as_str().map(str::to_owned))
                            .take(500)
                            .collect()
                    })
                    .unwrap_or_default();
                let store = crate::loudness_store::LoudnessStore::new(&self.data_dir);
                let gains = store
                    .gains(&paths)
                    .map_err(|e| failure("loudness_unavailable", e.to_string()))?;
                Ok(json!({ "mode": store.mode(), "gains": gains }))
            }
            "levelling_tags_preview" => {
                let store = crate::loudness_store::LoudnessStore::new(&self.data_dir);
                crate::levelling_tags::preview(&store, &self.data_dir)
                    .map_err(|e| failure("levelling_unavailable", e))
            }
            "levelling_tags_albums" => {
                let store = crate::loudness_store::LoudnessStore::new(&self.data_dir);
                crate::levelling_tags::albums(&store, &self.data_dir)
                    .map_err(|e| failure("levelling_unavailable", e))
            }
            "levelling_tags_write" | "levelling_tags_undo" | "levelling_tags_strip" => {
                let undo = command == "levelling_tags_undo";
                let strip = command == "levelling_tags_strip";
                let folder = args
                    .get("folder")
                    .and_then(Value::as_str)
                    .filter(|f| !f.is_empty())
                    .map(str::to_owned);
                let options = crate::levelling_tags::WriteOptions {
                    limit_albums: args
                        .get("limit_albums")
                        .and_then(Value::as_u64)
                        .filter(|n| *n > 0)
                        .map(|n| n as usize),
                    folder: folder.clone(),
                };
                if args.get("confirm").and_then(Value::as_bool) != Some(true) {
                    return Err(failure(
                        "invalid_arguments",
                        "The change must be confirmed.",
                    ));
                }
                if self.tag_write.swap(true, Ordering::SeqCst) {
                    return Err(failure(
                        "busy",
                        "Files are already being changed; wait for that to finish.",
                    ));
                }
                Ok(self.start_job(move |this, id| {
                    let (canceller, stop) = Canceller::flag();
                    if let Ok(mut jobs) = this.jobs.lock() {
                        jobs.insert(id.to_owned(), canceller);
                    }
                    let progress = |done: usize, total: usize| this.output.emit("job-progress", json!({ "job_id": id, "kind": "levelling_tags", "tracks_done": done, "tracks_total": total }));
                    let store = crate::loudness_store::LoudnessStore::new(&this.data_dir);
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        if undo {
                            crate::levelling_tags::undo(&store, &this.data_dir, &progress, &stop)
                        } else if strip {
                            crate::levelling_tags::strip(&store, &this.data_dir, folder.as_deref(), &progress, &stop)
                        } else {
                            crate::levelling_tags::write(&store, &this.data_dir, &options, &progress, &stop)
                        }
                    }));
                    if let Ok(mut jobs) = this.jobs.lock() {
                        jobs.remove(id);
                    }
                    this.tag_write.store(false, Ordering::SeqCst);
                    match outcome {
                        Ok(result) => result.map_err(|message| failure("levelling_failed", message)),
                        Err(_) => Err(failure("internal_error", "Writing stopped unexpectedly. Files already written are in the undo list.")),
                    }
                }))
            }
            "native_audio_devices" => {
                crate::native_audio::devices().map_err(|e| failure("native_audio_unavailable", e))
            }
            "native_audio_status" => Ok(crate::native_audio::status()),
            "native_audio_open" | "native_audio_next" => {
                let path = args
                    .get("path")
                    .and_then(Value::as_str)
                    .filter(|p| !p.is_empty());
                let token = args.get("token").and_then(Value::as_u64).unwrap_or(0);
                // only music inside the library folder is played this way; anything else is played the ordinary way
                let file = match path {
                    Some(path) => Some(
                        crate::library_cover::resolve_in_library(
                            path,
                            (self.library_root)().as_deref(),
                        )
                        .map_err(|e| failure("native_audio_unavailable", e))?,
                    ),
                    None if command == "native_audio_next" => None,
                    None => {
                        return Err(failure("invalid_arguments", "A song to play is needed."));
                    }
                };
                if command == "native_audio_next" {
                    return crate::native_audio::queue_next(file, token)
                        .map_err(|e| failure("native_audio_unavailable", e));
                }
                let start_ms = args.get("start_ms").and_then(Value::as_u64).unwrap_or(0);
                let play = args.get("play").and_then(Value::as_bool).unwrap_or(true);
                let device = args
                    .get("device")
                    .and_then(Value::as_str)
                    .map(str::to_owned);
                crate::native_audio::open(file.unwrap_or_default(), token, start_ms, play, device)
                    .map_err(|e| failure("native_audio_unavailable", e))
            }
            "native_audio_control" => {
                let action = args.get("action").and_then(Value::as_str).unwrap_or("");
                crate::native_audio::control(
                    action,
                    args.get("ms").and_then(Value::as_u64),
                    args.get("volume").and_then(Value::as_f64),
                    args.get("muted").and_then(Value::as_bool),
                )
                .map_err(|e| failure("native_audio_unavailable", e))
            }
            "get_loudness_settings" => Ok(
                json!({ "mode": crate::loudness_store::LoudnessStore::new(&self.data_dir).mode() }),
            ),
            "set_loudness_settings" => {
                let mode = args
                    .get("mode")
                    .and_then(Value::as_str)
                    .filter(|m| ["off", "gentle", "standard"].contains(m));
                let Some(mode) = mode else {
                    return Err(failure(
                        "invalid_arguments",
                        "The levelling is off, gentle or standard.",
                    ));
                };
                crate::loudness_store::LoudnessStore::new(&self.data_dir)
                    .set_mode(mode)
                    .map_err(|e| failure("settings_save_failed", e.to_string()))?;
                Ok(json!({ "mode": mode }))
            }
            "scan_tag_repair" => {
                if let Some(running) = self
                    .tag_scan
                    .lock()
                    .ok()
                    .and_then(|s| s.as_ref().map(|p| p.job_id.clone()))
                {
                    return Ok(json!({ "job_id": running, "already_running": true }));
                }
                if self.tag_write.load(Ordering::SeqCst) {
                    return Err(failure(
                        "busy",
                        "Wait until the tags being written are finished.",
                    ));
                }
                let Some(root) = (self.library_root)() else {
                    return Err(failure(
                        "invalid_arguments",
                        "No music library folder is chosen.",
                    ));
                };
                let again = args.get("again").and_then(Value::as_bool).unwrap_or(false);
                let retry = args.get("retry").and_then(Value::as_bool).unwrap_or(false);
                Ok(self.start_job(move |this, id| {
                    let (canceller, stop) = Canceller::flag();
                    if let Ok(mut jobs) = this.jobs.lock() {
                        jobs.insert(id.to_owned(), canceller);
                    }
                    let progress = crate::tag_repair::ScanState::new(id);
                    if let Ok(mut slot) = this.tag_scan.lock() {
                        *slot = Some(progress.clone());
                    }
                    let store = crate::tag_repair::TagRepairStore::new(&this.data_dir);
                    let settings = this.metadata.current();
                    let emit = |p: &crate::tag_repair::ScanState| {
                        let mut payload = p.json();
                        payload["kind"] = json!("tag_repair");
                        this.output.emit("job-progress", payload);
                    };
                    let outcome = crate::tag_repair::run(
                        &root,
                        &store,
                        &settings,
                        &this.metadata,
                        again,
                        retry,
                        &stop,
                        &progress,
                        &emit,
                    )
                    .map_err(|message| failure("tag_repair_failed", message));
                    if let Ok(mut slot) = this.tag_scan.lock() {
                        *slot = None;
                    }
                    outcome
                }))
            }
            "apply_tag_repair" | "undo_tag_repair" => {
                if self.tag_scan.lock().ok().is_some_and(|s| s.is_some()) {
                    return Err(failure(
                        "busy",
                        "Wait for the library check to finish first.",
                    ));
                }
                if self.tag_write.swap(true, Ordering::SeqCst) {
                    return Err(failure("busy", "Tags are already being written."));
                }
                let undo = command == "undo_tag_repair";
                let parsed: Result<(Vec<crate::tag_repair::AlbumChoice>, i64), HelperError> =
                    (|| {
                        if undo {
                            let batch =
                                args.get("batch").and_then(Value::as_i64).ok_or_else(|| {
                                    failure("invalid_arguments", "'batch' must be a number")
                                })?;
                            return Ok((Vec::new(), batch));
                        }
                        let list =
                            args.get("albums")
                                .and_then(Value::as_array)
                                .ok_or_else(|| {
                                    failure("invalid_arguments", "'albums' must be a list")
                                })?;
                        let strings = |value: &Value| -> std::collections::HashSet<String> {
                            value
                                .as_array()
                                .into_iter()
                                .flatten()
                                .filter_map(|v| v.as_str().map(str::to_owned))
                                .collect()
                        };
                        let albums = list
                            .iter()
                            .map(|a| {
                                Ok(crate::tag_repair::AlbumChoice {
                                    path: a
                                        .get("path")
                                        .and_then(Value::as_str)
                                        .ok_or_else(|| {
                                            failure(
                                                "invalid_arguments",
                                                "each album needs a 'path'",
                                            )
                                        })?
                                        .to_owned(),
                                    edition: a.get("edition").and_then(Value::as_u64).unwrap_or(0)
                                        as usize,
                                    skip_files: strings(&a["skip_files"]),
                                    skip_fields: strings(&a["skip_fields"]),
                                    edits: a["edits"]
                                        .as_object()
                                        .into_iter()
                                        .flatten()
                                        .map(|(path, fields)| {
                                            let fields = fields
                                                .as_object()
                                                .into_iter()
                                                .flatten()
                                                .filter_map(|(f, v)| {
                                                    Some((f.clone(), v.as_str()?.to_owned()))
                                                })
                                                .collect();
                                            (path.clone(), fields)
                                        })
                                        .collect(),
                                })
                            })
                            .collect::<Result<Vec<_>, HelperError>>()?;
                        Ok((albums, 0))
                    })();
                let (albums, batch) = match parsed {
                    Ok(parsed) => parsed,
                    Err(error) => {
                        self.tag_write.store(false, Ordering::SeqCst);
                        return Err(error);
                    }
                };
                Ok(self.start_job(move |this, id| {
                    let store = crate::tag_repair::TagRepairStore::new(&this.data_dir);
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        if undo {
                            crate::tag_repair::undo(&store, batch)
                        } else {
                            let progress = |done: usize, total: usize| {
                                this.output.emit("job-progress", json!({ "job_id": id, "kind": "tag_write", "done": done, "total": total }));
                            };
                            crate::tag_repair::apply(&store, &albums, &progress)
                        }
                    }));
                    this.tag_write.store(false, Ordering::SeqCst);
                    match outcome {
                        Ok(result) => result.map_err(|message| failure("tag_write_failed", message)),
                        Err(_) => Err(failure("internal_error", "Writing stopped unexpectedly. Files already written are in the undo list.")),
                    }
                }))
            }
            "convert_survey" => {
                let Some(root) = (self.library_root)() else {
                    return Err(failure(
                        "invalid_arguments",
                        "No music library folder is chosen.",
                    ));
                };
                Ok(crate::convert_job::survey(&root))
            }
            "convert_to_mp3" => {
                let Some(root) = (self.library_root)() else {
                    return Err(failure(
                        "invalid_arguments",
                        "No music library folder is chosen.",
                    ));
                };
                if self.tag_write.swap(true, Ordering::SeqCst) {
                    return Err(failure(
                        "busy",
                        "Files are already being changed; wait for that to finish.",
                    ));
                }
                let work = self.data_dir.join("converting");
                Ok(self.start_job(move |this, id| {
                    let (canceller, stop) = Canceller::flag();
                    if let Ok(mut jobs) = this.jobs.lock() {
                        jobs.insert(id.to_owned(), canceller);
                    }
                    let progress = |done: usize, total: usize, current: &str| {
                        this.output.emit("job-progress", json!({ "job_id": id, "kind": "convert", "done": done, "total": total, "current": current }));
                    };
                    let outcome = crate::convert_job::run(&root, &work, &stop, &progress);
                    this.tag_write.store(false, Ordering::SeqCst);
                    outcome.map_err(|message| failure("convert_failed", message))
                }))
            }
            "get_tag_settings" => Ok(json!({ "id3v24": self.settings.id3v24() })),
            "set_tag_settings" => {
                let on = args.get("id3v24").and_then(Value::as_bool).ok_or_else(|| {
                    failure("invalid_arguments", "'id3v24' must be true or false")
                })?;
                self.settings.set_id3v24(on).map_err(|e| {
                    failure(
                        "settings_save_failed",
                        format!("Could not save the setting: {e}"),
                    )
                })?;
                mediaverse_metadata_tags::set_write_id3v24(on);
                Ok(json!({ "id3v24": on }))
            }
            "id3_survey" => {
                let Some(root) = (self.library_root)() else {
                    return Err(failure(
                        "invalid_arguments",
                        "No music library folder is chosen.",
                    ));
                };
                Ok(crate::tag_standard::survey(
                    &root,
                    if self.settings.id3v24() { 4 } else { 3 },
                ))
            }
            "standardize_id3" | "tag_untagged" => {
                let Some(root) = (self.library_root)() else {
                    return Err(failure(
                        "invalid_arguments",
                        "No music library folder is chosen.",
                    ));
                };
                if self.tag_write.swap(true, Ordering::SeqCst) {
                    return Err(failure("busy", "Tags are already being written."));
                }
                let target = if self.settings.id3v24() { 4 } else { 3 };
                let untagged = command == "tag_untagged";
                Ok(self.start_job(move |this, id| {
                    let (canceller, stop) = Canceller::flag();
                    if let Ok(mut jobs) = this.jobs.lock() {
                        jobs.insert(id.to_owned(), canceller);
                    }
                    let progress = |done: usize, total: usize| {
                        this.output.emit(
                            "job-progress",
                            json!({ "job_id": id, "kind": "id3", "done": done, "total": total }),
                        );
                    };
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        if untagged {
                            crate::tag_standard::tag_untagged(&root, &stop, &progress)
                        } else {
                            crate::tag_standard::run(&root, target, &stop, &progress)
                        }
                    }));
                    this.tag_write.store(false, Ordering::SeqCst);
                    outcome.map_err(|_| {
                        failure("internal_error", "Converting tags stopped unexpectedly.")
                    })
                }))
            }
            "align_album" => crate::album_align::align_album(
                args,
                (self.library_root)().as_deref(),
                &self.data_dir,
            )
            .map_err(|message| failure("invalid_arguments", message)),
            "undo_album_align" => crate::album_align::undo_album_align(
                args.get("batch").and_then(Value::as_str).unwrap_or(""),
                (self.library_root)().as_deref(),
                &self.data_dir,
            )
            .map_err(|message| failure("undo_failed", message)),
            "cover_preview" => {
                // A small front cover for a release the lookup found, so the person can match the edition before ripping.
                let release = args
                    .get("release")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_arguments", "'release' must be a string"))?;
                let settings = self.metadata.current();
                if !settings.cover_art.enabled {
                    return Ok(Value::Null);
                }
                self.metadata
                    .wait_turn("coverart", Duration::from_millis(500));
                let contact = settings.identity.contact.trim();
                let agent = mediaverse_disc_metadata::musicbrainz::user_agent(
                    "MediaVerseStudio",
                    env!("CARGO_PKG_VERSION"),
                    if contact.is_empty() {
                        "https://github.com/MediaVerseStudio/MediaVerse-Studio"
                    } else {
                        contact
                    },
                );
                match crate::cover_art::fetch_front_cover_sizes(
                    &settings.cover_art.base_url,
                    release,
                    &agent,
                    Duration::from_secs(20),
                    &["front-250"],
                ) {
                    Ok(image) => {
                        self.metadata.outcome("coverart", false, None);
                        let mime = if image.bytes.starts_with(&[0x89, b'P', b'N', b'G']) {
                            "image/png"
                        } else {
                            "image/jpeg"
                        };
                        Ok(
                            json!({ "mime": mime, "data_base64": crate::artist_photos_wiki::base64(&image.bytes) }),
                        )
                    }
                    Err((code, _)) => {
                        self.metadata
                            .outcome("coverart", code == "rate_limited", None);
                        Ok(Value::Null) // no cover is not an error: the card just has no picture
                    }
                }
            }
            "canonical_artist_names" => Ok(crate::artist_names_mb::answers(&self.data_dir)),
            "check_artist_names" => {
                if let Some(running) = self
                    .tag_scan
                    .lock()
                    .ok()
                    .and_then(|s| s.as_ref().map(|p| p.job_id.clone()))
                {
                    return Ok(json!({ "job_id": running, "already_running": true }));
                }
                let args = args.clone();
                Ok(self.start_job(move |this, id| {
                    let (canceller, stop) = Canceller::flag();
                    if let Ok(mut jobs) = this.jobs.lock() {
                        jobs.insert(id.to_owned(), canceller);
                    }
                    let progress = crate::tag_repair::ScanState::new(id);
                    if let Ok(mut slot) = this.tag_scan.lock() {
                        *slot = Some(progress.clone());
                    }
                    let settings = this.metadata.current();
                    let emit = |p: &crate::tag_repair::ScanState| {
                        let mut payload = p.json();
                        payload["kind"] = json!("artist_names");
                        this.output.emit("job-progress", payload);
                    };
                    let outcome = crate::artist_names_mb::check(
                        &args,
                        &this.data_dir,
                        &settings,
                        &this.metadata,
                        &stop,
                        &progress,
                        &emit,
                    )
                    .map_err(|message| failure("artist_names_failed", message));
                    if let Ok(mut slot) = this.tag_scan.lock() {
                        *slot = None;
                    }
                    outcome
                }))
            }
            "list_wiki_photos" => Ok(crate::artist_photos_wiki::summary(&self.data_dir)),
            "find_wiki_photos" => {
                if let Some(running) = self
                    .tag_scan
                    .lock()
                    .ok()
                    .and_then(|s| s.as_ref().map(|p| p.job_id.clone()))
                {
                    return Ok(json!({ "job_id": running, "already_running": true }));
                }
                let args = args.clone();
                Ok(self.start_job(move |this, id| {
                    let (canceller, stop) = Canceller::flag();
                    if let Ok(mut jobs) = this.jobs.lock() {
                        jobs.insert(id.to_owned(), canceller);
                    }
                    let progress = crate::tag_repair::ScanState::new(id);
                    if let Ok(mut slot) = this.tag_scan.lock() {
                        *slot = Some(progress.clone());
                    }
                    let settings = this.metadata.current();
                    let emit = |p: &crate::tag_repair::ScanState| {
                        let mut payload = p.json();
                        payload["kind"] = json!("wiki_photos");
                        this.output.emit("job-progress", payload);
                    };
                    let outcome = crate::artist_photos_wiki::find_photos(
                        &args,
                        &this.data_dir,
                        &settings,
                        &this.metadata,
                        &stop,
                        &progress,
                        &emit,
                    )
                    .map_err(|message| failure("wiki_photos_failed", message));
                    if let Ok(mut slot) = this.tag_scan.lock() {
                        *slot = None;
                    }
                    outcome
                }))
            }
            "write_wiki_photos" => {
                if self.tag_scan.lock().ok().is_some_and(|s| s.is_some()) {
                    return Err(failure(
                        "busy",
                        "Wait for the photo search to finish first.",
                    ));
                }
                if self.tag_write.swap(true, Ordering::SeqCst) {
                    return Err(failure("busy", "Tags are already being written."));
                }
                let args = args.clone();
                Ok(self.start_job(move |this, id| {
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        let progress = |done: usize, total: usize| {
                            this.output.emit("job-progress", json!({ "job_id": id, "kind": "wiki_photos_write", "done": done, "total": total }));
                        };
                        crate::artist_photos_wiki::write_photos(&args, (this.library_root)().as_deref(), &this.data_dir, &progress)
                    }));
                    this.tag_write.store(false, Ordering::SeqCst);
                    match outcome {
                        Ok(result) => result.map_err(|message| failure("wiki_photos_failed", message)),
                        Err(_) => Err(failure("internal_error", "Writing stopped unexpectedly. Photos already written can be undone.")),
                    }
                }))
            }
            "scan_album_align" => {
                if let Some(running) = self
                    .tag_scan
                    .lock()
                    .ok()
                    .and_then(|s| s.as_ref().map(|p| p.job_id.clone()))
                {
                    return Ok(json!({ "job_id": running, "already_running": true }));
                }
                let Some(root) = (self.library_root)() else {
                    return Err(failure(
                        "invalid_arguments",
                        "No music library folder is chosen.",
                    ));
                };
                Ok(self.start_job(move |this, id| {
                    let (canceller, stop) = Canceller::flag();
                    if let Ok(mut jobs) = this.jobs.lock() {
                        jobs.insert(id.to_owned(), canceller);
                    }
                    let progress = crate::tag_repair::ScanState::new(id);
                    if let Ok(mut slot) = this.tag_scan.lock() {
                        *slot = Some(progress.clone());
                    }
                    let emit = |p: &crate::tag_repair::ScanState| {
                        let mut payload = p.json();
                        payload["kind"] = json!("album_align");
                        this.output.emit("job-progress", payload);
                    };
                    let outcome = crate::album_align::scan(&root, &stop, &progress, &emit)
                        .map_err(|message| failure("album_align_failed", message));
                    if let Ok(mut slot) = this.tag_scan.lock() {
                        *slot = None;
                    }
                    outcome
                }))
            }
            "scan_mb_ids" => {
                if let Some(running) = self
                    .tag_scan
                    .lock()
                    .ok()
                    .and_then(|s| s.as_ref().map(|p| p.job_id.clone()))
                {
                    return Ok(json!({ "job_id": running, "already_running": true }));
                }
                if self.tag_write.load(Ordering::SeqCst) {
                    return Err(failure(
                        "busy",
                        "Wait until the tags being written are finished.",
                    ));
                }
                let Some(root) = (self.library_root)() else {
                    return Err(failure(
                        "invalid_arguments",
                        "No music library folder is chosen.",
                    ));
                };
                let again = args.get("again").and_then(Value::as_bool).unwrap_or(false);
                Ok(self.start_job(move |this, id| {
                    let (canceller, stop) = Canceller::flag();
                    if let Ok(mut jobs) = this.jobs.lock() {
                        jobs.insert(id.to_owned(), canceller);
                    }
                    let progress = crate::tag_repair::ScanState::new(id);
                    if let Ok(mut slot) = this.tag_scan.lock() {
                        *slot = Some(progress.clone());
                    }
                    let store = crate::mb_ids::Store::new(&this.data_dir);
                    let settings = this.metadata.current();
                    let emit = |p: &crate::tag_repair::ScanState| {
                        let mut payload = p.json();
                        payload["kind"] = json!("mb_ids");
                        this.output.emit("job-progress", payload);
                    };
                    let outcome = crate::mb_ids::scan(
                        &root,
                        &store,
                        &settings,
                        &this.metadata,
                        again,
                        &stop,
                        &progress,
                        &emit,
                    )
                    .map_err(|message| failure("mb_ids_failed", message));
                    if let Ok(mut slot) = this.tag_scan.lock() {
                        *slot = None;
                    }
                    outcome
                }))
            }
            "list_mb_ids" => {
                let Some(root) = (self.library_root)() else {
                    return Err(failure(
                        "invalid_arguments",
                        "No music library folder is chosen.",
                    ));
                };
                let filter = args
                    .get("filter")
                    .and_then(Value::as_str)
                    .unwrap_or("review");
                let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
                let limit = args
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(10)
                    .clamp(1, 50) as usize;
                Ok(crate::mb_ids::list(
                    &crate::mb_ids::Store::new(&self.data_dir),
                    &root,
                    filter,
                    offset,
                    limit,
                ))
            }
            "dismiss_mb_ids" => {
                let path = args
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_arguments", "'path' must be text"))?;
                let undo = args.get("undo").and_then(Value::as_bool).unwrap_or(false);
                crate::mb_ids::dismiss(&crate::mb_ids::Store::new(&self.data_dir), path, undo)
                    .map_err(|message| failure("invalid_arguments", message))?;
                Ok(json!({ "ok": true }))
            }
            "apply_mb_ids" | "undo_mb_ids" => {
                if self.tag_scan.lock().ok().is_some_and(|s| s.is_some()) {
                    return Err(failure("busy", "Wait for the check to finish first."));
                }
                let batch = args
                    .get("batch")
                    .and_then(Value::as_str)
                    .filter(|b| {
                        !b.is_empty()
                            && b.chars()
                                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
                    })
                    .ok_or_else(|| failure("invalid_arguments", "'batch' must be a plain name"))?
                    .to_owned();
                let chosen: Option<Vec<(String, Option<crate::mb_ids::Candidate>)>> =
                    args.get("albums").and_then(Value::as_array).map(|list| {
                        list.iter()
                            .filter_map(|a| {
                                Some((
                                    a.get("path")?.as_str()?.to_owned(),
                                    Some(crate::mb_ids::Candidate::from_json(a)),
                                ))
                            })
                            .collect()
                    });
                if self.tag_write.swap(true, Ordering::SeqCst) {
                    return Err(failure("busy", "Tags are already being written."));
                }
                let undo = command == "undo_mb_ids";
                Ok(self.start_job(move |this, id| {
                    let (canceller, stop) = Canceller::flag();
                    if let Ok(mut jobs) = this.jobs.lock() {
                        jobs.insert(id.to_owned(), canceller);
                    }
                    let store = crate::mb_ids::Store::new(&this.data_dir);
                    let outcome = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
                        if undo {
                            crate::mb_ids::undo(&store, &batch)
                        } else {
                            let progress = |done: usize, total: usize| {
                                this.output.emit("job-progress", json!({ "job_id": id, "kind": "mb_ids_write", "done": done, "total": total }));
                            };
                            crate::mb_ids::apply(&store, &batch, chosen.as_deref(), &stop, &progress)
                        }
                    }));
                    this.tag_write.store(false, Ordering::SeqCst);
                    match outcome {
                        Ok(result) => result.map_err(|message| failure("mb_ids_failed", message)),
                        Err(_) => Err(failure("internal_error", "Writing stopped unexpectedly. Songs already written are in the undo list.")),
                    }
                }))
            }
            "tag_repair_status" => {
                let running = self
                    .tag_scan
                    .lock()
                    .ok()
                    .and_then(|s| s.as_ref().map(|p| p.json()));
                Ok(running.unwrap_or_else(|| json!({ "running": false })))
            }
            "source_status" => Ok(self.metadata.source_status()),
            "check_folder_audio" => {
                let dir =
                    PathBuf::from(args.get("path").and_then(Value::as_str).unwrap_or_default());
                if !dir.is_dir() {
                    return Err(failure(
                        "invalid_arguments",
                        "That album folder is not there any more.",
                    ));
                }
                if let Some(root) = (self.library_root)()
                    && !dir.starts_with(&root)
                {
                    return Err(failure(
                        "invalid_arguments",
                        "That folder is not in your music library.",
                    ));
                }
                if self.acoustid_asker().is_none() {
                    return Err(failure(
                        "not_configured",
                        "AcoustID is not switched on. Turn it on and enter its key in Settings first.",
                    ));
                }
                Ok(self.start_job(move |this, id| {
                    let (canceller, stop) = Canceller::flag();
                    if let Ok(mut jobs) = this.jobs.lock() {
                        jobs.insert(id.to_owned(), canceller);
                    }
                    let asker = this
                        .acoustid_asker()
                        .ok_or_else(|| failure("not_configured", "AcoustID is not switched on."))?;
                    this.check_folder(&asker, &dir, None, &stop)
                }))
            }
            "scan_audio_check" => {
                if let Some(running) = self
                    .tag_scan
                    .lock()
                    .ok()
                    .and_then(|s| s.as_ref().map(|p| p.job_id.clone()))
                {
                    return Ok(json!({ "job_id": running, "already_running": true }));
                }
                if self.tag_write.load(Ordering::SeqCst) {
                    return Err(failure(
                        "busy",
                        "Wait until the tags being written are finished.",
                    ));
                }
                let Some(root) = (self.library_root)() else {
                    return Err(failure(
                        "invalid_arguments",
                        "No music library folder is chosen.",
                    ));
                };
                if self.acoustid_asker().is_none() {
                    return Err(failure(
                        "not_configured",
                        "AcoustID is not switched on. Turn it on and enter its key in Settings first.",
                    ));
                }
                let again = args.get("again").and_then(Value::as_bool).unwrap_or(false);
                Ok(self.start_job(move |this, id| {
                    let (canceller, stop) = Canceller::flag();
                    if let Ok(mut jobs) = this.jobs.lock() {
                        jobs.insert(id.to_owned(), canceller);
                    }
                    let progress = crate::tag_repair::ScanState::new(id);
                    if let Ok(mut slot) = this.tag_scan.lock() {
                        *slot = Some(progress.clone());
                    }
                    let emit = |p: &crate::tag_repair::ScanState| {
                        let mut payload = p.json();
                        payload["kind"] = json!("audio_check_scan");
                        this.output.emit("job-progress", payload);
                    };
                    let outcome = this.scan_audio(&root, again, &stop, &progress, &emit);
                    if let Ok(mut slot) = this.tag_scan.lock() {
                        *slot = None;
                    }
                    outcome
                }))
            }
            "list_audio_check" => {
                let filter = args
                    .get("filter")
                    .and_then(Value::as_str)
                    .unwrap_or("problems");
                let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
                let limit = args
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(10)
                    .clamp(1, 50) as usize;
                Ok(crate::audio_folder::list(
                    &crate::audio_folder::Store::new(&self.data_dir),
                    filter,
                    offset,
                    limit,
                ))
            }
            "dismiss_audio_check" => {
                let path = args
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_arguments", "'path' must be text"))?;
                let undo = args.get("undo").and_then(Value::as_bool).unwrap_or(false);
                crate::audio_folder::dismiss(
                    &crate::audio_folder::Store::new(&self.data_dir),
                    path,
                    undo,
                )
                .map_err(|message| failure("invalid_arguments", message))?;
                Ok(json!({ "ok": true }))
            }
            "apply_audio_names" => {
                let dir =
                    PathBuf::from(args.get("path").and_then(Value::as_str).unwrap_or_default());
                if !dir.is_dir() {
                    return Err(failure(
                        "invalid_arguments",
                        "That album folder is not there any more.",
                    ));
                }
                if let Some(root) = (self.library_root)()
                    && !dir.starts_with(&root)
                {
                    return Err(failure(
                        "invalid_arguments",
                        "That folder is not in your music library.",
                    ));
                }
                if self.tag_scan.lock().ok().is_some_and(|s| s.is_some())
                    || self.tag_write.load(Ordering::SeqCst)
                {
                    return Err(failure(
                        "busy",
                        "Wait for the library check to finish first.",
                    ));
                }
                let titles: Vec<(String, String)> = args
                    .get("titles")
                    .and_then(Value::as_array)
                    .into_iter()
                    .flatten()
                    .filter_map(|t| {
                        Some((
                            t.get("path")?.as_str()?.to_owned(),
                            t.get("title")?.as_str()?.to_owned(),
                        ))
                    })
                    .collect();
                let tag_store = crate::tag_repair::TagRepairStore::new(&self.data_dir);
                crate::audio_folder::apply_names(
                    &tag_store,
                    &crate::audio_folder::Store::new(&self.data_dir),
                    &dir,
                    &titles,
                )
                .map_err(|(code, message)| failure(&code, message))
            }
            "search_folder_album" => {
                let text = |key: &str| {
                    args.get(key)
                        .and_then(Value::as_str)
                        .unwrap_or_default()
                        .to_owned()
                };
                let dir = PathBuf::from(text("path"));
                if !dir.is_dir() {
                    return Err(failure(
                        "invalid_arguments",
                        "That album folder is not there any more.",
                    ));
                }
                if let Some(root) = (self.library_root)()
                    && !dir.starts_with(&root)
                {
                    return Err(failure(
                        "invalid_arguments",
                        "That folder is not in your music library.",
                    ));
                }
                let (artist, album) = (text("artist"), text("album"));
                Ok(self
                    .start_job(move |this, id| this.run_folder_search(id, &dir, &artist, &album)))
            }
            "compare_album_release" | "adopt_release_values" => {
                let text = |key: &str| {
                    args.get(key)
                        .and_then(Value::as_str)
                        .filter(|v| !v.is_empty())
                        .map(str::to_owned)
                };
                let (Some(path), Some(release_id)) = (text("path"), text("release_id")) else {
                    return Err(failure(
                        "invalid_arguments",
                        "'path' and 'release_id' must be strings",
                    ));
                };
                let settings = self.metadata.current();
                let dir = PathBuf::from(&path);
                if !dir.is_dir() {
                    return Err(failure(
                        "invalid_arguments",
                        "That album folder is not there any more.",
                    ));
                }
                if let Some(root) = (self.library_root)()
                    && !dir.starts_with(&root)
                {
                    return Err(failure(
                        "invalid_arguments",
                        "That folder is not in your music library.",
                    ));
                }
                let strings = |value: &Value| -> Vec<String> {
                    value
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter_map(|v| v.as_str().map(str::to_owned))
                        .collect()
                };
                let result = if command == "compare_album_release" {
                    crate::release_compare::compare(&dir, &release_id, &settings, &self.metadata)
                } else {
                    if self.tag_scan.lock().ok().is_some_and(|s| s.is_some()) {
                        return Err(failure(
                            "busy",
                            "Wait for the library check to finish first.",
                        ));
                    }
                    let songs: Vec<(String, Vec<String>)> = args
                        .get("songs")
                        .and_then(Value::as_array)
                        .into_iter()
                        .flatten()
                        .filter_map(|s| {
                            Some((s.get("path")?.as_str()?.to_owned(), strings(&s["fields"])))
                        })
                        .collect();
                    let store = crate::tag_repair::TagRepairStore::new(&self.data_dir);
                    crate::release_compare::adopt(
                        &store,
                        &dir,
                        &release_id,
                        &strings(&args["album_fields"]),
                        &songs,
                        &settings,
                        &self.metadata,
                    )
                };
                result.map_err(|(code, message)| failure(&code, message))
            }
            "flag_rerip" => {
                let text = |key: &str| args.get(key).and_then(Value::as_str).unwrap_or_default();
                if text("path").is_empty() {
                    return Err(failure("invalid_arguments", "'path' must be a string"));
                }
                let now = std::time::SystemTime::now()
                    .duration_since(std::time::UNIX_EPOCH)
                    .map_or(0, |d| d.as_secs());
                crate::rerip::Rerip::new(&self.data_dir)
                    .flag(
                        text("path"),
                        text("album"),
                        text("artist"),
                        text("reason"),
                        now,
                    )
                    .map_err(|e| {
                        failure(
                            "settings_save_failed",
                            format!("Could not save the flag: {e}"),
                        )
                    })?;
                Ok(json!({ "flagged": true }))
            }
            "unflag_rerip" => {
                let removed = crate::rerip::Rerip::new(&self.data_dir)
                    .unflag(args.get("path").and_then(Value::as_str).unwrap_or_default())
                    .map_err(|e| {
                        failure("settings_save_failed", format!("Could not save that: {e}"))
                    })?;
                Ok(json!({ "removed": removed }))
            }
            "list_rerip" => Ok(crate::rerip::Rerip::new(&self.data_dir).list()),
            "leave_albums_alone" | "stop_leaving_alone" => {
                let paths: Vec<String> = args
                    .get("paths")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .filter_map(|p| p.as_str().map(str::to_owned))
                            .collect()
                    })
                    .filter(|list: &Vec<String>| !list.is_empty() && list.len() <= 500)
                    .ok_or_else(|| {
                        failure(
                            "invalid_arguments",
                            "'paths' must list between 1 and 500 albums",
                        )
                    })?;
                let store = crate::tag_repair::TagRepairStore::new(&self.data_dir);
                let changed = if command == "leave_albums_alone" {
                    store.leave_alone(&paths)
                } else {
                    store.stop_leaving_alone(&paths)
                }
                .map_err(|e| failure("results_unavailable", format!("Could not save that: {e}")))?;
                Ok(json!({ "changed": changed }))
            }
            "list_tag_repair" => {
                let filter = args.get("filter").and_then(Value::as_str).unwrap_or("all");
                let offset = args.get("offset").and_then(Value::as_u64).unwrap_or(0) as usize;
                let limit = args
                    .get("limit")
                    .and_then(Value::as_u64)
                    .unwrap_or(4)
                    .clamp(1, 50) as usize;
                let store = crate::tag_repair::TagRepairStore::new(&self.data_dir);
                let mut page = store.page(filter, offset, limit).map_err(|e| {
                    failure(
                        "results_unavailable",
                        format!("Could not read the tag repair results: {e}"),
                    )
                })?;
                let settings = self.metadata.current();
                crate::tag_repair::refresh_stale_discogs(
                    &store,
                    &mut page,
                    &settings,
                    &self.metadata,
                );
                crate::tag_repair::suggest_genres(&store, &mut page, &settings, &self.metadata);
                Ok(page)
            }
            "set_defect_reviewed" => {
                let path = args
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_arguments", "'path' must be a string"))?;
                let good = args
                    .get("good")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| failure("invalid_arguments", "'good' must be true or false"))?;
                let marked = crate::defect_results::DefectResults::new(&self.data_dir)
                    .set_reviewed_good(path, good)
                    .map_err(|e| {
                        failure(
                            "settings_save_failed",
                            format!("Could not save the mark: {e}"),
                        )
                    })?;
                if !marked {
                    return Err(failure(
                        "no_scan_result",
                        "This song has no current scan result to mark; scan it first.",
                    ));
                }
                Ok(json!({ "path": path, "reviewed_good": good }))
            }
            "get_listen_settings" => Ok(
                json!({ "seconds": self.settings.listen_seconds(), "min": Settings::LISTEN_MIN, "max": Settings::LISTEN_MAX, "recommended_min": 5, "recommended_max": 12 }),
            ),
            "set_listen_settings" => {
                let seconds = args.get("seconds").and_then(Value::as_u64).filter(|s| {
                    (u64::from(Settings::LISTEN_MIN)..=u64::from(Settings::LISTEN_MAX)).contains(s)
                });
                let Some(seconds) = seconds else {
                    return Err(failure(
                        "invalid_arguments",
                        format!(
                            "The listening sample must be a whole number of seconds from {} to {}.",
                            Settings::LISTEN_MIN,
                            Settings::LISTEN_MAX
                        ),
                    ));
                };
                self.settings
                    .set_listen_seconds(seconds as u32)
                    .map_err(|e| {
                        failure(
                            "settings_save_failed",
                            format!("Could not save the setting: {e}"),
                        )
                    })?;
                Ok(json!({ "seconds": self.settings.listen_seconds() }))
            }
            "library_gaps" => {
                let Some(root) = (self.library_root)() else {
                    return Err(failure(
                        "invalid_arguments",
                        "No music library folder is chosen.",
                    ));
                };
                Ok(self.start_job(move |this, id| {
                    let mut progress = |done: usize, total: usize| {
                        this.output.emit("job-progress", json!({ "job_id": id, "kind": "gaps", "tracks_done": done, "tracks_total": total }));
                    };
                    let cache = this.data_dir.join("library-gaps-cache.json");
                    Ok(crate::library_gaps::scan_with_cache(&root, Some(&cache), &mut progress))
                }))
            }
            "scan_defects" => {
                let paths: Vec<String> = args
                    .get("paths")
                    .and_then(Value::as_array)
                    .map(|list| {
                        list.iter()
                            .filter_map(|p| p.as_str().map(str::to_owned))
                            .collect()
                    })
                    .filter(|list: &Vec<String>| !list.is_empty() && list.len() <= 1000)
                    .ok_or_else(|| {
                        failure(
                            "invalid_arguments",
                            "'paths' must list between 1 and 1000 files",
                        )
                    })?;
                Ok(self.start_job(move |this, id| {
                    // Cancellable: `cancel_job` raises the flag and the scan stops before its next file.
                    let (canceller, stop_flag) = Canceller::flag();
                    if let Ok(mut jobs) = this.jobs.lock() {
                        jobs.insert(id.to_owned(), canceller);
                    }
                    let root = (this.library_root)();
                    let mut progress = |done: usize, total: usize, path: &str| {
                        this.output.emit("job-progress", json!({ "job_id": id, "kind": "defects", "tracks_done": done, "tracks_total": total, "path": path }));
                    };
                    let stop = || stop_flag.load(Ordering::SeqCst);
                    let reply = crate::library_defects::scan_files_until(&paths, root.as_deref(), &mut progress, &stop);
                    // Remember each result so the Review page can list tracks with problems without scanning again.
                    let store = crate::defect_results::DefectResults::new(&this.data_dir);
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
                    for entry in reply["tracks"].as_array().into_iter().flatten() {
                        if let (true, Some(path)) = (entry["ok"] == true, entry["path"].as_str()) {
                            let _ = store.record(path, &entry["report"], now);
                        }
                    }
                    // Songs scanned before the stop are kept above; the job itself reports the cancel.
                    if reply["stopped"] == true {
                        return Err(failure("cancelled", "The scan was stopped."));
                    }
                    Ok(reply)
                }))
            }
            "track_lyrics" => {
                let path = args
                    .get("path")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_arguments", "'path' must be a string"))?;
                crate::library_media::track_lyrics(path, (self.library_root)().as_deref())
                    .map_err(|message| failure("media_unavailable", message))
            }
            "undo_picture_batch" => crate::library_media::undo_picture_batch(
                args.get("batch").and_then(Value::as_str).unwrap_or(""),
                (self.library_root)().as_deref(),
                &self.data_dir,
            )
            .map_err(|message| failure("undo_failed", message)),
            "update_track_media" => crate::library_media::update_track_media(
                args,
                (self.library_root)().as_deref(),
                &self.data_dir,
            )
            .map_err(|message| failure("invalid_arguments", message)),
            "set_archive_enabled" => {
                let enabled = args
                    .get("enabled")
                    .and_then(Value::as_bool)
                    .ok_or_else(|| {
                        failure("invalid_arguments", "'enabled' must be true or false")
                    })?;
                self.settings.set_archive_enabled(enabled).map_err(|e| {
                    failure(
                        "settings_save_failed",
                        format!("Could not save the setting: {e}"),
                    )
                })?;
                Ok(self.archive_settings())
            }
            "cancel_job" => {
                let job = args
                    .get("job_id")
                    .and_then(Value::as_str)
                    .ok_or_else(|| failure("invalid_arguments", "'job_id' must be a string"))?;
                let jobs = self
                    .jobs
                    .lock()
                    .map_err(|_| failure("state_unavailable", "job list unavailable"))?;
                match jobs.get(job) {
                    Some(canceller) => {
                        canceller.cancel();
                        Ok(Value::Null)
                    }
                    None => Err(failure("unknown_job", format!("No running job '{job}'."))),
                }
            }
            _ => Err(failure(
                "unknown_command",
                format!("Unknown command: {command}"),
            )),
        }
    }

    fn archive_settings(&self) -> Value {
        json!({
            "archive_enabled": self.settings.archive_enabled(),
            "archive_decided": self.settings.archive_decided(),
            "archive_dir": self.settings.archive_dir().map(|dir| dir.to_string_lossy().into_owned()),
            "library_dir": (self.library_root)().map(|dir| dir.to_string_lossy().into_owned()),
        })
    }

    /// Sets (or, with `null`, clears) the Media Library Archive folder. The folder must be separate
    /// from, and not nested with, the Main Media Library.
    fn set_archive_dir(&self, path: Option<&Value>) -> Result<Value, HelperError> {
        let requested = match path {
            Some(Value::String(text)) if !text.trim().is_empty() => {
                Some(PathBuf::from(text.trim()))
            }
            Some(Value::Null) | None => None,
            _ => {
                return Err(failure(
                    "invalid_arguments",
                    "'path' must be a folder path or null",
                ));
            }
        };
        if let Some(archive) = &requested {
            // Compare real locations where they exist, so shortcuts and junctions cannot sneak the
            // archive into the library.
            let resolve = |path: &Path| crate::rip_job::resolve_real(path);
            if let Some(library) = (self.library_root)() {
                validate_locations(&resolve(&library), &resolve(archive))
                    .map_err(|problem| failure("invalid_archive_location", problem))?;
            } else if !archive.is_absolute() {
                return Err(failure(
                    "invalid_archive_location",
                    "Choose a full folder path for the archive.",
                ));
            }
        }
        self.settings
            .set_archive_dir(requested.as_deref())
            .map_err(|e| {
                failure(
                    "settings_save_failed",
                    format!("Could not save the setting: {e}"),
                )
            })?;
        Ok(self.archive_settings())
    }

    /// Identity as the helper reports it. The connection type is not yet detected (ADR 0004).
    fn identity_of(drive: &Value) -> DriveIdentity {
        let text = |name: &str| drive[name].as_str().unwrap_or_default().to_owned();
        DriveIdentity {
            vendor: text("vendor"),
            model: text("model"),
            revision: text("revision"),
            connection: Connection::Unknown,
        }
    }

    fn list_drives(&self) -> Result<Value, HelperError> {
        let mut helper = Helper::start()?;
        let listed = helper.request("list_drives", Value::Null, &mut |_, _| {})?;
        let drives: Vec<Value> = listed
            .as_array()
            .map(|drives| {
                drives
                    .iter()
                    .map(|drive| {
                        let mut entry = drive.clone();
                        if drive.get("error").is_none() {
                            entry["profile"] = json!(self.store.load(&Self::identity_of(drive)));
                        }
                        entry
                    })
                    .collect()
            })
            .unwrap_or_default();
        Ok(Value::Array(drives))
    }

    fn start_calibration(self: &Arc<Self>, device: String) -> Value {
        self.start_job(move |this, id| this.run_calibration(id, &device))
    }

    /// Runs `work` on a background thread as a job and announces its end with `job-finished`.
    pub(crate) fn start_job<F>(self: &Arc<Self>, work: F) -> Value
    where
        F: FnOnce(&Drives, &str) -> Result<Value, HelperError> + Send + 'static,
    {
        let job_id = format!("job-{}", self.next_job.fetch_add(1, Ordering::Relaxed));
        let this = self.clone();
        let id = job_id.clone();
        // The job asks outside services with the priority of the command that started it (see `scheduler`).
        let priority = crate::scheduler::current_priority();
        std::thread::spawn(move || {
            let _priority = crate::scheduler::priority(priority);
            // Library-wide bulk work runs in the system's background mode (lower processor, disk and memory priority),
            // so music playing, a rip being encoded and the page's clicks come first.
            if priority == crate::scheduler::Priority::Bulk {
                crate::os_priority::background_thread();
            }
            // A panic in a job (a damaged file, a bug) must still end the job with an error, so the page is told and
            // the job (a library scan, say) can be started again.
            let result =
                std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| work(&this, &id)))
                    .unwrap_or_else(|_| {
                        Err(failure("internal_error", "The job stopped unexpectedly."))
                    });
            // Whatever happened, a library-wide scan that was this job is over.
            if let Ok(mut slot) = this.library_scan.lock()
                && slot.as_ref().is_some_and(|p| p.job_id == id)
            {
                *slot = None;
            }
            if let Ok(mut slot) = this.tag_scan.lock()
                && slot.as_ref().is_some_and(|p| p.job_id == id)
            {
                *slot = None;
            }
            if let Ok(mut jobs) = this.jobs.lock() {
                jobs.remove(&id);
            }
            let message = match result {
                Ok(result) => json!({ "job_id": id, "ok": true, "result": result }),
                Err((code, message)) => {
                    json!({ "job_id": id, "ok": false, "error": { "code": code, "message": message } })
                }
            };
            this.output.emit("job-finished", message);
        });
        json!({ "job_id": job_id })
    }
    /// Reads the disc's table of contents and looks it up in AccurateRip.
    pub(crate) fn disc_context(
        &self,
        helper: &mut Helper,
        device: &str,
    ) -> Result<DiscContext, HelperError> {
        let mut ignore = |_: &str, _: &Value| {};
        let listed = helper.request("list_drives", Value::Null, &mut ignore)?;
        let drive = listed
            .as_array()
            .and_then(|drives| drives.iter().find(|drive| drive["device"] == device))
            .ok_or_else(|| {
                failure(
                    "drive_not_found",
                    format!("No optical drive at '{device}'."),
                )
            })?;
        let identity = Self::identity_of(drive);

        let toc = helper.request("read_toc", json!({ "device": device }), &mut ignore)?;
        let starts: Vec<u32> = toc["tracks"]
            .as_array()
            .map(|tracks| {
                tracks
                    .iter()
                    .filter(|track| track["audio"] == true)
                    .filter_map(|track| track["start_lsn"].as_u64().map(|lsn| lsn as u32))
                    .collect()
            })
            .unwrap_or_default();
        let leadout = toc["leadout_lsn"].as_u64().unwrap_or(0) as u32;
        let (id1, id2, cddb) = disc_ids(&starts, leadout);
        let disc = format!("{id1:08x}-{id2:08x}-{cddb:08x}");

        let mut notes = Vec::new();
        let pressings_hex = match self.lookup_accuraterip(starts.len(), id1, id2, cddb) {
            Lookup::Found(bytes) => {
                Some(bytes.iter().map(|b| format!("{b:02x}")).collect::<String>())
            }
            Lookup::NotFound => {
                notes.push("This disc is not in the AccurateRip database.".to_owned());
                None
            }
            Lookup::Failed(reason) => {
                notes.push(format!("The AccurateRip lookup failed ({reason}); the result could not be verified against it."));
                None
            }
        };
        Ok(DiscContext {
            identity,
            track_count: starts.len(),
            disc,
            pressings_hex,
            notes,
        })
    }

    fn run_calibration(&self, job_id: &str, device: &str) -> Result<Value, HelperError> {
        let mut helper = Helper::start()?;
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.insert(job_id.to_owned(), helper.canceller());
        }
        let context = self.disc_context(&mut helper, device)?;

        let output = self.output.clone();
        let job = job_id.to_owned();
        let mut on_event = move |event: &str, payload: &Value| {
            if event == "calibration-progress" {
                let mut progress = payload.clone();
                progress["job_id"] = json!(job);
                progress["kind"] = json!("calibration");
                output.emit("job-progress", progress);
            }
        };
        let mut report = helper.request(
            "calibrate",
            json!({
                "device": device,
                "disc": context.disc,
                "date": today(),
                "pressings_hex": context.pressings_hex,
                "existing": self.store.load(&context.identity),
            }),
            &mut on_event,
        )?;

        let profile: DriveProfile =
            serde_json::from_value(report["profile"].clone()).map_err(|e| {
                failure(
                    "helper_failed",
                    format!("The helper returned an unreadable profile: {e}"),
                )
            })?;
        self.store.save(&profile).map_err(|e| {
            failure(
                "profile_save_failed",
                format!("Could not save the drive profile: {e}"),
            )
        })?;

        if let Some(warnings) = report["warnings"].as_array_mut() {
            warnings.extend(context.notes.into_iter().map(Value::String));
        }
        report["disc"] = json!(context.disc);
        Ok(report)
    }

    /// Looks the disc up in AccurateRip, using the on-disk cache first (ADR 0004: cache and limit
    /// requests). Answers "not found" are remembered for a week.
    fn lookup_accuraterip(&self, tracks: usize, id1: u32, id2: u32, cddb: u32) -> Lookup {
        let url = database_url(tracks, id1, id2, cddb);
        let name = url.rsplit('/').next().unwrap_or("unknown.bin").to_owned();
        let dir = self.data_dir.join("accuraterip");
        let (cached, missing) = (dir.join(&name), dir.join(format!("{name}.none")));

        if let Ok(bytes) = std::fs::read(&cached) {
            return Lookup::Found(bytes);
        }
        let fresh_miss = std::fs::metadata(&missing)
            .and_then(|meta| meta.modified())
            .ok()
            .and_then(|modified| SystemTime::now().duration_since(modified).ok())
            .is_some_and(|age| age < NOT_FOUND_TTL);
        if fresh_miss {
            return Lookup::NotFound;
        }

        let agent = ureq::AgentBuilder::new()
            .timeout(Duration::from_secs(15))
            .user_agent(concat!("MediaVerseStudio/", env!("CARGO_PKG_VERSION")))
            .build();
        let _ = std::fs::create_dir_all(&dir);
        match agent.get(&url).call() {
            Ok(response) => {
                let mut bytes = Vec::new();
                match response
                    .into_reader()
                    .take(MAX_RESPONSE_BYTES)
                    .read_to_end(&mut bytes)
                {
                    Ok(_) if !bytes.is_empty() => {
                        let _ = std::fs::write(&cached, &bytes);
                        Lookup::Found(bytes)
                    }
                    Ok(_) => Lookup::Failed("empty response".to_owned()),
                    Err(e) => Lookup::Failed(e.to_string()),
                }
            }
            Err(ureq::Error::Status(404, _)) => {
                let _ = std::fs::write(&missing, b"");
                Lookup::NotFound
            }
            Err(e) => Lookup::Failed(e.to_string()),
        }
    }
}

/// Today's date (UTC) as `YYYY-MM-DD`, without a date library.
fn today() -> String {
    let seconds = SystemTime::now()
        .duration_since(SystemTime::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    civil_date((seconds / 86_400) as i64)
}

/// Converts days since 1970-01-01 to `YYYY-MM-DD` (Howard Hinnant's civil-from-days algorithm).
fn civil_date(days: i64) -> String {
    let z = days + 719_468;
    let era = z.div_euclid(146_097);
    let day_of_era = z.rem_euclid(146_097);
    let year_of_era =
        (day_of_era - day_of_era / 1460 + day_of_era / 36_524 - day_of_era / 146_096) / 365;
    let day_of_year = day_of_era - (365 * year_of_era + year_of_era / 4 - year_of_era / 100);
    let month_index = (5 * day_of_year + 2) / 153;
    let day = day_of_year - (153 * month_index + 2) / 5 + 1;
    let month = if month_index < 10 {
        month_index + 3
    } else {
        month_index - 9
    };
    let year = year_of_era + era * 400 + i64::from(month <= 2);
    format!("{year:04}-{month:02}-{day:02}")
}

/// Other artists who recorded the same work, when LRCLIB has nothing under this artist. A busy MusicBrainz
/// is skipped: the lookup still answers with the empty LRCLIB result.
fn work_artist_names(
    drives: &Drives,
    title: &str,
    artist: &str,
    agent: &str,
) -> Option<Vec<String>> {
    let settings = drives.metadata.current();
    if !settings.musicbrainz.enabled || title.trim().is_empty() || artist.trim().is_empty() {
        return None;
    }
    let base = settings.musicbrainz.base_url.clone();
    let pause = Duration::from_millis(settings.musicbrainz.min_interval_ms);
    let timeout = Duration::from_secs(settings.musicbrainz.timeout_seconds.max(1).min(8));
    let get = |url: String| -> Option<String> {
        drives.metadata.wait_turn("musicbrainz", pause);
        let reply = crate::lookup::http_get(&url, agent, timeout).ok()?;
        if matches!(reply.status, 429 | 503) {
            drives
                .metadata
                .outcome("musicbrainz", true, reply.retry_after);
            return None;
        }
        if reply.status != 200 {
            return None;
        }
        drives.metadata.outcome("musicbrainz", false, None);
        Some(String::from_utf8_lossy(&reply.body).into_owned())
    };
    let search = get(crate::lyrics_lookup::recording_search_url(
        &base, artist, title,
    ))?;
    let recording = crate::lyrics_lookup::first_recording_id(&search)?;
    let recording_body = get(crate::lyrics_lookup::recording_lookup_url(
        &base, &recording,
    ))?;
    let work = crate::lyrics_lookup::work_id_from_recording(&recording_body)?;
    let work_body = get(crate::lyrics_lookup::work_lookup_url(&base, &work))?;
    let names = crate::lyrics_lookup::other_artists_from_work(&work_body, artist);
    (!names.is_empty()).then_some(names)
}

#[cfg(test)]
mod tests {
    use super::civil_date;

    #[test]
    fn converts_days_to_calendar_dates() {
        assert_eq!(civil_date(0), "1970-01-01");
        assert_eq!(civil_date(59), "1970-03-01");
        assert_eq!(civil_date(11_016), "2000-02-29");
        assert_eq!(civil_date(20_392), "2025-10-31");
        assert_eq!(civil_date(20_818), "2026-12-31");
    }
}

/// The naming rule asked for (trimmed, not too long), or the default.
fn organize_pattern(args: &Value) -> String {
    args.get("pattern")
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|p| !p.is_empty() && p.len() < 200)
        .unwrap_or(crate::library_organize::DEFAULT_PATTERN)
        .to_owned()
}

/// The choices besides the naming rule (compilations are kept together by default).
fn organize_options(args: &Value) -> crate::library_organize::Options {
    crate::library_organize::Options {
        keep_compilations: args
            .get("keep_compilations")
            .and_then(Value::as_bool)
            .unwrap_or(true),
    }
}
