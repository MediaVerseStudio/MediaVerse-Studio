//! The rip pipeline (decisions D2 to D4, D19): folder checks first, then reading the disc, the FLAC
//! archive, the MP3 copies, the defect scan of unconfirmed tracks, and cleanup. Split out of `drives.rs`,
//! which keeps command routing, drive lists and calibration.

use crate::archive_job::archive_tracks;
use crate::drives::{Drives, failure};
use crate::helper::{Helper, HelperError};
use mediaverse_host::EventSink;
use mediaverse_ripper::archive::validate_locations;
use mediaverse_ripper::profile::Provenance;
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::time::Duration;

pub(crate) struct RipOptions {
    pub(crate) tracks: Option<Value>,
    pub(crate) secure: bool,
    pub(crate) archive: bool,
    pub(crate) metadata: Value,
    /// Number of tracks the chosen album lists; must equal the disc's audio track count.
    pub(crate) expected_tracks: Option<usize>,
    /// Make MP3 copies in the Main Media Library.
    pub(crate) mp3: bool,
    pub(crate) mp3_quality: mediaverse_ripper::mp3::Quality,
    /// Keep the intermediate WAV files even when every output succeeded.
    pub(crate) keep_wav: bool,
}

/// Warnings about AccurateRip results. A missing reference is not a failed rip, but the user should
/// know the tracks could not be confirmed against other people's copies of the disc.
fn verification_warnings(result: &Value) -> Vec<String> {
    let mut unavailable = Vec::new();
    let mut no_match = Vec::new();
    let mut shifted = Vec::new();
    for track in result["tracks"].as_array().into_iter().flatten() {
        let number = track["number"].as_u64().unwrap_or(0);
        match track["verification"]["kind"].as_str() {
            Some("unavailable") => unavailable.push(number),
            Some("no_match") if track["pressing_shift"].is_object() => shifted.push(number),
            Some("no_match") => no_match.push(number),
            _ => {}
        }
    }
    let list = |numbers: &[u64]| {
        numbers
            .iter()
            .map(u64::to_string)
            .collect::<Vec<_>>()
            .join(", ")
    };
    let mut warnings = Vec::new();
    if !unavailable.is_empty() {
        warnings.push(format!(
            "AccurateRip has no reference for track{} {}, so {} could not be confirmed against other people's copies. The rip finished normally; run a defect scan on {} later to check for pops or damage.",
            if unavailable.len() == 1 { "" } else { "s" },
            list(&unavailable),
            if unavailable.len() == 1 { "it" } else { "they" },
            if unavailable.len() == 1 { "it" } else { "them" },
        ));
    }
    if !shifted.is_empty() {
        warnings.push(format!(
            "Track{} {} matched AccurateRip only after shifting the audio by a few samples. That means this disc is a different pressing from the one most people ripped; the audio itself was read correctly.",
            if shifted.len() == 1 { "" } else { "s" },
            list(&shifted),
        ));
    }
    if !no_match.is_empty() {
        warnings.push(format!(
            "Track{} {} did not match AccurateRip. The disc may be a different pressing or the copy may contain read errors; check {} by ear or re-rip.",
            if no_match.len() == 1 { "" } else { "s" },
            list(&no_match),
            if no_match.len() == 1 { "it" } else { "them" },
        ));
    }
    warnings
}

#[cfg(test)]
mod verification_tests {
    use super::*;

    #[test]
    fn a_missing_accuraterip_entry_is_a_warning_naming_the_tracks() {
        let result = json!({ "tracks": [
            { "number": 1, "verification": { "kind": "matched" } },
            { "number": 2, "verification": { "kind": "unavailable" } },
            { "number": 3, "verification": { "kind": "unavailable" } },
        ]});
        let warnings = verification_warnings(&result);
        assert_eq!(warnings.len(), 1);
        assert!(
            warnings[0].contains("no reference for tracks 2, 3")
                && warnings[0].contains("defect scan"),
            "{warnings:?}"
        );
        assert!(
            verification_warnings(
                &json!({ "tracks": [{ "number": 1, "verification": { "kind": "matched" } }] })
            )
            .is_empty()
        );
    }
}

/// The real location of a path that may not exist yet: the deepest existing parent is resolved (so
/// shortcuts, junctions and 8.3 or `\\?\` spellings cannot hide a folder inside another) and the
/// missing part is appended.
pub(crate) fn resolve_real(path: &Path) -> PathBuf {
    let mut missing = Vec::new();
    let mut existing = path;
    loop {
        if let Ok(real) = existing.canonicalize() {
            return missing.iter().rev().fold(real, |acc, part| acc.join(part));
        }
        match (existing.parent(), existing.file_name()) {
            (Some(parent), Some(name)) => {
                missing.push(name.to_owned());
                existing = parent;
            }
            _ => return path.to_path_buf(),
        }
    }
}

impl Drives {
    /// Checks, before ripping, that the folders make sense: when FLAC archiving is on an archive
    /// folder must be chosen and be separate from the Main Media Library (so no song is stored twice
    /// there), and the temporary WAV folder must not be inside the library either.
    pub(crate) fn check_folders(&self, output_dir: &str, archive: bool) -> Result<(), HelperError> {
        let library = (self.library_root)().map(|dir| resolve_real(&dir));
        let resolve = |path: &Path| resolve_real(path);
        if archive {
            let Some(dir) = self.settings.archive_dir() else {
                return Err(failure(
                    "archive_folder_required",
                    "FLAC archiving is on but no archive folder is chosen. Choose a Media Library Archive folder in Settings, or turn archiving off.",
                ));
            };
            match &library {
                Some(library) => {
                    validate_locations(library, &resolve(&dir)).map_err(|problem| {
                        failure(
                            "invalid_archive_location",
                            format!("The archive folder cannot be used: {problem}"),
                        )
                    })?
                }
                None if !dir.is_absolute() => {
                    return Err(failure(
                        "invalid_archive_location",
                        "The archive folder must be a full folder path.",
                    ));
                }
                None => {}
            }
        }
        if let Some(library) = &library
            && resolve(Path::new(output_dir)).starts_with(library)
        {
            return Err(failure(
                "output_in_library",
                "The folder for the temporary ripped audio is inside your music library, which would leave duplicate song files there. Choose a folder outside the library.",
            ));
        }
        Ok(())
    }

    /// Downloads the front cover for the chosen album, if the details name one and cover art is on.
    /// Failure is never fatal: the masters are saved either way, and the reason goes in the warnings.
    fn fetch_cover(
        &self,
        metadata: &Value,
        warnings: &mut Vec<String>,
    ) -> Option<crate::cover_art::CoverImage> {
        let release = metadata["cover_art_release"].as_str()?;
        let settings = self.metadata.current();
        if !settings.cover_art.enabled {
            return None;
        }
        self.metadata
            .wait_turn("coverart", Duration::from_millis(1000));
        let contact = settings.identity.contact.trim();
        let user_agent = mediaverse_disc_metadata::musicbrainz::user_agent(
            "MediaVerseStudio",
            env!("CARGO_PKG_VERSION"),
            if contact.is_empty() {
                "https://github.com/MediaVerseStudio/MediaVerse-Studio"
            } else {
                contact
            },
        );
        match crate::cover_art::fetch_front_cover(
            &settings.cover_art.base_url,
            release,
            &user_agent,
            Duration::from_secs(30),
        ) {
            Ok(image) => {
                self.metadata.outcome("coverart", false, None);
                Some(image)
            }
            Err((code, message)) => {
                self.metadata
                    .outcome("coverart", code == "rate_limited", None);
                if code != "no_cover" {
                    warnings.push(format!("No cover art was saved: {message}"));
                } else {
                    warnings.push(
                        "No front cover is available for this release, so none was saved."
                            .to_owned(),
                    );
                }
                None
            }
        }
    }

    /// A smaller (500 px) cover, for embedding when the full-size one is too big or progressive.
    fn fetch_small_cover(&self, metadata: &Value) -> Option<crate::cover_art::CoverImage> {
        let release = metadata["cover_art_release"].as_str()?;
        let settings = self.metadata.current();
        if !settings.cover_art.enabled {
            return None;
        }
        self.metadata
            .wait_turn("coverart", Duration::from_millis(1000));
        let contact = settings.identity.contact.trim();
        let user_agent = mediaverse_disc_metadata::musicbrainz::user_agent(
            "MediaVerseStudio",
            env!("CARGO_PKG_VERSION"),
            if contact.is_empty() {
                "https://github.com/MediaVerseStudio/MediaVerse-Studio"
            } else {
                contact
            },
        );
        crate::cover_art::fetch_front_cover_sizes(
            &settings.cover_art.base_url,
            release,
            &user_agent,
            Duration::from_secs(30),
            &["front-500"],
        )
        .ok()
    }

    /// Rips audio tracks to verified WAV files. The drive must already be calibrated: the stored
    /// read offset is applied, and an offset that was never measured is flagged in the result.
    pub(crate) fn run_rip(
        &self,
        job_id: &str,
        device: &str,
        output_dir: &str,
        options: RipOptions,
        seen_drive: &mut Option<mediaverse_ripper::profile::DriveIdentity>,
    ) -> Result<Value, HelperError> {
        let RipOptions {
            tracks,
            secure,
            archive,
            mut metadata,
            expected_tracks,
            mp3,
            mp3_quality,
            keep_wav,
        } = options;
        // Folder checks come first, before the disc is touched: a rip must never start and then find
        // it has nowhere safe to put its files.
        self.check_folders(output_dir, archive)?;
        let mut helper = Helper::start()?;
        if let Ok(mut jobs) = self.jobs.lock() {
            jobs.insert(job_id.to_owned(), helper.canceller());
        }
        let context = self.disc_context(&mut helper, device)?;
        // From here on a disc is in the drive and the drive is known, so a failure counts in its history.
        *seen_drive = Some(context.identity.clone());
        if let Some(expected) = expected_tracks
            && expected != context.track_count
        {
            return Err(failure(
                "metadata_mismatch",
                format!(
                    "The chosen album lists {expected} tracks but the disc in the drive has {}. Choose a different album or enter the details by hand.",
                    context.track_count
                ),
            ));
        }
        let profile = self.store.load(&context.identity).ok_or_else(|| {
            failure(
                "drive_not_calibrated",
                "This drive has not been checked yet. Run the drive check in Drive setup first.",
            )
        })?;
        let offset = profile.read_offset.ok_or_else(|| {
            failure(
                "drive_not_calibrated",
                "This drive's read offset is not known. Run the drive check first.",
            )
        })?;

        let output = self.output.clone();
        let job = job_id.to_owned();
        let mut on_event = move |event: &str, payload: &Value| {
            if event == "rip-progress" {
                let mut progress = payload.clone();
                progress["job_id"] = json!(job);
                progress["kind"] = json!("rip");
                output.emit("job-progress", progress);
            }
        };
        let mut result = helper.request(
            "rip_disc",
            json!({
                "device": device,
                "output_dir": output_dir,
                "offset": offset.value,
                "max_transfer": profile.max_transfer_sectors.map(|field| field.value),
                "secure": secure,
                "tracks": tracks,
                "pressings_hex": context.pressings_hex,
            }),
            &mut on_event,
        )?;

        // Tracks that read badly are read again, harder, and the better read is kept (D102).
        let passes = self.reread_suspect_tracks(
            &mut helper,
            &mut result,
            job_id,
            device,
            output_dir,
            offset.value,
            profile.max_transfer_sectors.map(|field| field.value),
            &context.pressings_hex,
        );

        // Tracks that still do not match may be an intact copy of another pressing: look for a match at a shifted position.
        if let Some(hex) = &context.pressings_hex {
            crate::pressing_shift::find_shifts(
                &mut result,
                &crate::pressing_shift::parse_pressings(hex),
            );
        }

        let mut warnings = context.notes;
        if offset.provenance != Provenance::Measured {
            warnings.push("This drive's read offset was not verified against AccurateRip, so the audio may be shifted.".to_owned());
        }
        warnings.extend(verification_warnings(&result));
        // Tracks AccurateRip could not confirm get a defect scan instead (the WAV files still exist here).
        let (scans, scan_warnings) = crate::library_defects::scan_unconfirmed(&result);
        if !scans.is_empty() {
            result["defect_scan"] = json!(scans);
        }
        warnings.extend(scan_warnings);
        let health = crate::disc_health::assess(&result, &passes);
        if matches!(health["state"].as_str(), Some("damaged" | "suspect")) {
            // The first thing in the warnings: a damaged disc must not be buried under the usual notes.
            warnings.insert(
                0,
                format!(
                    "DISC PROBLEM: {}",
                    health["headline"]
                        .as_str()
                        .unwrap_or("some tracks could not be read cleanly")
                ),
            );
        }
        result["disc_health"] = health;
        result["disc"] = json!(context.disc);
        result["offset_verified"] = json!(offset.provenance == Provenance::Measured);
        drop(helper); // the drive is no longer needed; encoding is plain computation

        // The audio itself is asked about (AcoustID), while the verified WAV files still exist: a report, never a change (D113).
        if let Some(mut check) = self.audio_check(&result, &metadata, job_id) {
            if matches!(check["state"].as_str(), Some("mixed" | "different")) {
                warnings.push(format!(
                    "AUDIO CHECK: {}",
                    check["headline"]
                        .as_str()
                        .unwrap_or("AcoustID disagrees with the details chosen")
                ));
            }
            // Tracks nobody titled take AcoustID's title when it is very sure, and the ids of the tracks it is sure of go into the
            // files' tags (MusicBrainz recording id, AcoustID) in the standard places. Both are reported, never silent.
            let named = crate::audio_check::apply_to_details(&mut check, &mut metadata);
            if !named.is_empty() {
                warnings.push(format!(
                    "Named by AcoustID, from the audio: track{} {}. Check {} against the case.",
                    if named.len() == 1 { "" } else { "s" },
                    named
                        .iter()
                        .map(u64::to_string)
                        .collect::<Vec<_>>()
                        .join(", "),
                    if named.len() == 1 { "it" } else { "them" }
                ));
            }
            result["audio_check"] = check;
        }

        let cover = if archive || mp3 {
            self.fetch_cover(&metadata, &mut warnings)
        } else {
            None
        };
        let (mut any_output, mut every_output_ok) = (false, true);
        let tracks_ripped = result["tracks"].as_array().map_or(0, Vec::len);

        if archive {
            any_output = true;
            match self.settings.archive_dir() {
                Some(dir) => {
                    let output = self.output.clone();
                    let job = job_id.to_owned();
                    let mut progress = |track: u8, done: usize, total: usize| {
                        output.emit(
                            "job-progress",
                            json!({ "job_id": job, "kind": "archive", "track": track, "tracks_done": done, "tracks_total": total }),
                        );
                    };
                    let library = (self.library_root)();
                    let outcome = archive_tracks(
                        &result,
                        &dir,
                        library.as_deref(),
                        &metadata,
                        cover.as_ref(),
                        &mut progress,
                    );
                    every_output_ok &= outcome.entries.len() == tracks_ripped
                        && outcome.entries.iter().all(|e| e["ok"] == true);
                    warnings.extend(outcome.warnings);
                    result["archive"] = json!({ "dir": dir.to_string_lossy(), "tracks": outcome.entries, "cover": outcome.cover });
                }
                None => {
                    every_output_ok = false;
                    warnings.push(
                        "No Media Library Archive folder is set, so no FLAC masters were saved."
                            .to_owned(),
                    );
                }
            }
        }

        if mp3 {
            any_output = true;
            match ((self.library_root)(), crate::mp3_job::find_lame()) {
                (None, _) => {
                    every_output_ok = false;
                    warnings.push(
                        "No music library folder is chosen, so no MP3 copies were made.".to_owned(),
                    );
                }
                (_, None) => {
                    every_output_ok = false;
                    warnings.push("The MP3 encoder (LAME) was not found, so no MP3 copies were made. Build it with tools\\build-lame-4.0.ps1.".to_owned());
                }
                (Some(library), Some(lame)) => {
                    let output = self.output.clone();
                    let job = job_id.to_owned();
                    let mut progress = |track: u8, done: usize, total: usize| {
                        output.emit(
                            "job-progress",
                            json!({ "job_id": job, "kind": "mp3", "track": track, "tracks_done": done, "tracks_total": total }),
                        );
                    };
                    let archive_dir = self.settings.archive_dir();
                    let mut small = || self.fetch_small_cover(&metadata);
                    let outcome = crate::mp3_job::make_mp3s(
                        &result,
                        &library,
                        archive_dir.as_deref(),
                        &lame,
                        mp3_quality,
                        &metadata,
                        cover.as_ref(),
                        &mut small,
                        &mut progress,
                    );
                    every_output_ok &= outcome.entries.len() == tracks_ripped
                        && outcome.entries.iter().all(|e| e["ok"] == true);
                    warnings.extend(outcome.warnings);
                    result["mp3"] =
                        json!({ "dir": library.to_string_lossy(), "tracks": outcome.entries });
                }
            }
        }

        self.flag_damaged_tracks(&result, &metadata);

        // The verified WAV files are only a stepping stone. Remove them once every output that was
        // asked for has been written and checked; keep them if anything failed (or on request).
        if any_output && every_output_ok && !keep_wav {
            let mut removed = 0;
            for file in result["files"].as_array().cloned().unwrap_or_default() {
                if let Some(path) = file
                    .as_str()
                    .filter(|p| p.to_ascii_lowercase().ends_with(".wav"))
                    && std::fs::remove_file(path).is_ok()
                {
                    removed += 1;
                }
            }
            result["wav_removed"] = json!(removed);
            // The program's own working folder is tidied too: the rip log was copied to the archive,
            // and `remove_dir` only succeeds on an empty folder, so nothing else can be lost.
            let work = Path::new(output_dir);
            if work.starts_with(self.data_dir.join("rip-work")) {
                let _ = std::fs::remove_file(work.join("rip-log.json"));
                let _ = std::fs::remove_dir(work);
            }
        } else {
            result["wav_removed"] = json!(0);
            if any_output && !every_output_ok {
                warnings.push("The ripped WAV files were kept because not every output was written and checked.".to_owned());
            }
        }
        result["warnings"] = json!(warnings);
        Ok(result)
    }
}

/// The most time all the extra read passes over damaged tracks may take together.
const RETRY_BUDGET: Duration = Duration::from_secs(25 * 60);

impl Drives {
    /// Reads every suspect track (see `disc_health::is_suspect`) again with more re-reads per block, up to
    /// `MAX_PASSES` reads in all, keeping the best read and stopping early once a track matches AccurateRip. The
    /// better WAV replaces the worse. Returns how many times each retried track was read.
    #[allow(clippy::too_many_arguments)]
    fn reread_suspect_tracks(
        &self,
        helper: &mut Helper,
        result: &mut Value,
        job_id: &str,
        device: &str,
        output_dir: &str,
        offset: i32,
        max_transfer: Option<u32>,
        pressings_hex: &Option<String>,
    ) -> std::collections::BTreeMap<u8, u32> {
        use crate::disc_health::{MAX_PASSES, MAX_RETRIED_TRACKS, better, is_suspect};
        let mut passes = std::collections::BTreeMap::new();
        // Re-reading a scratched stretch can be slow, so all the extra passes together get a time budget; the Cancel
        // button works throughout. Tracks left unread again keep their first read and are reported as such.
        let started = std::time::Instant::now();
        let suspects: Vec<usize> = result["tracks"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .filter(|(_, t)| is_suspect(t))
            .map(|(i, _)| i)
            .take(MAX_RETRIED_TRACKS)
            .collect();
        for index in suspects {
            let number = result["tracks"][index]["number"].as_u64().unwrap_or(0) as u8;
            let Some(wav) = result["files"][index].as_str().map(PathBuf::from) else {
                continue;
            };
            passes.insert(number, 1);
            // Whether every read of this track came out sample for sample the same: reads that agree with each other are
            // trustworthy even when AccurateRip's copy (another pressing, perhaps) differs.
            let sums = |t: &Value| (t["checksum_v1"].clone(), t["checksum_v2"].clone());
            let first_sums = sums(&result["tracks"][index]);
            let mut identical = true;
            for pass in 2..=MAX_PASSES {
                if !is_suspect(&result["tracks"][index]) || started.elapsed() > RETRY_BUDGET {
                    break;
                }
                self.output.emit("job-progress", json!({ "job_id": job_id, "kind": "rip_retry", "track": number, "pass": pass, "passes": MAX_PASSES }));
                let dir = Path::new(output_dir).join(format!("retry-{number}-{pass}"));
                // Each pass is more patient: 40, then 80 re-reads per block (the first pass used the default 20).
                let again = helper.request(
                    "rip_disc",
                    json!({
                        "device": device, "output_dir": dir.to_string_lossy(), "offset": offset, "max_transfer": max_transfer,
                        "secure": true, "tracks": [number], "pressings_hex": pressings_hex, "retries": 40 * (pass - 1),
                    }),
                    &mut |_: &str, _: &Value| {},
                );
                let Ok(again) = again else {
                    let _ = std::fs::remove_dir_all(&dir);
                    break; // cancelled, or the drive failed: keep what there is
                };
                passes.insert(number, pass);
                let (new_track, new_file) = (
                    again["tracks"][0].clone(),
                    again["files"][0].as_str().map(PathBuf::from),
                );
                identical &= sums(&new_track) == first_sums;
                if let Some(new_file) = new_file
                    && better(&new_track, &result["tracks"][index])
                    && std::fs::copy(&new_file, &wav).is_ok()
                {
                    result["tracks"][index] = new_track;
                }
                result["tracks"][index]["read_agreement"] =
                    json!({ "reads": pass, "identical": identical });
                let _ = std::fs::remove_dir_all(&dir);
                // A clean read that comes out the same again has nothing to gain from more tries.
                let track = &result["tracks"][index];
                let clean = track["quality"]["skipped_sectors"].as_u64().unwrap_or(0) == 0
                    && track["quality"]["cache_errors"].as_u64().unwrap_or(0) == 0;
                if identical && clean {
                    break;
                }
            }
        }
        passes
    }

    /// Puts the MP3 of every track that is still damaged or suspect on the review list (Review > Flagged tracks) with what
    /// is wrong and where, so it is not forgotten and can be replaced later.
    fn flag_damaged_tracks(&self, result: &Value, metadata: &Value) {
        let health = &result["disc_health"];
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let flags = crate::flags::Flags::new(&self.data_dir);
        for entry in health["tracks"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|t| matches!(t["state"].as_str(), Some("damaged" | "suspect")))
        {
            let number = entry["number"].as_u64().unwrap_or(0);
            let Some(mp3) = result["mp3"]["tracks"]
                .as_array()
                .into_iter()
                .flatten()
                .find(|m| m["track"].as_u64() == Some(number) && m["ok"] == true)
            else {
                continue;
            };
            let Some(path) = mp3["path"].as_str() else {
                continue;
            };
            let note = format!(
                "Ripped from a damaged disc. {}",
                entry["reasons"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(Value::as_str)
                    .collect::<Vec<_>>()
                    .join(" ")
            );
            let args = json!({
                "flagged": true, "reasons": ["audio"], "note": note,
                "position_ms": entry["problem_span_ms"][0].as_u64(),
                "title": metadata["tracks"][number.to_string()]["title"], "artist": metadata["album_artist"], "album": metadata["album"],
            });
            let _ = flags.set(path, &args, now);
        }
    }
}
