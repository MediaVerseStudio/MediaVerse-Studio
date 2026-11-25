//! Step 4 of Review > Lyrics: timing (owner, 2026-11-22; D169). Step 3 decides whose words belong to a song; this step only times words that are already settled and
//! can be run again and again: the words are never changed, only the time-stamped (synced) lyrics of the song are replaced, and the timing that was there is kept in
//! the batch's journal so Undo puts it back. The bar for writing is lower than Step 3's: a poor timing is something to improve gradually, wrong words are not.

use super::trust;
use super::*;
use mediaverse_lyric_ai::check::BIAS_SECONDS;

/// At least this share of the lines must be placed in the singing before a result is written.
pub const MIN_PLACED: f64 = 0.8;
/// At most this share of the lines may be doubtful before a result is written (Step 3 allows 10%).
pub const MAX_DOUBTFUL: f64 = 0.25;

/// What to time and how.
#[derive(Clone, Copy)]
pub struct TimeOptions {
    /// Also songs whose untimed lyrics the program found itself (their words are not confirmed).
    pub include_found: bool,
    /// Also songs that already have timing (it is replaced; Undo restores it).
    pub retime: bool,
    pub min_placed: f64,
    pub max_doubtful: f64,
}

/// The words to time for a song and where they came from, or why the song is left out.
pub fn words_to_time(
    existing: &Value,
    settled: bool,
    options: TimeOptions,
) -> Result<(Vec<String>, &'static str), &'static str> {
    let timed: Vec<String> = existing["lines"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| l["text"].as_str())
        .filter(|t| !t.trim().is_empty())
        .map(|t| t.trim().to_owned())
        .collect();
    if !timed.is_empty() {
        return if options.retime {
            Ok((timed, "timed"))
        } else {
            Err("already timed")
        };
    }
    if !trust::untimed(existing) {
        return Err("no lyrics");
    }
    if !settled && !options.include_found {
        return Err("words not confirmed");
    }
    let lines = trust::sung_lines(lyric_lines(existing["plain"].as_str().unwrap_or("")));
    if lines.len() < 4 {
        return Err("too few lines");
    }
    Ok((lines, if settled { "band" } else { "found" }))
}

/// The `(milliseconds, text)` of each line, as written into the song: every start less the aligner's lateness, a line that could not be placed sharing the time of
/// the line before it, never going backwards.
pub fn synced_lines(aligned: &[LineTime]) -> Vec<(u32, String)> {
    let mut previous = 0.0f64;
    aligned
        .iter()
        .map(|line| {
            if let Some(start) = line.start {
                previous = previous.max(start - BIAS_SECONDS);
            }
            (
                (previous * 1000.0).round().max(0.0) as u32,
                line.text.clone(),
            )
        })
        .collect()
}

/// What goes back to the lyrics editor for each line it sent: the time in milliseconds (never before the line above; a line the AI could not place shares the time of
/// the one above) and whether the AI, or a person, placed it. Same rule as `synced_lines`.
pub fn editor_times(aligned: &[LineTime]) -> Vec<(u32, bool)> {
    let mut previous = 0.0f64;
    aligned
        .iter()
        .map(|line| {
            if let Some(start) = line.start {
                previous = previous.max(start - BIAS_SECONDS);
            }
            (
                (previous * 1000.0).round().max(0.0) as u32,
                line.start.is_some(),
            )
        })
        .collect()
}

/// Whether a timing is good enough to be written without a person looking.
pub fn good_enough(
    lines: usize,
    placed: usize,
    doubtful: usize,
    words_fit: bool,
    options: TimeOptions,
) -> bool {
    lines > 0
        && words_fit
        && placed as f64 >= lines as f64 * options.min_placed
        && doubtful as f64 <= lines as f64 * options.max_doubtful
}

impl Drives {
    /// `lyric_ai_time {paths, include_found?, retime?, apply?, batch?}`: a job that times the words songs already have (see the module). With `apply` (and a `batch`
    /// id for Undo) timings that are good enough are written into the songs; the others wait under General review, timed.
    pub(crate) fn lyric_ai_time(
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
        let missing = load_config(&self.data_dir).missing();
        if !missing.is_empty() {
            return Err(fail(
                "not_configured",
                format!(
                    "The lyric AI is not set up: missing {}.",
                    missing.join(", ")
                ),
            ));
        }
        let options = TimeOptions {
            include_found: args["include_found"].as_bool().unwrap_or(false),
            retime: args["retime"].as_bool().unwrap_or(false),
            min_placed: MIN_PLACED,
            max_doubtful: MAX_DOUBTFUL,
        };
        let apply = args["apply"].as_bool().unwrap_or(false);
        let batch = args["batch"]
            .as_str()
            .filter(|b| {
                !b.is_empty()
                    && b.len() <= 64
                    && b.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            })
            .map(str::to_owned);
        if apply && batch.is_none() {
            return Err(fail(
                "invalid_arguments",
                "Writing timing needs a batch id (so it can be undone).",
            ));
        }
        Ok(self.start_job(move |this, id| {
            let (canceller, stop) = Canceller::flag();
            if let Ok(mut jobs) = this.jobs.lock() {
                jobs.insert(id.to_owned(), canceller);
            }
            trust::forget(); // what was written or confirmed a moment ago counts now
            let root = (this.library_root)();
            let total = paths.len();
            let (mut written, mut review, mut skipped, mut failed) = (0usize, 0usize, 0usize, 0usize);
            let mut streak = FailStreak::default();
            let mut aborted: Option<String> = None;
            for (n, path) in paths.iter().enumerate() {
                if aborted.is_some() || stop.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
                this.output.emit("job-progress", json!({ "kind": "lyric_time", "done": n, "total": total, "skipped": skipped, "current": Path::new(path).file_name().map(|f| f.to_string_lossy().into_owned()) }));
                let result = match this.lyric_time_song(path, root.as_deref(), options) {
                    Ok(None) => {
                        streak.succeeded();
                        skipped += 1;
                        continue;
                    }
                    Ok(Some(r)) => {
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
                let mut did_write = false;
                if result["need"] == "sure" && apply
                    && let (Some(batch), Some(lines)) = (batch.as_deref(), result["synced"].as_array())
                {
                    let lines: Vec<(u32, String)> = lines
                        .iter()
                        .filter_map(|l| Some((u32::try_from(l["ms"].as_u64()?).ok()?, l["text"].as_str()?.to_owned())))
                        .collect();
                    match crate::library_media::set_synced_lyrics(path, &lines, batch, root.as_deref(), &this.data_dir) {
                        Ok(()) => {
                            did_write = true;
                            written += 1;
                        }
                        Err(message) => {
                            failed += 1;
                            this.output.emit("job-progress", json!({ "kind": "lyric_time_result", "result": { "path": path, "task": "error", "verdict": message, "need": "review" } }));
                            continue;
                        }
                    }
                }
                if !did_write && result["task"] != "error" && result["lrc"].is_string() {
                    review += 1;
                    this.lyric_ai_to_review(path, &result);
                }
                this.output.emit("job-progress", json!({ "kind": "lyric_time_result", "result": summary_of(&result, did_write) }));
            }
            Ok(json!({ "songs": total, "written": written, "review": review, "skipped": skipped, "failed": failed, "aborted": aborted, "stopped": stop.load(std::sync::atomic::Ordering::SeqCst) }))
        }))
    }

    /// `lyric_ai_time_lines {path, lines: [{text, ms?, mine?}]}`: a job that times the lines a person is editing, in the lyrics editor, against the singing, without
    /// writing anything (the person saves). Lines with `mine: true` and a `ms` were timed by hand and stay exactly where they are; the others are placed between
    /// them (D172: the AI and the person take turns). The reply has one `{ms, placed, flags}` per line sent, in order.
    pub(crate) fn lyric_ai_time_lines(
        self: &std::sync::Arc<Self>,
        args: &Value,
    ) -> Result<Value, (String, String)> {
        let path = args["path"]
            .as_str()
            .filter(|p| !p.is_empty())
            .ok_or_else(|| fail("invalid_arguments", "Say which song."))?
            .to_owned();
        let sent = args["lines"]
            .as_array()
            .ok_or_else(|| fail("invalid_arguments", "Send the lines to time."))?;
        if sent.is_empty() || sent.len() > 2_000 {
            return Err(fail("invalid_arguments", "Send between 1 and 2000 lines."));
        }
        let texts: Vec<String> = sent
            .iter()
            .map(|l| l["text"].as_str().unwrap_or("").trim().to_owned())
            .collect();
        let anchors: Vec<(usize, f64)> = sent
            .iter()
            .enumerate()
            .filter(|(_, l)| l["mine"].as_bool() == Some(true))
            .filter_map(|(n, l)| Some((n, l["ms"].as_u64()? as f64 / 1000.0 + BIAS_SECONDS)))
            .collect();
        let missing = load_config(&self.data_dir).missing();
        if !missing.is_empty() {
            return Err(fail(
                "not_configured",
                format!(
                    "The lyric AI is not set up: missing {}.",
                    missing.join(", ")
                ),
            ));
        }
        Ok(self.start_job(move |this, _id| {
            let root = (this.library_root)();
            let file = resolve_in_library(&path, root.as_deref()).map_err(|m| fail("not_found", m))?;
            this.output.emit("job-progress", json!({ "kind": "lyric_time_lines", "step": "listening" }));
            let listening = this.lyric_ai.heard(&file).map_err(|m| fail("lyric_ai", m))?;
            if listening.voice.probably_instrumental() {
                return Err(fail("lyric_ai", "Almost no singing was heard in this song."));
            }
            this.output.emit("job-progress", json!({ "kind": "lyric_time_lines", "step": "placing" }));
            let floor = this.lyric_ai.limits().floor;
            let reply = this
                .lyric_ai
                .with_engine(|engine| {
                    let fit = engine.fit(&listening, &texts.join("\n"));
                    let aligned = engine.time_anchored(&listening, &texts, &anchors);
                    Ok((fit, aligned))
                })
                .map_err(|m| fail("lyric_ai", m))?;
            let (fit, aligned) = reply;
            let times = editor_times(&aligned);
            let doubtful = aligned.iter().filter(|l| !l.flags.is_empty()).count();
            let placed = times.iter().filter(|t| t.1).count();
            Ok(json!({
                "lines": times.iter().zip(&aligned).map(|((ms, placed), line)| json!({ "ms": ms, "placed": placed, "flags": line.flags })).collect::<Vec<_>>(),
                "placed": placed,
                "doubtful": doubtful,
                "anchored": anchors.len(),
                "fit": fit.map(|f| (f * 100.0).round() / 100.0),
                "words_fit": fit.is_some_and(|f| f >= floor),
                "seconds": listening.seconds.round(),
            }))
        }))
    }

    /// Times one song. `Ok(None)`: nothing to time (no lyrics, already timed and not asked for, words not confirmed, instrumental tag).
    fn lyric_time_song(
        &self,
        path: &str,
        root: Option<&Path>,
        options: TimeOptions,
    ) -> Result<Option<Value>, String> {
        let file = resolve_in_library(path, root)?;
        let existing = crate::library_media::track_lyrics(path, root).unwrap_or(Value::Null);
        if !existing.is_object() {
            return Ok(None);
        }
        let settled = trust::current(&self.data_dir).words_settled(path);
        let Ok((lines, source)) = words_to_time(&existing, settled, options) else {
            return Ok(None);
        };
        let tags =
            mediaverse_metadata_tags::read_track_metadata(&file).map_err(|e| e.to_string())?;
        let (left, right) = decode_for_listening(&file)?;
        let floor = self.lyric_ai.limits().floor;
        self.lyric_ai
            .with_engine(|engine| {
                let listening = engine.listen(&left, &right, |_| {})?;
                let mut result = json!({
                    "path": path, "title": tags.title, "artist": tags.artist, "album": tags.album,
                    "task": "time", "words": source, "seconds": listening.seconds.round(),
                });
                if listening.voice.probably_instrumental() {
                    result["verdict"] = json!("almost no singing was heard");
                    result["need"] = json!("review");
                    return Ok(result);
                }
                let fit = engine.fit(&listening, &lines.join("\n"));
                let aligned = engine.time(&listening, &lines);
                let placed = aligned.iter().filter(|l| l.start.is_some()).count();
                let doubtful = aligned.iter().filter(|l| !l.flags.is_empty()).count();
                let words_fit = fit.is_some_and(|f| f >= floor);
                result["identity"] = json!({ "fit": fit.map(|f| (f * 100.0).round() / 100.0) });
                result["flagged"] = json!(doubtful);
                result["placed"] = json!(placed);
                result["lines"] = lines_json(&aligned);
                result["lrc"] = json!(to_lrc(&aligned));
                result["band_words"] = json!(source == "band");
                result["synced"] = json!(
                    synced_lines(&aligned)
                        .into_iter()
                        .map(|(ms, text)| json!({ "ms": ms, "text": text }))
                        .collect::<Vec<_>>()
                );
                let good = good_enough(aligned.len(), placed, doubtful, words_fit, options);
                result["verdict"] = json!(if good {
                    "timed"
                } else if !words_fit {
                    "timed, but the words fit the singing poorly"
                } else {
                    "timed, but too many lines are doubtful"
                });
                result["need"] = json!(if good { "sure" } else { "review" });
                Ok(result)
            })
            .map(Some)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const OPTIONS: TimeOptions = TimeOptions {
        include_found: false,
        retime: false,
        min_placed: MIN_PLACED,
        max_doubtful: MAX_DOUBTFUL,
    };
    const WORDS: &str = "one two three\nfour five six\nseven eight nine\nten eleven twelve";

    #[test]
    fn a_bands_untimed_words_are_timed_without_being_asked_twice() {
        let existing = json!({ "plain": format!("[Chorus]\n{WORDS}") });
        let (lines, source) = words_to_time(&existing, true, OPTIONS).unwrap();
        assert_eq!((lines.len(), source), (4, "band"));
        assert!(words_to_time(&existing, false, OPTIONS).is_err());
        let found = TimeOptions {
            include_found: true,
            ..OPTIONS
        };
        assert_eq!(words_to_time(&existing, false, found).unwrap().1, "found");
    }

    #[test]
    fn songs_that_are_already_timed_wait_for_a_re_run() {
        let existing = json!({ "plain": WORDS, "lines": [{ "ms": 1000, "text": "la la la" }] });
        assert_eq!(
            words_to_time(&existing, true, OPTIONS),
            Err("already timed")
        );
        let again = TimeOptions {
            retime: true,
            ..OPTIONS
        };
        let (lines, source) = words_to_time(&existing, true, again).unwrap();
        assert_eq!((lines, source), (vec!["la la la".to_owned()], "timed"));
    }

    #[test]
    fn the_bar_for_writing_is_lower_than_step_three() {
        // 20 lines, 4 doubtful (20%): Step 3 (10%) would ask a person, Step 4 writes it.
        assert!(good_enough(20, 20, 4, true, OPTIONS));
        assert!(!good_enough(20, 20, 6, true, OPTIONS), "30% doubtful");
        assert!(!good_enough(20, 15, 0, true, OPTIONS), "only 75% placed");
        assert!(
            !good_enough(20, 20, 0, false, OPTIONS),
            "poor fit goes to a person"
        );
    }

    #[test]
    fn the_editor_gets_a_time_per_line_and_knows_which_were_placed() {
        let line = |start: Option<f64>| LineTime {
            text: "x".to_owned(),
            start,
            end: None,
            score: None,
            words: Vec::new(),
            flags: Vec::new(),
        };
        // A hand-timed line keeps its exact millisecond (its start is the written time plus the aligner's lateness); an unplaced line shares the one above.
        let sent = [line(Some(10.2)), line(None), line(Some(12.2))];
        assert_eq!(
            editor_times(&sent),
            [(10_000, true), (10_000, false), (12_000, true)]
        );
        let anchored = line(Some(65.432 + BIAS_SECONDS));
        assert_eq!(editor_times(&[anchored]), [(65_432, true)]);
    }

    #[test]
    fn written_times_never_go_backwards_and_unplaced_lines_share_the_line_before() {
        let line = |start: Option<f64>| LineTime {
            text: "x".to_owned(),
            start,
            end: None,
            score: None,
            words: Vec::new(),
            flags: Vec::new(),
        };
        let times: Vec<u32> = synced_lines(&[
            line(Some(10.2)),
            line(None),
            line(Some(9.0)),
            line(Some(12.2)),
        ])
        .iter()
        .map(|l| l.0)
        .collect();
        assert_eq!(times, [10_000, 10_000, 10_000, 12_000]);
    }
}
