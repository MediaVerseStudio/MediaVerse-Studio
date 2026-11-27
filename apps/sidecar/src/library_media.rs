//! Editing pictures and lyrics of MP3 files in the music library (the library repair page, D17).
//! Only files inside the library are touched, only MP3s with a tag this program can edit, and each
//! file is replaced atomically: the new file is written beside it, read back and compared (the audio
//! must be byte for byte unchanged and the tag must parse), and only then does it take the place of
//! the old one. A failure on one file never affects another, and is reported per file.

use crate::library_cover::{resolve_in_library, unbase64};
use mediaverse_ripper::id3::{self, LyricsChange, Picture, PictureChange, PictureKind, TagEdit};
use mediaverse_ripper::lrc;
use serde_json::{Value, json};
use std::io::Write;
use std::path::Path;

const MAX_FILES: usize = 1000;

fn kind_of(name: &str) -> Option<PictureKind> {
    match name {
        "front_cover" => Some(PictureKind::FrontCover),
        "back_cover" => Some(PictureKind::BackCover),
        "artist_photo" => Some(PictureKind::ArtistPhoto),
        _ => None,
    }
}

/// Reads the requested change from the request: `pictures: [{kind, data_base64 | null}]` and
/// `lyrics: {text} | {clear: true}`.
fn edit_from(args: &Value, single_file: bool) -> Result<TagEdit, String> {
    let mut edit = TagEdit::default();
    for item in args["pictures"].as_array().into_iter().flatten() {
        let kind = item["kind"]
            .as_str()
            .and_then(kind_of)
            .ok_or("A picture needs a kind: front_cover, back_cover or artist_photo.")?;
        match item["data_base64"].as_str() {
            Some(text) => {
                let data = unbase64(text).ok_or("A picture was not valid base64 data.")?;
                if let Some(problem) = crate::cover_art::song_picture_problem(&data) {
                    return Err(problem);
                }
                edit.pictures
                    .push(PictureChange::Set(Picture { kind, data }));
            }
            None => edit.pictures.push(PictureChange::Remove(kind)),
        }
    }
    if let Some(lyrics) = args.get("lyrics").filter(|l| l.is_object()) {
        if !single_file {
            return Err("Lyrics belong to one track; choose a single track.".to_owned());
        }
        if lyrics["clear"] == true {
            edit.lyrics = Some(LyricsChange::Remove);
        } else {
            let text = lyrics["text"].as_str().ok_or("The lyrics must be text.")?;
            let parsed = lrc::parse(text);
            if parsed.plain.trim().is_empty() {
                return Err("The lyrics contain no words.".to_owned());
            }
            edit.lyrics = Some(LyricsChange::Set {
                plain: parsed.plain,
                synced: parsed.synced,
            });
        }
    }
    if edit.pictures.is_empty() && edit.lyrics.is_none() {
        return Err("There is nothing to change.".to_owned());
    }
    Ok(edit)
}

fn apply_to_file(file: &Path, edit: &TagEdit) -> Result<(), String> {
    if !file
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("mp3"))
    {
        return Err("Only MP3 files can be edited here.".to_owned());
    }
    let old = std::fs::read(file).map_err(|e| format!("could not read the file: {e}"))?;
    let old_tag = if old.starts_with(b"ID3") {
        id3::tag_length(&old).map_err(|e| e.to_string())?
    } else {
        0
    };
    let tag = id3::edit_tag(&old, edit).map_err(|e| e.to_string())?;
    let mut new = tag;
    new.extend_from_slice(&old[old_tag..]);

    // Check before touching anything.
    let new_tag = id3::tag_length(&new).map_err(|e| e.to_string())?;
    id3::read_frames(&new).map_err(|e| e.to_string())?;
    if new[new_tag..] != old[old_tag..] {
        return Err("internal check failed: the audio would have changed".to_owned());
    }

    let temp = file.with_extension("mp3.mediaverse-tmp");
    let write = || -> std::io::Result<()> {
        let mut out = std::fs::File::create(&temp)?;
        out.write_all(&new)?;
        out.sync_all()
    };
    if let Err(problem) = write() {
        let _ = std::fs::remove_file(&temp);
        return Err(format!("could not write the new file: {problem}"));
    }
    if let Err(problem) = std::fs::rename(&temp, file) {
        let _ = std::fs::remove_file(&temp);
        return Err(format!(
            "could not replace the file (is it playing or open in another program?): {problem}"
        ));
    }
    let stored = std::fs::read(file).map_err(|e| format!("could not re-read the file: {e}"))?;
    if stored != new {
        return Err("the file on disk is not what was written; check it".to_owned());
    }
    Ok(())
}

/// Largest picture saved in an album folder: full-size scans and photos are welcome there.
const MAX_FOLDER_PICTURE_BYTES: usize = 40 * 1024 * 1024;

/// The file names a kind of picture has in an album folder: the name written, and the names that are replaced
/// (players read `cover`, `folder` and `front` as the album cover; Navidrome reads `artist` as the artist photo).
fn folder_names(kind: PictureKind) -> (&'static str, &'static [&'static str]) {
    match kind {
        PictureKind::FrontCover => ("cover", &["cover", "folder", "front"]),
        PictureKind::BackCover => ("back", &["back"]),
        PictureKind::ArtistPhoto => ("artist", &["artist"]),
    }
}

/// Moves a file into the app's backup folder for replaced pictures (never deleted), and notes where it came from.
/// Returns where it went.
fn back_up(file: &Path, backups: &Path) -> Result<std::path::PathBuf, String> {
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_nanos());
    std::fs::create_dir_all(backups)
        .map_err(|e| format!("could not make the backup folder: {e}"))?;
    let name = file
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_default();
    let target = backups.join(format!("{stamp}-{name}"));
    if std::fs::rename(file, &target).is_err() {
        std::fs::copy(file, &target).map_err(|e| format!("could not back up {name}: {e}"))?;
        std::fs::remove_file(file).map_err(|e| format!("could not move {name} aside: {e}"))?;
    }
    let mut manifest = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(backups.join("replaced.tsv"))
        .map_err(|e| e.to_string())?;
    writeln!(
        manifest,
        "{stamp}\t{}\t{}",
        file.display(),
        target.display()
    )
    .map_err(|e| e.to_string())?;
    Ok(target)
}

/// A batch id from the page: letters, digits and dashes only (it names a folder).
fn valid_batch(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

/**
 * The undo journal of one batch of picture changes (the library-wide "shrink pictures" tool): the pictures each
 * song had before (stored once each, by content), and the folder files moved aside or written. `undo_picture_batch`
 * reads it back. Kept in `<data>/picture-batches/<batch>`.
 */
struct Journal {
    dir: std::path::PathBuf,
    lines: std::fs::File,
}

impl Journal {
    fn open(data_dir: &Path, batch: &str) -> Result<Self, String> {
        if !valid_batch(batch) {
            return Err("The batch id is not valid.".to_owned());
        }
        let dir = data_dir.join("picture-batches").join(batch);
        std::fs::create_dir_all(&dir)
            .map_err(|e| format!("could not make the undo folder: {e}"))?;
        let lines = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(dir.join("journal.tsv"))
            .map_err(|e| e.to_string())?;
        Ok(Self { dir, lines })
    }

    fn line(&mut self, fields: &[&str]) -> Result<(), String> {
        writeln!(self.lines, "{}", fields.join("\t"))
            .map_err(|e| format!("could not write the undo journal: {e}"))
    }

    /// The picture of `kind` a song had before (`None`: it had none, so undo removes it).
    fn embedded(
        &mut self,
        file: &Path,
        kind: PictureKind,
        old: Option<&[u8]>,
    ) -> Result<(), String> {
        let name = match old {
            Some(bytes) => {
                // FNV-1a: the same picture on every song of an album is stored once.
                let hash = bytes.iter().fold(0xcbf2_9ce4_8422_2325u64, |h, b| {
                    (h ^ u64::from(*b)).wrapping_mul(0x0100_0000_01b3)
                });
                let name = format!("{hash:016x}-{}.bin", bytes.len());
                let path = self.dir.join(&name);
                if !path.is_file() {
                    std::fs::write(&path, bytes)
                        .map_err(|e| format!("could not keep the old picture: {e}"))?;
                }
                name
            }
            None => "-".to_owned(),
        };
        self.line(&[
            "embedded",
            &kind.id3_type().to_string(),
            &file.display().to_string(),
            &name,
        ])
    }
}

/// `undo_picture_batch {batch}`: every song gets back the pictures it had before the batch, the folder files the
/// batch wrote are removed and the ones it moved aside are put back. Returns `{songs, folder_files, problems}`.
pub fn undo_picture_batch(
    batch: &str,
    library_root: Option<&Path>,
    data_dir: &Path,
) -> Result<Value, String> {
    if !valid_batch(batch) {
        return Err("The batch id is not valid.".to_owned());
    }
    let dir = data_dir.join("picture-batches").join(batch);
    let text = std::fs::read_to_string(dir.join("journal.tsv"))
        .map_err(|_| "That change was not found, or was already undone.".to_owned())?;
    let mut songs: std::collections::BTreeMap<String, Vec<PictureChange>> =
        std::collections::BTreeMap::new();
    let mut problems = Vec::new();
    let mut folder_files = 0;
    // Folder files first, newest change last: written files go, moved files come back.
    for line in text.lines().rev() {
        let fields: Vec<&str> = line.split('\t').collect();
        match fields.as_slice() {
            ["written", target] => {
                let _ = std::fs::remove_file(target);
            }
            ["moved", original, backup] => match std::fs::rename(backup, original)
                .or_else(|_| std::fs::copy(backup, original).map(|_| ()))
            {
                Ok(()) => folder_files += 1,
                Err(e) => problems.push(
                    json!({ "path": original, "message": format!("could not put it back: {e}") }),
                ),
            },
            _ => {}
        }
    }
    for line in text.lines() {
        if let ["embedded", kind, path, name] = line.split('\t').collect::<Vec<_>>().as_slice() {
            let Some(kind) = kind.parse::<u8>().ok().and_then(PictureKind::from_id3_type) else {
                continue;
            };
            let change = if *name == "-" {
                PictureChange::Remove(kind)
            } else {
                match std::fs::read(dir.join(name)) {
                    Ok(data) => PictureChange::Restore(Picture { kind, data }),
                    Err(e) => {
                        problems.push(json!({ "path": path, "message": format!("the old picture is missing: {e}") }));
                        continue;
                    }
                }
            };
            songs.entry((*path).to_owned()).or_default().push(change);
        }
    }
    // Lyrics the batch added are removed again.
    let added_lyrics: std::collections::BTreeSet<String> = text
        .lines()
        .filter_map(|l| l.strip_prefix("lyrics_added\t"))
        .map(str::to_owned)
        .collect();
    for path in &added_lyrics {
        songs.entry(path.clone()).or_default();
    }
    let mut restored = 0;
    for (path, pictures) in songs {
        let lyrics = added_lyrics.contains(&path).then_some(LyricsChange::Remove);
        match resolve_in_library(&path, library_root)
            .and_then(|file| apply_to_file(&file, &TagEdit { pictures, lyrics }))
        {
            Ok(()) => restored += 1,
            Err(message) => problems.push(json!({ "path": path, "message": message })),
        }
    }
    // Timing the Lyric AI replaced comes back (the oldest record of a song first wins, so a song timed twice in one batch returns to how it was before the batch).
    let mut seen = std::collections::BTreeSet::new();
    for line in text.lines() {
        if let ["synced_replaced", path, name] = line.split('\t').collect::<Vec<_>>().as_slice() {
            if !seen.insert((*path).to_owned()) {
                continue;
            }
            let old = if *name == "-" {
                Ok(Vec::new())
            } else {
                std::fs::read_to_string(dir.join(name))
                    .map_err(|e| format!("the old timing is missing: {e}"))
                    .and_then(|t| synced_from_json(&t))
            };
            match old.and_then(|old| {
                resolve_in_library(path, library_root).and_then(|file| {
                    apply_to_file(
                        &file,
                        &TagEdit {
                            pictures: vec![],
                            lyrics: Some(LyricsChange::Synced(old)),
                        },
                    )
                })
            }) {
                Ok(()) => restored += 1,
                Err(message) => problems.push(json!({ "path": path, "message": message })),
            }
        }
    }
    if problems.is_empty() {
        let _ = std::fs::remove_dir_all(&dir);
    } else {
        let _ = std::fs::rename(dir.join("journal.tsv"), dir.join("journal.undone.tsv"));
    }
    Ok(json!({ "songs": restored, "folder_files": folder_files, "problems": problems }))
}

fn synced_to_json(lines: &[id3::SyncedLine]) -> String {
    json!(
        lines
            .iter()
            .map(|l| json!({ "ms": l.milliseconds, "text": l.text }))
            .collect::<Vec<_>>()
    )
    .to_string()
}

fn synced_from_json(text: &str) -> Result<Vec<id3::SyncedLine>, String> {
    let value: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
    Ok(value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| {
            Some(id3::SyncedLine {
                milliseconds: u32::try_from(l["ms"].as_u64()?).ok()?,
                text: l["text"].as_str()?.to_owned(),
            })
        })
        .collect())
}

/// Replaces only the synced (time-stamped) lyrics of one song (the Lyric AI's timing step, D169): the plain words stay exactly as they are. The old timing is
/// kept in the batch's journal, so Undo puts it back. `lines` are `(milliseconds, text)`.
pub fn set_synced_lyrics(
    path: &str,
    lines: &[(u32, String)],
    batch: &str,
    library_root: Option<&Path>,
    data_dir: &Path,
) -> Result<(), String> {
    let file = resolve_in_library(path, library_root)?;
    let mut journal = Journal::open(data_dir, batch)?;
    let bytes = std::fs::read(&file).map_err(|e| format!("could not read the file: {e}"))?;
    let old: Option<Vec<id3::SyncedLine>> = bytes
        .starts_with(b"ID3")
        .then(|| id3::read_frames(&bytes).ok())
        .flatten()
        .and_then(|frames| {
            frames
                .iter()
                .find(|f| f.id == "SYLT")
                .and_then(|f| id3::frame_synced(f).ok())
        });
    let name = match &old {
        Some(old) => {
            let name = format!(
                "synced-{:016x}.json",
                synced_to_json(old)
                    .bytes()
                    .fold(0xcbf2_9ce4_8422_2325u64, |h, b| (h ^ u64::from(b))
                        .wrapping_mul(0x0100_0000_01b3))
            );
            let target = journal.dir.join(&name);
            if !target.is_file() {
                std::fs::write(&target, synced_to_json(old))
                    .map_err(|e| format!("could not keep the old timing: {e}"))?;
            }
            name
        }
        None => "-".to_owned(),
    };
    journal.line(&["synced_replaced", &file.display().to_string(), &name])?;
    let synced = lines
        .iter()
        .map(|(ms, text)| id3::SyncedLine {
            milliseconds: *ms,
            text: text.clone(),
        })
        .collect();
    apply_to_file(
        &file,
        &TagEdit {
            pictures: vec![],
            lyrics: Some(LyricsChange::Synced(synced)),
        },
    )
}

/**
 * `folder_pictures: [{kind, data_base64}]`: the full-size picture saved in each album folder of the songs, as
 * `cover`, `back` or `artist` `.jpg`/`.png` (owner, 2026-11-05: high-resolution covers and photos are kept at their
 * native size in the album folder; the songs get a copy of at most 1000 pixels). The files they replace (also
 * `folder.jpg` and `front.jpg` for the cover) are moved to `<data>/replaced-pictures`, never deleted.
 */
fn save_folder_pictures(
    args: &Value,
    files: &[std::path::PathBuf],
    backups: &Path,
    mut journal: Option<&mut Journal>,
) -> Vec<Value> {
    let mut results = Vec::new();
    let folders: std::collections::BTreeSet<&Path> =
        files.iter().filter_map(|f| f.parent()).collect();
    for item in args["folder_pictures"].as_array().into_iter().flatten() {
        let outcome = (|| -> Result<Vec<String>, String> {
            let kind = item["kind"]
                .as_str()
                .and_then(kind_of)
                .ok_or("A folder picture needs a kind.")?;
            let data = item["data_base64"]
                .as_str()
                .and_then(unbase64)
                .ok_or("A folder picture was not valid base64 data.")?;
            let extension = match crate::library_cover::mime_of(&data) {
                Some("image/png") => "png",
                Some(_) => "jpg",
                None => return Err("A folder picture must be a JPEG or PNG.".to_owned()),
            };
            if data.len() > MAX_FOLDER_PICTURE_BYTES {
                return Err(format!(
                    "The picture is {} MB; the limit is {} MB.",
                    data.len() / (1024 * 1024),
                    MAX_FOLDER_PICTURE_BYTES / (1024 * 1024)
                ));
            }
            let (name, replaced) = folder_names(kind);
            let mut written = Vec::new();
            for folder in &folders {
                for old in replaced {
                    for ext in ["jpg", "jpeg", "png"] {
                        let candidate = folder.join(format!("{old}.{ext}"));
                        if candidate.is_file() {
                            let kept = back_up(&candidate, backups)?;
                            if let Some(journal) = journal.as_deref_mut() {
                                journal.line(&[
                                    "moved",
                                    &candidate.display().to_string(),
                                    &kept.display().to_string(),
                                ])?;
                            }
                        }
                    }
                }
                let target = folder.join(format!("{name}.{extension}"));
                let temp = folder.join(format!(".{name}.{extension}.mediaverse-tmp"));
                std::fs::write(&temp, &data)
                    .map_err(|e| format!("could not write {}: {e}", target.display()))?;
                std::fs::rename(&temp, &target).map_err(|e| {
                    let _ = std::fs::remove_file(&temp);
                    format!("could not save {}: {e}", target.display())
                })?;
                if let Some(journal) = journal.as_deref_mut() {
                    journal.line(&["written", &target.display().to_string()])?;
                }
                written.push(target.display().to_string());
            }
            Ok(written)
        })();
        results.push(match outcome {
            Ok(written) => json!({ "kind": item["kind"], "ok": true, "files": written }),
            Err(error) => json!({ "kind": item["kind"], "ok": false, "error": error }),
        });
    }
    results
}

/// `update_track_media {paths: [one], lyrics: {text}, keep_words: true, batch?}`: the song's own words (a band's, with its labels and layout) stay exactly as
/// they are and only the time-stamped copy is replaced by the times in `text` (approving a timing result in To review, D169). Journalled, so Undo puts the old timing back.
fn keep_words_timing(
    args: &Value,
    paths: &[&str],
    library_root: Option<&Path>,
    data_dir: &Path,
) -> Result<Value, String> {
    let [path] = paths else {
        return Err("Timing belongs to one track; choose a single track.".to_owned());
    };
    let text = args["lyrics"]["text"]
        .as_str()
        .ok_or("The lyrics must be text.")?;
    let lines: Vec<(u32, String)> = lrc::parse(text)
        .synced
        .into_iter()
        .map(|l| (l.milliseconds, l.text))
        .collect();
    if lines.is_empty() {
        return Err("There are no times to save.".to_owned());
    }
    let batch = args["batch"].as_str().unwrap_or("review-timing");
    let done = set_synced_lyrics(path, &lines, batch, library_root, data_dir);
    Ok(json!({
        "results": [match done {
            Ok(()) => json!({ "path": path, "ok": true }),
            Err(error) => json!({ "path": path, "ok": false, "error": error }),
        }],
        "folder": [],
    }))
}

/// `update_track_media {paths: [..], pictures: [..], folder_pictures: [..], lyrics: {..}, batch?}`. Returns
/// `{results: [{path, ok, error?}], folder: [{kind, ok, files | error}]}`. `data_dir`: where replaced folder pictures
/// are kept. With `batch`, everything changed is journalled so `undo_picture_batch` can put it back.
pub fn update_track_media(
    args: &Value,
    library_root: Option<&Path>,
    data_dir: &Path,
) -> Result<Value, String> {
    let paths: Vec<&str> = args["paths"]
        .as_array()
        .ok_or("''paths'' must be a list of files.")?
        .iter()
        .filter_map(Value::as_str)
        .collect();
    if paths.is_empty() || paths.len() > MAX_FILES {
        return Err(format!("Give between 1 and {MAX_FILES} files."));
    }
    if args["keep_words"] == true {
        return keep_words_timing(args, &paths, library_root, data_dir);
    }
    let has_folder_pictures = args["folder_pictures"]
        .as_array()
        .is_some_and(|a| !a.is_empty());
    let wants_edit = args["pictures"].as_array().is_some_and(|a| !a.is_empty())
        || args.get("lyrics").is_some_and(Value::is_object);
    // Only a folder picture is fine; otherwise a request with nothing to change is refused as before.
    let edit = if wants_edit || !has_folder_pictures {
        Some(edit_from(args, paths.len() == 1)?)
    } else {
        None
    };
    let mut journal = match args["batch"].as_str() {
        Some(batch) => Some(Journal::open(data_dir, batch)?),
        None => None,
    };
    let mut resolved = Vec::new();
    let mut results = Vec::new();
    for requested in &paths {
        let file = resolve_in_library(requested, library_root);
        if let Ok(file) = &file {
            resolved.push(file.clone());
        }
        let done = match (&edit, file) {
            (_, Err(error)) => Err(error),
            (Some(edit), Ok(file)) => (|| {
                if let Some(journal) = journal.as_mut() {
                    let before = crate::library_cover::embedded_pictures(&file);
                    for change in &edit.pictures {
                        let kind = match change {
                            PictureChange::Set(picture) | PictureChange::Restore(picture) => {
                                picture.kind
                            }
                            PictureChange::Remove(kind) => *kind,
                        };
                        // A front cover replaces a cover stored as type 0 ("Other") too; that is what undo puts back.
                        let old = before
                            .iter()
                            .find(|(k, _)| *k == kind.id3_type())
                            .or_else(|| {
                                (kind == PictureKind::FrontCover)
                                    .then(|| before.iter().find(|(k, _)| *k == id3::OTHER_PICTURE))
                                    .flatten()
                            })
                            .map(|(_, data)| data.as_slice());
                        journal.embedded(&file, kind, old)?;
                    }
                    // Lyrics in a batch (the automatic lyrics) only fill a song that has none, so undo removes them.
                    if let Some(LyricsChange::Set { synced, .. }) = &edit.lyrics {
                        let bytes = std::fs::read(&file)
                            .map_err(|e| format!("could not read the file: {e}"))?;
                        let has = bytes.starts_with(b"ID3")
                            && id3::read_frames(&bytes).is_ok_and(|f| {
                                f.iter().any(|fr| fr.id == "USLT" || fr.id == "SYLT")
                            });
                        if has {
                            // Timed lyrics with (nearly) the same words are already in the song (an earlier run wrote them, and a later run suggested them again, perhaps from another record):
                            // nothing to write, nothing to journal (undo must not remove lyrics this batch did not add), and the suggestion is settled.
                            let share = timed_lyrics_similarity(&bytes, synced);
                            if edit.pictures.is_empty()
                                && share.is_some_and(|s| s >= SAME_LYRICS_SHARE)
                            {
                                return Ok(());
                            }
                            return Err(match share {
                                Some(s) => format!(
                                    "this song already has different lyrics ({}% of the words match), so they were left as they are",
                                    (s * 100.0).round()
                                ),
                                None => {
                                    "this song already has lyrics, so they were left as they are"
                                        .to_owned()
                                }
                            });
                        }
                        journal.line(&["lyrics_added", &file.display().to_string()])?;
                    }
                }
                apply_to_file(&file, edit)
            })(),
            (None, Ok(_)) => Ok(()),
        };
        results.push(match done {
            Ok(()) => json!({ "path": requested, "ok": true }),
            Err(error) => json!({ "path": requested, "ok": false, "error": error }),
        });
    }
    let folder = save_folder_pictures(
        args,
        &resolved,
        &data_dir.join("replaced-pictures"),
        journal.as_mut(),
    );
    Ok(json!({ "results": results, "folder": folder }))
}

/// The words of timed lyrics, lower case, letters and digits only (spacing, punctuation and timing do not matter).
fn lyric_words(lines: &[id3::SyncedLine]) -> Vec<String> {
    lines
        .iter()
        .flat_map(|l| l.text.split(|c: char| !c.is_alphanumeric()))
        .filter(|w| !w.is_empty())
        .map(str::to_lowercase)
        .collect()
}

/// How much of the words are shared (0 to 1, twice the longest common run of words over both lengths) between the timed lyrics in the MP3's tag and `new`; `None` when the tag holds no timed lyrics.
fn timed_lyrics_similarity(mp3: &[u8], new: &[id3::SyncedLine]) -> Option<f64> {
    let frames = id3::read_frames(mp3).ok()?;
    let existing = frames
        .iter()
        .find(|f| f.id == "SYLT")
        .and_then(|f| id3::frame_synced(f).ok())
        .unwrap_or_default();
    if existing.is_empty() || new.is_empty() {
        return None;
    }
    Some(word_similarity(&lyric_words(&existing), &lyric_words(new)))
}

/// Twice the length of the longest common subsequence of words, over the two lengths together: 1 for the same words, 0 for none shared.
fn word_similarity(a: &[String], b: &[String]) -> f64 {
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    // Lyrics are a few hundred words; a song with thousands is not lyrics, so it is never "the same".
    if a.len() > 4000 || b.len() > 4000 {
        return 0.0;
    }
    let mut row = vec![0usize; b.len() + 1];
    for x in a {
        let mut diagonal = 0;
        for (j, y) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = if x == y {
                diagonal + 1
            } else {
                row[j + 1].max(row[j])
            };
            diagonal = above;
        }
    }
    2.0 * row[b.len()] as f64 / (a.len() + b.len()) as f64
}

/// A song already holding timed lyrics with at least this share of the words of the suggestion has them settled (a different LRCLIB record of the same song; a few words differ).
const SAME_LYRICS_SHARE: f64 = 0.9;

const MAX_LRC_BYTES: u64 = 1024 * 1024;

fn lines_json(lines: &[id3::SyncedLine]) -> Value {
    Value::Array(
        lines
            .iter()
            .map(|l| json!({ "ms": l.milliseconds, "text": l.text }))
            .collect(),
    )
}

/// `track_lyrics {path}`: the lyrics of a song, looked for in the order embedded tag, then a `.lrc` file with
/// the same name beside it. Returns `{plain, synced (bool), lines: [{ms, text}], source}`; everything is empty
/// (`source: null`) when there are none. Lyrics in a tag this program cannot read are reported as missing,
/// not as an error, because the `.lrc` file may still have them.
pub fn track_lyrics(requested: &str, library_root: Option<&Path>) -> Result<Value, String> {
    let file = resolve_in_library(requested, library_root)?;
    if file
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("mp3"))
    {
        let bytes = std::fs::read(&file).map_err(|e| format!("could not read the file: {e}"))?;
        if bytes.starts_with(b"ID3") {
            if let Ok(frames) = id3::read_frames(&bytes) {
                let plain = frames
                    .iter()
                    .find(|f| f.id == "USLT")
                    .and_then(|f| id3::frame_lyrics(f).ok());
                let lines = frames
                    .iter()
                    .find(|f| f.id == "SYLT")
                    .and_then(|f| id3::frame_synced(f).ok())
                    .unwrap_or_default();
                if plain.is_some() || !lines.is_empty() {
                    let plain_text = plain.or_else(|| {
                        Some(
                            lines
                                .iter()
                                .map(|l| l.text.clone())
                                .collect::<Vec<_>>()
                                .join("\n"),
                        )
                    });
                    return Ok(
                        json!({ "plain": plain_text, "synced": !lines.is_empty(), "lines": lines_json(&lines), "source": "tag" }),
                    );
                }
            }
        }
    }
    let beside = file.with_extension("lrc");
    if let Ok(meta) = std::fs::metadata(&beside) {
        if meta.is_file() && meta.len() <= MAX_LRC_BYTES {
            if let Ok(text) =
                std::fs::read(&beside).map(|b| String::from_utf8_lossy(&b).into_owned())
            {
                let parsed = lrc::parse(&text);
                if !parsed.plain.trim().is_empty() {
                    return Ok(
                        json!({ "plain": parsed.plain, "synced": !parsed.synced.is_empty(), "lines": lines_json(&parsed.synced), "source": "lrc_file" }),
                    );
                }
            }
        }
    }
    Ok(json!({ "plain": null, "synced": false, "lines": [], "source": null }))
}
#[cfg(test)]
mod tests {
    use super::*;
    use crate::library_cover::base64;
    use mediaverse_ripper::id3::TagSet;

    fn jpeg(fill: u8) -> Vec<u8> {
        let mut data = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 16];
        data.extend(std::iter::repeat_n(fill, 100));
        data.extend_from_slice(&[0xFF, 0xD9]);
        data
    }

    fn library(name: &str) -> (std::path::PathBuf, Vec<std::path::PathBuf>) {
        let root =
            std::env::temp_dir().join(format!("mv-media-edit-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(&root).unwrap();
        let files = (1..=2)
            .map(|n| {
                let mut bytes = id3::write_tag(&TagSet {
                    title: format!("Song {n}"),
                    ..TagSet::default()
                })
                .unwrap();
                bytes.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00, n, n, n, n]);
                let path = root.join(format!("{n:02}.mp3"));
                std::fs::write(&path, bytes).unwrap();
                path
            })
            .collect();
        (root, files)
    }

    #[test]
    fn a_png_or_an_oversize_picture_is_never_put_inside_a_song() {
        let sized = |width: u16| {
            let mut data = vec![0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08];
            data.extend_from_slice(&width.to_be_bytes());
            data.extend_from_slice(&width.to_be_bytes());
            data.extend([0u8; 10]);
            data.extend([0xFF, 0xD9]);
            data
        };
        let ask = |data: &[u8]| {
            edit_from(
                &json!({ "pictures": [{ "kind": "front_cover", "data_base64": base64(data) }] }),
                true,
            )
        };
        let mut png = vec![0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A];
        png.extend([0u8; 40]);
        assert!(ask(&png).unwrap_err().contains("not a PNG"));
        assert!(ask(&sized(1001)).unwrap_err().contains("1001 × 1001"));
        assert!(ask(&sized(1000)).is_ok());
    }
    #[test]
    fn a_picture_goes_onto_every_track_of_an_album_and_the_audio_is_untouched() {
        let (root, files) = library("album");
        let before: Vec<Vec<u8>> = files.iter().map(|f| std::fs::read(f).unwrap()).collect();
        let args = json!({
            "paths": files.iter().map(|f| f.to_str().unwrap()).collect::<Vec<_>>(),
            "pictures": [{ "kind": "front_cover", "data_base64": base64(&jpeg(4)) }, { "kind": "artist_photo", "data_base64": base64(&jpeg(5)) }],
        });
        let reply = update_track_media(&args, Some(&root), &root.join("data")).unwrap();
        assert!(
            reply["results"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r["ok"] == true),
            "{reply}"
        );
        for (file, old) in files.iter().zip(&before) {
            let now = std::fs::read(file).unwrap();
            let frames = id3::read_frames(&now).unwrap();
            assert_eq!(frames.iter().filter(|f| f.id == "APIC").count(), 2);
            assert_eq!(
                &now[id3::tag_length(&now).unwrap()..],
                &old[id3::tag_length(old).unwrap()..],
                "audio byte for byte"
            );
            assert!(!file.with_extension("mp3.mediaverse-tmp").exists());
        }
        // The cover command now finds it.
        assert_eq!(
            crate::library_cover::track_cover(files[0].to_str().unwrap(), Some(&root)).unwrap()["from"],
            "embedded"
        );
    }

    #[test]
    fn lyrics_are_set_read_back_and_cleared_for_one_track_only() {
        let (root, files) = library("lyrics");
        let one = files[0].to_str().unwrap();
        let set =
            json!({ "paths": [one], "lyrics": { "text": "[00:01.00]First\n[00:03.50]Second" } });
        assert_eq!(
            update_track_media(&set, Some(&root), &root.join("data")).unwrap()["results"][0]["ok"],
            true
        );
        let read = track_lyrics(one, Some(&root)).unwrap();
        assert_eq!(read["plain"], "First\nSecond");
        assert_eq!(read["synced"], true);
        assert_eq!(read["source"], "tag");
        assert_eq!(
            read["lines"],
            json!([{ "ms": 1000, "text": "First" }, { "ms": 3500, "text": "Second" }])
        );
        // Lyrics for several tracks at once are refused.
        let both = json!({ "paths": files.iter().map(|f| f.to_str().unwrap()).collect::<Vec<_>>(), "lyrics": { "text": "x" } });
        assert!(
            update_track_media(&both, Some(&root), &root.join("data"))
                .unwrap_err()
                .contains("one track")
        );
        assert!(
            update_track_media(
                &json!({ "paths": [one], "lyrics": { "text": "   " } }),
                Some(&root),
                &root.join("data")
            )
            .is_err()
        );
        let clear = json!({ "paths": [one], "lyrics": { "clear": true } });
        assert_eq!(
            update_track_media(&clear, Some(&root), &root.join("data")).unwrap()["results"][0]["ok"],
            true
        );
        assert_eq!(
            track_lyrics(one, Some(&root)).unwrap()["plain"],
            Value::Null
        );
    }

    #[test]
    fn an_lrc_file_beside_the_song_supplies_lyrics_when_the_tag_has_none() {
        let (root, files) = library("lrcfile");
        let song = files[1].to_str().unwrap();
        assert_eq!(
            track_lyrics(song, Some(&root)).unwrap()["source"],
            Value::Null
        );
        std::fs::write(
            files[1].with_extension("lrc"),
            "[ti:x]\n[00:02.00]Hello\n[00:05.00]World é\n",
        )
        .unwrap();
        let read = track_lyrics(song, Some(&root)).unwrap();
        assert_eq!(read["source"], "lrc_file");
        assert_eq!(read["synced"], true);
        assert_eq!(read["lines"][1], json!({ "ms": 5000, "text": "World é" }));
        std::fs::write(files[1].with_extension("lrc"), "just words\nmore words").unwrap();
        let plain = track_lyrics(song, Some(&root)).unwrap();
        assert_eq!(
            (plain["source"].clone(), plain["synced"].clone()),
            (json!("lrc_file"), json!(false))
        );
        std::fs::write(files[1].with_extension("lrc"), "  \n").unwrap();
        assert_eq!(
            track_lyrics(song, Some(&root)).unwrap()["source"],
            Value::Null
        );
    }

    #[test]
    fn bad_requests_and_outside_files_are_refused_per_file() {
        let (root, files) = library("bad");
        let outside =
            std::env::temp_dir().join(format!("mv-media-edit-outside-{}.mp3", std::process::id()));
        std::fs::write(&outside, b"\xFF\xFB\x90\x00").unwrap();
        let args = json!({ "paths": [files[0].to_str().unwrap(), outside.to_str().unwrap()], "pictures": [{ "kind": "back_cover", "data_base64": base64(&jpeg(1)) }] });
        let reply = update_track_media(&args, Some(&root), &root.join("data")).unwrap();
        assert_eq!(reply["results"][0]["ok"], true);
        assert_eq!(reply["results"][1]["ok"], false);
        assert!(
            reply["results"][1]["error"]
                .as_str()
                .unwrap()
                .contains("outside")
        );
        assert_eq!(
            std::fs::read(&outside).unwrap(),
            b"\xFF\xFB\x90\x00",
            "the outside file is untouched"
        );

        let one = files[1].to_str().unwrap();
        for bad in [
            json!({ "paths": [one], "pictures": [{ "kind": "poster", "data_base64": base64(&jpeg(1)) }] }),
            json!({ "paths": [one], "pictures": [{ "kind": "front_cover", "data_base64": "!!!" }] }),
            json!({ "paths": [one] }),
            json!({ "paths": [] , "pictures": [{ "kind": "front_cover", "data_base64": null }] }),
        ] {
            assert!(
                update_track_media(&bad, Some(&root), &root.join("data")).is_err(),
                "{bad}"
            );
        }
        // Not an image: reported for that file, the file keeps its old tag.
        let not_image = json!({ "paths": [one], "pictures": [{ "kind": "front_cover", "data_base64": base64(b"hello world") }] });
        let reply = update_track_media(&not_image, Some(&root), &root.join("data")).unwrap();
        assert_eq!(reply["results"][0]["ok"], false);
        assert!(
            id3::read_frames(&std::fs::read(one).unwrap())
                .unwrap()
                .iter()
                .all(|f| f.id != "APIC")
        );
        // A non-MP3 file in the library is refused.
        let flac = root.join("x.flac");
        std::fs::write(&flac, b"fLaC").unwrap();
        let reply = update_track_media(&json!({ "paths": [flac.to_str().unwrap()], "pictures": [{ "kind": "front_cover", "data_base64": base64(&jpeg(1)) }] }), Some(&root), &root.join("data")).unwrap();
        assert_eq!(reply["results"][0]["ok"], false);
    }

    #[test]
    fn a_full_size_picture_goes_in_the_album_folder_and_the_files_it_replaces_are_kept() {
        let (root, files) = library("folderpics");
        std::fs::write(root.join("folder.jpg"), jpeg(1)).unwrap();
        std::fs::write(
            root.join("back.png"),
            [0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A],
        )
        .unwrap();
        let data = root.join("data");
        let big = jpeg(9);
        let args = json!({
            "paths": [files[0].to_str().unwrap(), files[1].to_str().unwrap()],
            "pictures": [{ "kind": "front_cover", "data_base64": base64(&jpeg(4)) }],
            "folder_pictures": [{ "kind": "front_cover", "data_base64": base64(&big) }],
        });
        let reply = update_track_media(&args, Some(&root), &data).unwrap();
        assert_eq!(reply["folder"][0]["ok"], true, "{reply}");
        assert_eq!(
            std::fs::read(root.join("cover.jpg")).unwrap(),
            big,
            "the full-size picture, once per folder"
        );
        assert!(
            !root.join("folder.jpg").exists(),
            "the old cover is moved aside"
        );
        assert!(root.join("back.png").exists(), "other kinds are left alone");
        let kept: Vec<_> = std::fs::read_dir(data.join("replaced-pictures"))
            .unwrap()
            .map(|e| e.unwrap().file_name().to_string_lossy().into_owned())
            .collect();
        assert!(
            kept.iter().any(|n| n.ends_with("-folder.jpg"))
                && kept.iter().any(|n| n == "replaced.tsv"),
            "{kept:?}"
        );
        assert!(
            reply["results"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r["ok"] == true),
            "the songs got the small copy"
        );

        // Only a folder picture (no change to the songs) is fine too; a non-image is refused.
        let only = json!({ "paths": [files[0].to_str().unwrap()], "folder_pictures": [{ "kind": "artist_photo", "data_base64": base64(&jpeg(2)) }] });
        assert_eq!(
            update_track_media(&only, Some(&root), &data).unwrap()["folder"][0]["ok"],
            true
        );
        assert!(root.join("artist.jpg").exists());
        let junk = json!({ "paths": [files[0].to_str().unwrap()], "folder_pictures": [{ "kind": "back_cover", "data_base64": base64(b"GIF89a") }] });
        assert_eq!(
            update_track_media(&junk, Some(&root), &data).unwrap()["folder"][0]["ok"],
            false
        );
    }

    #[test]
    fn a_batch_of_picture_changes_can_be_undone() {
        let (root, files) = library("undo");
        let data = root.join("data");
        let old_cover = jpeg(3);
        let one = json!({ "paths": [files[0].to_str().unwrap()], "pictures": [{ "kind": "front_cover", "data_base64": base64(&old_cover) }] });
        update_track_media(&one, Some(&root), &data).unwrap();
        std::fs::write(root.join("cover.jpg"), jpeg(7)).unwrap();
        let before: Vec<Vec<u8>> = files.iter().map(|f| std::fs::read(f).unwrap()).collect();

        // The batch: a new front cover on both songs (one had one, one had none), a full-size copy in the folder.
        let batch = json!({
            "paths": [files[0].to_str().unwrap(), files[1].to_str().unwrap()], "batch": "b-1",
            "pictures": [{ "kind": "front_cover", "data_base64": base64(&jpeg(5)) }],
            "folder_pictures": [{ "kind": "front_cover", "data_base64": base64(&jpeg(6)) }],
        });
        let reply = update_track_media(&batch, Some(&root), &data).unwrap();
        assert!(
            reply["results"]
                .as_array()
                .unwrap()
                .iter()
                .all(|r| r["ok"] == true),
            "{reply}"
        );
        assert_eq!(std::fs::read(root.join("cover.jpg")).unwrap(), jpeg(6));

        let undone = undo_picture_batch("b-1", Some(&root), &data).unwrap();
        assert_eq!(
            (undone["songs"].as_u64(), undone["folder_files"].as_u64()),
            (Some(2), Some(1)),
            "{undone}"
        );
        let after: Vec<Vec<u8>> = files.iter().map(|f| std::fs::read(f).unwrap()).collect();
        assert_eq!(
            crate::library_cover::embedded_pictures(&files[0]),
            vec![(3, old_cover)],
            "the old cover is back"
        );
        assert!(
            crate::library_cover::embedded_pictures(&files[1]).is_empty(),
            "a song that had none has none again"
        );
        assert_eq!(after[1], before[1], "byte for byte as before");
        assert_eq!(
            std::fs::read(root.join("cover.jpg")).unwrap(),
            jpeg(7),
            "the folder's own cover is back"
        );
        assert!(
            undo_picture_batch("b-1", Some(&root), &data).is_err(),
            "undone once"
        );
        assert!(undo_picture_batch("../x", Some(&root), &data).is_err());
    }

    #[test]
    fn suggesting_the_same_timed_lyrics_again_is_settled_without_a_write_or_an_undo_entry() {
        let (root, files) = library("lyricsagain");
        let data = root.join("data");
        let one = |text: &str, batch: &str| {
            let args = json!({ "paths": [files[0].to_str().unwrap()], "lyrics": { "text": text }, "batch": batch });
            update_track_media(&args, Some(&root), &data).unwrap()["results"][0].clone()
        };
        assert_eq!(
            one("[00:01.00]Hello there\n[00:05.00]General Kenobi", "first")["ok"],
            true
        );
        let written = std::fs::read(&files[0]).unwrap();
        // The same words, other timing and spelling of the case: nothing to do, and no change to the file.
        let again = one(
            "[00:02.50]hello there,\n[00:06.00]General KENOBI!",
            "second",
        );
        assert_eq!(again["ok"], true, "{again}");
        assert_eq!(std::fs::read(&files[0]).unwrap(), written);
        // Undoing the second batch must not take the first batch's lyrics away.
        let _ = undo_picture_batch("second", Some(&root), &data);
        assert_eq!(
            track_lyrics(files[0].to_str().unwrap(), Some(&root)).unwrap()["synced"],
            true
        );
        // Different words are still refused.
        let other = one("[00:01.00]Something else entirely", "third");
        assert_eq!(other["ok"], false);
    }

    #[test]
    fn another_record_of_the_same_song_is_settled_but_other_lyrics_are_refused_with_the_share() {
        let (root, files) = library("lyricsnear");
        let data = root.join("data");
        let one = |text: &str, batch: &str| {
            let args = json!({ "paths": [files[0].to_str().unwrap()], "lyrics": { "text": text }, "batch": batch });
            update_track_media(&args, Some(&root), &data).unwrap()["results"][0].clone()
        };
        let base = "[00:01.00]one two three four five\n[00:05.00]six seven eight nine ten";
        assert_eq!(one(base, "first")["ok"], true);
        let written = std::fs::read(&files[0]).unwrap();
        // One word of ten differs (90% shared): the same song from another record.
        let near = one(
            "[00:01.00]one two three four five\n[00:05.00]six seven eight nine eleven",
            "second",
        );
        assert_eq!(near["ok"], true, "{near}");
        assert_eq!(std::fs::read(&files[0]).unwrap(), written);
        // Half the words differ: refused, and the message says how much matches.
        let far = one(
            "[00:01.00]one two three four five\n[00:05.00]a b c d e",
            "third",
        );
        assert_eq!(far["ok"], false);
        let why = far["error"].as_str().unwrap();
        assert!(why.contains("50% of the words match"), "{why}");
    }

    #[test]
    fn word_similarity_counts_shared_words_in_order() {
        let w = |s: &str| -> Vec<String> { s.split(' ').map(str::to_owned).collect() };
        assert_eq!(word_similarity(&w("a b c"), &w("a b c")), 1.0);
        assert_eq!(word_similarity(&w("a b c"), &w("x y z")), 0.0);
        assert_eq!(word_similarity(&w("a b c d"), &w("a c d")), 6.0 / 7.0);
        assert_eq!(word_similarity(&w("a b"), &[]), 0.0);
    }

    #[test]
    fn lyrics_filled_in_a_batch_can_be_undone_and_never_replace_lyrics() {
        let (root, files) = library("lyricsbatch");
        let data = root.join("data");
        let one = |path: &std::path::Path, text: &str, batch: Option<&str>| {
            let mut args = json!({ "paths": [path.to_str().unwrap()], "lyrics": { "text": text } });
            if let Some(batch) = batch {
                args["batch"] = json!(batch);
            }
            update_track_media(&args, Some(&root), &data).unwrap()["results"][0].clone()
        };
        assert_eq!(
            one(&files[1], "Old words", None)["ok"],
            true,
            "the second song already has lyrics"
        );
        let before = std::fs::read(&files[0]).unwrap();
        assert_eq!(
            one(&files[0], "[00:01.00]New words", Some("lyr-1"))["ok"],
            true
        );
        let refused = one(&files[1], "Other words", Some("lyr-1"));
        assert_eq!(refused["ok"], false);
        assert!(
            refused["error"]
                .as_str()
                .unwrap()
                .contains("already has lyrics")
        );
        assert_eq!(
            track_lyrics(files[0].to_str().unwrap(), Some(&root)).unwrap()["plain"],
            "New words"
        );

        let undone = undo_picture_batch("lyr-1", Some(&root), &data).unwrap();
        assert_eq!(undone["songs"], 1, "{undone}");
        assert_eq!(
            track_lyrics(files[0].to_str().unwrap(), Some(&root)).unwrap()["plain"],
            Value::Null
        );
        assert_eq!(
            std::fs::read(&files[0]).unwrap().len(),
            before.len(),
            "back to a song without lyrics"
        );
        assert_eq!(
            track_lyrics(files[1].to_str().unwrap(), Some(&root)).unwrap()["plain"],
            "Old words",
            "untouched"
        );
    }

    #[test]
    fn timing_replaces_only_the_synced_lyrics_and_undo_puts_the_old_timing_back() {
        let (root, files) = library("timingbatch");
        let data = root.join("data");
        let path = files[0].to_str().unwrap();
        let first = json!({ "paths": [path], "lyrics": { "text": "[00:01.00]Hey ho\n[00:03.00]Let's go" } });
        update_track_media(&first, Some(&root), &data).unwrap();
        // the band's own words, with a label, in the plain lyrics
        let plain = "[Chorus]\nHey ho (x2)\nLet's go";
        let mut bytes = std::fs::read(&files[0]).unwrap();
        let tag = id3::edit_tag(
            &bytes,
            &TagEdit {
                pictures: vec![],
                lyrics: Some(LyricsChange::Set {
                    plain: plain.to_owned(),
                    synced: vec![id3::SyncedLine {
                        milliseconds: 1000,
                        text: "Hey ho".to_owned(),
                    }],
                }),
            },
        )
        .unwrap();
        let old_tag = id3::tag_length(&bytes).unwrap();
        bytes.splice(..old_tag, tag);
        std::fs::write(&files[0], bytes).unwrap();

        set_synced_lyrics(
            path,
            &[(2500, "Hey ho".to_owned()), (4000, "Let's go".to_owned())],
            "time-1",
            Some(&root),
            &data,
        )
        .unwrap();
        let now = track_lyrics(path, Some(&root)).unwrap();
        assert_eq!(now["plain"], plain, "the words and labels are untouched");
        assert_eq!(now["lines"][0]["ms"], 2500);
        assert_eq!(now["lines"].as_array().unwrap().len(), 2);

        let undone = undo_picture_batch("time-1", Some(&root), &data).unwrap();
        assert_eq!(undone["songs"], 1, "{undone}");
        let back = track_lyrics(path, Some(&root)).unwrap();
        assert_eq!(back["plain"], plain);
        assert_eq!(back["lines"].as_array().unwrap().len(), 1);
        assert_eq!(back["lines"][0]["ms"], 1000);
    }

    #[test]
    fn approving_a_timing_result_keeps_the_songs_own_words() {
        let (root, files) = library("keepwords");
        let data = root.join("data");
        let path = files[0].to_str().unwrap();
        // The band's words, with a label, and no times yet.
        let plain = "[Chorus]\nHey ho (x2)\nLet's go";
        let mut bytes = std::fs::read(&files[0]).unwrap();
        let tag = id3::edit_tag(
            &bytes,
            &TagEdit {
                pictures: vec![],
                lyrics: Some(LyricsChange::Set {
                    plain: plain.to_owned(),
                    synced: vec![],
                }),
            },
        )
        .unwrap();
        let old_tag = id3::tag_length(&bytes).unwrap();
        bytes.splice(..old_tag, tag);
        std::fs::write(&files[0], bytes).unwrap();

        let args = json!({ "paths": [path], "lyrics": { "text": "[00:02.50]Hey ho\n[00:04.00]Let's go" }, "keep_words": true, "batch": "keep-1" });
        let reply = update_track_media(&args, Some(&root), &data).unwrap();
        assert_eq!(reply["results"][0]["ok"], true, "{reply}");
        let now = track_lyrics(path, Some(&root)).unwrap();
        assert_eq!(
            now["plain"], plain,
            "the band's words and label are untouched"
        );
        assert_eq!(now["lines"][0]["ms"], 2500);

        let two = json!({ "paths": [path, files[1].to_str().unwrap()], "lyrics": { "text": "[00:01.00]x" }, "keep_words": true });
        assert!(
            update_track_media(&two, Some(&root), &data).is_err(),
            "timing belongs to one song"
        );
        let none =
            json!({ "paths": [path], "lyrics": { "text": "no times here" }, "keep_words": true });
        assert!(update_track_media(&none, Some(&root), &data).is_err());
    }
}
