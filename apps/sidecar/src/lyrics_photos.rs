//! Lyrics by photo (owner, 2026-11-20): photos of a booklet's lyric pages are read on this computer with the PP-OCRv5 text models
//! (PaddlePaddle, Apache-2.0, a separate download of about 170 MB that is never inside the installer), split into song panels, matched
//! to an album's tracks by their titles, and the words are repaired with a word list counted from the lyrics the library already has.
//! Nothing is saved into a song here: the page shows what was read, the person fixes the matching, and the words go to Review >
//! Lyrics > To review (`save_lyrics_review`) like any other doubtful lyrics, where they are played, timed and confirmed.

use crate::drives::{Drives, failure};
use crate::helper::Canceller;
use crate::vision_reader::{
    STANZA_PROMPT, Server, page_picture, photo_for_reading, picture_for_editor,
};
use mediaverse_host::EventSink;
use mediaverse_page_reader::{
    Habits, PageReader, Panel, Vocabulary, borrow_breaks, match_tracks, panels_from_lines,
    songs_from_reading, unify_repeats,
};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::atomic::Ordering;

/// The model files, pinned to the published revision of each official repository (so a later change upstream cannot reach a
/// person unannounced) with the exact size each must have.
const MODEL_FILES: [(&str, &str, u64); 3] = [
    (
        "det-inference.onnx",
        "https://huggingface.co/PaddlePaddle/PP-OCRv5_server_det_onnx/resolve/dcf248c4dcc064c6d030db241255f9e8fbc6733a/inference.onnx",
        88_116_791,
    ),
    (
        "rec-inference.onnx",
        "https://huggingface.co/PaddlePaddle/PP-OCRv5_server_rec_onnx/resolve/b70df217f4fd99d14f970bad092cebe7d74cc4d1/inference.onnx",
        84_503_027,
    ),
    (
        "rec-inference.yml",
        "https://huggingface.co/PaddlePaddle/PP-OCRv5_server_rec_onnx/resolve/b70df217f4fd99d14f970bad092cebe7d74cc4d1/inference.yml",
        148_345,
    ),
];

const MAX_PHOTOS: usize = 40;
/// How many of the library's songs are read for their words (a spread over the whole library: that is plenty for a word list).
const VOCAB_SONGS: usize = 3000;
const AUDIO_EXTENSIONS: [&str; 6] = ["mp3", "flac", "m4a", "ogg", "opus", "wma"];

fn model_dir(data_dir: &Path) -> PathBuf {
    crate::lyric_ai::load_config(data_dir)
        .models
        .join("page-reader")
}

fn missing_files(dir: &Path) -> Vec<&'static str> {
    MODEL_FILES
        .iter()
        .filter(|(name, _, size)| {
            std::fs::metadata(dir.join(name)).map_or(true, |m| m.len() != *size)
        })
        .map(|(name, _, _)| *name)
        .collect()
}

fn words_file(data_dir: &Path) -> PathBuf {
    data_dir
        .join("lyric-ai")
        .join("page-reader")
        .join("words.json")
}

/// The word list saved from an earlier run, as `{songs, words: {word: count}}`.
fn load_words(path: &Path) -> Option<(usize, Vocabulary, Habits)> {
    let saved: Value = serde_json::from_slice(&std::fs::read(path).ok()?).ok()?;
    // A list saved before the habits (commas, apostrophes, capitals) were learned is made again.
    if saved["version"].as_u64()? < WORDS_VERSION {
        return None;
    }
    let counts = saved["words"].as_object()?;
    let vocab = Vocabulary::from_counts(
        counts
            .iter()
            .filter_map(|(w, n)| Some((w.clone(), u32::try_from(n.as_u64()?).ok()?))),
    );
    let triple = |v: &Value| -> Option<(u32, u32, u32)> {
        Some((
            u32::try_from(v[0].as_u64()?).ok()?,
            u32::try_from(v[1].as_u64()?).ok()?,
            u32::try_from(v[2].as_u64()?).ok()?,
        ))
    };
    let pair = |v: &Value| -> Option<(u32, u32)> {
        Some((
            u32::try_from(v[0].as_u64()?).ok()?,
            u32::try_from(v[1].as_u64()?).ok()?,
        ))
    };
    let habits = Habits::from_parts(
        saved["shapes"]
            .as_object()?
            .iter()
            .filter_map(|(w, v)| Some((w.clone(), triple(v)?))),
        saved["commas"]
            .as_object()?
            .iter()
            .filter_map(|(w, v)| Some((w.clone(), pair(v)?))),
        saved["before"]
            .as_object()?
            .iter()
            .filter_map(|(w, v)| Some((w.clone(), pair(v)?))),
        saved["after"]
            .as_object()?
            .iter()
            .filter_map(|(w, v)| Some((w.clone(), pair(v)?))),
    );
    Some((saved["songs"].as_u64()? as usize, vocab, habits))
}

/// Bumped when what is saved in the word list changes, so an older file is learned again.
const WORDS_VERSION: u64 = 3;

fn save_words(path: &Path, songs: usize, vocab: &Vocabulary, habits: &Habits) {
    // Words seen once are dropped from the saved list: they are mostly typing mistakes, and it keeps the file small.
    let words: serde_json::Map<String, Value> = vocab
        .counts()
        .filter(|(_, n)| *n >= 2)
        .map(|(w, n)| (w.to_owned(), json!(n)))
        .collect();
    let shapes: serde_json::Map<String, Value> = habits
        .shapes()
        .map(|(w, (a, b, c))| (w.to_owned(), json!([a, b, c])))
        .collect();
    let commas: serde_json::Map<String, Value> = habits
        .commas()
        .map(|(w, (a, b))| (w.to_owned(), json!([a, b])))
        .collect();
    let before: serde_json::Map<String, Value> = habits
        .before()
        .map(|(w, (a, b))| (w.to_owned(), json!([a, b])))
        .collect();
    let after: serde_json::Map<String, Value> = habits
        .after()
        .map(|(w, (a, b))| (w.to_owned(), json!([a, b])))
        .collect();
    if let Some(parent) = path.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let _ = std::fs::write(
        path,
        json!({ "version": WORDS_VERSION, "songs": songs, "words": words, "shapes": shapes, "commas": commas, "before": before, "after": after }).to_string(),
    );
}

fn library_songs(root: &Path) -> Vec<PathBuf> {
    let mut songs = Vec::new();
    let mut stack = vec![root.to_path_buf()];
    while let Some(folder) = stack.pop() {
        for entry in std::fs::read_dir(&folder).into_iter().flatten().flatten() {
            let path = entry.path();
            if path.is_dir() {
                stack.push(path);
            } else if path
                .extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| AUDIO_EXTENSIONS.contains(&e.to_ascii_lowercase().as_str()))
            {
                songs.push(path);
            }
        }
    }
    songs.sort();
    songs
}

/// A panel's title: the reading or its repaired form, whichever is closer to one of the album's titles.
fn best_title(raw: &str, fixed: &str, titles: &[String]) -> String {
    let score = |t: &str| {
        titles
            .iter()
            .map(|a| mediaverse_page_reader::layout::title_similarity(t, a))
            .fold(0.0f32, f32::max)
    };
    if score(fixed) >= score(raw) {
        fixed.to_owned()
    } else {
        raw.to_owned()
    }
}

/// Where one album's saved work is kept: the album folder's key.
fn session_file(data_dir: &Path, album: &str) -> PathBuf {
    data_dir
        .join("lyric-ai")
        .join("page-reader")
        .join("sessions")
        .join(format!("{}.json", crate::lyrics_review::key_of(album)))
}

/// The biggest saved session accepted (the pictures of the pages are inside it).
const MAX_SESSION_BYTES: usize = 64 * 1024 * 1024;

impl Drives {
    /// `lyric_photos_session_save {album, state}`: keeps the work on one album (the photos read, which page is which song, the words as
    /// corrected so far, which songs are checked) so it can be carried on later, even after the program is closed.
    pub(crate) fn lyric_photos_session_save(
        &self,
        args: &Value,
    ) -> Result<Value, (String, String)> {
        let album = args["album"].as_str().unwrap_or("").trim();
        if album.is_empty() || !args["state"].is_object() {
            return Err(failure(
                "invalid_arguments",
                "Give the album and its state.",
            ));
        }
        let text = json!({ "album": album, "saved": std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs()), "state": args["state"] })
        .to_string();
        if text.len() > MAX_SESSION_BYTES {
            return Err(failure("too_large", "That is too much to keep."));
        }
        let path = session_file(&self.data_dir, album);
        if let Some(parent) = path.parent() {
            std::fs::create_dir_all(parent)
                .map_err(|e| failure("save_failed", format!("Could not make the folder: {e}")))?;
        }
        let temp = path.with_extension("json.tmp");
        std::fs::write(&temp, text)
            .map_err(|e| failure("save_failed", format!("Could not save: {e}")))?;
        std::fs::rename(&temp, &path)
            .map_err(|e| failure("save_failed", format!("Could not save: {e}")))?;
        Ok(json!({ "saved": true }))
    }

    /// `lyric_photos_session_load {album}`: the saved work on an album, or `null`.
    pub(crate) fn lyric_photos_session_load(
        &self,
        args: &Value,
    ) -> Result<Value, (String, String)> {
        let album = args["album"].as_str().unwrap_or("").trim();
        if album.is_empty() {
            return Err(failure("invalid_arguments", "Give the album."));
        }
        let saved: Option<Value> = std::fs::read(session_file(&self.data_dir, album))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok());
        Ok(saved.filter(|s| s["album"] == album).unwrap_or(Value::Null))
    }

    /// `lyric_photos_session_forget {album}`: removes the saved work on an album.
    pub(crate) fn lyric_photos_session_forget(
        &self,
        args: &Value,
    ) -> Result<Value, (String, String)> {
        let album = args["album"].as_str().unwrap_or("").trim();
        if album.is_empty() {
            return Err(failure("invalid_arguments", "Give the album."));
        }
        let _ = std::fs::remove_file(session_file(&self.data_dir, album));
        Ok(json!({ "forgotten": true }))
    }

    /// `lyric_photos_status`: whether the models are on this computer, where they go, and what is missing.
    pub(crate) fn lyric_photos_status(&self) -> Value {
        let dir = model_dir(&self.data_dir);
        let missing = missing_files(&dir);
        json!({
            "installed": missing.is_empty(),
            "folder": dir.display().to_string(),
            "missing": missing,
            "download_mb": 172,
            "licence": "Apache-2.0",
            "source": "https://huggingface.co/PaddlePaddle/PP-OCRv5_server_rec_onnx",
            "runtime_ready": crate::lyric_ai::load_config(&self.data_dir).runtime.is_file(),
            "vision": self.vision_status(),
        })
    }

    /// `lyric_photos_read {photos, tracks?}`: a job that reads the photos and answers with every panel found (title, words, how sure) and,
    /// for the album's `tracks` (`[{path, title}]`), which panel looks like which track. Nothing is saved.
    pub(crate) fn lyric_photos_read(
        self: &std::sync::Arc<Self>,
        args: &Value,
    ) -> Result<Value, (String, String)> {
        let photos: Vec<PathBuf> = args["photos"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(PathBuf::from)
            .collect();
        if photos.is_empty() || photos.len() > MAX_PHOTOS {
            return Err(failure(
                "invalid_arguments",
                format!("Give between 1 and {MAX_PHOTOS} photos."),
            ));
        }
        if let Some(bad) = photos.iter().find(|p| {
            !p.extension()
                .and_then(|e| e.to_str())
                .is_some_and(|e| matches!(e.to_ascii_lowercase().as_str(), "jpg" | "jpeg" | "png"))
                || !p.is_file()
        }) {
            return Err(failure(
                "invalid_arguments",
                format!(
                    "{} is not a JPEG or PNG picture that exists.",
                    bad.display()
                ),
            ));
        }
        let tracks: Vec<(String, String)> = args["tracks"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|t| {
                (
                    t["path"].as_str().unwrap_or("").to_owned(),
                    t["title"].as_str().unwrap_or("").to_owned(),
                )
            })
            .collect();
        let rotations: Vec<u32> = (0..photos.len())
            .map(|i| {
                let turn = args["rotations"][i].as_u64().unwrap_or(0) as u32 % 360;
                if turn % 90 == 0 { turn } else { 0 }
            })
            .collect();
        let config = crate::lyric_ai::load_config(&self.data_dir);
        let dir = model_dir(&self.data_dir);
        let vision = crate::vision_reader::ready(&self.data_dir);
        if !vision {
            if !missing_files(&dir).is_empty() {
                return Err(failure(
                    "not_configured",
                    "The photo reader is not on this computer yet. Download it first (about 3 GB, once).",
                ));
            }
            if !config.runtime.is_file() {
                return Err(failure(
                    "not_configured",
                    format!(
                        "ONNX Runtime is missing ({}): set up the Lyric AI in Settings > Lyrics first.",
                        config.runtime.display()
                    ),
                ));
            }
        }
        Ok(self.start_job(move |this, id| {
            let (canceller, stop) = Canceller::flag();
            if let Ok(mut jobs) = this.jobs.lock() {
                jobs.insert(id.to_owned(), canceller);
            }
            let progress = |step: &str, done: usize, total: usize| {
                this.output.emit("job-progress", json!({ "kind": "lyric_photos", "step": step, "done": done, "total": total }));
            };
            let cancelled = || failure("cancelled", "Stopped.");

            // 1. the word list: counted once from the library's lyrics, then kept
            let words_path = words_file(&this.data_dir);
            let (mut vocab, habits) = match load_words(&words_path) {
                Some((_, vocab, habits)) => (vocab, habits),
                None => {
                    let mut vocab = Vocabulary::default();
                    let mut habits = Habits::default();
                    let root = (this.library_root)();
                    let songs = root.as_deref().map(library_songs).unwrap_or_default();
                    let step = (songs.len() / VOCAB_SONGS).max(1);
                    let chosen: Vec<&PathBuf> = songs.iter().step_by(step).collect();
                    let mut read = 0usize;
                    for (n, song) in chosen.iter().enumerate() {
                        if stop.load(Ordering::SeqCst) {
                            return Err(cancelled());
                        }
                        if n % 50 == 0 {
                            progress("Learning the words from your library's lyrics", n, chosen.len());
                        }
                        if let Ok(found) = crate::library_media::track_lyrics(&song.to_string_lossy(), root.as_deref()) {
                            let text = crate::lyric_ai::wrongcheck::lyrics_text(&found);
                            if !text.is_empty() {
                                vocab.add(&text);
                                habits.add(&text);
                                read += 1;
                            }
                        }
                    }
                    save_words(&words_path, read, &vocab, &habits);
                    (vocab, habits)
                }
            };
            // the album's own titles are words too
            for (_, title) in &tracks {
                for _ in 0..3 {
                    vocab.add(title);
                }
            }

            // 2. the photos, read by the vision reader when it is installed (the older line-by-line reader otherwise)
            let titles: Vec<String> = tracks.iter().map(|(_, t)| t.clone()).collect();
            let mut all: Vec<(usize, Panel)> = Vec::new();
            let pictures: Vec<String>;
            let mut crops: Vec<String>;
            if vision {
                progress("Starting the photo reader (the first start takes a moment)", 0, photos.len());
                let server = match Server::start(&this.data_dir, true, &stop) {
                    Ok(server) => server,
                    Err(_) if stop.load(Ordering::SeqCst) => return Err(cancelled()),
                    Err(first) => Server::start(&this.data_dir, false, &stop).map_err(|second| {
                        failure("read_failed", format!("{first} Then on the processor alone: {second}"))
                    })?,
                };
                // the words are printed as the booklet has them, so only the capitals and apostrophes are restored from the library's habits
                let mut page_crops: Vec<String> = Vec::new();
                let shapes_only = Habits::from_parts(habits.shapes().map(|(k, v)| (k.to_owned(), v)), [], [], []);
                for (n, photo) in photos.iter().enumerate() {
                    if stop.load(Ordering::SeqCst) {
                        return Err(cancelled());
                    }
                    progress(
                        &format!("Reading {}", photo.file_name().map_or_else(String::new, |f| f.to_string_lossy().into_owned())),
                        n,
                        photos.len(),
                    );
                    let jpeg = photo_for_reading(photo, rotations[n]).map_err(|e| failure("read_failed", e))?;
                    let text = server.read(&jpeg, &stop).map_err(|m| {
                        if stop.load(Ordering::SeqCst) { cancelled() } else { failure("read_failed", m) }
                    })?;
                    for mut panel in songs_from_reading(&text, &titles, &vocab) {
                        let fixed = vocab.correct_line(&panel.title);
                        panel.title = best_title(&panel.title, &fixed, &titles);
                        panel.lines = panel
                            .lines
                            .iter()
                            .map(|l| if l.is_empty() { String::new() } else { shapes_only.restore_line(&vocab.correct_line(l), &vocab) })
                            .collect();
                        unify_repeats(&mut panel.lines, |l| vocab.known_fraction(l));
                        let known: Vec<f32> = panel.lines.iter().filter(|l| !l.is_empty()).map(|l| vocab.known_fraction(l)).collect();
                        panel.score = if known.is_empty() { 0.0 } else { known.iter().sum::<f32>() / known.len() as f32 };
                        // where this song's page is in the photo, to show beside its words; the page read again by itself keeps the
                        // gaps between stanzas better than the whole photo does, so its gaps are borrowed (the words are not)
                        let mut crop = String::new();
                        if !panel.title.is_empty() {
                            if let Some(part) = server.locate(&jpeg, &panel.title) {
                                let page = page_picture(photo, rotations[n], part);
                                if !page.is_empty() {
                                    crop = crate::artist_photos_wiki::base64(&page);
                                    if let Ok(again) = server.read_with(&page, &stop, STANZA_PROMPT) {
                                        panel.lines = borrow_breaks(&panel.lines, &again);
                                    }
                                }
                            }
                        }
                        page_crops.push(crop);
                        all.push((n, panel));
                    }
                }
                drop(server);
                progress("Keeping the pictures of the pages", photos.len(), photos.len());
                pictures = photos.iter().enumerate().map(|(n, p)| picture_for_editor(p, rotations[n])).collect();
                crops = page_crops;
            } else {
                pictures = Vec::new();
                progress("Loading the photo reader", 0, photos.len());
                mediaverse_lyric_engine::models::init(&config.runtime).map_err(|e| failure("not_configured", e))?;
                let mut reader = PageReader::open(&dir).map_err(|e| failure("not_configured", e))?;
                for (n, photo) in photos.iter().enumerate() {
                    if stop.load(Ordering::SeqCst) {
                        return Err(cancelled());
                    }
                    progress(
                        &format!("Reading {}", photo.file_name().map_or_else(String::new, |f| f.to_string_lossy().into_owned())),
                        n,
                        photos.len(),
                    );
                    let lines = reader.read(photo).map_err(|e| failure("read_failed", e))?;
                    for mut panel in panels_from_lines(&lines) {
                        let fixed = vocab.correct_line(&panel.title);
                        panel.title = best_title(&panel.title, &fixed, &titles);
                        // the words repaired, then the commas, apostrophes and capitals the small print lost put back, then repeated lines made alike
                        panel.lines = panel
                            .lines
                            .iter()
                            .map(|l| habits.restore_line(&vocab.correct_line(l), &vocab))
                            .collect();
                        unify_repeats(&mut panel.lines, |l| vocab.known_fraction(l));
                        all.push((n, panel));
                    }
                }
                progress("Cutting out the pages", photos.len(), photos.len());
                // the picture each panel was read from, to show beside its words while they are corrected
                crops = vec![String::new(); all.len()];
                for (n, photo) in photos.iter().enumerate() {
                    let indexes: Vec<usize> = (0..all.len()).filter(|&i| all[i].0 == n).collect();
                    let boxes: Vec<[f32; 4]> = indexes.iter().map(|&i| all[i].1.bounds).collect();
                    if let Ok(found) = mediaverse_page_reader::crop_jpegs(photo, &boxes, 1600) {
                        for (index, bytes) in indexes.into_iter().zip(found) {
                            crops[index] = crate::artist_photos_wiki::base64(&bytes);
                        }
                    }
                }
            }
            progress("Matching the songs", photos.len(), photos.len());

            // 3. which panel is which track (across all the photos: a page that appears in two photos is used once)
            let panels: Vec<Panel> = all.iter().map(|(_, p)| p.clone()).collect();
            let matches = match_tracks(&panels, &titles);
            let panel_json = |index: usize| {
                let (photo, panel) = &all[index];
                let matched = matches.iter().find(|m| m.panel == index);
                json!({
                    "photo": photo, "title": panel.title, "score": (panel.score * 100.0).round() / 100.0,
                    "lines": panel.lines, "text": panel.text(), "crop_base64": crops[index],
                    "track": matched.map(|m| m.track), "similarity": matched.map(|m| (m.similarity * 100.0).round() / 100.0),
                })
            };
            Ok(json!({
                "photos": photos.iter().map(|p| p.display().to_string()).collect::<Vec<_>>(),
                "pictures": pictures, "reader": if vision { "vision" } else { "basic" },
                "panels": (0..all.len()).map(panel_json).collect::<Vec<_>>(),
                "tracks": tracks.iter().enumerate().map(|(i, (path, title))| json!({
                    "index": i, "path": path, "title": title,
                    "panel": matches.iter().find(|m| m.track == i).map(|m| m.panel),
                })).collect::<Vec<_>>(),
                "words_known": vocab.len(),
            }))
        }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_missing_or_wrong_sized_file_counts_as_missing() {
        let dir = std::env::temp_dir().join(format!("mvs-photos-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        assert_eq!(missing_files(&dir).len(), 3);
        std::fs::write(dir.join("rec-inference.yml"), vec![0u8; 148_345]).unwrap();
        std::fs::write(dir.join("det-inference.onnx"), b"too short").unwrap();
        assert_eq!(
            missing_files(&dir),
            vec!["det-inference.onnx", "rec-inference.onnx"]
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_word_list_survives_a_save_and_keeps_only_repeated_words() {
        let dir = std::env::temp_dir().join(format!("mvs-words-{}", std::process::id()));
        let path = dir.join("words.json");
        let mut vocab = Vocabulary::default();
        vocab.add("burn burn burn once");
        save_words(&path, 7, &vocab, &Habits::default());
        let (songs, loaded, _) = load_words(&path).expect("saved list");
        assert_eq!(songs, 7);
        assert_eq!(loaded.len(), 1, "the word seen once is not kept");
        assert_eq!(loaded.correct_line("burn"), "burn");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_better_of_two_readings_of_a_title_is_kept() {
        let titles = vec!["Never Apologize".to_owned()];
        assert_eq!(
            best_title("Nevcr Apologize", "Never Apologize", &titles),
            "Never Apologize"
        );
        assert_eq!(
            best_title("Never Apologize", "Never Apologise me", &titles),
            "Never Apologize"
        );
    }

    /// Tuning of the comma rule against lyrics a person corrected: `MV_WORDS` is a saved word list, `MV_TRUTH` a text file of correct lines.
    /// Each line has its commas taken out, they are put back by the rule at several settings, and hits and false commas are counted.
    #[test]
    #[ignore = "needs a saved word list and corrected lines"]
    fn tuning_the_comma_rule() {
        let words = std::path::PathBuf::from(std::env::var("MV_WORDS").expect("MV_WORDS"));
        let truth = std::fs::read_to_string(std::env::var("MV_TRUTH").expect("MV_TRUTH")).unwrap();
        let (_, vocab, habits) = load_words(&words).expect("word list");
        for (share, min) in [
            (55, 3),
            (45, 3),
            (35, 3),
            (30, 2),
            (25, 2),
            (20, 2),
            (15, 2),
            (10, 2),
        ] {
            let habits = habits.clone().with_comma_rule(share, min);
            let (mut hit, mut wrong, mut missed) = (0, 0, 0);
            for line in truth.lines() {
                let stripped = line.replace(',', "");
                let restored = habits.restore_line(&stripped, &vocab);
                let a: Vec<&str> = line.split_whitespace().collect();
                let b: Vec<&str> = restored.split_whitespace().collect();
                if a.len() != b.len() {
                    continue;
                }
                for (x, y) in a.iter().zip(&b) {
                    match (x.ends_with(','), y.ends_with(',')) {
                        (true, true) => hit += 1,
                        (false, true) => wrong += 1,
                        (true, false) => missed += 1,
                        _ => {}
                    }
                }
            }
            println!(
                "share {share:>2}% min {min}: commas right {hit}, false commas {wrong}, missed {missed}"
            );
        }
    }

    /// The same tuning for the per-word rule (a word that usually follows a comma, after a word that often has one).
    #[test]
    #[ignore = "needs a saved word list and corrected lines"]
    fn tuning_the_word_comma_rule() {
        let words = std::path::PathBuf::from(std::env::var("MV_WORDS").expect("MV_WORDS"));
        let truth = std::fs::read_to_string(std::env::var("MV_TRUTH").expect("MV_TRUTH")).unwrap();
        let (_, vocab, habits) = load_words(&words).expect("word list");
        for before in [60, 40, 30, 20, 15, 10, 8, 5] {
            for after in [30, 20, 15, 10, 5, 3, 1] {
                let habits = habits
                    .clone()
                    .with_comma_rule(101, 99)
                    .with_word_rule(before, after);
                let (mut hit, mut wrong, mut missed) = (0, 0, 0);
                for line in truth.lines() {
                    let restored = habits.restore_line(&line.replace(',', ""), &vocab);
                    let a: Vec<&str> = line.split_whitespace().collect();
                    let b: Vec<&str> = restored.split_whitespace().collect();
                    if a.len() != b.len() {
                        continue;
                    }
                    for (x, y) in a.iter().zip(&b) {
                        match (x.ends_with(','), y.ends_with(',')) {
                            (true, true) => hit += 1,
                            (false, true) => wrong += 1,
                            (true, false) => missed += 1,
                            _ => {}
                        }
                    }
                }
                println!(
                    "before>={before:>2}% after>={after:>2}%: right {hit}, false {wrong}, missed {missed}"
                );
            }
        }
    }
}
