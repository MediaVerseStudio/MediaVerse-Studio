//! AcoustID for folders already in the library (D116): the same audio check as after a rip, for albums that are
//! already tagged. It answers "are these songs what their tags say?" and, for an album nothing identified, "what does the
//! audio say they are?". Reading only: the check writes nothing. Writing titles is a separate, ticked and journalled step
//! (`apply_names`) that Fix tags' Undo puts back.
//!
//! A library scan samples a few songs of each album (the first, the last and some between), so a thousand albums take a few
//! thousand requests, not every song. One album can be checked in full on request.

use crate::audio_check::Asker;
use crate::drives::{Drives, failure};
use crate::helper::HelperError;
use crate::tag_repair::{
    ScanState, TagRepairStore, album_folders, audio_files, read_file, signature,
};
use mediaverse_disc_metadata::acoustid::{self, Chosen, Found};
use mediaverse_metadata_tags::{TagField, patch_track_metadata};
use mediaverse_tag_repair::FolderFile;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

/// Songs asked about per album in a library scan.
pub const SAMPLE: usize = 5;
/// Albums with fewer songs than this are not checked (a pair of singles says little about an album).
const MIN_FILES: usize = 3;
/// A scan stops after this many albums in a row could not be asked about at all (the service is down or refusing us).
const GIVE_UP_AFTER: usize = 3;
/// File types the fingerprinting reads.
const READABLE: [&str; 3] = ["mp3", "flac", "wav"];

/// Which of `n` songs to ask about when `k` are wanted: spread from the first to the last.
pub fn sample_indices(n: usize, k: usize) -> Vec<usize> {
    if k == 0 || n == 0 {
        return Vec::new();
    }
    if n <= k {
        return (0..n).collect();
    }
    let mut picks: Vec<usize> = (0..k)
        .map(|i| (i * (n - 1) + (k - 1) / 2) / (k - 1).max(1))
        .collect();
    picks.dedup();
    picks
}

fn ordered(mut files: Vec<FolderFile>) -> Vec<FolderFile> {
    files.sort_by(|a, b| {
        (
            a.tags.disc.unwrap_or(1),
            a.tags.track.unwrap_or(999),
            &a.stem,
        )
            .cmp(&(
                b.tags.disc.unwrap_or(1),
                b.tags.track.unwrap_or(999),
                &b.stem,
            ))
    });
    files
}

fn readable(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| READABLE.contains(&e.to_ascii_lowercase().as_str()))
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// The results of earlier checks, one entry per album folder, kept in the data folder.
pub struct Store {
    file: PathBuf,
}

impl Store {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            file: data_dir.join("audio-check").join("results.json"),
        }
    }

    pub fn load(&self) -> BTreeMap<String, Value> {
        std::fs::read(&self.file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    pub fn save(&self, entries: &BTreeMap<String, Value>) -> Result<(), String> {
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let temp = self.file.with_extension("json.tmp");
        std::fs::write(
            &temp,
            serde_json::to_vec(entries).map_err(|e| e.to_string())?,
        )
        .and_then(|()| std::fs::rename(&temp, &self.file))
        .map_err(|e| format!("Could not save the results: {e}"))
    }

    fn put(&self, folder: &str, entry: Value) -> Result<(), String> {
        let mut entries = self.load();
        let dismissed = entries.get(folder).is_some_and(|e| e["dismissed"] == true);
        let mut entry = entry;
        entry["dismissed"] = json!(dismissed);
        entries.insert(folder.to_owned(), entry);
        self.save(&entries)
    }
}

impl Drives {
    /// Asks AcoustID about some or all of the songs of one album (already read, in any order) and compares the answers with
    /// their titles. `limit` is how many to ask about (spread over the album); `None` asks about every song.
    pub(crate) fn check_files(
        &self,
        asker: &Asker,
        files: Vec<FolderFile>,
        limit: Option<usize>,
        stop: &AtomicBool,
    ) -> Result<Value, HelperError> {
        let files = ordered(files);
        let picks = limit.map_or_else(
            || (0..files.len()).collect(),
            |k| sample_indices(files.len(), k),
        );
        let chosen: Vec<Chosen> = files
            .iter()
            .enumerate()
            .map(|(i, f)| Chosen {
                number: i as u32 + 1,
                title: f.tags.title.clone().unwrap_or_default(),
            })
            .collect();
        let mut answers: Vec<(u32, Result<Option<Found>, String>)> = Vec::new();
        let mut failures_in_a_row = 0;
        for &index in &picks {
            if stop.load(Ordering::SeqCst) {
                return Err(failure("cancelled", "Stopped."));
            }
            let number = index as u32 + 1;
            if failures_in_a_row >= GIVE_UP_AFTER {
                answers.push((
                    number,
                    Err("skipped after AcoustID failed to answer".to_owned()),
                ));
                continue;
            }
            let answer = self.ask_acoustid(asker, Path::new(&files[index].path));
            failures_in_a_row = if answer.is_err() {
                failures_in_a_row + 1
            } else {
                0
            };
            answers.push((number, answer));
        }
        let album = files
            .iter()
            .find_map(|f| f.tags.album.clone())
            .unwrap_or_default();
        let check = acoustid::check_disc(&album, &chosen, &answers);
        let mut value =
            serde_json::to_value(check).map_err(|e| failure("internal_error", e.to_string()))?;
        value["checked_at"] = json!(now());
        value["album"] = json!(album);
        value["artist"] = json!(
            files
                .iter()
                .find_map(|f| f
                    .tags
                    .album_artist
                    .clone()
                    .or_else(|| f.tags.artist.clone()))
                .unwrap_or_default()
        );
        value["total"] = json!(files.len());
        value["asked"] = json!(picks.len());
        value["files"] = json!(picks.iter().map(|&i| json!({ "number": i + 1, "path": files[i].path, "name": files[i].stem, "title": files[i].tags.title, "track": files[i].tags.track })).collect::<Vec<_>>());
        Ok(value)
    }

    /// One album folder: reads its songs' tags and checks them. The result is kept for the Audio check page.
    pub(crate) fn check_folder(
        &self,
        asker: &Asker,
        dir: &Path,
        limit: Option<usize>,
        stop: &AtomicBool,
    ) -> Result<Value, HelperError> {
        let paths: Vec<PathBuf> = audio_files(dir)
            .into_iter()
            .filter(|p| readable(p))
            .collect();
        let files: Vec<FolderFile> = paths.iter().filter_map(|p| read_file(p).ok()).collect();
        if files.is_empty() {
            return Err(failure(
                "no_files",
                "There are no songs in that folder this can listen to (MP3, FLAC or WAV).",
            ));
        }
        let mut value = self.check_files(asker, files, limit, stop)?;
        let folder = dir.to_string_lossy().into_owned();
        value["folder"] = json!(folder);
        value["signature"] = json!(signature(&paths));
        Store::new(&self.data_dir)
            .put(&folder, value.clone())
            .map_err(|m| failure("settings_save_failed", m))?;
        Ok(value)
    }

    /// Checks every album folder of the library that has not been checked (or has changed, or `again`), a sample of each.
    pub(crate) fn scan_audio(
        &self,
        root: &Path,
        again: bool,
        stop: &AtomicBool,
        progress: &ScanState,
        emit: &dyn Fn(&ScanState),
    ) -> Result<Value, HelperError> {
        let Some(asker) = self.acoustid_asker() else {
            return Err(failure(
                "not_configured",
                "AcoustID is not switched on. Turn it on and enter its key in Settings first.",
            ));
        };
        let folders: Vec<(PathBuf, Vec<PathBuf>)> = album_folders(root)
            .into_iter()
            .map(|(d, f)| (d, f.into_iter().filter(|p| readable(p)).collect::<Vec<_>>()))
            .filter(|(_, f)| f.len() >= MIN_FILES)
            .collect();
        let store = Store::new(&self.data_dir);
        let known = store.load();
        progress.total.store(folders.len(), Ordering::Relaxed);
        let (mut checked, mut skipped, mut failed_in_a_row) = (0usize, 0usize, 0usize);
        for (dir, files) in &folders {
            if stop.load(Ordering::SeqCst) {
                break;
            }
            let folder = dir.to_string_lossy().into_owned();
            if let Ok(mut current) = progress.current.lock() {
                *current = folder.clone();
            }
            let unchanged = known.get(&folder).is_some_and(|e| {
                e["signature"] == json!(signature(files)) && e["state"] != "failed"
            });
            if unchanged && !again {
                skipped += 1;
            } else {
                match self.check_folder(&asker, dir, Some(SAMPLE), stop) {
                    Ok(result) => {
                        checked += 1;
                        failed_in_a_row = if result["state"] == "failed" {
                            failed_in_a_row + 1
                        } else {
                            0
                        };
                        match result["state"].as_str() {
                            Some("agrees") => progress.identified.fetch_add(1, Ordering::Relaxed),
                            Some("mixed" | "different") => {
                                progress.unmatched.fetch_add(1, Ordering::Relaxed)
                            }
                            _ => 0,
                        };
                    }
                    Err((code, _)) if code == "cancelled" => break,
                    Err(_) => failed_in_a_row += 1,
                }
                if failed_in_a_row >= GIVE_UP_AFTER {
                    return Err(failure(
                        "service_unavailable",
                        "AcoustID is not answering right now, so the check stopped. Results so far are kept; run it again later.",
                    ));
                }
            }
            progress.done.fetch_add(1, Ordering::Relaxed);
            emit(progress);
        }
        Ok(
            json!({ "albums": folders.len(), "checked": checked, "skipped": skipped, "stopped": stop.load(Ordering::SeqCst) }),
        )
    }
}

/// The page of results: counts for every state, and the albums of the one asked for.
pub fn list(store: &Store, filter: &str, offset: usize, limit: usize) -> Value {
    let entries = store.load();
    let count = |states: &[&str], dismissed: bool| {
        entries
            .values()
            .filter(|e| {
                (e["dismissed"] == true) == dismissed
                    && states.contains(&e["state"].as_str().unwrap_or(""))
            })
            .count()
    };
    let summary = json!({
        "problems": count(&["mixed", "different"], false),
        "named": count(&["named"], false),
        "unknown": count(&["unknown"], false),
        "failed": count(&["failed"], false),
        "agrees": count(&["agrees"], false),
        "dismissed": entries.values().filter(|e| e["dismissed"] == true).count(),
        "checked": entries.len(),
    });
    let wanted: &[&str] = match filter {
        "named" => &["named"],
        "unknown" => &["unknown"],
        "failed" => &["failed"],
        "agrees" => &["agrees"],
        _ => &["mixed", "different"],
    };
    let dismissed = filter == "dismissed";
    let mut rows: Vec<(&String, &Value)> = entries
        .iter()
        .filter(|(_, e)| {
            (e["dismissed"] == true) == dismissed
                && (dismissed || wanted.contains(&e["state"].as_str().unwrap_or("")))
        })
        .collect();
    // The likeliest wrong ones first: nothing agrees, then some do not.
    rows.sort_by_key(|(folder, e)| (e["state"] != "different", folder.to_lowercase()));
    let total = rows.len();
    let folders: Vec<Value> = rows
        .into_iter()
        .skip(offset)
        .take(limit)
        .map(|(_, e)| e.clone())
        .collect();
    json!({ "summary": summary, "total": total, "offset": offset, "folders": folders })
}

/// "It is fine as it is": the album is left out of the problem list (and can be taken back).
pub fn dismiss(store: &Store, folder: &str, undo: bool) -> Result<(), String> {
    let mut entries = store.load();
    let entry = entries
        .get_mut(folder)
        .ok_or("This album is no longer in the results.")?;
    entry["dismissed"] = json!(!undo);
    store.save(&entries)
}

/// Writes the ticked titles into their songs, journalled in the Fix tags journal so "Undo it" there puts them back. The album's
/// stored result is dropped, since it no longer describes the files.
pub fn apply_names(
    tag_store: &TagRepairStore,
    store: &Store,
    dir: &Path,
    titles: &[(String, String)],
) -> Result<Value, (String, String)> {
    let mut journal: Vec<(String, String, Option<String>, Option<String>)> = Vec::new();
    let mut problems: Vec<Value> = Vec::new();
    let mut written = 0usize;
    for (path, title) in titles {
        let file = Path::new(path);
        let title = title.trim();
        if file.parent() != Some(dir) || title.is_empty() || title.chars().any(char::is_control) {
            problems.push(
                json!({ "path": path, "message": "That title cannot be written to that file." }),
            );
            continue;
        }
        match patch_track_metadata(file, &[(TagField::Title, Some(title.to_owned()))]) {
            Ok(before) => {
                written += 1;
                journal.push((
                    path.clone(),
                    "title".to_owned(),
                    before.into_iter().next().and_then(|(_, old)| old),
                    Some(title.to_owned()),
                ));
            }
            Err(e) => problems.push(json!({ "path": path, "message": e.to_string() })),
        }
    }
    let batch = tag_store.journal(&journal, 1, written).map_err(|e| {
        (
            "journal_failed".to_owned(),
            format!("The titles were written but could not be journalled: {e}"),
        )
    })?;
    let mut entries = store.load();
    entries.remove(dir.to_string_lossy().as_ref());
    let _ = store.save(&entries);
    Ok(json!({ "batch": batch, "files": written, "fields": journal.len(), "problems": problems }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::audio_check::tests::{reply, serve};
    use crate::fingerprint::tests::{tone, write_wav};
    use mediaverse_tag_repair::Tags;
    use std::sync::Arc;

    #[test]
    fn the_sample_is_spread_from_the_first_song_to_the_last() {
        assert_eq!(
            sample_indices(3, 5),
            vec![0, 1, 2],
            "a small album is asked about in full"
        );
        assert_eq!(sample_indices(12, 5), vec![0, 3, 6, 8, 11]);
        assert_eq!(sample_indices(10, 1), vec![0]);
        assert_eq!(sample_indices(0, 5), Vec::<usize>::new());
        let big = sample_indices(40, 5);
        assert_eq!(
            (big.first(), big.last(), big.len()),
            (Some(&0), Some(&39), 5)
        );
    }

    fn folder_file(path: &Path, title: &str, track: u32) -> FolderFile {
        FolderFile {
            path: path.to_string_lossy().into_owned(),
            stem: format!("{track:02}"),
            tags: Tags {
                title: Some(title.into()),
                album: Some("Sing the Sorrow".into()),
                track: Some(track),
                ..Tags::default()
            },
            length_ms: 11_000,
        }
    }

    #[test]
    fn a_folder_is_checked_in_part_or_in_full_and_the_stop_button_works() {
        let dir = std::env::temp_dir().join(format!("mv-audio-folder-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let drives = Drives::new(
            &dir.join("data"),
            crate::Output::new(std::io::sink()),
            Arc::new(|| None),
        );
        let (port, server) = serve(vec![
            reply("One"),
            reply("Not Two"),
            r#"{"status":"ok","results":[]}"#.to_owned(),
        ]);
        drives.metadata.update(&json!({ "acoustid": { "enabled": true, "api_key": "KEY", "base_url": format!("http://127.0.0.1:{port}"), "min_interval_ms": 1 } })).unwrap();
        let asker = drives.acoustid_asker().expect("keyed");
        let mut files = Vec::new();
        for n in 1..=3u32 {
            let path = dir.join(format!("{n:02}.wav"));
            write_wav(&path, &tone(10 + n, 11_025), 11_025);
            files.push(folder_file(
                &path,
                ["One", "Two", "Three"][n as usize - 1],
                n,
            ));
        }
        // Given out of order, asked about in track order; all three here.
        let shuffled = vec![files[2].clone(), files[0].clone(), files[1].clone()];
        let stop = AtomicBool::new(false);
        let check = drives.check_files(&asker, shuffled, None, &stop).unwrap();
        assert_eq!(check["state"], "mixed");
        assert_eq!(
            (check["total"].as_u64(), check["asked"].as_u64()),
            (Some(3), Some(3))
        );
        assert_eq!(check["tracks"][0]["state"], "agrees");
        assert_eq!(check["tracks"][1]["state"], "other");
        assert_eq!(
            check["files"][1]["title"], "Two",
            "the file list lines up with the track list"
        );
        server.join().unwrap();

        // Stopped before the first question: nothing is asked and it ends as cancelled.
        let stopped = AtomicBool::new(true);
        let (code, _) = drives
            .check_files(&asker, files.clone(), None, &stopped)
            .unwrap_err();
        assert_eq!(code, "cancelled");

        // A folder with nothing this can listen to says so, and keeps nothing.
        let empty = dir.join("empty");
        std::fs::create_dir_all(&empty).unwrap();
        let (code, _) = drives
            .check_folder(&asker, &empty, Some(SAMPLE), &stop)
            .unwrap_err();
        assert_eq!(code, "no_files");
        assert!(Store::new(&dir.join("data")).load().is_empty());

        // A result is kept per album, and a later one keeps the person's "it is fine".
        let store = Store::new(&dir.join("data"));
        store.put("C:/m/a", json!({ "state": "mixed" })).unwrap();
        dismiss(&store, "C:/m/a", false).unwrap();
        store
            .put("C:/m/a", json!({ "state": "different" }))
            .unwrap();
        assert_eq!(store.load()["C:/m/a"]["dismissed"], true);
        assert_eq!(store.load()["C:/m/a"]["state"], "different");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_results_list_puts_the_likeliest_wrong_albums_first_and_dismissing_hides_them() {
        let dir = std::env::temp_dir().join(format!("mv-audio-list-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Store::new(&dir);
        let mut entries = BTreeMap::new();
        for (folder, state) in [
            ("C:/m/b", "mixed"),
            ("C:/m/a", "different"),
            ("C:/m/c", "agrees"),
            ("C:/m/d", "unknown"),
            ("C:/m/e", "mixed"),
        ] {
            entries.insert(
                folder.to_owned(),
                json!({ "folder": folder, "state": state, "dismissed": false }),
            );
        }
        store.save(&entries).unwrap();
        let problems = list(&store, "problems", 0, 10);
        assert_eq!(problems["total"], 3);
        assert_eq!(
            problems["folders"][0]["folder"], "C:/m/a",
            "nothing agreeing comes first"
        );
        assert_eq!(problems["summary"]["agrees"], 1);
        dismiss(&store, "C:/m/a", false).unwrap();
        assert_eq!(list(&store, "problems", 0, 10)["total"], 2);
        assert_eq!(list(&store, "dismissed", 0, 10)["total"], 1);
        dismiss(&store, "C:/m/a", true).unwrap();
        assert_eq!(list(&store, "problems", 0, 10)["total"], 3);
        assert!(dismiss(&store, "C:/m/none", false).is_err());
        let _ = std::fs::remove_dir_all(&dir);
    }

    fn mp3(path: &Path, title: &str) {
        let mut bytes = Vec::new();
        for _ in 0..4 {
            bytes.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
            bytes.extend(std::iter::repeat_n(0u8, 413));
        }
        std::fs::write(path, bytes).unwrap();
        patch_track_metadata(
            path,
            &[
                (TagField::Title, Some(title.to_owned())),
                (TagField::Artist, Some("AFI".to_owned())),
            ],
        )
        .unwrap();
    }

    #[test]
    fn ticked_titles_are_written_journalled_and_put_back_by_undo_and_other_folders_are_refused() {
        let base = std::env::temp_dir().join(format!("mv-audio-names-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let album = base.join("Album");
        std::fs::create_dir_all(&album).unwrap();
        mp3(&album.join("01.mp3"), "Track 1");
        mp3(&album.join("02.mp3"), "Track 2");
        let (tag_store, store) = (TagRepairStore::new(&base), Store::new(&base));
        store
            .put(&album.to_string_lossy(), json!({ "state": "named" }))
            .unwrap();
        let first = album.join("01.mp3").to_string_lossy().into_owned();
        let elsewhere = base.join("other.mp3");
        mp3(&elsewhere, "Not mine");
        let titles = vec![
            (first.clone(), "Real Title".to_owned()),
            (
                elsewhere.to_string_lossy().into_owned(),
                "Hijack".to_owned(),
            ),
            (
                album.join("02.mp3").to_string_lossy().into_owned(),
                "  ".to_owned(),
            ),
        ];
        let result = apply_names(&tag_store, &store, &album, &titles).unwrap();
        assert_eq!(result["files"], 1, "{result}");
        assert_eq!(
            result["problems"].as_array().unwrap().len(),
            2,
            "a file of another folder and a blank title are refused: {result}"
        );
        let title = |p: &Path| read_file(p).unwrap().tags.title;
        assert_eq!(title(&album.join("01.mp3")).as_deref(), Some("Real Title"));
        assert_eq!(title(&album.join("02.mp3")).as_deref(), Some("Track 2"));
        assert_eq!(title(&elsewhere).as_deref(), Some("Not mine"));
        assert!(
            store.load().is_empty(),
            "the stored result no longer describes the files"
        );
        let undone =
            crate::tag_repair::undo(&tag_store, result["batch"].as_i64().unwrap()).unwrap();
        assert_eq!(undone["files"], 1, "{undone}");
        assert_eq!(title(&album.join("01.mp3")).as_deref(), Some("Track 1"));
        let _ = std::fs::remove_dir_all(&base);
    }

    /// Live check on a real album folder. Run by hand:
    /// `MV_TEST_FOLDER=... MV_ACOUSTID_KEY=... cargo test -p mediaverse_sidecar --lib live_folder -- --ignored --nocapture`
    #[test]
    #[ignore = "needs the network, an AcoustID key and a real album folder"]
    fn live_folder_check_on_a_real_album() {
        let (Ok(folder), Ok(key)) = (
            std::env::var("MV_TEST_FOLDER"),
            std::env::var("MV_ACOUSTID_KEY"),
        ) else {
            panic!("set MV_TEST_FOLDER and MV_ACOUSTID_KEY")
        };
        let base = std::env::temp_dir().join(format!("mv-live-folder-{}", std::process::id()));
        let drives = Drives::new(
            &base,
            crate::Output::new(std::io::sink()),
            Arc::new(|| None),
        );
        drives
            .metadata
            .update(&json!({ "acoustid": { "enabled": true, "api_key": key } }))
            .unwrap();
        let asker = drives.acoustid_asker().unwrap();
        let result = drives
            .check_folder(
                &asker,
                Path::new(&folder),
                Some(SAMPLE),
                &AtomicBool::new(false),
            )
            .unwrap();
        println!(
            "{} / {} - {}",
            result["artist"], result["album"], result["headline"]
        );
        println!("asked {} of {}", result["asked"], result["total"]);
        for (track, file) in result["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .zip(result["files"].as_array().unwrap())
        {
            println!(
                "  {:>2} {:<28} tags: {:<28} acoustid: {} ({})",
                track["number"],
                file["name"].as_str().unwrap_or(""),
                file["title"].as_str().unwrap_or(""),
                track["title"].as_str().unwrap_or("-"),
                track["state"]
            );
        }
        println!("hint: {}", result["album_hint"]);
        let _ = std::fs::remove_dir_all(&base);
    }
}
