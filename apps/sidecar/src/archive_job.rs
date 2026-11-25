//! The Media Library Archive step of a rip (ADR 0005, decision D3): turns the verified WAV files
//! from the helper into tagged FLAC masters in the archive folder.
//!
//! For each track: read the WAV, encode to FLAC and prove it decodes back to the same samples,
//! add the tags to the encoded bytes and prove again, write the result to a new file (never
//! overwriting), then decode the file from disk once more to prove what was stored is intact. A track that fails any step leaves no file behind,
//! and its failure is reported without stopping the others. Tracks that did not match AccurateRip
//! are still archived but flagged as unverified.

use crate::cover_art::CoverImage;
use mediaverse_ripper::archive::{ArchiveTrack, track_path, validate_locations, write_new_file};
use mediaverse_ripper::{flac, wav};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub struct ArchiveOutcome {
    /// One entry per track: `{track, ok, path?, bytes?, error?}`.
    pub entries: Vec<Value>,
    pub warnings: Vec<String>,
    /// What happened to the cover image, when there was one: `{ok, path | error, ...}`.
    pub cover: Option<Value>,
}

/// Turns a lookup result (one of the `candidates[].album` objects from `lookup_disc`) into the
/// `metadata` shape the archive step uses. The caller passes a candidate only after the user chose
/// it, so nothing is written from a guess. Rejects a candidate that has no album, no artist or no
/// tracks, because blank or generic tags are worse than none.
pub fn metadata_from_candidate(candidate: &Value) -> Result<Value, String> {
    let album = text(candidate, "album").ok_or("The chosen album has no title.")?;
    let album_artist = text(candidate, "album_artist").ok_or("The chosen album has no artist.")?;
    let tracks = candidate["tracks"]
        .as_array()
        .filter(|t| !t.is_empty())
        .ok_or("The chosen album lists no tracks.")?;
    let mut per_track = serde_json::Map::new();
    for track in tracks {
        let number = track["number"]
            .as_u64()
            .ok_or("A track in the chosen album has no number.")?;
        let title = text(track, "title").map(str::to_owned).unwrap_or_default();
        per_track.insert(number.to_string(), json!({ "title": title, "artist": text(track, "artist"), "lyrics": text(track, "lyrics") }));
    }
    Ok(json!({
        "album": album,
        "album_artist": album_artist,
        "genre": text(candidate, "genre"),
        "release_year": candidate["year"],
        "tracks": per_track,
        "track_total": tracks.len(),
        "disc_number": candidate["disc_number"],
        "disc_count": candidate["disc_count"],
        "compilation": candidate["compilation"] == true,
        "cover_art_release": text(candidate, "cover_art_release"),
        "source": text(candidate, "source"),
    }))
}

fn text<'a>(value: &'a Value, key: &str) -> Option<&'a str> {
    value
        .get(key)
        .and_then(Value::as_str)
        .map(str::trim)
        .filter(|s| !s.is_empty())
}

/// Archives every ripped track listed in `rip` (the helper's result). `metadata` may hold
/// `album_artist`, `album`, `artist`, `genre`, `release_year` and `tracks: {"5": {title, artist}}`.
pub fn archive_tracks(
    rip: &Value,
    archive_dir: &Path,
    library_dir: Option<&Path>,
    metadata: &Value,
    cover: Option<&CoverImage>,
    progress: &mut dyn FnMut(u8, usize, usize),
) -> ArchiveOutcome {
    let mut outcome = ArchiveOutcome {
        entries: Vec::new(),
        warnings: Vec::new(),
        cover: None,
    };

    // The settings were checked when saved, but the library folder may have changed since.
    if let Some(library) = library_dir
        && let Err(problem) = validate_locations(library, archive_dir)
    {
        outcome
            .warnings
            .push(format!("No FLAC masters were saved: {problem}"));
        return outcome;
    }

    let reports = rip["tracks"].as_array().cloned().unwrap_or_default();
    let files = rip["files"].as_array().cloned().unwrap_or_default();
    let album_artist = text(metadata, "album_artist")
        .or_else(|| text(metadata, "artist"))
        .unwrap_or("Unknown Artist");
    let album = text(metadata, "album").unwrap_or("Unknown Album");
    let mut album_dir: Option<PathBuf> = None;

    for (index, report) in reports.iter().enumerate() {
        let number = report["number"].as_u64().unwrap_or(0) as u8;
        progress(number, index, reports.len());
        let wav_path = files.get(index).and_then(Value::as_str).unwrap_or_default();

        let per_track = &metadata["tracks"][number.to_string()];
        let title = match text(per_track, "title") {
            Some(title) => title.to_owned(),
            None => {
                outcome.warnings.push(format!("Track {number} has no title in the chosen details, so it was saved as \"Track {number:02}\"."));
                format!("Track {number:02}")
            }
        };
        let artist = text(per_track, "artist")
            .or_else(|| text(metadata, "artist"))
            .unwrap_or(album_artist);
        let title = flac::clean_tag_value(&title);
        let (artist, album, album_artist) = (
            flac::clean_tag_value(artist),
            flac::clean_tag_value(album),
            flac::clean_tag_value(album_artist),
        );
        let genre = text(metadata, "genre")
            .map(flac::clean_tag_value)
            .filter(|g| !g.is_empty());
        let number_text = number.to_string();
        let total_text = metadata["track_total"].as_u64().map(|n| n.to_string());
        let disc_text = metadata["disc_number"].as_u64().map(|n| n.to_string());
        let disc_total_text = metadata["disc_count"].as_u64().map(|n| n.to_string());
        let year_text = metadata["release_year"]
            .as_u64()
            .map(|year| year.to_string());
        // The MusicBrainz recording id and AcoustID, when the audio check was sure of this track (Picard's Vorbis names).
        let recording_id = crate::audio_check::tag_id(per_track, "recording_id");
        let acoustid_id = crate::audio_check::tag_id(per_track, "acoustid_id");
        let mut tags: Vec<(&str, &str)> = vec![
            ("TITLE", title.as_str()),
            ("ARTIST", artist.as_str()),
            ("ALBUM", album.as_str()),
            ("ALBUMARTIST", album_artist.as_str()),
            ("TRACKNUMBER", number_text.as_str()),
        ];
        if let Some(total) = total_text.as_deref() {
            tags.push(("TRACKTOTAL", total));
        }
        if let Some(disc) = disc_text.as_deref() {
            tags.push(("DISCNUMBER", disc));
        }
        if let Some(total) = disc_total_text.as_deref() {
            tags.push(("DISCTOTAL", total));
        }
        if metadata["compilation"] == true {
            tags.push(("COMPILATION", "1"));
        }
        if let Some(genre) = genre.as_deref() {
            tags.push(("GENRE", genre));
        }
        if let Some(year) = year_text.as_deref() {
            tags.push(("DATE", year));
        }
        if let Some(id) = recording_id.as_deref() {
            tags.push(("MUSICBRAINZ_TRACKID", id));
        }
        if let Some(id) = acoustid_id.as_deref() {
            tags.push(("ACOUSTID_ID", id));
        }
        let destination = track_path(
            archive_dir,
            &ArchiveTrack {
                album_artist: &album_artist,
                album: &album,
                track_number: u32::from(number),
                title: &title,
            },
        );

        match archive_one(Path::new(wav_path), &destination, &tags) {
            Ok(bytes) => {
                album_dir = album_dir.or_else(|| destination.parent().map(Path::to_path_buf));
                outcome.entries.push(json!({
                    "track": number, "ok": true, "path": destination.to_string_lossy(), "bytes": bytes,
                    "checked": "decoded back identical to the ripped audio, before and after tagging",
                }));
                if report["verification"]["kind"] != "matched" {
                    outcome.warnings.push(format!(
                        "Track {number} was saved to the archive but is not verified against AccurateRip."
                    ));
                }
            }
            Err(message) => {
                // The album folder exists if an earlier rip put masters there; the cover and the log
                // belong in it even though this track was not written again.
                if album_dir.is_none() && destination.parent().is_some_and(Path::is_dir) {
                    album_dir = destination.parent().map(Path::to_path_buf);
                }
                outcome
                    .entries
                    .push(json!({ "track": number, "ok": false, "error": message }));
                outcome.warnings.push(format!(
                    "Track {number} was not saved to the archive: {message}"
                ));
            }
        }
    }
    progress(0, reports.len(), reports.len());

    // The cover goes beside the masters as an ordinary file, written exactly as received.
    if let (Some(dir), Some(image)) = (album_dir.as_ref(), cover) {
        let path = dir.join(format!("cover.{}", image.info.kind.extension()));
        outcome.cover = Some(match write_new_file(&path, &image.bytes) {
            Ok(()) => {
                if image.info.progressive {
                    outcome.warnings.push("The cover is a progressive JPEG; some older players and car stereos cannot show those.".to_owned());
                }
                json!({ "ok": true, "path": path.to_string_lossy(), "width": image.info.width, "height": image.info.height, "bytes": image.bytes.len() })
            }
            Err(e) if e.kind() == std::io::ErrorKind::AlreadyExists => {
                json!({ "ok": false, "skipped": true, "error": format!("{} already exists and was left untouched", path.display()) })
            }
            Err(e) => {
                outcome
                    .warnings
                    .push(format!("The cover could not be saved: {e}"));
                json!({ "ok": false, "error": e.to_string() })
            }
        });
    }

    // Keep the rip log next to the masters, without replacing one from an earlier rip.
    if let Some(dir) = album_dir {
        let log = serde_json::to_vec_pretty(rip).unwrap_or_default();
        let disc = rip["disc"].as_str().unwrap_or("disc");
        let first = dir.join("rip-log.json");
        let second = dir.join(format!("rip-log-{disc}.json"));
        let written = write_new_file(&first, &log).or_else(|_| write_new_file(&second, &log));
        if let Err(problem) = written {
            outcome.warnings.push(format!(
                "The rip log could not be saved to the archive: {problem}"
            ));
        }
    }
    outcome
}

/// Encodes one track and returns the size of the finished file, or why it could not be made.
fn archive_one(wav_path: &Path, destination: &Path, tags: &[(&str, &str)]) -> Result<u64, String> {
    let wav_bytes =
        std::fs::read(wav_path).map_err(|e| format!("could not read the ripped audio: {e}"))?;
    let samples =
        wav::read_wav(&wav_bytes).map_err(|e| format!("the ripped audio is not usable: {e}"))?;
    let encoded = flac::encode_verified(&samples).map_err(|e| e.to_string())?;
    let flac_bytes = flac::with_vorbis_comments(&encoded, tags).map_err(|e| e.to_string())?;
    flac::check_master_with_tags(&flac_bytes, &samples, tags)
        .map_err(|e| format!("after tagging, {e}"))?;

    write_new_file(destination, &flac_bytes).map_err(|e| match e.kind() {
        std::io::ErrorKind::AlreadyExists => {
            format!(
                "{} already exists and was left untouched",
                destination.display()
            )
        }
        _ => format!("could not write {}: {e}", destination.display()),
    })?;

    // The file now exists, so any failure from here on must remove it rather than leave a bad master.
    let finish = || -> Result<u64, String> {
        let on_disk =
            std::fs::read(destination).map_err(|e| format!("could not re-read the file: {e}"))?;
        flac::check_master_with_tags(&on_disk, &samples, tags)
            .map_err(|e| format!("the stored file is damaged: {e}"))?;
        Ok(on_disk.len() as u64)
    };
    finish().inspect_err(|_| {
        let _ = std::fs::remove_file(destination);
    })
}
