//! Renaming an artist across the library (D97): every song whose Artist or Album artist tag is one of the spellings
//! given ("A.F.I.", "AFI ") gets the chosen spelling ("AFI"). Only whole values that equal a given spelling are
//! changed, so "AFI & Friends" is never touched, and nothing else in a file changes. Each song is rewritten the
//! way Fix tags writes (a copy is made, read back and compared before it replaces the file), and every old value is
//! journalled in `<data>/artist-rename-batches/<batch>/journal.jsonl`, so `undo_artist_rename` can put it back.

use crate::library_cover::resolve_in_library;
use mediaverse_metadata_tags::{TagField, patch_track_metadata, read_track_metadata};
use serde_json::{Value, json};
use std::io::Write;
use std::path::{Path, PathBuf};

const MAX_FILES: usize = 20_000;

/// A batch id from the page: letters, digits and dashes only (it names a folder).
fn valid_batch(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn batch_dir(data_dir: &Path, batch: &str) -> PathBuf {
    data_dir.join("artist-rename-batches").join(batch)
}

/// `rename_artist {paths, from: [..], to, batch}`. Returns `{songs, fields, unchanged, problems: [{path, message}]}`.
/// `songs`: how many files were rewritten; `unchanged`: files that had none of the spellings (the page may have been
/// out of date) or already had the new one.
pub fn rename_artist(
    args: &Value,
    library_root: Option<&Path>,
    data_dir: &Path,
) -> Result<Value, String> {
    let paths: Vec<&str> = args["paths"]
        .as_array()
        .ok_or("'paths' must be a list of files.")?
        .iter()
        .filter_map(Value::as_str)
        .collect();
    if paths.is_empty() || paths.len() > MAX_FILES {
        return Err(format!("Give between 1 and {MAX_FILES} files."));
    }
    let to = args["to"]
        .as_str()
        .map(str::trim)
        .filter(|t| !t.is_empty())
        .ok_or("The new name must not be empty.")?;
    if to.chars().any(char::is_control) {
        return Err("The new name must be plain text on one line.".to_owned());
    }
    let from: Vec<&str> = args["from"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(Value::as_str)
        .filter(|f| !f.trim().is_empty() && *f != to)
        .collect();
    if from.is_empty() {
        return Err("Give at least one spelling to change.".to_owned());
    }
    let batch = args["batch"]
        .as_str()
        .filter(|b| valid_batch(b))
        .ok_or("The batch id is not valid.")?;
    let dir = batch_dir(data_dir, batch);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make the undo folder: {e}"))?;
    let mut journal = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("journal.jsonl"))
        .map_err(|e| e.to_string())?;

    let (mut songs, mut fields, mut unchanged) = (0usize, 0usize, 0usize);
    let mut problems = Vec::new();
    for requested in paths {
        let outcome = (|| -> Result<usize, String> {
            let file = resolve_in_library(requested, library_root)?;
            let now = read_track_metadata(&file).map_err(|e| e.to_string())?;
            let mut changes = Vec::new();
            for (field, value) in [
                (TagField::Artist, &now.artist),
                (TagField::AlbumArtist, &now.album_artist),
            ] {
                // Compared without regard to spaces at either end, so "AFI " is a spelling of "AFI" that can be corrected.
                if value
                    .as_deref()
                    .is_some_and(|v| v != to && from.iter().any(|f| f.trim() == v.trim()))
                {
                    changes.push((field, Some(to.to_owned())));
                }
            }
            if changes.is_empty() {
                return Ok(0);
            }
            let before = patch_track_metadata(&file, &changes).map_err(|e| e.to_string())?;
            for (field, old) in before {
                let line = json!({ "path": file.display().to_string(), "field": field.name(), "old": old, "new": to });
                writeln!(journal, "{line}").map_err(|e| {
                    format!("the change was written but could not be journalled: {e}")
                })?;
            }
            Ok(changes.len())
        })();
        match outcome {
            Ok(0) => unchanged += 1,
            Ok(count) => {
                songs += 1;
                fields += count;
            }
            Err(message) => problems.push(json!({ "path": requested, "message": message })),
        }
    }
    drop(journal);
    if songs == 0 {
        let _ = std::fs::remove_dir_all(&dir);
    }
    Ok(json!({ "songs": songs, "fields": fields, "unchanged": unchanged, "problems": problems }))
}

/// `undo_artist_rename {batch}`: each changed tag goes back to the value it had, unless it has been changed again since
/// (then it is left alone and listed). Returns `{songs, fields, problems}`.
pub fn undo_artist_rename(
    batch: &str,
    library_root: Option<&Path>,
    data_dir: &Path,
) -> Result<Value, String> {
    if !valid_batch(batch) {
        return Err("The batch id is not valid.".to_owned());
    }
    let dir = batch_dir(data_dir, batch);
    let text = std::fs::read_to_string(dir.join("journal.jsonl"))
        .map_err(|_| "That change was not found, or was already undone.".to_owned())?;
    let mut by_file: std::collections::BTreeMap<String, Vec<(TagField, Option<String>, String)>> =
        std::collections::BTreeMap::new();
    for line in text.lines().filter(|l| !l.trim().is_empty()) {
        let entry: Value =
            serde_json::from_str(line).map_err(|e| format!("the undo journal is damaged: {e}"))?;
        let (Some(path), Some(field), Some(new)) = (
            entry["path"].as_str(),
            entry["field"].as_str().and_then(TagField::from_name),
            entry["new"].as_str(),
        ) else {
            continue;
        };
        by_file.entry(path.to_owned()).or_default().push((
            field,
            entry["old"].as_str().map(str::to_owned),
            new.to_owned(),
        ));
    }
    let (mut songs, mut fields) = (0usize, 0usize);
    let mut problems = Vec::new();
    for (path, entries) in by_file {
        let outcome = (|| -> Result<usize, String> {
            let file = resolve_in_library(&path, library_root)?;
            let now = read_track_metadata(&file).map_err(|e| e.to_string())?;
            let mut changes = Vec::new();
            for (field, old, new) in entries {
                let current = if field == TagField::Artist {
                    &now.artist
                } else {
                    &now.album_artist
                };
                if current.as_deref().map(str::trim) == Some(new.as_str()) {
                    changes.push((field, old));
                }
            }
            if changes.is_empty() {
                return Err(
                    "its artist tags were changed again since, so they were left as they are"
                        .to_owned(),
                );
            }
            patch_track_metadata(&file, &changes).map_err(|e| e.to_string())?;
            Ok(changes.len())
        })();
        match outcome {
            Ok(count) => {
                songs += 1;
                fields += count;
            }
            Err(message) => problems.push(json!({ "path": path, "message": message })),
        }
    }
    if problems.is_empty() {
        let _ = std::fs::remove_dir_all(&dir);
    } else {
        let _ = std::fs::rename(dir.join("journal.jsonl"), dir.join("journal.undone.jsonl"));
    }
    Ok(json!({ "songs": songs, "fields": fields, "problems": problems }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mediaverse_ripper::id3::{self, TagSet};

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mv-rename-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn song(folder: &Path, name: &str, artist: &str, album_artist: &str) -> String {
        let mut bytes = id3::write_tag(&TagSet {
            title: "T".into(),
            artist: artist.into(),
            album: "Album".into(),
            album_artist: album_artist.into(),
            ..TagSet::default()
        })
        .unwrap();
        // A few silent MPEG-1 Layer III frames (128 kbps, 44.1 kHz, 417 bytes each): a real MP3 stream.
        for _ in 0..4 {
            bytes.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
            bytes.extend(std::iter::repeat_n(0u8, 413));
        }
        std::fs::write(folder.join(name), &bytes).unwrap();
        folder.join(name).to_string_lossy().into_owned()
    }

    #[test]
    fn only_whole_matching_values_change_and_undo_puts_them_back() {
        let library = temp("lib").canonicalize().unwrap();
        let data = temp("data");
        let album = library.join("A.F.I.").join("Album");
        std::fs::create_dir_all(&album).unwrap();
        let one = song(&album, "01.mp3", "A.F.I.", "A.F.I.");
        let two = song(&album, "02.mp3", "A.F.I. ", "");
        let spaced = song(&album, "06.mp3", "AFI ", "AFI");
        let guest = song(&album, "03.mp3", "A.F.I. & Friends", "A.F.I.");
        let other = song(&album, "04.mp3", "Someone Else", "Someone Else");
        let already = song(&album, "05.mp3", "AFI", "AFI");
        let paths = [&one, &two, &guest, &other, &already, &spaced];
        let args =
            json!({ "paths": paths, "from": ["A.F.I.", "AFI "], "to": "AFI", "batch": "b-1" });
        let done = rename_artist(&args, Some(&library), &data).unwrap();
        assert_eq!(
            (
                done["songs"].clone(),
                done["fields"].clone(),
                done["unchanged"].clone()
            ),
            (json!(4), json!(5), json!(2)),
            "{done}"
        );
        assert_eq!(done["problems"], json!([]));
        let read = |p: &str| {
            let m = read_track_metadata(Path::new(p)).unwrap();
            (
                m.artist.unwrap_or_default(),
                m.album_artist.unwrap_or_default(),
            )
        };
        assert_eq!(read(&one), ("AFI".into(), "AFI".into()));
        assert_eq!(read(&two).0, "AFI");
        assert_eq!(
            read(&guest),
            ("A.F.I. & Friends".into(), "AFI".into()),
            "a longer value is left alone"
        );
        assert_eq!(read(&other), ("Someone Else".into(), "Someone Else".into()));

        // Undo: the old spellings come back; a tag changed in between is left alone and reported.
        patch_track_metadata(
            Path::new(&one),
            &[(TagField::Artist, Some("Changed Since".into()))],
        )
        .unwrap();
        let undone = undo_artist_rename("b-1", Some(&library), &data).unwrap();
        assert_eq!(undone["songs"], 4);
        assert_eq!(
            undone["problems"],
            json!([]),
            "a song with one of its two tags changed is still partly restored"
        );
        assert_eq!(read(&one), ("Changed Since".into(), "A.F.I.".into()));
        assert_eq!(read(&two).0.trim(), "A.F.I.");
        assert!(
            undo_artist_rename("b-1", Some(&library), &data).is_err(),
            "undone once"
        );
    }

    #[test]
    fn bad_requests_are_refused() {
        let library = temp("lib2");
        let data = temp("data2");
        let args = |v: Value| rename_artist(&v, Some(&library), &data);
        assert!(args(json!({ "paths": [], "from": ["a"], "to": "b", "batch": "x" })).is_err());
        assert!(
            args(json!({ "paths": ["x.mp3"], "from": ["a"], "to": " ", "batch": "x" })).is_err()
        );
        assert!(
            args(json!({ "paths": ["x.mp3"], "from": ["b"], "to": "b", "batch": "x" })).is_err(),
            "nothing to change"
        );
        assert!(
            args(json!({ "paths": ["x.mp3"], "from": ["a"], "to": "b", "batch": "../x" })).is_err()
        );
        let outside = args(json!({ "paths": ["C:\\Windows\\notepad.exe"], "from": ["a"], "to": "b", "batch": "x" })).unwrap();
        assert_eq!(outside["songs"], 0);
        assert_eq!(
            outside["problems"].as_array().unwrap().len(),
            1,
            "a file outside the library is refused"
        );
        assert!(undo_artist_rename("../x", Some(&library), &data).is_err());
    }
}
