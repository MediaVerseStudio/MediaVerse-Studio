//! Songs that do not agree with their own album (D100). In a folder of three or more songs, when most of them say the
//! same Album, Album artist, Genre or Year and a few say something else (or nothing), those few are "orphans": a song
//! re-tagged by hand, a bonus track, a stray rip. The scan lists them with what the album says; the person presses
//! one button per album and the few songs are made to match (with Undo). It also finds songs with no embedded cover
//! while most of their album has one. Compilations (Various Artists) keep each song's own genre, year and artist.
//! Nothing is changed by the scan; every tag written is journalled in `<data>/album-align-batches/<batch>`.

use crate::library_cover::resolve_in_library;
use crate::tag_repair::{ScanState, album_folders, read_file};
use lofty::file::TaggedFileExt;
use mediaverse_metadata_tags::{TagField, patch_track_metadata, read_tag_fields};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const MIN_SONGS: usize = 3;
/// At least this share of an album's songs must agree before the others are called orphans.
const MAJORITY_PERCENT: usize = 60;
/// How many albums one scan reports (the worst first); the page says how many more there are.
const MAX_ALBUMS: usize = 300;
const FIELDS: [(&str, TagField); 4] = [
    ("album", TagField::Album),
    ("album_artist", TagField::AlbumArtist),
    ("genre", TagField::Genre),
    ("year", TagField::Year),
];

fn valid_batch(id: &str) -> bool {
    !id.is_empty() && id.len() <= 64 && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
}

fn batch_dir(data_dir: &Path, batch: &str) -> PathBuf {
    data_dir.join("album-align-batches").join(batch)
}

/// What most values say, and which positions differ: `(majority, how many say it, [(index, value)])`. None when no
/// value has a clear majority (at least two songs and 60%), or when nothing differs.
pub fn outliers(
    values: &[Option<String>],
) -> Option<(String, usize, Vec<(usize, Option<String>)>)> {
    let mut counts: BTreeMap<&str, usize> = BTreeMap::new();
    for value in values.iter().flatten() {
        *counts.entry(value.as_str()).or_default() += 1;
    }
    let (best, count) = counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(a.0)))?;
    if count < 2 || count * 100 < MAJORITY_PERCENT * values.len() {
        return None;
    }
    let odd: Vec<(usize, Option<String>)> = values
        .iter()
        .enumerate()
        .filter(|(_, v)| v.as_deref() != Some(best))
        .map(|(i, v)| (i, v.clone()))
        .collect();
    (!odd.is_empty()).then(|| (best.to_owned(), count, odd))
}

fn has_cover(path: &Path) -> bool {
    lofty::read_from_path(path).ok().is_some_and(|f| {
        f.primary_tag()
            .or_else(|| f.first_tag())
            .is_some_and(|t| !t.pictures().is_empty())
    })
}

fn clean(value: &Option<String>) -> Option<String> {
    value
        .as_deref()
        .map(str::trim)
        .filter(|v| !v.is_empty())
        .map(str::to_owned)
}

/// One album folder: the differences found, or None when its songs agree.
fn check_folder(dir: &Path, files: &[PathBuf], root: &Path) -> Option<Value> {
    if files.len() < MIN_SONGS {
        return None;
    }
    let read: Vec<_> = files.iter().filter_map(|f| read_file(f).ok()).collect();
    if read.len() < MIN_SONGS {
        return None;
    }
    let various = {
        let artists: Vec<Option<String>> =
            read.iter().map(|f| clean(&f.tags.album_artist)).collect();
        outliers(&artists)
            .map(|(v, ..)| v)
            .or_else(|| artists.iter().flatten().next().cloned())
            .is_some_and(|v| mediaverse_tag_repair::names::is_various(&v))
    };
    let mut fields = Vec::new();
    for (name, _) in FIELDS {
        // On a compilation each song has its own genre and year.
        if various && matches!(name, "genre" | "year") {
            continue;
        }
        let values: Vec<Option<String>> = read
            .iter()
            .map(|f| match name {
                "album" => clean(&f.tags.album),
                "album_artist" => clean(&f.tags.album_artist),
                "genre" => clean(&f.tags.genre),
                _ => f.tags.year.map(|y| y.to_string()),
            })
            .collect();
        if let Some((majority, count, odd)) = outliers(&values) {
            // A field most songs lack and a few have is not an orphan problem (those few are the exception).
            let songs: Vec<Value> = odd
                .iter()
                .map(|(i, v)| json!({ "path": read[*i].path, "value": v }))
                .collect();
            fields.push(
                json!({ "field": name, "majority": majority, "count": count, "songs": songs }),
            );
        }
    }
    let covers: Vec<bool> = read.iter().map(|f| has_cover(Path::new(&f.path))).collect();
    let with = covers.iter().filter(|c| **c).count();
    let mut cover = Value::Null;
    if with >= 2 && with * 100 >= MAJORITY_PERCENT * read.len() && with < read.len() {
        let source = read
            .iter()
            .zip(&covers)
            .find(|(_, c)| **c)
            .map(|(f, _)| f.path.clone());
        let missing: Vec<String> = read
            .iter()
            .zip(&covers)
            .filter(|(_, c)| !**c)
            .map(|(f, _)| f.path.clone())
            .collect();
        cover = json!({ "have": with, "missing": missing, "source": source });
    }
    if fields.is_empty() && cover.is_null() {
        return None;
    }
    let issues: usize = fields
        .iter()
        .map(|f| f["songs"].as_array().map_or(0, Vec::len))
        .sum::<usize>()
        + cover["missing"].as_array().map_or(0, Vec::len);
    Some(json!({
        "folder": dir.to_string_lossy(), "name": dir.strip_prefix(root).unwrap_or(dir).to_string_lossy(), "songs": read.len(),
        "fields": fields, "cover": cover, "issues": issues,
    }))
}

/// The scan job: every album folder checked; the worst `MAX_ALBUMS` are returned.
pub fn scan(
    root: &Path,
    stop: &AtomicBool,
    progress: &ScanState,
    emit: &dyn Fn(&ScanState),
) -> Result<Value, String> {
    let folders = album_folders(root);
    progress.total.store(folders.len(), Ordering::Relaxed);
    emit(progress);
    let mut found: Vec<Value> = Vec::new();
    let mut stopped = false;
    for (dir, files) in folders {
        if stop.load(Ordering::Relaxed) {
            stopped = true;
            break;
        }
        if let Ok(mut current) = progress.current.lock() {
            *current = dir
                .strip_prefix(root)
                .unwrap_or(&dir)
                .to_string_lossy()
                .into_owned();
        }
        if let Ok(Some(album)) = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            check_folder(&dir, &files, root)
        })) {
            found.push(album);
            progress.identified.fetch_add(1, Ordering::Relaxed);
        }
        let done = progress.done.fetch_add(1, Ordering::Relaxed) + 1;
        if done % 25 == 0 {
            emit(progress);
        }
    }
    found.sort_by(|a, b| {
        b["issues"]
            .as_u64()
            .cmp(&a["issues"].as_u64())
            .then_with(|| a["name"].as_str().cmp(&b["name"].as_str()))
    });
    let total = found.len();
    found.truncate(MAX_ALBUMS);
    Ok(
        json!({ "stopped": stopped, "checked": progress.done.load(Ordering::Relaxed), "total": total, "albums": found }),
    )
}

/// `align_album {changes: [{path, field, value}], batch}`: writes the given values (only album, album_artist, genre,
/// year), journalling each old value. Returns `{songs, fields, unchanged, problems}`.
pub fn align_album(
    args: &Value,
    library_root: Option<&Path>,
    data_dir: &Path,
) -> Result<Value, String> {
    let batch = args["batch"]
        .as_str()
        .filter(|b| valid_batch(b))
        .ok_or("The batch id is not valid.")?;
    let list = args["changes"]
        .as_array()
        .ok_or("'changes' must be a list.")?;
    if list.is_empty() || list.len() > 5_000 {
        return Err("Give between 1 and 5000 changes.".to_owned());
    }
    let mut by_file: BTreeMap<String, Vec<(TagField, String)>> = BTreeMap::new();
    for change in list {
        let path = change["path"]
            .as_str()
            .ok_or("each change needs a 'path'")?;
        let field = FIELDS
            .iter()
            .find(|(name, _)| Some(*name) == change["field"].as_str())
            .map(|(_, f)| *f)
            .ok_or("only album, album_artist, genre and year can be changed here")?;
        let value = change["value"]
            .as_str()
            .map(str::trim)
            .filter(|v| !v.is_empty() && !v.chars().any(char::is_control))
            .ok_or("a new value must be plain, non-empty text")?;
        by_file
            .entry(path.to_owned())
            .or_default()
            .push((field, value.to_owned()));
    }
    let dir = batch_dir(data_dir, batch);
    std::fs::create_dir_all(&dir).map_err(|e| format!("could not make the undo folder: {e}"))?;
    let mut journal = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(dir.join("journal.jsonl"))
        .map_err(|e| e.to_string())?;
    let (mut songs, mut fields, mut unchanged) = (0usize, 0usize, 0usize);
    let mut problems = Vec::new();
    for (requested, wanted) in by_file {
        let outcome = (|| -> Result<usize, String> {
            let file = resolve_in_library(&requested, library_root)?;
            let keys: Vec<TagField> = wanted.iter().map(|(f, _)| *f).collect();
            let now = read_tag_fields(&file, &keys).map_err(|e| e.to_string())?;
            let changes: Vec<(TagField, Option<String>)> = wanted
                .iter()
                .filter(|(field, value)| {
                    now.iter()
                        .find(|(f, _)| f == field)
                        .and_then(|(_, v)| v.as_deref())
                        .map(str::trim)
                        != Some(value.as_str())
                })
                .map(|(field, value)| (*field, Some(value.clone())))
                .collect();
            if changes.is_empty() {
                return Ok(0);
            }
            let before = patch_track_metadata(&file, &changes).map_err(|e| e.to_string())?;
            for ((field, new), (_, old)) in changes.iter().zip(before) {
                let line = json!({ "path": file.display().to_string(), "field": field.name(), "old": old, "new": new });
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

/// `undo_album_align {batch}`: every value goes back, unless it was changed again since (then it is left and listed).
pub fn undo_album_align(
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
    let (mut songs, mut fields) = (0usize, 0usize);
    let mut problems = Vec::new();
    let mut by_file: BTreeMap<String, Vec<(TagField, Option<String>, String)>> = BTreeMap::new();
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
    for (path, entries) in by_file {
        let outcome = (|| -> Result<usize, String> {
            let file = resolve_in_library(&path, library_root)?;
            let keys: Vec<TagField> = entries.iter().map(|(f, ..)| *f).collect();
            let now = read_tag_fields(&file, &keys).map_err(|e| e.to_string())?;
            let changes: Vec<(TagField, Option<String>)> = entries
                .into_iter()
                .filter(|(field, _, new)| {
                    now.iter()
                        .find(|(f, _)| f == field)
                        .and_then(|(_, v)| v.as_deref())
                        .map(str::trim)
                        == Some(new.as_str())
                })
                .map(|(field, old, _)| (field, old))
                .collect();
            if changes.is_empty() {
                return Err(
                    "its tags were changed again since, so they were left as they are".to_owned(),
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

    fn some(v: &str) -> Option<String> {
        Some(v.to_owned())
    }

    #[test]
    fn a_clear_majority_makes_the_rest_orphans() {
        let values = [some("Punk"), some("Punk"), some("Punk"), some("Rock"), None];
        let (majority, count, odd) = outliers(&values).unwrap();
        assert_eq!((majority.as_str(), count), ("Punk", 3));
        assert_eq!(odd, vec![(3, some("Rock")), (4, None)]);
        // Everyone agrees, or nobody has a majority: nothing to report.
        assert!(outliers(&[some("Punk"), some("Punk")]).is_none());
        assert!(outliers(&[some("A"), some("B"), some("C")]).is_none());
        assert!(
            outliers(&[some("A"), some("A"), some("B"), some("C"), None]).is_none(),
            "2 of 5 is not a majority"
        );
        assert!(outliers(&[None, None, None]).is_none());
    }

    fn song(folder: &Path, name: &str, album: &str, genre: &str, year: &str) -> String {
        let mut bytes = id3::write_tag(&TagSet {
            title: name.into(),
            artist: "AFI".into(),
            album: album.into(),
            album_artist: "AFI".into(),
            genre: Some(genre.into()),
            year: year.parse().ok(),
            ..TagSet::default()
        })
        .unwrap();
        for _ in 0..4 {
            bytes.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
            bytes.extend(std::iter::repeat_n(0u8, 413));
        }
        std::fs::write(folder.join(name), &bytes).unwrap();
        folder.join(name).to_string_lossy().into_owned()
    }

    #[test]
    fn the_scan_finds_the_orphan_and_aligning_and_undo_work() {
        let temp = std::env::temp_dir().join(format!("mv-align-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        let library = temp.join("lib");
        let album = library.join("AFI").join("Crash Love");
        std::fs::create_dir_all(&album).unwrap();
        let _ = song(&album, "01.mp3", "Crash Love", "Punk Rock", "2009");
        let _ = song(&album, "02.mp3", "Crash Love", "Punk Rock", "2009");
        let _ = song(&album, "03.mp3", "Crash Love", "Punk Rock", "2009");
        let orphan = song(&album, "04.mp3", "Crash Love", "Rock", "2009");
        let library = library.canonicalize().unwrap();
        let album = library.join("AFI").join("Crash Love");

        let progress = ScanState::new("j");
        let found = scan(&library, &AtomicBool::new(false), &progress, &|_| {}).unwrap();
        assert_eq!(found["total"], 1, "{found}");
        let fields = found["albums"][0]["fields"].as_array().unwrap();
        assert_eq!(fields.len(), 1);
        assert_eq!(
            (
                fields[0]["field"].as_str(),
                fields[0]["majority"].as_str(),
                fields[0]["count"].as_u64()
            ),
            (Some("genre"), Some("Punk Rock"), Some(3))
        );
        assert!(
            album.join("04.mp3").to_string_lossy().ends_with("04.mp3")
                && fields[0]["songs"][0]["path"]
                    .as_str()
                    .unwrap()
                    .ends_with("04.mp3")
        );

        let data = temp.join("data");
        let orphan_path = album.join("04.mp3").to_string_lossy().into_owned();
        let args = json!({ "batch": "a-1", "changes": [{ "path": orphan_path, "field": "genre", "value": "Punk Rock" }] });
        let done = align_album(&args, Some(&library), &data).unwrap();
        assert_eq!(
            (done["songs"].clone(), done["fields"].clone()),
            (json!(1), json!(1)),
            "{done}"
        );
        let genre = |p: &str| {
            read_tag_fields(Path::new(p), &[TagField::Genre]).unwrap()[0]
                .1
                .clone()
        };
        assert_eq!(genre(&orphan_path), some("Punk Rock"));
        assert_eq!(
            scan(
                &library,
                &AtomicBool::new(false),
                &ScanState::new("k"),
                &|_| {}
            )
            .unwrap()["total"],
            0,
            "now the album agrees"
        );

        let undone = undo_album_align("a-1", Some(&library), &data).unwrap();
        assert_eq!(undone["songs"], 1);
        assert_eq!(genre(&orphan_path), some("Rock"));
        assert!(align_album(&json!({ "batch": "a-2", "changes": [{ "path": orphan_path, "field": "title", "value": "x" }] }), Some(&library), &data).is_err(), "only album-wide fields");
        let _ = orphan;
        let _ = std::fs::remove_dir_all(&temp);
    }
}
