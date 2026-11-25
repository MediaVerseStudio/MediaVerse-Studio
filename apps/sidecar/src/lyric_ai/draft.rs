//! Drafting lyrics by listening (owner, 2026-11-19): for a song nobody has lyrics for, Whisper writes down what it hears, the music reader checks how well those
//! words fit the singing (the same fit score that tells right lyrics from wrong ones) and times them line by line. A draft is only ever put under General review,
//! labelled as a draft, for a person to correct and confirm; it is never written into a song by itself.
//!
//! Measured on 40 library songs against their true lyrics (`judge-lab/whisper_fit.py`): the draft's fit predicts its word errors (correlation -0.88). At a fit of
//! -0.5 or better about 20% of the words are wrong ("good"), between -0.5 and -1.0 about 40% ("fair"), and below -1.0 most are ("poor": not kept).

use super::*;

/// A draft that fits the singing this well (or better) is "good"; down to `FAIR_FIT` it is "fair"; below that it is not kept.
pub const GOOD_FIT: f64 = -0.5;
pub const FAIR_FIT: f64 = -1.0;
/// Fewer lines or words than this heard in a song: too little to call a draft.
const MIN_LINES: usize = 4;
const MIN_WORDS: usize = 12;
const MAX_LINE_WORDS: usize = 9;

/// Lines from Whisper's running text: after a sentence mark, after a comma once the line has a few words, and at the most nine words; the marks at the ends of
/// lines are taken off (lyrics are written without them).
pub fn draft_lines(text: &str) -> Vec<String> {
    let mut lines: Vec<String> = Vec::new();
    let mut current: Vec<&str> = Vec::new();
    let finish = |current: &mut Vec<&str>, lines: &mut Vec<String>| {
        if current.is_empty() {
            return;
        }
        let line = current.join(" ");
        let line = line
            .trim_end_matches(['.', ',', ';', ':', '-', '…', ' '])
            .trim()
            .to_owned();
        if line.chars().any(char::is_alphanumeric) {
            lines.push(line);
        }
        current.clear();
    };
    for word in text.split_whitespace() {
        current.push(word);
        let ends_sentence = word.ends_with(['.', '?', '!', ';']) && !word.ends_with("..");
        let ends_phrase = word.ends_with(',') && current.len() >= 4;
        if ends_sentence || ends_phrase || current.len() >= MAX_LINE_WORDS {
            finish(&mut current, &mut lines);
        }
    }
    finish(&mut current, &mut lines);
    lines
}

/// "good", "fair" or "poor" by how well the words fit the singing.
pub fn draft_quality(fit: f64) -> &'static str {
    if fit >= GOOD_FIT {
        "good"
    } else if fit >= FAIR_FIT {
        "fair"
    } else {
        "poor"
    }
}

/// The match percentage shown for a draft: 80 for a perfect fit down to 40 at the "fair" limit (a draft is never as sure as lyrics somebody wrote).
pub fn draft_confidence(fit: f64) -> u64 {
    (40.0 + 40.0 * (fit - FAIR_FIT)).clamp(40.0, 80.0).round() as u64
}

/// A draft from what Whisper heard (`text`) of one listened song: checked, timed, ready to be kept under General review (a result with `lrc`), or the reason it is not.
pub fn build_draft(
    engine: &mut Engine,
    listening: &Listening,
    text: &str,
    path: &str,
    title: &str,
    artist: &str,
) -> Value {
    let mut result = json!({
        "path": path, "title": title, "artist": artist, "task": "draft",
        "seconds": listening.seconds.round(),
        "voice": { "letters": (listening.voice.letters * 1000.0).round() / 1000.0 },
    });
    if listening.voice.probably_instrumental() {
        result["task"] = json!("instrumental");
        result["verdict"] = json!("probably instrumental (almost no singing heard)");
        result["need"] = json!("review");
        return result;
    }
    let lines = draft_lines(text);
    let words: usize = lines.iter().map(|l| l.split_whitespace().count()).sum();
    result["words"] = json!(words);
    if lines.len() < MIN_LINES || words < MIN_WORDS {
        result["verdict"] = json!("too little was heard to draft lyrics");
        result["need"] = json!("review");
        return result;
    }
    let Some(fit) = engine.fit(listening, &lines.join("\n")) else {
        result["verdict"] = json!("the draft could not be checked against the singing");
        result["need"] = json!("review");
        return result;
    };
    let fit_shown = (fit * 100.0).round() / 100.0;
    result["identity"] = json!({ "fit": fit_shown });
    result["draft_quality"] = json!(draft_quality(fit));
    if fit < FAIR_FIT {
        result["verdict"] = json!("the draft does not fit the singing well enough to keep");
        result["need"] = json!("review");
        return result;
    }
    let aligned = engine.time(listening, &lines);
    let placed = aligned.iter().filter(|l| l.start.is_some()).count();
    if placed * 10 < aligned.len() * 8 {
        result["verdict"] = json!("too few lines of the draft could be placed");
        result["need"] = json!("review");
        return result;
    }
    result["flagged"] = json!(aligned.iter().filter(|l| !l.flags.is_empty()).count());
    result["verdict"] = json!("draft");
    result["need"] = json!("review");
    result["confidence"] = json!(draft_confidence(fit));
    result["lines"] = lines_json(&aligned);
    result["lrc"] = json!(to_lrc(&aligned));
    result
}

fn drafted_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("lyric-ai").join("drafted")
}

/// Puts the draft under General review next to any suggestions the song already has.
fn keep_draft(review: &crate::lyrics_review::LyricsReview, path: &str, result: &Value) {
    let key = crate::lyrics_review::key_of(path);
    let mut candidates = vec![json!({
        "id": Value::Null, "track": result["title"], "artist": "Lyric AI draft (from listening)", "album": result["album"], "duration": Value::Null,
        "plain": result["lrc"].as_str().map(|l| lyric_lines(l).join("\n")), "synced": result["lrc"],
        "confidence": result["confidence"], "source": "whisper-draft",
        "other_version": false, "other_artist": false, "length_unknown": false,
    })];
    if let Ok(entry) = review.get(&key) {
        candidates.extend(
            entry["candidates"]
                .as_array()
                .into_iter()
                .flatten()
                .filter(|c| c["source"] != "whisper-draft")
                .cloned(),
        );
    }
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let args = json!({ "title": result["title"], "artist": result["artist"], "album": result["album"], "candidates": candidates });
    let _ = review.save(path, &args, now);
}

impl Drives {
    /// `lyric_ai_draft {paths, again?, with_suggestions?}`: a job that drafts lyrics for songs with none (see the module). Songs that already have suggestions under
    /// General review are left to the judge unless `with_suggestions`; songs drafted in the last 30 days are skipped unless `again`.
    pub(crate) fn lyric_ai_draft(
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
        if paths.is_empty() || paths.len() > 20_000 {
            return Err(fail("invalid_arguments", "Give between 1 and 20000 songs."));
        }
        let config = load_config(&self.data_dir);
        if config.reader_model != "music" {
            return Err(fail(
                "not_configured",
                "Drafting checks the words against the singing with the music-lyrics model: choose it in Settings > Lyrics > Lyric AI.",
            ));
        }
        let missing: Vec<String> = config
            .missing()
            .into_iter()
            .chain(
                whisper_files(&config.whisper_dir())
                    .err()
                    .unwrap_or_default(),
            )
            .collect();
        if !missing.is_empty() {
            return Err(fail(
                "not_configured",
                format!("Drafting is not set up: missing {}.", missing.join(", ")),
            ));
        }
        let again = args["again"].as_bool().unwrap_or(false);
        let with_suggestions = args["with_suggestions"].as_bool().unwrap_or(false);
        Ok(self.start_job(move |this, id| {
            let (canceller, stop) = Canceller::flag();
            if let Ok(mut jobs) = this.jobs.lock() {
                jobs.insert(id.to_owned(), canceller);
            }
            let root = (this.library_root)();
            let drafted = drafted_dir(&this.data_dir);
            let _ = std::fs::create_dir_all(&drafted);
            let review = crate::lyrics_review::LyricsReview::new(&this.data_dir);
            let (mut kept, mut nothing, mut failed, mut skipped) = (0usize, 0usize, 0usize, 0usize);
            let total = paths.len();
            let mut streak = super::FailStreak::default();
            let mut aborted: Option<String> = None;
            for (n, path) in paths.iter().enumerate() {
                if aborted.is_some() || stop.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
                this.output.emit("job-progress", json!({ "kind": "lyric_ai", "done": n, "total": total, "skipped": skipped, "current": Path::new(path).file_name().map(|f| f.to_string_lossy().into_owned()) }));
                let key = crate::lyrics_review::key_of(path);
                let marker = drafted.join(format!("{key}.json"));
                let fresh = !again
                    && std::fs::metadata(&marker)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age < std::time::Duration::from_secs(30 * 24 * 3600));
                let has_suggestions = !with_suggestions
                    && review
                        .get(&key)
                        .is_ok_and(|e| e["candidates"].as_array().is_some_and(|c| c.iter().any(|c| c["source"] != "whisper-draft")));
                if fresh || has_suggestions {
                    skipped += 1;
                    continue;
                }
                let result = match this.lyric_ai_draft_song(path, root.as_deref()) {
                    Ok(r) => {
                        streak.succeeded();
                        r
                    }
                    Err(message) => {
                        failed += 1;
                        if streak.failed(&message) {
                            aborted = Some(message.clone());
                        }
                        json!({ "path": path, "task": "error", "verdict": message, "need": "review" })
                    }
                };
                if result["task"] == "instrumental" {
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
                    let _ = crate::lyrics_instrumental::Store::new(&this.data_dir).mark(path, "no singing found (Lyric AI)", now);
                    nothing += 1;
                } else if result["lrc"].is_string() {
                    keep_draft(&review, path, &result);
                    kept += 1;
                } else if result["task"] != "error" {
                    nothing += 1;
                }
                if result["task"] != "error" {
                    let _ = std::fs::write(&marker, summary_of(&result, false).to_string());
                }
                this.output.emit("job-progress", json!({ "kind": "lyric_ai_result", "result": summary_of(&result, false) }));
            }
            Ok(json!({ "songs": total, "sure": 0, "applied": 0, "review": kept, "nothing": nothing, "skipped": skipped, "failed": failed, "aborted": aborted, "stopped": stop.load(std::sync::atomic::Ordering::SeqCst) }))
        }))
    }

    fn lyric_ai_draft_song(&self, path: &str, root: Option<&Path>) -> Result<Value, String> {
        let file = resolve_in_library(path, root)?;
        let tags =
            mediaverse_metadata_tags::read_track_metadata(&file).map_err(|e| e.to_string())?;
        let (left, right) = decode_for_listening(&file)?;
        let (title, artist) = (
            tags.title.clone().unwrap_or_default(),
            tags.artist.clone().unwrap_or_default(),
        );
        self.lyric_ai
            .with_engine(|engine| {
                let listening = engine.listen(&left, &right, |_| {})?;
                // Whisper is only run for a song in which something is sung.
                let text = if listening.voice.probably_instrumental() {
                    String::new()
                } else {
                    self.lyric_ai
                        .with_whisper(|whisper| whisper.transcribe(&listening.mix16, |_| {}))?
                };
                Ok(build_draft(
                    engine, &listening, &text, path, &title, &artist,
                ))
            })
            .map(|mut r| {
                r["album"] = json!(tags.album);
                r
            })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn whispers_running_text_becomes_lyric_lines() {
        let text = "Why are we still so surprised every time we buy the light? Why don't we pursue the truth, even when it's hard to do. Whoa, some things will never change";
        let lines = draft_lines(text);
        assert_eq!(
            lines,
            [
                "Why are we still so surprised every time we",
                "buy the light?",
                "Why don't we pursue the truth",
                "even when it's hard to do",
                "Whoa, some things will never change"
            ]
        );
        assert!(draft_lines("").is_empty());
        assert!(
            draft_lines("... . ,").is_empty(),
            "marks alone are not lines"
        );
        assert_eq!(draft_lines("Hey!"), ["Hey!"]);
    }

    #[test]
    fn a_drafts_quality_follows_how_well_it_fits_the_singing() {
        assert_eq!(draft_quality(-0.2), "good");
        assert_eq!(draft_quality(-0.5), "good");
        assert_eq!(draft_quality(-0.8), "fair");
        assert_eq!(draft_quality(-1.0), "fair");
        assert_eq!(draft_quality(-1.5), "poor");
        assert_eq!(draft_confidence(0.0), 80);
        assert_eq!(draft_confidence(-0.5), 60);
        assert_eq!(draft_confidence(-1.0), 40);
        assert_eq!(draft_confidence(-3.0), 40, "never below 40");
    }

    /// A dry run on songs where nothing fitted (`<data>/lyric-ai/results` or `judged`, verdict "no found lyrics match this recording"): each is drafted with Whisper
    /// and checked against the singing; nothing is saved. `LYRIC_JUDGE_DATA`, `LYRIC_JUDGE_N`, `LYRIC_JUDGE_SOURCE`, and for the readers `LYRIC_JUDGE_MODELS` (the
    /// music-lyrics ONNX folder) and `LYRIC_JUDGE_WHISPER` (the Whisper folder).
    #[test]
    #[ignore = "needs the models and the owner's library (see the comment)"]
    fn a_dry_run_of_drafts_for_songs_nothing_fitted() {
        let data = PathBuf::from(std::env::var("LYRIC_JUDGE_DATA").expect("LYRIC_JUDGE_DATA"));
        let wanted: usize = std::env::var("LYRIC_JUDGE_N")
            .ok()
            .and_then(|n| n.parse().ok())
            .unwrap_or(20);
        let sub = std::env::var("LYRIC_JUDGE_SOURCE").unwrap_or_else(|_| "results".to_owned());
        let mut misses: Vec<Value> = std::fs::read_dir(data.join("lyric-ai").join(&sub))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| std::fs::read(e.path()).ok())
            .filter_map(|b| serde_json::from_slice::<Value>(&b).ok())
            .filter(|r| r["verdict"] == "no found lyrics match this recording")
            .collect();
        misses.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
        let step = (misses.len() / wanted.max(1)).max(1);
        let settings = std::env::temp_dir().join("mv-draft-settings");
        std::fs::create_dir_all(&settings).unwrap();
        let mut saved: Value = std::fs::read(data.join("lyric-ai.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| json!({}));
        saved["reader_model"] = json!("music");
        saved["models"] = json!(std::env::var("LYRIC_JUDGE_MODELS").expect("LYRIC_JUDGE_MODELS"));
        saved["whisper_folder"] =
            json!(std::env::var("LYRIC_JUDGE_WHISPER").expect("LYRIC_JUDGE_WHISPER"));
        std::fs::write(
            settings.join("lyric-ai.json"),
            serde_json::to_vec_pretty(&saved).unwrap(),
        )
        .unwrap();
        let ai = LyricAi::new(&settings);
        let mut counts = std::collections::BTreeMap::<String, usize>::new();
        for miss in misses.iter().step_by(step).take(wanted) {
            let path = miss["path"].as_str().unwrap_or("");
            let outcome: Result<Value, String> = (|| {
                let file = PathBuf::from(path);
                let tags = mediaverse_metadata_tags::read_track_metadata(&file)
                    .map_err(|e| e.to_string())?;
                let (left, right) = decode_for_listening(&file)?;
                let (title, artist) = (
                    tags.title.unwrap_or_default(),
                    tags.artist.unwrap_or_default(),
                );
                ai.with_engine(|engine| {
                    let listening = engine.listen(&left, &right, |_| {})?;
                    let started = std::time::Instant::now();
                    let text = ai.with_whisper(|w| w.transcribe(&listening.mix16, |_| {}))?;
                    let seconds = started.elapsed().as_secs_f64();
                    let mut result = build_draft(engine, &listening, &text, path, &title, &artist);
                    result["whisper_seconds"] = json!((seconds * 10.0).round() / 10.0);
                    result["heard"] = json!(text.chars().take(150).collect::<String>());
                    Ok(result)
                })
            })();
            match outcome {
                Ok(r) => {
                    let label = format!(
                        "{} / {}",
                        r["task"].as_str().unwrap_or("?"),
                        r["draft_quality"]
                            .as_str()
                            .unwrap_or(r["verdict"].as_str().unwrap_or("?"))
                    );
                    *counts.entry(label.clone()).or_default() += 1;
                    println!(
                        "DRAFT {:28} {:26} | {label:24} fit {} words {} lines {} ({} s) | {}",
                        miss["artist"]
                            .as_str()
                            .unwrap_or("")
                            .chars()
                            .take(27)
                            .collect::<String>(),
                        miss["title"]
                            .as_str()
                            .unwrap_or("")
                            .chars()
                            .take(25)
                            .collect::<String>(),
                        r["identity"]["fit"],
                        r["words"],
                        r["lines"].as_array().map_or(0, Vec::len),
                        r["whisper_seconds"],
                        r["heard"].as_str().unwrap_or(""),
                    );
                }
                Err(e) => println!(
                    "DRAFT {path} | failed: {}",
                    e.chars().take(100).collect::<String>()
                ),
            }
        }
        println!("DRAFT summary: {counts:?}");
    }
}
