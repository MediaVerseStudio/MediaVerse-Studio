//! A library-wide check for lyrics that do not belong to their song (owner, 2026-11-19; D152). Every song that already has lyrics is listened to and its lyrics are forced
//! into the singing with the music-lyrics reader: lyrics that fit the singing badly (an instrumental with lyrics, another song's words, samples) are listed for a person.
//! Nothing is ever changed or removed by this check; the list only says which songs to look at. A person chooses whether songs already marked instrumental are included.
//!
//! The threshold is the one found on the owner's first-line check (D149): the three wrong lyrics among 25 written by the AI all fitted at -2.8 or worse and every right
//! one was better than that.

use super::judge::CORROBORATED_MIN_FIT;
use super::*;

/// Lyrics that fit the singing worse than this are listed as not belonging to the song.
pub const WRONG_BELOW: f64 = CORROBORATED_MIN_FIT;
/// Fewer words than this and there is too little text to judge.
const MIN_WORDS: usize = 12;
/// A song checked in the last 30 days is skipped unless the person asks for it again.
const RECHECK_AFTER_DAYS: u64 = 30;

/// The song's lyrics as plain lines of text, from what `track_lyrics` read out of the file (the synced lines when there are no plain ones).
pub fn lyrics_text(existing: &Value) -> String {
    let plain = existing["plain"].as_str().unwrap_or("").trim();
    if !plain.is_empty() {
        return lyric_lines(plain).join("\n");
    }
    existing["lines"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| l["text"].as_str())
        .filter(|t| !t.trim().is_empty())
        .map(str::to_owned)
        .collect::<Vec<_>>()
        .join("\n")
}

/// What listening says about the lyrics a song already has: "no singing" (words, but almost nothing sung), "does not fit", "fits" or "unchecked".
pub fn verdict_of(no_singing: bool, fit: Option<f64>) -> &'static str {
    // The fit decides when there is one: loud music with screamed vocals (industrial, metal) can make the singing detector doubt itself while the words still fit
    // (Nine Inch Nails "Ruiner", checked 2026-11-20). "No singing" is said only when the words fit badly or could not be placed at all.
    match (no_singing, fit) {
        (true, Some(f)) if f >= WRONG_BELOW => "fits",
        (true, _) => "no singing",
        (false, Some(f)) if f < WRONG_BELOW => "does not fit",
        (false, Some(_)) => "fits",
        (false, None) => "unchecked",
    }
}

fn checked_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("lyric-ai").join("wrongcheck")
}

/// Whether a song's earlier check is recent enough to skip it.
fn recently_checked(marker: &Path, now: u64) -> bool {
    std::fs::metadata(marker)
        .and_then(|m| m.modified())
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .is_some_and(|t| now.saturating_sub(t.as_secs()) < RECHECK_AFTER_DAYS * 24 * 3600)
}

fn now_secs() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

impl Drives {
    /// `lyric_ai_wrong_check {paths, include_instrumental?, again?}`: a job that listens to songs that already have lyrics and records those whose lyrics do not fit
    /// (see the module). Songs marked instrumental are left out unless `include_instrumental`; songs checked in the last 30 days are skipped unless `again`.
    pub(crate) fn lyric_ai_wrong_check(
        self: &std::sync::Arc<Self>,
        args: &Value,
    ) -> Result<Value, (String, String)> {
        let paths: Vec<String> = args["paths"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        if paths.is_empty() || paths.len() > 50_000 {
            return Err(fail("invalid_arguments", "Give between 1 and 50000 songs."));
        }
        let config = load_config(&self.data_dir);
        if config.reader_model != "music" {
            return Err(fail(
                "not_configured",
                "The check judges lyrics by how well they fit the singing, which is calibrated for the music-lyrics model: choose it in Settings > Lyrics > Lyric AI.",
            ));
        }
        let missing = config.missing();
        if !missing.is_empty() {
            return Err(fail(
                "not_configured",
                format!(
                    "The Lyric AI is not set up: missing {}.",
                    missing.join(", ")
                ),
            ));
        }
        let include_instrumental = args["include_instrumental"].as_bool().unwrap_or(false);
        let again = args["again"].as_bool().unwrap_or(false);
        Ok(self.start_job(move |this, id| {
            let (canceller, stop) = Canceller::flag();
            if let Ok(mut jobs) = this.jobs.lock() {
                jobs.insert(id.to_owned(), canceller);
            }
            let root = (this.library_root)();
            let dir = checked_dir(&this.data_dir);
            let _ = std::fs::create_dir_all(&dir);
            let instrumental = crate::lyrics_instrumental::Store::new(&this.data_dir);
            let total = paths.len();
            let (mut checked, mut wrong, mut no_singing, mut no_lyrics, mut skipped, mut failed) =
                (0usize, 0usize, 0usize, 0usize, 0usize, 0usize);
            let mut streak = super::FailStreak::default();
            let mut aborted: Option<String> = None;
            for (n, path) in paths.iter().enumerate() {
                if aborted.is_some() || stop.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
                this.output.emit("job-progress", json!({ "kind": "lyric_wrong", "done": n, "total": total, "current": Path::new(path).file_name().map(|f| f.to_string_lossy().into_owned()) }));
                if !include_instrumental && instrumental.is_instrumental(path) {
                    skipped += 1;
                    continue;
                }
                let marker = dir.join(format!("{}.json", crate::lyrics_review::key_of(path)));
                if !again && recently_checked(&marker, now_secs()) {
                    skipped += 1;
                    continue;
                }
                match this.lyric_wrong_song(path, root.as_deref()) {
                    Ok(None) => {
                        streak.succeeded();
                        no_lyrics += 1;
                    }
                    Ok(Some(result)) => {
                        streak.succeeded();
                        checked += 1;
                        match result["verdict"].as_str() {
                            Some("does not fit") => wrong += 1,
                            Some("no singing") => no_singing += 1,
                            _ => {}
                        }
                        let mut record = result.clone();
                        // A person's "keep it" is kept when the same verdict comes again.
                        if let Some(old) = std::fs::read(&marker)
                            .ok()
                            .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
                            && old["dismissed"] == true
                            && old["verdict"] == record["verdict"]
                        {
                            record["dismissed"] = json!(true);
                        }
                        let _ = std::fs::write(&marker, record.to_string());
                        if result["verdict"] != "fits" {
                            this.output.emit("job-progress", json!({ "kind": "lyric_wrong_found", "result": result }));
                        }
                    }
                    Err(message) => {
                        failed += 1;
                        if streak.failed(&message) {
                            aborted = Some(message);
                        }
                    }
                }
            }
            Ok(json!({ "songs": total, "checked": checked, "wrong": wrong, "no_singing": no_singing, "no_lyrics": no_lyrics, "skipped": skipped, "failed": failed, "aborted": aborted, "stopped": stop.load(std::sync::atomic::Ordering::SeqCst) }))
        }))
    }

    /// Listens to one song that has lyrics. `Ok(None)`: the song has no lyrics (or too few words) to check.
    fn lyric_wrong_song(&self, path: &str, root: Option<&Path>) -> Result<Option<Value>, String> {
        let existing = crate::library_media::track_lyrics(path, root).unwrap_or(Value::Null);
        let text = lyrics_text(&existing);
        let words = mediaverse_lyric_ai::text::words(&text, true).len();
        if words < MIN_WORDS {
            return Ok(None);
        }
        let file = resolve_in_library(path, root)?;
        let tags =
            mediaverse_metadata_tags::read_track_metadata(&file).map_err(|e| e.to_string())?;
        let (left, right) = decode_for_listening(&file)?;
        self.lyric_ai
            .with_engine(|engine| {
                let listening = engine.listen(&left, &right, |_| {})?;
                let no_singing = listening.voice.probably_instrumental();
                let fit = engine.fit(&listening, &text);

                Ok(json!({
                    "path": path, "title": tags.title, "artist": tags.artist, "album": tags.album,
                    "seconds": listening.seconds.round(), "words": words,
                    "fit": fit.map(|f| (f * 100.0).round() / 100.0),
                    "verdict": verdict_of(no_singing, fit), "checked": now_secs(), "dismissed": false,
                }))
            })
            .map(Some)
    }

    /// `lyric_ai_wrong_results`: the songs whose lyrics did not fit (not those the person said to keep), worst fit first, and how many were checked.
    pub(crate) fn lyric_ai_wrong_results(&self) -> Value {
        let all: Vec<Value> = std::fs::read_dir(checked_dir(&self.data_dir))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| std::fs::read(e.path()).ok())
            .filter_map(|b| serde_json::from_slice::<Value>(&b).ok())
            .collect();
        let mut items: Vec<Value> = all
            .iter()
            .filter(|r| r["verdict"] != "fits" && r["dismissed"] != true)
            .cloned()
            .collect();
        items.sort_by(|a, b| {
            a["fit"]
                .as_f64()
                .unwrap_or(f64::NEG_INFINITY)
                .total_cmp(&b["fit"].as_f64().unwrap_or(f64::NEG_INFINITY))
        });
        json!({ "items": items, "checked": all.len() })
    }

    /// `lyric_ai_wrong_dismiss {path, dismissed?}`: the person looked and the lyrics are fine (or puts the song back on the list).
    pub(crate) fn lyric_ai_wrong_dismiss(&self, args: &Value) -> Result<Value, (String, String)> {
        let path = args["path"]
            .as_str()
            .ok_or_else(|| fail("invalid_arguments", "Give the song's path."))?;
        let marker = checked_dir(&self.data_dir)
            .join(format!("{}.json", crate::lyrics_review::key_of(path)));
        let mut record: Value = std::fs::read(&marker)
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .ok_or_else(|| fail("not_found", "That song is not on the list."))?;
        record["dismissed"] = json!(args["dismissed"].as_bool().unwrap_or(true));
        std::fs::write(&marker, record.to_string())
            .map_err(|e| fail("io", format!("could not save: {e}")))?;
        Ok(json!({ "dismissed": record["dismissed"] }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_verdict_follows_the_singing_and_the_fit() {
        assert_eq!(verdict_of(true, None), "no singing");
        assert_eq!(
            verdict_of(true, Some(-0.2)),
            "fits",
            "the detector doubting the singing is overruled by words that fit it"
        );
        assert_eq!(verdict_of(true, Some(-3.2)), "no singing");
        assert_eq!(verdict_of(false, Some(-0.4)), "fits");
        assert_eq!(
            verdict_of(false, Some(-2.79)),
            "fits",
            "the weakest right one seen was -2.67"
        );
        assert_eq!(verdict_of(false, Some(-2.81)), "does not fit");
        assert_eq!(verdict_of(false, Some(-3.47)), "does not fit");
        assert_eq!(verdict_of(false, None), "unchecked");
    }

    #[test]
    fn the_lyrics_text_comes_from_the_plain_lyrics_or_else_the_timed_lines() {
        let plain = json!({ "plain": "  one two\nthree four  ", "lines": [{ "ms": 1, "text": "ignored" }] });
        assert_eq!(lyrics_text(&plain), "one two\nthree four");
        let timed = json!({ "lines": [{ "ms": 1000, "text": "la la" }, { "ms": 2000, "text": "  " }, { "ms": 3000, "text": "da da" }] });
        assert_eq!(lyrics_text(&timed), "la la\nda da");
        assert_eq!(lyrics_text(&Value::Null), "");
    }

    #[test]
    fn songs_marked_instrumental_are_told_apart_and_a_recheck_waits_30_days() {
        let dir = std::env::temp_dir().join(format!("mv-wrongcheck-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = crate::lyrics_instrumental::Store::new(&dir);
        assert!(!store.is_instrumental("C:\\Music\\a.mp3"));
        store.mark("C:\\Music\\a.mp3", "test", 1).unwrap();
        assert!(store.is_instrumental("C:\\Music\\a.mp3"));
        store.unmark("C:\\Music\\a.mp3").unwrap();
        assert!(
            !store.is_instrumental("C:\\Music\\a.mp3"),
            "put back by the person"
        );
        let marker = dir.join("m.json");
        assert!(
            !recently_checked(&marker, now_secs()),
            "no file: not checked"
        );
        std::fs::write(&marker, "{}").unwrap();
        assert!(recently_checked(&marker, now_secs()));
        assert!(!recently_checked(&marker, now_secs() + 31 * 24 * 3600));
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Real-data check (read only): the songs in `LYRIC_WRONG_FILES` (one path a line) are listened to with the owner's models and the verdict of each is printed.
    ///   LYRIC_JUDGE_DATA=<app data folder>  LYRIC_WRONG_FILES=<text file>  (optional LYRIC_WRONG_N: only every n-th path)
    #[test]
    #[ignore = "needs the models and the owner's library (see the comment)"]
    fn a_real_data_check_of_lyrics_already_in_songs() {
        let data = PathBuf::from(std::env::var("LYRIC_JUDGE_DATA").expect("LYRIC_JUDGE_DATA"));
        let list =
            std::fs::read_to_string(std::env::var("LYRIC_WRONG_FILES").expect("LYRIC_WRONG_FILES"))
                .unwrap();
        let every: usize = std::env::var("LYRIC_WRONG_N")
            .ok()
            .and_then(|n| n.parse().ok())
            .unwrap_or(1);
        let ai = LyricAi::new(&data);
        let (mut fits, mut wrong, mut silent, mut other) = (0, 0, 0, 0);
        for path in list
            .lines()
            .map(str::trim)
            .filter(|l| !l.is_empty())
            .step_by(every.max(1))
        {
            let existing =
                crate::library_media::track_lyrics(path, Some(Path::new("C:\\Users\\Sam")))
                    .unwrap_or(Value::Null);
            let text = lyrics_text(&existing);
            let words = mediaverse_lyric_ai::text::words(&text, true).len();
            if words < MIN_WORDS {
                println!("NO LYRICS ({words} words) | {path}");
                other += 1;
                continue;
            }
            let outcome = resolve_in_library(path, Some(Path::new("C:\\Users\\Sam")))
                .and_then(|p| decode_for_listening(&p))
                .and_then(|(left, right)| {
                    ai.with_engine(|engine| {
                        let listening = engine.listen(&left, &right, |_| {})?;
                        let quiet = listening.voice.probably_instrumental();
                        let fit = engine.fit(&listening, &text);
                        Ok((quiet, fit))
                    })
                });
            match outcome {
                Ok((quiet, fit)) => {
                    let verdict = verdict_of(quiet, fit);
                    match verdict {
                        "fits" => fits += 1,
                        "does not fit" => wrong += 1,
                        "no singing" => silent += 1,
                        _ => other += 1,
                    }
                    println!(
                        "{verdict:13} fit {:>6} | {path}",
                        fit.map_or("-".to_owned(), |f| format!("{f:.2}"))
                    );
                }
                Err(e) => {
                    other += 1;
                    println!("ERROR {e} | {path}");
                }
            }
        }
        println!("fits {fits}, does not fit {wrong}, no singing {silent}, other {other}");
    }
}
