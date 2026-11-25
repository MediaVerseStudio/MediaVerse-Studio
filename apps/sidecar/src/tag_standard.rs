//! One ID3 version for the whole library (owner, 2026-11-04): MP3 tags are rewritten as ID3v2.3, or ID3v2.4 when
//! the person chose it in the advanced settings. Only the version changes: every frame is kept (written through
//! `patch_track_metadata` with no changes, which edits the file's own tag, checks a copy and swaps it in). A file
//! with only an old ID3v1 tag gets an ID3v2 tag holding the same values; a file with no tag at all is left alone.

use serde_json::{Value, json};
use std::io::{Read, Seek, SeekFrom};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// What tag a file starts and ends with: its ID3v2 major version (2, 3 or 4) if any, and whether it has ID3v1.
pub fn tag_versions(path: &Path) -> std::io::Result<(Option<u8>, bool)> {
    let mut file = std::fs::File::open(path)?;
    let mut head = [0u8; 4];
    let read = file.read(&mut head)?;
    let v2 = (read == 4 && &head[..3] == b"ID3").then_some(head[3]);
    let length = file.metadata()?.len();
    let mut v1 = false;
    if length >= 128 {
        file.seek(SeekFrom::End(-128))?;
        let mut tail = [0u8; 3];
        file.read_exact(&mut tail)?;
        v1 = &tail == b"TAG";
    }
    Ok((v2, v1))
}

fn mp3_files(root: &Path) -> Vec<PathBuf> {
    let mut found = Vec::new();
    let mut pending = vec![root.to_path_buf()];
    while let Some(dir) = pending.pop() {
        let Ok(entries) = std::fs::read_dir(&dir) else {
            continue;
        };
        for entry in entries.flatten() {
            let path = entry.path();
            match entry.file_type() {
                Ok(kind) if kind.is_dir() => pending.push(path),
                Ok(kind)
                    if kind.is_file()
                        && path
                            .extension()
                            .is_some_and(|e| e.eq_ignore_ascii_case("mp3")) =>
                {
                    found.push(path)
                }
                _ => {}
            }
        }
    }
    found.sort();
    found
}

/// Whether a file needs rewriting to reach `target` (3 or 4).
fn needs(versions: (Option<u8>, bool), target: u8) -> bool {
    match versions {
        (Some(v), _) => v != target,
        (None, has_v1) => has_v1,
    }
}

/// How many MP3s have each tag version, and how many would be rewritten for `target`.
pub fn survey(root: &Path, target: u8) -> Value {
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    let mut to_change = 0;
    let files = mp3_files(root);
    for path in &files {
        let versions = tag_versions(path).unwrap_or((None, false));
        let name = match versions.0 {
            Some(v) => format!("ID3v2.{v}"),
            None if versions.1 => "ID3v1 only".to_owned(),
            None => "no tag".to_owned(),
        };
        *counts.entry(name).or_default() += 1;
        if needs(versions, target) {
            to_change += 1;
        }
    }
    json!({ "files": files.len(), "versions": counts, "to_change": to_change, "target": format!("ID3v2.{target}") })
}

/// Rewrites every MP3 whose tag is not yet `target`. Stops between files when `stop` is raised.
pub fn run(root: &Path, target: u8, stop: &AtomicBool, progress: &dyn Fn(usize, usize)) -> Value {
    let todo: Vec<PathBuf> = mp3_files(root)
        .into_iter()
        .filter(|p| tag_versions(p).is_ok_and(|v| needs(v, target)))
        .collect();
    let total = todo.len();
    let mut changed = 0;
    let mut problems = Vec::new();
    for (done, path) in todo.iter().enumerate() {
        if stop.load(Ordering::Relaxed) {
            return json!({ "stopped": true, "changed": changed, "total": total, "problems": problems });
        }
        match mediaverse_metadata_tags::patch_track_metadata(path, &[]) {
            Ok(_) => changed += 1,
            Err(error) => problems
                .push(json!({ "path": path.to_string_lossy(), "message": error.to_string() })),
        }
        progress(done + 1, total);
    }
    json!({ "stopped": false, "changed": changed, "total": total, "problems": problems })
}

/// Gives MP3s that have no tag at all a tag made from their file and folder names (owner, 2026-11-04): title and
/// track number from the file name, artist, album, year and disc from the folders. Fix tags can then look them
/// up like any other song with gaps.
pub fn tag_untagged(root: &Path, stop: &AtomicBool, progress: &dyn Fn(usize, usize)) -> Value {
    use mediaverse_metadata_tags::TagField;
    use mediaverse_tag_repair::names::{from_file_name, from_folders};
    let todo: Vec<PathBuf> = mp3_files(root)
        .into_iter()
        .filter(|p| tag_versions(p).is_ok_and(|v| v == (None, false)))
        .collect();
    let total = todo.len();
    let mut changed = 0;
    let mut problems = Vec::new();
    for (done, path) in todo.iter().enumerate() {
        if stop.load(Ordering::Relaxed) {
            return json!({ "stopped": true, "changed": changed, "total": total, "problems": problems });
        }
        let stem = path
            .file_stem()
            .map(|s| s.to_string_lossy().into_owned())
            .unwrap_or_default();
        let file = from_file_name(&stem);
        let folders: Vec<String> = path
            .parent()
            .and_then(|dir| dir.strip_prefix(root).ok())
            .map(|relative| {
                relative
                    .iter()
                    .rev()
                    .map(|part| part.to_string_lossy().into_owned())
                    .collect()
            })
            .unwrap_or_default();
        let names = from_folders(&folders.iter().map(String::as_str).collect::<Vec<_>>());
        let mut changes = vec![(
            TagField::Title,
            Some(file.title.clone().unwrap_or_else(|| stem.clone())),
        )];
        let mut add = |field: TagField, value: Option<String>| {
            if let Some(value) = value.filter(|v| !v.trim().is_empty()) {
                changes.push((field, Some(value)));
            }
        };
        add(TagField::Track, file.track.map(|n| n.to_string()));
        add(
            TagField::Disc,
            file.disc.or(names.disc).map(|n| n.to_string()),
        );
        add(TagField::Artist, names.artist.clone());
        add(TagField::AlbumArtist, names.artist.clone());
        add(TagField::Album, names.album.clone());
        add(TagField::Year, names.year.map(|y| y.to_string()));
        match mediaverse_metadata_tags::patch_track_metadata(path, &changes) {
            Ok(_) => changed += 1,
            Err(error) => problems
                .push(json!({ "path": path.to_string_lossy(), "message": error.to_string() })),
        }
        progress(done + 1, total);
    }
    json!({ "stopped": false, "changed": changed, "total": total, "problems": problems })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn audio() -> Vec<u8> {
        let mut data = Vec::new();
        for _ in 0..40 {
            data.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
            data.extend(std::iter::repeat(0u8).take(413));
        }
        data
    }

    #[test]
    fn old_and_new_tags_become_the_chosen_version_and_keep_their_values() {
        let dir = std::env::temp_dir().join(format!("mv-id3-standard-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        // An ID3v2.4 file (lofty's default) with a title and year.
        // Made by hand rather than by switching the global version setting, which other tests running at the same
        // time would see. TIT2 "Song" and TDRC "1999", both UTF-8, in an ID3v2.4 tag.
        let v24 = dir.join("a.mp3");
        let mut bytes = vec![b'I', b'D', b'3', 4, 0, 0, 0, 0, 0, 30];
        bytes.extend_from_slice(b"TIT2\x00\x00\x00\x05\x00\x00\x03Song");
        bytes.extend_from_slice(b"TDRC\x00\x00\x00\x05\x00\x00\x031999");
        bytes.extend_from_slice(&audio());
        std::fs::write(&v24, bytes).unwrap();
        assert_eq!(tag_versions(&v24).unwrap(), (Some(4), false));
        // A file with no tag at all, left alone.
        let bare = dir.join("b.mp3");
        std::fs::write(&bare, audio()).unwrap();

        let before = survey(&dir, 3);
        assert_eq!(before["to_change"], 1, "{before}");
        let stop = AtomicBool::new(false);
        let result = run(&dir, 3, &stop, &|_, _| {});
        assert_eq!(result["changed"], 1, "{result}");
        assert_eq!(tag_versions(&v24).unwrap(), (Some(3), false));
        let now = mediaverse_metadata_tags::read_track_metadata(&v24).unwrap();
        assert_eq!(
            (now.title.as_deref(), now.release_year),
            (Some("Song"), Some(1999))
        );
        assert_eq!(std::fs::read(&bare).unwrap(), audio(), "no tag: untouched");
        assert_eq!(survey(&dir, 3)["to_change"], 0);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn an_untagged_mp3_gets_a_tag_from_its_names() {
        let root = std::env::temp_dir().join(format!("mv-untagged-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let album = root.join("Band").join("Record (1999)");
        std::fs::create_dir_all(&album).unwrap();
        let file = album.join("03 A Song.mp3");
        std::fs::write(&file, audio()).unwrap();
        let stop = AtomicBool::new(false);
        let result = tag_untagged(&root, &stop, &|_, _| {});
        assert_eq!(result["changed"], 1, "{result}");
        let tags = mediaverse_metadata_tags::read_track_metadata(&file).unwrap();
        assert_eq!(tags.title.as_deref(), Some("A Song"));
        assert_eq!(tags.track_number, Some(3));
        assert_eq!(tags.artist.as_deref(), Some("Band"));
        assert_eq!(tags.album.as_deref(), Some("Record"));
        assert_eq!(tags.release_year, Some(1999));
        assert_eq!(tag_versions(&file).unwrap().0, Some(3));
        assert!(std::fs::read(&file).unwrap().ends_with(&audio()));
        let _ = std::fs::remove_dir_all(&root);
    }
}
