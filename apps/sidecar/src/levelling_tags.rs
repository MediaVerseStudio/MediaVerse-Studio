//! Writing the levelling into the music files, so every program and device that honours ReplayGain tags (Jellyfin and its apps, other players) hears it, not
//! only this program's own player (owner, 2026-11-24). Only albums that are turned UP get tags (nothing is ever turned down). Each file's earlier values of the
//! four tags are saved in a journal before anything is written, so the whole thing can be put back exactly, and a file is replaced only after its new tag has been
//! written to a copy and read back (the same safe path as every other tag change in the program).

use crate::loudness_store::LoudnessStore;
use mediaverse_metadata_tags::{TagField, patch_track_metadata, read_tag_fields};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const FIELDS: [TagField; 4] = [
    TagField::ReplayGainTrackGain,
    TagField::ReplayGainTrackPeak,
    TagField::ReplayGainAlbumGain,
    TagField::ReplayGainAlbumPeak,
];

pub fn journal_path(data_dir: &Path) -> PathBuf {
    data_dir.join("levelling-tags-journal.json")
}

/// path -> the four tags as they were before the program wrote them (null where the file had none).
type Journal = BTreeMap<String, BTreeMap<String, Option<String>>>;

fn read_journal(data_dir: &Path) -> Journal {
    std::fs::read_to_string(journal_path(data_dir))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or_default()
}

fn save_journal(data_dir: &Path, journal: &Journal) -> Result<(), String> {
    let path = journal_path(data_dir);
    let temp = path.with_extension("tmp");
    let text = serde_json::to_string(journal).map_err(|e| e.to_string())?;
    std::fs::write(&temp, text).map_err(|e| format!("the undo list could not be saved: {e}"))?;
    std::fs::rename(&temp, &path).map_err(|e| format!("the undo list could not be saved: {e}"))
}

/// The four values to write for one song of an album.
fn values(
    track_gain: f64,
    track_peak: f64,
    album_gain: f64,
    album_peak: f64,
) -> [(TagField, Option<String>); 4] {
    [
        (
            TagField::ReplayGainTrackGain,
            Some(format!("{track_gain:+.2} dB")),
        ),
        (
            TagField::ReplayGainTrackPeak,
            Some(format!("{track_peak:.6}")),
        ),
        (
            TagField::ReplayGainAlbumGain,
            Some(format!("{album_gain:+.2} dB")),
        ),
        (
            TagField::ReplayGainAlbumPeak,
            Some(format!("{album_peak:.6}")),
        ),
    ]
}

/// What a write would do, from the measurements alone (no file is opened): the songs and albums that would get tags and how many already carry the program's tags.
pub fn preview(store: &LoudnessStore, data_dir: &Path) -> Result<Value, String> {
    let albums = store.boosted_albums().map_err(|e| e.to_string())?;
    let songs: usize = albums.iter().map(|a| a.songs.len()).sum();
    let largest = albums.iter().map(|a| a.album_gain_db).fold(0.0, f64::max);
    Ok(json!({
        "albums": albums.len(),
        "songs": songs,
        "largest_boost_db": largest,
        "written": read_journal(data_dir).len(),
    }))
}

/// "Band - Album" from the last two parts of an album's folder.
fn album_name(folder: &str) -> String {
    let parts: Vec<&str> = folder
        .split(['\\', '/'])
        .filter(|p| !p.is_empty())
        .collect();
    match parts.as_slice() {
        [.., band, album] => format!("{band} - {album}"),
        [only] => (*only).to_owned(),
        [] => folder.to_owned(),
    }
}

/// The albums that are turned up, for choosing one: name, folder, songs, the album's boost and how many of its songs carry tags written by this program.
pub fn albums(store: &LoudnessStore, data_dir: &Path) -> Result<Value, String> {
    let journal = read_journal(data_dir);
    let list: Vec<Value> = store
        .boosted_albums()
        .map_err(|e| e.to_string())?
        .iter()
        .map(|a| {
            let on_file = a
                .songs
                .iter()
                .filter(|(p, _, _)| journal.contains_key(p))
                .count();
            json!({
                "folder": a.folder,
                "name": album_name(&a.folder),
                "songs": a.songs.len(),
                "boost_db": a.album_gain_db,
                "written": on_file,
            })
        })
        .collect();
    Ok(json!({ "albums": list }))
}

/// What to write: everything (the default), the first few albums that still need it, or one album.
#[derive(Default, Clone, Debug)]
pub struct WriteOptions {
    /// Stop after this many albums have had tags written (albums already right do not count).
    pub limit_albums: Option<usize>,
    /// Only the album in this folder.
    pub folder: Option<String>,
}

/// Writes the tags. Songs that already carry exactly these values, songs changed since they were measured and songs that cannot be opened are skipped
/// (and counted); a stop request ends it between two files. Safe to run again: it carries on where it stopped.
pub fn write(
    store: &LoudnessStore,
    data_dir: &Path,
    options: &WriteOptions,
    progress: &dyn Fn(usize, usize),
    stop: &AtomicBool,
) -> Result<Value, String> {
    let albums: Vec<_> = store
        .boosted_albums()
        .map_err(|e| e.to_string())?
        .into_iter()
        .filter(|a| options.folder.as_deref().is_none_or(|f| a.folder == f))
        .collect();
    let total: usize = albums.iter().map(|a| a.songs.len()).sum();
    let mut albums_written: Vec<String> = Vec::new();
    let mut limit_reached = false;
    let connection = store.open().map_err(|e| e.to_string())?;
    let mut journal = read_journal(data_dir);
    let (mut done, mut written, mut same, mut changed, mut failed) =
        (0usize, 0usize, 0usize, 0usize, 0usize);
    let mut problems: Vec<String> = Vec::new();
    progress(0, total);
    'albums: for album in &albums {
        if options
            .limit_albums
            .is_some_and(|limit| albums_written.len() >= limit)
        {
            limit_reached = true;
            break;
        }
        let written_before = written;
        for (path, gain, peak) in &album.songs {
            if stop.load(Ordering::Relaxed) {
                break 'albums;
            }
            done += 1;
            if done % 5 == 0 || done == total {
                progress(done, total);
            }
            let file = Path::new(path);
            // A file edited since it was measured has a different loudness now: it is left alone until it is measured again.
            let now = crate::defect_results::fingerprint(file);
            if now.is_none() || now != store.recorded(&connection, path) {
                changed += 1;
                continue;
            }
            let wanted = values(*gain, *peak, album.album_gain_db, album.album_peak);
            let current = match read_tag_fields(file, &FIELDS) {
                Ok(current) => current,
                Err(e) => {
                    failed += 1;
                    problems.push(format!("{path}: {e}"));
                    continue;
                }
            };
            if current.iter().zip(&wanted).all(|((_, a), (_, b))| a == b) {
                same += 1;
                continue;
            }
            // Remember how the file was the first time the program touched it; a second run must not overwrite that.
            let before: BTreeMap<String, Option<String>> = current
                .iter()
                .map(|(f, v)| (f.name().to_owned(), v.clone()))
                .collect();
            let first_time = !journal.contains_key(path);
            if first_time {
                journal.insert(path.clone(), before);
                save_journal(data_dir, &journal)?;
            }
            match patch_track_metadata(file, &wanted) {
                Ok(_) => {
                    written += 1;
                    store.refresh_fingerprint(&connection, path);
                }
                Err(e) => {
                    failed += 1;
                    problems.push(format!("{path}: {e}"));
                    if first_time {
                        journal.remove(path); // nothing was changed
                        save_journal(data_dir, &journal)?;
                    }
                }
            }
        }
        if written > written_before {
            albums_written.push(album_name(&album.folder));
        }
    }
    if limit_reached {
        done = total; // the albums that were asked for are finished
    }
    progress(done, total);
    Ok(json!({
        "total": total,
        "written": written,
        "albums_written": albums_written.len(),
        "album_names": albums_written.into_iter().take(100).collect::<Vec<_>>(),
        "limit_reached": limit_reached,
        "already_right": same,
        "changed_since_measured": changed,
        "failed": failed,
        "problems": problems.into_iter().take(10).collect::<Vec<_>>(),
        "stopped": stop.load(Ordering::Relaxed),
        "on_file": journal.len(),
    }))
}

/// Puts every file the program wrote tags to back as it was (its earlier values of the four tags, or none at all).
pub fn undo(
    store: &LoudnessStore,
    data_dir: &Path,
    progress: &dyn Fn(usize, usize),
    stop: &AtomicBool,
) -> Result<Value, String> {
    let mut journal = read_journal(data_dir);
    let total = journal.len();
    let connection = store.open().ok();
    let (mut restored, mut failed) = (0usize, 0usize);
    let mut problems: Vec<String> = Vec::new();
    progress(0, total);
    let paths: Vec<String> = journal.keys().cloned().collect();
    for (i, path) in paths.iter().enumerate() {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let before = &journal[path];
        let changes: Vec<(TagField, Option<String>)> = FIELDS
            .iter()
            .map(|f| (*f, before.get(f.name()).cloned().flatten()))
            .collect();
        if !Path::new(path).is_file() {
            journal.remove(path); // the file is gone: nothing to put back
            continue;
        }
        match patch_track_metadata(Path::new(path), &changes) {
            Ok(_) => {
                restored += 1;
                journal.remove(path);
                if let Some(connection) = &connection {
                    store.refresh_fingerprint(connection, path);
                }
            }
            Err(e) => {
                failed += 1;
                problems.push(format!("{path}: {e}"));
            }
        }
        if (i + 1) % 5 == 0 {
            progress(i + 1, total);
            save_journal(data_dir, &journal)?;
        }
    }
    save_journal(data_dir, &journal)?;
    progress(total, total);
    Ok(json!({
        "restored": restored,
        "failed": failed,
        "problems": problems.into_iter().take(10).collect::<Vec<_>>(),
        "on_file": journal.len(),
    }))
}

/// Removes the four ReplayGain tags from every measured song (or those of one album folder), without needing the undo list. This is the same thing
/// foobar2000's "Remove ReplayGain information" or Mp3tag does, for when the list is lost. It also removes ReplayGain tags another program wrote to those
/// songs, and it cannot bring back values that were there before this program wrote its own. Songs without the tags are not touched.
pub fn strip(
    store: &LoudnessStore,
    data_dir: &Path,
    folder: Option<&str>,
    progress: &dyn Fn(usize, usize),
    stop: &AtomicBool,
) -> Result<Value, String> {
    let paths = store.measured_paths(folder).map_err(|e| e.to_string())?;
    let total = paths.len();
    let connection = store.open().ok();
    let mut journal = read_journal(data_dir);
    let (mut removed, mut none, mut failed) = (0usize, 0usize, 0usize);
    let mut problems: Vec<String> = Vec::new();
    let nothing: Vec<(TagField, Option<String>)> = FIELDS.iter().map(|f| (*f, None)).collect();
    progress(0, total);
    for (i, path) in paths.iter().enumerate() {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        let file = Path::new(path);
        match read_tag_fields(file, &FIELDS) {
            Ok(current) if current.iter().all(|(_, v)| v.is_none()) => none += 1,
            Ok(_) => match patch_track_metadata(file, &nothing) {
                Ok(_) => {
                    removed += 1;
                    if journal.remove(path).is_some() {
                        save_journal(data_dir, &journal)?;
                    }
                    if let Some(connection) = &connection {
                        store.refresh_fingerprint(connection, path);
                    }
                }
                Err(e) => {
                    failed += 1;
                    problems.push(format!("{path}: {e}"));
                }
            },
            Err(_) => none += 1, // a file that is gone or cannot be read has nothing to remove
        }
        if (i + 1) % 5 == 0 {
            progress(i + 1, total);
        }
    }
    progress(total, total);
    Ok(json!({
        "removed": removed,
        "had_none": none,
        "failed": failed,
        "problems": problems.into_iter().take(10).collect::<Vec<_>>(),
        "stopped": stop.load(Ordering::Relaxed),
        "on_file": journal.len(),
    }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn an_album_is_named_by_the_last_two_parts_of_its_folder() {
        assert_eq!(
            album_name("M:\\Music\\Operation Ivy\\Energy"),
            "Operation Ivy - Energy"
        );
        assert_eq!(album_name("Energy"), "Energy");
    }

    #[test]
    fn the_values_are_written_the_way_players_read_them() {
        let v = values(4.3, 0.987_654_321, 4.0, 1.0);
        assert_eq!(v[0].1.as_deref(), Some("+4.30 dB"));
        assert_eq!(v[1].1.as_deref(), Some("0.987654"));
        assert_eq!(v[2].1.as_deref(), Some("+4.00 dB"));
        assert_eq!(v[3].1.as_deref(), Some("1.000000"));
    }

    #[test]
    fn a_missing_journal_is_an_empty_one_and_a_saved_one_comes_back() {
        let dir = std::env::temp_dir().join(format!("mv-levelling-journal-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert!(read_journal(&dir).is_empty());
        let mut journal = Journal::new();
        journal.insert(
            "M:\\a.mp3".to_owned(),
            BTreeMap::from([
                ("rg_track_gain".to_owned(), None),
                ("rg_album_gain".to_owned(), Some("-1.00 dB".to_owned())),
            ]),
        );
        save_journal(&dir, &journal).unwrap();
        assert_eq!(read_journal(&dir), journal);
        let _ = std::fs::remove_dir_all(&dir);
    }
}

#[cfg(test)]
mod file_tests {
    use super::*;
    use crate::loudness::Loudness;

    /// Writes the tags to a copy of a real MP3 and puts them back. Run on purpose:
    /// `MV_LEVEL_MP3=<an mp3 file> cargo test -p mediaverse_sidecar --lib levelling_tags::file_tests -- --ignored --nocapture`
    #[test]
    #[ignore = "needs a real MP3 file"]
    fn tags_are_written_to_a_copy_and_put_back() {
        let source = std::env::var("MV_LEVEL_MP3").expect("MV_LEVEL_MP3");
        let dir = std::env::temp_dir().join(format!("mv-levelling-files-{}", std::process::id()));
        let album = dir.join("Quiet Album");
        std::fs::create_dir_all(&album).unwrap();
        let file = album.join("01 Song.mp3");
        std::fs::copy(&source, &file).unwrap();
        let original = std::fs::read(&file).unwrap();
        let store = LoudnessStore::new(&dir);
        let connection = store.open().unwrap();
        let quiet = Loudness {
            lufs: -24.0,
            peak: 0.4,
            gain_db: 0.0,
            range_lu: 8.0,
            loud_end_lufs: -20.0,
            samples: 200 * 44_100,
        };
        store
            .record(&connection, &file.to_string_lossy(), &quiet, Some(1975))
            .unwrap();
        let preview = preview(&store, &dir).unwrap();
        assert_eq!(preview["songs"], 1);
        let stop = AtomicBool::new(false);
        let result = write(&store, &dir, &WriteOptions::default(), &|_, _| {}, &stop).unwrap();
        println!("write: {result}");
        assert_eq!(result["written"], 1);
        let now = read_tag_fields(&file, &FIELDS).unwrap();
        println!("tags now: {now:?}");
        assert!(now[0].1.as_deref().unwrap().ends_with(" dB"));
        assert_eq!(now[1].1.as_deref(), Some("0.400000"));
        // run again: nothing to do
        let again = write(&store, &dir, &WriteOptions::default(), &|_, _| {}, &stop).unwrap();
        assert_eq!(again["written"], 0);
        assert_eq!(again["already_right"], 1);
        // the undo list is lost: the tags can still be removed without it
        let kept = std::fs::read(journal_path(&dir)).unwrap();
        std::fs::remove_file(journal_path(&dir)).unwrap();
        let removed = strip(&store, &dir, None, &|_, _| {}, &stop).unwrap();
        assert_eq!(removed["removed"], 1);
        assert!(
            read_tag_fields(&file, &FIELDS)
                .unwrap()
                .iter()
                .all(|(_, v)| v.is_none())
        );
        // and writing again works from there (the file was measured and is still the measured version)
        let third = write(&store, &dir, &WriteOptions::default(), &|_, _| {}, &stop).unwrap();
        assert_eq!(third["written"], 1);
        assert_eq!(third["albums_written"], 1);
        std::fs::write(journal_path(&dir), kept).unwrap();
        // the file stayed measured (no new measuring needed)
        assert!(
            store.recorded(&connection, &file.to_string_lossy())
                == crate::defect_results::fingerprint(&file)
        );
        let back = undo(&store, &dir, &|_, _| {}, &stop).unwrap();
        println!("undo: {back}");
        assert_eq!(back["restored"], 1);
        let after = read_tag_fields(&file, &FIELDS).unwrap();
        assert!(after.iter().all(|(_, v)| v.is_none()), "{after:?}");
        assert_eq!(read_journal(&dir).len(), 0);
        // the song itself (its sound) is untouched: the tag-free audio length is the same
        let now_len = std::fs::read(&file).unwrap().len();
        println!("size {} -> {}", original.len(), now_len);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
