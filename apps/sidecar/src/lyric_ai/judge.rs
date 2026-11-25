//! The Lyric AI judges what is waiting under Review > Lyrics > To review (owner, 2026-11-18). Those suggestions came from the automatic lyrics and were scored only by
//! how well their title, artist and length matched, never by listening. Here each suggestion is forced into the singing and the one that fits best is chosen; its
//! timing is checked and, where the singing says it is off, replaced. Words that are certain are written into the song; words that are only likely replace the
//! suggestion under To review (the AI's pick comes first, already timed); when no suggestion fits the singing, the song is searched again the way a song with no
//! lyrics is (a cover album's songs are found under the original artist that way), and when that fails too the song stays under To review untouched.

use super::*;
use mediaverse_lyric_ai::check::{BIAS_SECONDS, Fit, USUAL_OFFSET_MS};

/// Suggestions below this confidence are not judged by default (the owner saw them go bad under about 60%).
pub const MIN_CONFIDENCE: u64 = 60;
/// A line whose letters were mostly not heard (below this share) and clearly worse than the song's usual line is marked with a leading `*`: sung differently
/// from the page (live versions) or not sung.
pub const UNSUNG_LINE: f64 = 0.2;
/// When more than this share of the lines would be marked the aligner is simply unsure of the whole song, so no line is marked and the song goes to a person.
const MAX_MARKED_SHARE: f64 = 0.3;
/// A suggestion's own first line is moved to where the singing starts when they differ by at least this many seconds (after the aligner's usual lateness is allowed
/// for), and by no more than `FIRST_LINE_MOVE_MAX`: a bigger jump is more likely the aligner (or an intro marker) than a real correction (2 of 31 songs, 16 and 19 s).
const FIRST_LINE_MOVE: f64 = 0.25;
const FIRST_LINE_MOVE_MAX: f64 = 3.0;
/// At least this share of the stamped lines must fall within 0.7 s of the usual offset before agreeing stamps count as proof of the words (the 39 agreeing right
/// suggestions had 0.59 to 1.0; another song's lyrics had at most 0.08).
const CORROBORATED_SHARE: f64 = 0.5;
/// Agreeing time stamps make the words certain only when the words also fit the singing at least this well (D149). Three of the Lyric AI's 25 songs in the
/// owner's first-line check had lyrics that did not belong to them (an instrumental, samples, another song) and all three had been called "sure" with fits of
/// -2.91, -3.23 and -3.47; the right ones were all above -2.8. Of 719 "sure" results 26 are below it, so this costs a few songs a look, never the reverse.
pub(super) const CORROBORATED_MIN_FIT: f64 = -2.8;

/// Whether the suggestion's own time stamps agreeing with the singing make its words certain.
fn corroborates(own_fits: bool, agreeing: f64, fit: f64) -> bool {
    own_fits && agreeing >= CORROBORATED_SHARE && fit >= CORROBORATED_MIN_FIT
}
/// Marking lines with `*` is off: the rule (line score under 0.2 and under half the song's usual) marked 2.5% of the lines of live tracks and 3.1% of studio tracks
/// (160 songs, 2026-11-18), so it finds noise, not live deviations. It stays until a line-by-line comparison with what is sung separates the two.
pub const MARK_UNSUNG_LINES: bool = false;

/// The stamped lines of an LRC text, in time order: (seconds, text). Lines with several stamps appear once for each.
pub fn timed_lines(text: &str) -> Vec<(f64, String)> {
    let mut out = Vec::new();
    for raw in text.lines() {
        let mut rest = raw.trim();
        let mut stamps = Vec::new();
        while rest.starts_with('[') {
            let Some(end) = rest.find(']') else { break };
            let Some((minutes, seconds)) = rest[1..end].split_once(':') else {
                break;
            };
            let (Ok(minutes), Ok(seconds)) = (minutes.parse::<f64>(), seconds.parse::<f64>())
            else {
                break;
            };
            stamps.push(minutes * 60.0 + seconds);
            rest = rest[end + 1..].trim_start();
        }
        if rest.is_empty() {
            continue;
        }
        out.extend(stamps.into_iter().map(|s| (s, rest.to_owned())));
    }
    out.sort_by(|a, b| a.0.total_cmp(&b.0));
    out
}

fn median(mut values: Vec<f64>) -> Option<f64> {
    if values.is_empty() {
        return None;
    }
    values.sort_by(f64::total_cmp);
    Some(values[values.len() / 2])
}

/// The lines to write, and how many were marked with `*`. When the suggestion's own timing fits the singing it is kept (people made it, line ends included), but
/// a first line that starts clearly away from where the singing starts is moved there; otherwise the singing's timing is used for every line.
pub fn finish_lines(
    aligned: &[LineTime],
    own: &[(f64, String)],
    own_fits: bool,
    mark_unsung: bool,
) -> (Vec<LineTime>, usize) {
    let mut lines = aligned.to_vec();
    if own_fits && own.len() == aligned.len() {
        for (line, (at, _)) in lines.iter_mut().zip(own) {
            // `to_lrc` writes every start 0.2 s early (the aligner runs late); stamps people made are already right, so they are given that 0.2 s back.
            line.start = Some(*at + BIAS_SECONDS);
        }
        if let (Some(heard), Some((own_first, _))) = (
            aligned
                .first()
                .filter(|l| l.flags.is_empty())
                .and_then(|l| l.start),
            own.first(),
        ) && (FIRST_LINE_MOVE..=FIRST_LINE_MOVE_MAX)
            .contains(&(heard - BIAS_SECONDS - own_first).abs())
        {
            lines[0].start = Some(heard);
        }
    }
    if !mark_unsung {
        return (lines, 0);
    }
    let usual = median(aligned.iter().filter_map(|l| l.score).collect());
    let unsung = |l: &LineTime| match (l.start, l.score) {
        (None, _) => true,
        (Some(_), Some(s)) => s < UNSUNG_LINE && usual.is_some_and(|u| s < u * 0.5),
        _ => false,
    };
    let marked = aligned.iter().filter(|l| unsung(l)).count();
    if marked == 0 || marked as f64 > aligned.len() as f64 * MAX_MARKED_SHARE {
        return (lines, 0);
    }
    for (line, heard) in lines.iter_mut().zip(aligned) {
        if unsung(heard) {
            line.text = format!("* {}", line.text);
        }
    }
    (lines, marked)
}

/// Each distinct text forced into the song once, at most 30 of them (the same words sit on many records).
fn fit_each(engine: &mut Engine, listening: &Listening, texts: &[&str]) -> Vec<Option<f64>> {
    let mut tried: std::collections::HashMap<String, Option<f64>> =
        std::collections::HashMap::new();
    texts
        .iter()
        .map(|t| {
            let key = mediaverse_lyric_ai::text::words(t, true).join(" ");
            if let Some(known) = tried.get(&key) {
                return *known;
            }
            let fit = if tried.len() < 30 && !key.is_empty() {
                engine.fit(listening, t)
            } else {
                None
            };
            tried.insert(key, fit);
            fit
        })
        .collect()
}

fn text_of(candidate: &Value) -> Option<&str> {
    candidate["synced"].as_str().or(candidate["plain"].as_str())
}

/// Judges the open suggestions of one To review entry (`entry` is `get_lyrics_review`'s answer) against the song.
pub fn judge_song(
    engine: &mut Engine,
    path: &str,
    entry: &Value,
    listening_of: impl FnOnce(&mut Engine) -> Result<Listening, String>,
    title: &str,
    artist: &str,
    ctx: &Context,
) -> Result<Value, String> {
    let listening = listening_of(engine)?;
    // Almost no singing was heard: whatever words a record has, they are not what is sung here. (A "likely" match was once given to a song in which the reader heard
    // letters in 2% of the frames, because a short text over mostly silent audio fits cheaply.) It goes to Suspected instrumental for a person to confirm.
    if listening.voice.probably_instrumental() {
        return Ok(json!({
            "path": path, "title": title, "artist": artist, "album": entry["album"], "task": "instrumental",
            "seconds": listening.seconds.round(), "verdict": "probably instrumental (almost no singing heard)", "need": "review",
        }));
    }
    let open: Vec<&Value> = entry["candidates"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|c| c["rejected"] != true)
        .collect();
    let mut texts: Vec<String> = open
        .iter()
        .map(|c| {
            text_of(c)
                .map(|t| lyric_lines(t).join("\n"))
                .unwrap_or_default()
        })
        .collect();
    let mut fits = fit_each(
        engine,
        &listening,
        &texts.iter().map(String::as_str).collect::<Vec<_>>(),
    );
    // A suggestion that fits poorly may still be the right words sung in another order (the song opens with its chorus): try the chorus first for the best few.
    // Only an arrangement that fits clearly better replaces the written order.
    let mut arranged: Vec<usize> = Vec::new();
    let mut order: Vec<usize> = (0..fits.len()).filter(|&k| fits[k].is_some()).collect();
    order.sort_by(|&a, &b| {
        fits[b]
            .partial_cmp(&fits[a])
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    for k in order.into_iter().take(3) {
        let Some(written) = fits[k] else { continue };
        if written >= ctx.limits.floor {
            continue;
        }
        let lines_k: Vec<String> = texts[k].lines().map(str::to_owned).collect();
        let mut best: Option<(f64, Vec<String>)> = None;
        for arrangement in arrangements(&lines_k) {
            if let Some(f) = engine.fit(&listening, &arrangement.join("\n"))
                && f >= written + REARRANGE_GAIN
                && best.as_ref().is_none_or(|b| f > b.0)
            {
                best = Some((f, arrangement));
            }
        }
        if let Some((f, arrangement)) = best {
            texts[k] = arrangement.join("\n");
            fits[k] = Some(f);
            arranged.push(k);
        }
    }
    // Records of the same song (same artist and title) are one song when choosing.
    let names: Vec<(String, String)> = open
        .iter()
        .map(|c| {
            (
                c["artist"].as_str().unwrap_or("").to_owned(),
                c["track"].as_str().unwrap_or("").to_owned(),
            )
        })
        .collect();
    let mut merged = texts.clone();
    merge_same_song(&mut merged, &fits, &names);
    let refs: Vec<&str> = merged.iter().map(String::as_str).collect();
    let choice = choose_by_fit(&fits, &refs, ctx.limits);
    let mut result = json!({
        "path": path, "title": title, "artist": artist, "album": entry["album"], "task": "judge",
        "seconds": listening.seconds.round(), "suggestions": open.len(),
        "ranking": open.iter().zip(&fits).map(|(c, f)| json!({ "artist": c["artist"], "track": c["track"], "confidence": c["confidence"], "fit": f.map(|f| (f * 100.0).round() / 100.0) })).collect::<Vec<_>>(),
    });
    let (mut i, mut fit, words_sure) = match choice {
        Verdict::None => {
            // None of the suggestions is what is sung: look again, as for a song with no lyrics, with the singing already heard.
            let mut found = analyse_song(
                engine,
                path,
                &Value::Null,
                move |_| Ok(listening),
                title,
                artist,
                ctx,
            )?;
            found["task"] = json!("judge");
            found["searched"] = json!(true);
            found["suggestions"] = result["suggestions"].clone();
            found["suggestions_ranking"] = result["ranking"].clone();
            return Ok(found);
        }
        Verdict::Likely(i, fit) => (i, fit, false),
        Verdict::Sure(i, fit) => (i, fit, true),
    };
    // Words read from the booklet and corrected by the person are the best words there are for the song (capitals, punctuation, their own check). When they fit the
    // singing about as well as the best suggestion they are the ones timed, instead of another record's near copy (owner, 2026-11-21: Nervous Energy came out at 86%
    // from a copy of the words he had already corrected, while his own version stayed first at 90% with no timing).
    if let Some((j, f)) = photo_pick(&open, &fits, ctx.limits.floor)
        && j != i
        && f >= fit - PHOTO_TOLERANCE
    {
        i = j;
        fit = f;
    }
    let chosen = open[i];
    let own = chosen["synced"]
        .as_str()
        .map(timed_lines)
        .unwrap_or_default();
    // With the suggestion's own time stamps the lines are its stamped lines (a chorus stamped several times is several lines), so each line has a time to check.
    let lines: Vec<String> = if arranged.contains(&i) {
        texts[i].lines().map(str::to_owned).collect()
    } else if own.len() >= 8 {
        own.iter().map(|(_, text)| text.clone()).collect()
    } else {
        lyric_lines(text_of(chosen).unwrap_or(""))
    };
    let mut aligned = engine.time(&listening, &lines);
    let placed = aligned.iter().filter(|l| l.start.is_some()).count();
    result["identity"] = json!({ "fit": (fit * 100.0).round() / 100.0, "candidate": { "id": chosen["id"], "artist": chosen["artist"], "track": chosen["track"], "album": chosen["album"], "confidence": chosen["confidence"], "source": chosen["source"] } });
    if placed * 10 < aligned.len() * 8 {
        result["verdict"] = json!("too few lines could be placed");
        result["need"] = json!("review");
        return Ok(result);
    }
    let errors: Vec<(f64, f64)> = if own.len() == aligned.len() {
        own.iter()
            .zip(&aligned)
            .filter_map(|((at, _), a)| Some((*at, a.start? * 1000.0 - at * 1000.0)))
            .collect()
    } else {
        Vec::new()
    };
    let own_fits = verdict(&errors).is_some_and(|v| v.fit == Fit::Fits);
    // The words fit but many lines are doubtful and the suggestion's own timing does not help: the song may be sung in another order (it opens with the
    // chorus). Try the chorus first; keep it only when it fits clearly better and leaves fewer doubtful lines.
    let mut rearranged = arranged.contains(&i);
    let doubtful = aligned.iter().filter(|l| !l.flags.is_empty()).count();
    if !own_fits && doubtful * 10 > aligned.len() {
        let here = engine.fit(&listening, &lines.join("\n"));
        let mut best: Option<(f64, Vec<String>)> = None;
        for arrangement in arrangements(&lines) {
            if let (Some(f), Some(h)) = (engine.fit(&listening, &arrangement.join("\n")), here)
                && f >= h + REARRANGE_GAIN
                && best.as_ref().is_none_or(|b| f > b.0)
            {
                best = Some((f, arrangement));
            }
        }
        if let Some((_, arrangement)) = best {
            let again = engine.time(&listening, &arrangement);
            if again.iter().filter(|l| !l.flags.is_empty()).count() < doubtful {
                aligned = again;
                rearranged = true;
            }
        }
    }
    // Time stamps that agree with the singing line after line cannot belong to other words: on 70 other songs' lyrics put on a song none agreed, while 39 of 67
    // right suggestions did. So agreeing stamps make words that merely fit ("likely") certain.
    let agreeing = errors
        .iter()
        .filter(|e| (e.1 - USUAL_OFFSET_MS).abs() <= 700.0)
        .count() as f64
        / errors.len().max(1) as f64;
    let corroborated = corroborates(own_fits, agreeing, fit);
    let words_sure = words_sure || corroborated;
    let (finished, marked) = finish_lines(&aligned, &own, own_fits, MARK_UNSUNG_LINES);
    let flagged = doubtful_lines(&aligned, &own, own_fits) + marked;
    result["flagged"] = json!(flagged);
    result["marked"] = json!(marked);
    result["own_timing_kept"] = json!(own_fits);
    result["rearranged"] = json!(rearranged);
    result["corroborated"] = json!(corroborated);
    result["verdict"] = json!("timed");
    result["lines"] = lines_json(&finished);
    result["lrc"] = json!(to_lrc(&finished));
    // A `*` written by itself could be the aligner's mistake, so a song with a marked line is first looked at by a person.
    result["first_line_stuck"] = json!(super::first_line_stuck(&aligned)); // recorded only (D149)
    result["need"] = json!(
        match decide(words_sure && marked == 0, finished.len(), flagged) {
            Need::Sure => "sure",
            _ => "review",
        }
    );
    Ok(result)
}
/// How much worse (per letter) the photo-read words may fit than the best suggestion and still be the ones timed.
const PHOTO_TOLERANCE: f64 = 0.4;

/// The photo-read suggestion that fits the singing best, if one fits at all (at least `floor`).
fn photo_pick(open: &[&Value], fits: &[Option<f64>], floor: f64) -> Option<(usize, f64)> {
    open.iter()
        .enumerate()
        .filter(|(_, c)| c["source"] == "photo")
        .filter_map(|(j, _)| fits.get(j).copied().flatten().map(|f| (j, f)))
        .filter(|&(_, f)| f >= floor)
        .max_by(|a, b| a.1.total_cmp(&b.1))
}

/// How far (ms, after the usual offset) the singing may be from a kept time stamp before a line the aligner doubts is still doubtful (D150).
const FLAG_FORGIVEN_WITHIN_MS: f64 = 1500.0;

/// The lines a person should look at. When the suggestion's own time stamps are kept (they agree with the singing) the written time is the people's, so a line
/// the aligner doubts is only doubtful when the aligner and the stamp disagree by more than `FLAG_FORGIVEN_WITHIN_MS`; otherwise every flagged line counts.
fn doubtful_lines(aligned: &[LineTime], own: &[(f64, String)], own_fits: bool) -> usize {
    let kept = own_fits && own.len() == aligned.len();
    aligned
        .iter()
        .enumerate()
        .filter(|(n, l)| {
            !l.flags.is_empty()
                && !(kept
                    && l.start.is_some_and(|s| {
                        ((s - own[*n].0) * 1000.0 - USUAL_OFFSET_MS).abs()
                            <= FLAG_FORGIVEN_WITHIN_MS
                    }))
        })
        .count()
}

/// An artist or album name reduced to lower-case letters and digits, for comparing.
fn name_key(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Whether `candidate` is the song's own artist (or a collaboration that names them: "Band, Guest" against "Band").
fn own_artist(tag: &str, candidate: &str) -> bool {
    let (a, b) = (name_key(tag), name_key(candidate));
    a.is_empty() || b.is_empty() || a == b || a.contains(&b) || b.contains(&a)
}

/// How much better (per letter) a rearranged text must fit the singing before it is used.
const REARRANGE_GAIN: f64 = 0.4;

/// The longest run of two or more consecutive lines that comes back later in the song (a chorus): (first position, length).
pub fn repeated_block(lines: &[String]) -> Option<(usize, usize)> {
    let norm: Vec<String> = lines
        .iter()
        .map(|l| mediaverse_lyric_ai::text::words(l, true).join(" "))
        .collect();
    let mut best: Option<(usize, usize)> = None;
    for i in 0..norm.len() {
        for j in i + 1..norm.len() {
            let mut length = 0;
            while j + length < norm.len()
                && i + length < j
                && !norm[i + length].is_empty()
                && norm[i + length] == norm[j + length]
            {
                length += 1;
            }
            if length >= 2 && best.is_none_or(|(_, longest)| length > longest) {
                best = Some((i, length));
            }
        }
    }
    best
}

/// Other orders the same words may be sung in: many songs open with the chorus, which written lyrics put after the first verse. (1) the chorus first and then the
/// whole song, (2) the chorus moved to the front. Empty when the song has no repeated block or already starts with it.
pub fn arrangements(lines: &[String]) -> Vec<Vec<String>> {
    let Some((start, length)) = repeated_block(lines) else {
        return Vec::new();
    };
    if start == 0 {
        return Vec::new();
    }
    let block = lines[start..start + length].to_vec();
    let mut first = block.clone();
    first.extend_from_slice(lines);
    let mut moved = block;
    moved.extend(lines[..start].iter().cloned());
    moved.extend(lines[start + length..].iter().cloned());
    vec![first, moved]
}

/// The match percentage shown for an AI-checked pick: certain results 100; the others by how well the words fit the singing (fit -3.5 is the floor, 0 perfect).
pub fn ai_confidence(result: &Value) -> u64 {
    if result["need"] == "sure" {
        return 100;
    }
    let fit = result["identity"]["fit"].as_f64().unwrap_or(-3.5);
    let by_fit = (70.0 + 25.0 * ((fit + 3.5) / 3.5).clamp(0.0, 1.0)).round() as u64;
    // Words from a booklet photo keep the match they were shown with: timing them must not make them look worse than the untimed copy was.
    if result["identity"]["candidate"]["source"] == "photo" {
        return by_fit.max(
            result["identity"]["candidate"]["confidence"]
                .as_u64()
                .unwrap_or(0),
        );
    }
    by_fit
}

/// The original artist an album's own title names: "A Tribute to Rancid", "Rancid Tribute", "Songs of Rancid", "Plays Rancid" (owner, 2026-11-21: a tribute album's songs
/// are each by a different band, so counting songs per artist never finds the original). `None` when the title says nothing of the kind.
pub fn tribute_original(album: &str) -> Option<String> {
    let lower = album.to_ascii_lowercase();
    let clean = |name: &str| -> Option<String> {
        let name = name
            .split(['(', '[', ':', '|', '—', '–'])
            .next()
            .unwrap_or("")
            .split(" - ")
            .next()
            .unwrap_or("")
            .trim_matches(|c: char| c.is_whitespace() || matches!(c, '"' | '\'' | '.' | ',' | '!'));
        let name = name.strip_prefix("the ").unwrap_or(name).trim();
        (name.chars().filter(|c| c.is_alphanumeric()).count() >= 2 && name.len() <= 48)
            .then(|| name.to_owned())
    };
    for marker in [
        "tribute to ",
        "tribute album to ",
        "songs of ",
        "songs by ",
        "plays ",
        "covers of ",
    ] {
        if let Some(at) = lower.find(marker) {
            let start = at + marker.len();
            if let Some(name) = album.get(start..).and_then(clean) {
                return Some(name);
            }
        }
    }
    // "Rancid Tribute", "Rancid: A Tribute" (the band comes first).
    for marker in [" tribute", ": a tribute", " a tribute"] {
        if let Some(at) = lower.find(marker)
            && at > 0
            && let Some(name) = album.get(..at).and_then(clean)
        {
            return Some(name);
        }
    }
    None
}

/// The same artist allowing for a typo or two in a longer name ("Overation Ivy" for "Operation Ivy", as LRCLIB has it).
fn near_name(a: &str, b: &str) -> bool {
    let (a, b): (Vec<char>, Vec<char>) =
        (name_key(a).chars().collect(), name_key(b).chars().collect());
    if a == b {
        return true;
    }
    if a.len().min(b.len()) < 10 || a.len().abs_diff(b.len()) > 2 {
        return false;
    }
    let mut row: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, cb) in b.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = (row[j + 1] + 1)
                .min(row[j] + 1)
                .min(diagonal + usize::from(ca != cb));
            diagonal = above;
        }
    }
    row[b.len()] <= 2
}

/// Cover albums among judged songs (results of `judge_song`): an album whose lyrics were found under one other artist (see below for how many), is that artist's
/// songs played by someone else ("Operation Ivy Live at The Empty Bottle" by a mix of bands). Keyed by (artist tag, album) names, giving the original artist's name.
pub fn cover_artists(results: &[Value]) -> std::collections::HashMap<(String, String), String> {
    type Counts = std::collections::HashMap<String, (usize, String)>;
    let mut groups: std::collections::HashMap<(String, String), (usize, Counts)> =
        std::collections::HashMap::new();
    for r in results {
        let album = name_key(r["album"].as_str().unwrap_or(""));
        if album.is_empty() || r["task"] == "error" {
            continue;
        }
        let tag = r["artist"].as_str().unwrap_or("");
        let group = groups.entry((name_key(tag), album)).or_default();
        group.0 += 1;
        if r["lrc"].is_string()
            && let Some(found) = r["identity"]["candidate"]["artist"].as_str()
            && !own_artist(tag, found)
        {
            group
                .1
                .entry(name_key(found))
                .or_insert((0, found.to_owned()))
                .0 += 1;
        }
    }
    groups
        .into_iter()
        .filter_map(|((tag, album), (_, counts))| {
            let others: usize = counts.values().map(|(n, _)| n).sum();
            let (top_key, (picks, name)) = counts.into_iter().max_by_key(|(_, (n, _))| *n)?;
            // One other artist makes up most of what was found under other artists (at least three songs), or the album's own title names that artist and
            // two songs were found under it. Songs found under the band itself do not count either way: a live album's own-artist records are common.
            let dominant = picks >= 3 && picks * 10 >= others * 6;
            let named = picks >= 2 && top_key.len() >= 4 && album.contains(&top_key);
            (dominant || named).then_some(((tag, album), name))
        })
        .collect()
}
fn judged_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("lyric-ai").join("judged")
}

impl Drives {
    /// `lyric_ai_judge {min_confidence?, apply_sure?, batch?, again?}`: a job over the songs under To review whose best suggestion has at least `min_confidence`
    /// (default 60): see `judge_song`. Songs judged in the last 30 days are skipped unless `again`.
    pub(crate) fn lyric_ai_judge(
        self: &std::sync::Arc<Self>,
        args: &Value,
    ) -> Result<Value, (String, String)> {
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
        let min = args["min_confidence"].as_u64().unwrap_or(MIN_CONFIDENCE);
        let apply_sure = args["apply_sure"].as_bool().unwrap_or(false);
        let again = args["again"].as_bool().unwrap_or(false);
        let batch = args["batch"]
            .as_str()
            .filter(|b| {
                !b.is_empty()
                    && b.len() <= 64
                    && b.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            })
            .map(str::to_owned);
        if apply_sure && batch.is_none() {
            return Err(fail(
                "invalid_arguments",
                "Applying results needs a batch id (so it can be undone).",
            ));
        }
        let wanted: Vec<(String, String)> = crate::lyrics_review::LyricsReview::new(&self.data_dir)
            .list()["items"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|i| i["candidates"][0]["confidence"].as_u64().unwrap_or(0) >= min)
            .filter_map(|i| {
                Some((
                    i["key"].as_str()?.to_owned(),
                    i["path"].as_str()?.to_owned(),
                ))
            })
            .collect();
        if wanted.is_empty() {
            return Err(fail(
                "nothing_to_do",
                format!("Nothing under To review has a suggestion at {min}% or more."),
            ));
        }
        let base_url = self.settings.lyrics_base_url();
        Ok(self.start_job(move |this, id| {
            let (canceller, stop) = Canceller::flag();
            if let Ok(mut jobs) = this.jobs.lock() {
                jobs.insert(id.to_owned(), canceller);
            }
            let contact = this.metadata.current().identity.contact.trim().to_owned();
            let agent = mediaverse_disc_metadata::musicbrainz::user_agent(
                "MediaVerseStudio",
                env!("CARGO_PKG_VERSION"),
                if contact.is_empty() { "https://github.com/MediaVerseStudio/MediaVerse-Studio" } else { &contact },
            );
            let pause = || this.metadata.wait_turn("lrclib", std::time::Duration::from_millis(500));
            let root = (this.library_root)();
            let ctx = Context { root: root.as_deref(), base_url, agent, pause: &pause, limits: this.lyric_ai.limits() };
            let judged = judged_dir(&this.data_dir);
            let _ = std::fs::create_dir_all(&judged);
            let review = crate::lyrics_review::LyricsReview::new(&this.data_dir);
            let (mut sure, mut applied, mut kept, mut nothing, mut failed, mut skipped) = (0usize, 0usize, 0usize, 0usize, 0usize, 0usize);
            let total = wanted.len();
            // Every judged song, for the cover-album pass after the loop: (review key, path, result, written).
            let mut records: Vec<(String, String, Value, bool)> = Vec::new();
            // A light copy of each result (no lines) for finding cover albums as the run goes, so the page can say so while it works.
            let mut slim: Vec<Value> = Vec::new();
            let mut announced: std::collections::HashSet<(String, String)> = std::collections::HashSet::new();
            let mut streak = super::FailStreak::default();
            let mut aborted: Option<String> = None;
            for (n, (key, path)) in wanted.iter().enumerate() {
                if aborted.is_some() || stop.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
                this.output.emit("job-progress", json!({ "kind": "lyric_ai", "done": n, "total": total, "skipped": skipped, "current": Path::new(path).file_name().map(|f| f.to_string_lossy().into_owned()) }));
                let marker = judged.join(format!("{key}.json"));
                if !again
                    && std::fs::metadata(&marker)
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age < std::time::Duration::from_secs(30 * 24 * 3600))
                {
                    skipped += 1;
                    continue;
                }
                let result = match this.lyric_ai_judge_song(path, key, &ctx) {
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
                // No singing heard: listed under Suspected instrumental (nothing is written to the song).
                if result["task"] == "instrumental" {
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
                    let _ = crate::lyrics_instrumental::Store::new(&this.data_dir).mark(path, "no singing found (Lyric AI)", now);
                    nothing += 1;
                    let _ = std::fs::write(&marker, summary_of(&result, false).to_string());
                    this.output.emit("job-progress", json!({ "kind": "lyric_ai_result", "result": summary_of(&result, false) }));
                    continue;
                }
                let mut wrote = false;
                match result["need"].as_str() {
                    Some("sure") => {
                        sure += 1;
                        if apply_sure
                            && let (Some(lrc), Some(batch)) = (result["lrc"].as_str(), batch.as_deref())
                            && this.lyric_ai_write(path, lrc, batch).is_ok()
                        {
                            applied += 1;
                            wrote = true;
                            let _ = review.remove(key);
                        } else if result["lrc"].is_string() {
                            promote(&review, key, path, &result);
                        }
                    }
                    Some("review") => {
                        kept += 1;
                        if result["lrc"].is_string() {
                            promote(&review, key, path, &result);
                        }
                    }
                    _ => nothing += 1,
                }
                // Not for a song that could not be read: it is tried again next time.
                if !wrote && result["task"] != "error" {
                    let _ = std::fs::write(&marker, summary_of(&result, false).to_string());
                }
                this.output.emit("job-progress", json!({ "kind": "lyric_ai_result", "result": summary_of(&result, wrote) }));
                slim.push(json!({
                    "artist": result["artist"], "album": result["album"], "task": result["task"],
                    "lrc": if result["lrc"].is_string() { json!("x") } else { Value::Null },
                    "identity": { "candidate": { "artist": result["identity"]["candidate"]["artist"] } },
                }));
                for (group, original) in cover_artists(&slim) {
                    if announced.insert(group.clone()) {
                        this.output.emit("job-progress", json!({ "kind": "lyric_ai_cover", "album": result["album"], "original": original }));
                    }
                }
                records.push((key.clone(), path.clone(), result, wrote));
            }
            // Cover albums: when most of an album's lyrics were found under one other artist, that artist is the original. A pick by the original is then
            // certain (an album of one band's songs does not borrow single songs of others), and songs where nothing fitted are searched for under it.
            let all_results: Vec<Value> = records.iter().map(|r| r.2.clone()).collect();
            let mut covers = cover_artists(&all_results);
            // A tribute album names the original in its title, however many bands play on it.
            for result in &all_results {
                let album = result["album"].as_str().unwrap_or("");
                if let Some(original) = tribute_original(album) {
                    covers
                        .entry((name_key(result["artist"].as_str().unwrap_or("")), name_key(album)))
                        .or_insert(original);
                }
            }
            let mut cover_applied = 0usize;
            if !stop.load(std::sync::atomic::Ordering::SeqCst) {
                for (key, path, result, was_written) in &records {
                    if *was_written || stop.load(std::sync::atomic::Ordering::SeqCst) || result["task"] == "error" {
                        continue;
                    }
                    let group = (name_key(result["artist"].as_str().unwrap_or("")), name_key(result["album"].as_str().unwrap_or("")));
                    let Some(original) = covers.get(&group) else { continue };
                    let picked_by_original = result["lrc"].is_string()
                        && result["identity"]["candidate"]["artist"].as_str().is_some_and(|a| own_artist(original, a) || near_name(original, a));
                    let better = if picked_by_original {
                        let lines = result["lines"].as_array().map_or(0, Vec::len);
                        let flagged = result["flagged"].as_u64().unwrap_or(0) as usize;
                        (decide(true, lines, flagged) == Need::Sure).then(|| result.clone())
                    } else {
                        // Nothing fitted, or the pick is by someone other than the original (a cover album's songs are the original's): search under the original.
                        this.output.emit("job-progress", json!({ "kind": "lyric_ai", "done": total, "total": total, "current": format!("{} (searching as {original})", Path::new(path).file_name().map(|f| f.to_string_lossy().into_owned()).unwrap_or_default()) }));
                        match this.lyric_ai_song_as(path, &ctx, Some(original)) {
                            Ok(found) if found["lrc"].is_string() => {
                                if found["need"] == "sure" || found["need"] == "review" && found["identity"]["candidate"]["artist"].as_str().is_some_and(|a| own_artist(original, a) || near_name(original, a)) {
                                    let lines = found["lines"].as_array().map_or(0, Vec::len);
                                    let flagged = found["flagged"].as_u64().unwrap_or(0) as usize;
                                    (decide(true, lines, flagged) == Need::Sure).then_some(found.clone()).or_else(|| {
                                        promote(&review, key, path, &found);
                                        None
                                    })
                                } else {
                                    // Not by the original: only better than nothing.
                                    if result["lrc"].is_null() {
                                        promote(&review, key, path, &found);
                                    }
                                    None
                                }
                            }
                            _ => None,
                        }
                    };
                    if let Some(found) = better {
                        if apply_sure
                            && let (Some(lrc), Some(batch)) = (found["lrc"].as_str(), batch.as_deref())
                            && this.lyric_ai_write(path, lrc, batch).is_ok()
                        {
                            applied += 1;
                            cover_applied += 1;
                            let _ = review.remove(key);
                            let _ = std::fs::remove_file(judged.join(format!("{key}.json")));
                            this.output.emit("job-progress", json!({ "kind": "lyric_ai_result", "result": summary_of(&found, true) }));
                        } else {
                            promote(&review, key, path, &found);
                        }
                    }
                }
            }
            // The list shows "Cover of ..." on every song of a recognised cover album that is still waiting there.
            for (key, _, result, _) in &records {
                let group = (name_key(result["artist"].as_str().unwrap_or("")), name_key(result["album"].as_str().unwrap_or("")));
                if let Some(original) = covers.get(&group) {
                    let _ = review.mark_cover(key, original);
                }
            }
            Ok(json!({ "songs": total, "sure": sure, "applied": applied, "review": kept, "nothing": nothing, "skipped": skipped, "failed": failed, "aborted": aborted, "covers": covers.len(), "cover_applied": cover_applied, "stopped": stop.load(std::sync::atomic::Ordering::SeqCst) }))
        }))
    }

    fn lyric_ai_judge_song(&self, path: &str, key: &str, ctx: &Context) -> Result<Value, String> {
        let file = resolve_in_library(path, ctx.root)?;
        let tags =
            mediaverse_metadata_tags::read_track_metadata(&file).map_err(|e| e.to_string())?;
        let entry = crate::lyrics_review::LyricsReview::new(&self.data_dir).get(key)?;
        let (left, right) = decode_for_listening(&file)?;
        let (title, artist) = (
            tags.title.clone().unwrap_or_default(),
            tags.artist.clone().unwrap_or_default(),
        );
        self.lyric_ai.with_engine(|engine| {
            judge_song(
                engine,
                path,
                &entry,
                |e| e.listen(&left, &right, |_| {}),
                &title,
                &artist,
                ctx,
            )
        })
    }
}

/// The AI's timed pick goes first under To review (the suggestion it came from is replaced by it, the others stay for the person to try).
fn promote(review: &crate::lyrics_review::LyricsReview, key: &str, path: &str, result: &Value) {
    let Ok(entry) = review.get(key) else { return };
    let chosen_id = &result["identity"]["candidate"]["id"];
    // The photo-read words have no id: when they were the ones timed, the untimed copy is replaced by the timed one.
    let from_photo = result["identity"]["candidate"]["source"] == "photo";
    let picked = json!({
        "id": chosen_id,
        "track": result["identity"]["candidate"]["track"].as_str().map_or_else(|| result["title"].clone(), |t| json!(t)),
        "artist": result["identity"]["candidate"]["artist"].as_str().map_or_else(|| result["artist"].clone(), |a| json!(a)),
        "album": result["album"], "duration": Value::Null,
        "plain": result["lrc"].as_str().map(|l| lyric_lines(l).join("\n")), "synced": result["lrc"],
        "confidence": ai_confidence(result), "source": "lyric-ai", "other_version": false, "other_artist": false, "length_unknown": false,
    });
    let mut candidates = vec![picked];
    candidates.extend(
        entry["candidates"]
            .as_array()
            .into_iter()
            .flatten()
            .filter(|c| !(chosen_id.is_number() && c["id"] == *chosen_id))
            .filter(|c| !(from_photo && c["source"] == "photo"))
            .filter(|c| c["rejected"] != true)
            .cloned(),
    );
    let now = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs());
    let args = json!({ "title": entry["title"], "artist": entry["artist"], "album": entry["album"], "duration": entry["duration"], "candidates": candidates });
    let _ = review.save(path, &args, now);
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, start: Option<f64>, score: Option<f64>) -> LineTime {
        LineTime {
            text: text.to_owned(),
            start,
            end: start.map(|s| s + 2.0),
            score,
            words: Vec::new(),
            flags: Vec::new(),
        }
    }

    #[test]
    fn agreeing_stamps_make_the_words_certain_only_when_they_also_fit_the_singing() {
        assert!(corroborates(true, 0.9, -1.2));
        assert!(corroborates(true, 0.9, -2.67), "the weakest good one seen");
        assert!(
            !corroborates(true, 0.9, -2.91),
            "an instrumental with other lyrics"
        );
        assert!(!corroborates(true, 0.9, -3.47));
        assert!(!corroborates(true, 0.3, -1.0), "too few agreeing stamps");
        assert!(!corroborates(false, 1.0, -1.0), "own timing does not fit");
    }

    #[test]
    fn a_tribute_album_title_names_the_original() {
        assert_eq!(
            tribute_original("A Tribute to Rancid").as_deref(),
            Some("Rancid")
        );
        assert_eq!(
            tribute_original("Tribute to the Ramones (Deluxe)").as_deref(),
            Some("Ramones")
        );
        assert_eq!(
            tribute_original("Rancid: A Tribute").as_deref(),
            Some("Rancid")
        );
        assert_eq!(
            tribute_original("Operation Ivy Tribute").as_deref(),
            Some("Operation Ivy")
        );
        assert_eq!(tribute_original("Living In The Chaos"), None);
        assert_eq!(tribute_original(""), None);
    }

    #[test]
    fn corrected_photo_words_are_timed_when_they_fit_nearly_as_well() {
        let web = json!({ "source": "lrclib", "id": 7 });
        let photo = json!({ "source": "photo", "id": null });
        let open = [&web, &photo];
        assert_eq!(
            photo_pick(&open, &[Some(-1.0), Some(-1.2)], -3.5),
            Some((1, -1.2))
        );
        assert_eq!(
            photo_pick(&open, &[Some(-1.0), None], -3.5),
            None,
            "not heard"
        );
        assert_eq!(
            photo_pick(&open, &[Some(-1.0), Some(-3.9)], -3.5),
            None,
            "below the floor"
        );
    }

    #[test]
    fn kept_time_stamps_forgive_a_doubted_line_the_stamp_agrees_with() {
        let own: Vec<(f64, String)> = (0..4).map(|n| (10.0 * n as f64, String::new())).collect();
        // The aligner runs about 0.2 s late (USUAL_OFFSET_MS).
        let mut aligned: Vec<LineTime> = (0..4)
            .map(|n| line("la", Some(10.0 * n as f64 + 0.2), Some(0.6)))
            .collect();
        aligned[1].flags.push("line barely heard".to_owned());
        aligned[2].flags.push("line barely heard".to_owned());
        aligned[2].start = Some(25.0); // the aligner is 5 s away from the stamp: still doubtful
        assert_eq!(doubtful_lines(&aligned, &own, true), 1);
        assert_eq!(
            doubtful_lines(&aligned, &own, false),
            2,
            "own timing not kept: every flag counts"
        );
        assert_eq!(
            doubtful_lines(&aligned, &own[..3], true),
            2,
            "different line count: nothing to compare"
        );
    }

    /// A dry run on the real To review list (nothing is written, and the internet is not used, so a song where no suggestion fits just reports that):
    ///   LYRIC_JUDGE_DATA=<app data folder, with lyric-ai.json and lyrics-review>  LYRIC_JUDGE_N=<songs, spread over the list>
    ///   cargo test --release -p mediaverse_sidecar --lib a_dry_run -- --ignored --nocapture
    #[test]
    #[ignore = "needs the models and the owner's library (see the comment)"]
    fn a_dry_run_on_the_real_review_list() {
        let data = PathBuf::from(std::env::var("LYRIC_JUDGE_DATA").expect("LYRIC_JUDGE_DATA"));
        let wanted: usize = std::env::var("LYRIC_JUDGE_N")
            .ok()
            .and_then(|n| n.parse().ok())
            .unwrap_or(30);
        let review = crate::lyrics_review::LyricsReview::new(&data);
        let items = review.list()["items"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let ai = LyricAi::new(&ai_settings(&data));
        // LYRIC_JUDGE_URL=default searches the real LRCLIB (politely: a pause between requests); LYRIC_JUDGE_MAX keeps only entries at or below that confidence.
        let online = std::env::var("LYRIC_JUDGE_URL").as_deref() == Ok("default");
        let pause = || {
            if online {
                std::thread::sleep(std::time::Duration::from_millis(700));
            }
        };
        let max: u64 = std::env::var("LYRIC_JUDGE_MAX")
            .ok()
            .and_then(|n| n.parse().ok())
            .unwrap_or(100);
        let items: Vec<Value> = items
            .into_iter()
            .filter(|i| i["candidates"][0]["confidence"].as_u64().unwrap_or(0) <= max)
            .collect();
        let artist_filter = std::env::var("LYRIC_JUDGE_ARTIST")
            .unwrap_or_default()
            .to_lowercase();
        let items: Vec<Value> = items
            .into_iter()
            .filter(|i| {
                i["artist"]
                    .as_str()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains(&artist_filter)
            })
            .collect();
        let title_filter = std::env::var("LYRIC_JUDGE_TITLE")
            .unwrap_or_default()
            .to_lowercase();
        let items: Vec<Value> = items
            .into_iter()
            .filter(|i| {
                i["title"]
                    .as_str()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains(&title_filter)
            })
            .collect();
        let step = (items.len() / wanted.max(1)).max(1);
        let ctx = Context {
            root: None,
            base_url: if online {
                crate::lyrics_lookup::DEFAULT_BASE_URL.to_owned()
            } else {
                "http://127.0.0.1:9".to_owned()
            },
            agent: "MediaVerseStudio-trial (https://github.com/MediaVerseStudio/MediaVerse-Studio)"
                .to_owned(),
            pause: &pause,
            limits: ai.limits(),
        };
        for item in items.iter().step_by(step).take(wanted) {
            let (key, path) = (
                item["key"].as_str().unwrap(),
                item["path"].as_str().unwrap(),
            );
            let entry = review.get(key).unwrap();
            let shown = format!(
                "{:>3}% {:30} {:36}",
                item["candidates"][0]["confidence"],
                item["artist"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .take(29)
                    .collect::<String>(),
                item["title"]
                    .as_str()
                    .unwrap_or("")
                    .chars()
                    .take(35)
                    .collect::<String>()
            );
            let file = PathBuf::from(path);
            let outcome = (|| {
                let tags = mediaverse_metadata_tags::read_track_metadata(&file)
                    .map_err(|e| e.to_string())?;
                let packed = crate::library_defects::decode_file(&file)?;
                let (left, right) = channels(&packed);
                let (title, artist) = (
                    tags.title.unwrap_or_default(),
                    tags.artist.unwrap_or_default(),
                );
                ai.with_engine(|e| {
                    judge_song(
                        e,
                        path,
                        &entry,
                        |e| e.listen(&left, &right, |_| {}),
                        &title,
                        &artist,
                        &ctx,
                    )
                })
            })();
            match outcome {
                Ok(r) => println!(
                    "{shown} | {}{} fit {} | need {} flagged {}/{} marked {} own {} rearranged {} | {} | found: {} - {}",
                    if r["searched"] == true {
                        "SEARCHED AGAIN: "
                    } else {
                        ""
                    },
                    r["verdict"].as_str().unwrap_or("-"),
                    r["identity"]["fit"],
                    r["need"].as_str().unwrap_or("-"),
                    r["flagged"],
                    r["lines"].as_array().map_or(0, Vec::len),
                    r["marked"],
                    r["own_timing_kept"],
                    r["rearranged"],
                    r["ranking"].as_array().map_or(String::new(), |l| l
                        .iter()
                        .take(3)
                        .map(|x| format!("{}:{}", x["confidence"], x["fit"]))
                        .collect::<Vec<_>>()
                        .join(" ")),
                    r["identity"]["candidate"]["artist"],
                    r["identity"]["candidate"]["track"]
                ),
                Err(e) => println!(
                    "{shown} | none of the suggestions fit; searching again was not tried here ({})",
                    e.chars().take(60).collect::<String>()
                ),
            }
        }
    }

    /// Per-line timing of the AI's picks, one JSON line per song to `LYRIC_DIAG_OUT`, for comparing the bands of the match percentage (nothing is written
    /// to the library; the internet is not used). The AI's earlier timing is taken out of each entry so the song is timed afresh, not against itself.
    ///   LYRIC_JUDGE_DATA=<app data folder>  LYRIC_DIAG_OUT=<file>  LYRIC_DIAG_BANDS=80-89,100  LYRIC_JUDGE_N=<songs per band>
    #[test]
    #[ignore = "needs the models and the owner's library (see the comment)"]
    fn a_timing_diagnostic_by_match_band() {
        let data = PathBuf::from(std::env::var("LYRIC_JUDGE_DATA").expect("LYRIC_JUDGE_DATA"));
        let out = PathBuf::from(std::env::var("LYRIC_DIAG_OUT").expect("LYRIC_DIAG_OUT"));
        let per_band: usize = std::env::var("LYRIC_JUDGE_N")
            .ok()
            .and_then(|n| n.parse().ok())
            .unwrap_or(40);
        let bands = std::env::var("LYRIC_DIAG_BANDS").unwrap_or_else(|_| "80-89,100".to_owned());
        let review = crate::lyrics_review::LyricsReview::new(&data);
        let items = review.list()["items"]
            .as_array()
            .cloned()
            .unwrap_or_default();
        let ai = LyricAi::new(&ai_settings(&data));
        let pause = || {};
        let ctx = Context {
            root: None,
            base_url: "http://127.0.0.1:9".to_owned(),
            agent: "MediaVerseStudio-trial".to_owned(),
            pause: &pause,
            limits: ai.limits(),
        };
        let mut lines_out = String::new();
        for band in bands.split(',') {
            let (low, high) = match band.split_once('-') {
                Some((a, b)) => (a.parse::<u64>().unwrap(), b.parse::<u64>().unwrap()),
                None => (band.parse::<u64>().unwrap(), band.parse::<u64>().unwrap()),
            };
            let chosen: Vec<&Value> = items
                .iter()
                .filter(|i| i["candidates"][0]["source"] == "lyric-ai")
                .filter(|i| {
                    let c = i["candidates"][0]["confidence"].as_u64().unwrap_or(0);
                    c >= low && c <= high
                })
                .collect();
            let step = (chosen.len() / per_band.max(1)).max(1);
            println!("band {band}: {} songs, taking every {step}", chosen.len());
            for item in chosen.iter().step_by(step).take(per_band) {
                let (key, path) = (
                    item["key"].as_str().unwrap(),
                    item["path"].as_str().unwrap(),
                );
                let mut entry = review.get(key).unwrap();
                if let Some(list) = entry["candidates"].as_array_mut() {
                    for c in list.iter_mut() {
                        if c["source"] == "lyric-ai" {
                            c["synced"] = Value::Null;
                        }
                    }
                }
                let file = PathBuf::from(path);
                let outcome = (|| {
                    let tags = mediaverse_metadata_tags::read_track_metadata(&file)
                        .map_err(|e| e.to_string())?;
                    let packed = crate::library_defects::decode_file(&file)?;
                    let (left, right) = channels(&packed);
                    let (title, artist) = (
                        tags.title.unwrap_or_default(),
                        tags.artist.unwrap_or_default(),
                    );
                    ai.with_engine(|e| {
                        judge_song(
                            e,
                            path,
                            &entry,
                            |e| e.listen(&left, &right, |_| {}),
                            &title,
                            &artist,
                            &ctx,
                        )
                    })
                })();
                match outcome {
                    Ok(r) => {
                        let lines: Vec<Value> = r["lines"].as_array().map_or_else(Vec::new, |l| {
                            l.iter()
                                .map(|x| json!({ "s": x["start"], "e": x["end"], "sc": x["score"], "f": x["flags"].as_array().map_or(0, Vec::len), "w": x["text"].as_str().map_or(0, |t| t.split_whitespace().count()) }))
                                .collect()
                        });
                        let row = json!({
                            "band": band, "shown": item["candidates"][0]["confidence"], "artist": item["artist"], "album": item["album"], "title": item["title"],
                            "secs": r["seconds"], "fit": r["identity"]["fit"], "need": r["need"], "verdict": r["verdict"], "flagged": r["flagged"],
                            "marked": r["marked"], "rearranged": r["rearranged"], "lines": lines,
                        });
                        lines_out.push_str(&row.to_string());
                        lines_out.push('\n');
                        println!(
                            "{band} {:30} fit {} need {} flagged {}/{}",
                            item["title"]
                                .as_str()
                                .unwrap_or("")
                                .chars()
                                .take(29)
                                .collect::<String>(),
                            r["identity"]["fit"],
                            r["need"].as_str().unwrap_or("-"),
                            r["flagged"],
                            lines.len()
                        );
                    }
                    Err(e) => println!(
                        "{band} {} failed: {}",
                        item["title"],
                        e.chars().take(60).collect::<String>()
                    ),
                }
            }
        }
        std::fs::write(&out, lines_out).unwrap();
    }

    /// A look at songs where nothing fitted (from `<data>/lyric-ai/results` or `judged`, verdict "no found lyrics match this recording"): each is listened to
    /// again (with the reader `ai_settings` gives), the real LRCLIB is searched, and for the best candidate it prints the fit, how much of its letters the reading
    /// contains, and the first words of the reading beside the first lines of the lyrics, to see what goes wrong. `LYRIC_JUDGE_N` songs spread over the list.
    #[test]
    #[ignore = "needs the models, the owner's library and the internet (see the comment)"]
    fn a_look_at_songs_where_nothing_fitted() {
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
        let ai = LyricAi::new(&ai_settings(&data));
        let pause = || std::thread::sleep(std::time::Duration::from_millis(700));
        let agent =
            "MediaVerseStudio-trial (https://github.com/MediaVerseStudio/MediaVerse-Studio)";
        let (mut rescued, mut tried) = (0, 0);
        for miss in misses.iter().step_by(step).take(wanted) {
            let path = miss["path"].as_str().unwrap_or("");
            let outcome: Result<String, String> = (|| {
                let file = PathBuf::from(path);
                let tags = mediaverse_metadata_tags::read_track_metadata(&file)
                    .map_err(|e| e.to_string())?;
                let (title, artist) = (
                    tags.title.unwrap_or_default(),
                    tags.artist.unwrap_or_default(),
                );
                let packed = crate::library_defects::decode_file(&file)?;
                let (left, right) = channels(&packed);
                let candidates = crate::lyrics_lookup::loose_candidates(
                    crate::lyrics_lookup::DEFAULT_BASE_URL,
                    &title,
                    &artist,
                    false,
                    agent,
                    &pause,
                )
                .map_err(|(code, message)| format!("{code}: {message}"))?;
                let limits = ai.limits();
                ai.with_engine(|e| {
                    let listening = e.listen(&left, &right, |_| {})?;
                    let texts: Vec<String> = candidates
                        .iter()
                        .map(|c| c["plain"].as_str().or(c["synced"].as_str()).map(|t| lyric_lines(t).join("\n")).unwrap_or_default())
                        .collect();
                    let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
                    let fits = fit_each(e, &listening, &refs);
                    let best = fits.iter().enumerate().filter_map(|(i, f)| f.map(|f| (i, f))).max_by(|a, b| a.1.total_cmp(&b.1));
                    let choice = choose_by_fit(&fits, &refs, limits);
                    let verdict = match choice {
                        Verdict::Sure(..) => "SURE",
                        Verdict::Likely(..) => "LIKELY",
                        Verdict::None => "none",
                    };
                    let Some((i, fit)) = best else {
                        return Ok(format!("{verdict}: {} candidates, none could be scored (heard {} letters)", candidates.len(), listening.reading.len()));
                    };
                    let first_lines: Vec<&str> = texts[i].lines().take(2).collect();
                    let heard: String = listening.reading.chars().take(110).collect();
                    Ok(format!(
                        "{verdict} fit {fit:.2} (floor {:.1}) voice {:.2} | {} cand | {} by {} | lyrics: {} / {} | heard: {heard}",
                        limits.floor,
                        listening.voice.letters,
                        candidates.len(),
                        candidates[i]["track"].as_str().unwrap_or("?"),
                        candidates[i]["artist"].as_str().unwrap_or("?"),
                        first_lines.first().unwrap_or(&""),
                        first_lines.get(1).unwrap_or(&""),
                    ))
                })
            })();
            tried += 1;
            match outcome {
                Ok(text) => {
                    if text.starts_with("SURE") || text.starts_with("LIKELY") {
                        rescued += 1;
                    }
                    println!(
                        "LOOK {:34} {:30} | {text}",
                        miss["artist"]
                            .as_str()
                            .unwrap_or("")
                            .chars()
                            .take(33)
                            .collect::<String>(),
                        miss["title"]
                            .as_str()
                            .unwrap_or("")
                            .chars()
                            .take(29)
                            .collect::<String>()
                    );
                }
                Err(e) => println!(
                    "LOOK {path} | failed: {}",
                    e.chars().take(90).collect::<String>()
                ),
            }
        }
        println!("LOOK rescued {rescued} of {tried}");
    }

    /// The whole cover-album pass as the job does it, on the real To review entries of one artist (`LYRIC_JUDGE_ARTIST`), nothing written: each song is judged, cover
    /// albums are found, picks by the original are upgraded, and songs where nothing fitted are searched for under the original. Uses the real LRCLIB.
    #[test]
    #[ignore = "needs the models, the owner's library and the internet (see the comment)"]
    fn a_dry_run_of_the_cover_album_pass() {
        let data = PathBuf::from(std::env::var("LYRIC_JUDGE_DATA").expect("LYRIC_JUDGE_DATA"));
        let artist_filter = std::env::var("LYRIC_JUDGE_ARTIST")
            .expect("LYRIC_JUDGE_ARTIST")
            .to_lowercase();
        let review = crate::lyrics_review::LyricsReview::new(&data);
        let items: Vec<Value> = review.list()["items"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|i| {
                i["artist"]
                    .as_str()
                    .unwrap_or("")
                    .to_lowercase()
                    .contains(&artist_filter)
            })
            .collect();
        let ai = LyricAi::new(&ai_settings(&data));
        let pause = || std::thread::sleep(std::time::Duration::from_millis(700));
        let ctx = Context {
            root: None,
            base_url: crate::lyrics_lookup::DEFAULT_BASE_URL.to_owned(),
            agent: "MediaVerseStudio-trial (https://github.com/MediaVerseStudio/MediaVerse-Studio)"
                .to_owned(),
            pause: &pause,
            limits: ai.limits(),
        };
        let listen = |path: &str| -> Result<(Vec<f32>, Vec<f32>), String> {
            let packed = crate::library_defects::decode_file(&PathBuf::from(path))?;
            Ok(channels(&packed))
        };
        let mut results: Vec<(String, Value)> = Vec::new();
        for item in &items {
            let (key, path) = (
                item["key"].as_str().unwrap(),
                item["path"].as_str().unwrap(),
            );
            let entry = review.get(key).unwrap();
            let outcome = (|| {
                let tags = mediaverse_metadata_tags::read_track_metadata(&PathBuf::from(path))
                    .map_err(|e| e.to_string())?;
                let (left, right) = listen(path)?;
                let (title, artist) = (
                    tags.title.unwrap_or_default(),
                    tags.artist.unwrap_or_default(),
                );
                ai.with_engine(|e| {
                    judge_song(
                        e,
                        path,
                        &entry,
                        |e| e.listen(&left, &right, |_| {}),
                        &title,
                        &artist,
                        &ctx,
                    )
                })
            })();
            if let Ok(mut r) = outcome {
                r["album"] = entry["album"].clone();
                results.push((path.to_owned(), r));
            }
        }
        let all: Vec<Value> = results.iter().map(|r| r.1.clone()).collect();
        let covers = cover_artists(&all);
        println!("{} songs judged; cover albums: {covers:?}", results.len());
        let mut upgraded = 0;
        for (path, r) in &results {
            let group = (
                name_key(r["artist"].as_str().unwrap_or("")),
                name_key(r["album"].as_str().unwrap_or("")),
            );
            let title = r["title"].as_str().unwrap_or("");
            let Some(original) = covers.get(&group) else {
                println!("  {title:36} (not a cover album) need {}", r["need"]);
                continue;
            };
            if r["lrc"].is_string() {
                let by = r["identity"]["candidate"]["artist"].as_str().unwrap_or("");
                let lines = r["lines"].as_array().map_or(0, Vec::len);
                let flagged = r["flagged"].as_u64().unwrap_or(0) as usize;
                let now = decide(true, lines, flagged);
                let was = r["need"].as_str().unwrap_or("");
                if own_artist(original, by) && now == Need::Sure && was != "sure" {
                    upgraded += 1;
                }
                println!(
                    "  {title:36} picked under {by:18} was {was:6} -> {}",
                    if own_artist(original, by) {
                        format!("{now:?} (by the original)")
                    } else {
                        "stays".to_owned()
                    }
                );
            } else {
                let again = (|| {
                    let tags = mediaverse_metadata_tags::read_track_metadata(&PathBuf::from(path))
                        .map_err(|e| e.to_string())?;
                    let (left, right) = listen(path)?;
                    let title = tags.title.unwrap_or_default();
                    ai.with_engine(|e| {
                        analyse_song(
                            e,
                            path,
                            &Value::Null,
                            |e| e.listen(&left, &right, |_| {}),
                            &title,
                            original,
                            &ctx,
                        )
                    })
                })();
                match again {
                    Ok(f) if f["lrc"].is_string() => println!(
                        "  {title:36} nothing fitted; searched as {original}: {} fit {} need {}",
                        f["identity"]["candidate"]["artist"], f["identity"]["fit"], f["need"]
                    ),
                    Ok(f) => println!(
                        "  {title:36} nothing fitted; searched as {original}: {}",
                        f["verdict"]
                    ),
                    Err(e) => println!("  {title:36} search as {original} failed: {e}"),
                }
            }
        }
        println!("{upgraded} songs upgraded to certain because their album is a cover album");
    }
    /// Calibration data (read only): for songs spread over the To review list, every suggestion's fit, whether the best suggestion's own time stamps agree with
    /// the singing, the first line's offset, the line scores, and a negative control (another song's synced lyrics put on this song). One JSON line a song into
    /// LYRIC_JUDGE_OUT. `LYRIC_JUDGE_DATA`, `LYRIC_JUDGE_N` as in the dry run.
    #[test]
    #[ignore = "needs the models and the owner's library (see the comment)"]
    fn a_calibration_run_on_the_real_review_list() {
        use std::io::Write;
        let data = PathBuf::from(std::env::var("LYRIC_JUDGE_DATA").expect("LYRIC_JUDGE_DATA"));
        let out_path = std::env::var("LYRIC_JUDGE_OUT").expect("LYRIC_JUDGE_OUT");
        let wanted: usize = std::env::var("LYRIC_JUDGE_N")
            .ok()
            .and_then(|n| n.parse().ok())
            .unwrap_or(100);
        let min: u64 = std::env::var("LYRIC_JUDGE_MIN")
            .ok()
            .and_then(|n| n.parse().ok())
            .unwrap_or(0);
        let review = crate::lyrics_review::LyricsReview::new(&data);
        let items: Vec<Value> = review.list()["items"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|i| i["candidates"][0]["confidence"].as_u64().unwrap_or(0) >= min)
            .filter(|i| {
                let live = format!("{} {}", i["title"], i["album"])
                    .to_lowercase()
                    .contains("live");
                match std::env::var("LYRIC_JUDGE_LIVE").as_deref() {
                    Ok("only") => live,
                    Ok("none") => !live,
                    _ => true,
                }
            })
            .collect();
        let step = (items.len() / wanted.max(1)).max(1);
        let ai = LyricAi::new(&ai_settings(&data));
        let mut out = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&out_path)
            .unwrap();
        let limits = ai.limits();
        let own_check = |engine: &mut Engine, listening: &Listening, synced: &str| -> Value {
            let own = timed_lines(synced);
            let texts: Vec<String> = own.iter().map(|(_, t)| t.clone()).collect();
            let aligned = engine.time(listening, &texts);
            let errors: Vec<(f64, f64)> = own
                .iter()
                .zip(&aligned)
                .filter_map(|((at, _), a)| Some((*at, a.start? * 1000.0 - at * 1000.0)))
                .collect();
            let v = verdict(&errors);
            json!({
                "lines": own.len(), "placed": errors.len(),
                "fit": v.as_ref().map(|v| format!("{:?}", v.fit)), "offset_ms": v.as_ref().map(|v| v.offset_ms), "drift": v.as_ref().map(|v| v.drift_ms_per_minute),
                "first_delta": aligned.first().and_then(|a| a.start).zip(own.first()).map(|(s, (o, _))| ((s - o) * 1000.0).round()),
                "first_flagged": aligned.first().is_some_and(|a| !a.flags.is_empty()),
                "scores": aligned.iter().map(|a| a.score).collect::<Vec<_>>(),
                "errors_ms": errors.iter().map(|e| e.1.round()).collect::<Vec<_>>(),
                "windows": engine.window_fits(listening, &aligned, 3).iter().map(|w| w.map(|w| (w * 100.0).round() / 100.0)).collect::<Vec<_>>(),
            })
        };
        for (n, item) in items.iter().step_by(step).take(wanted).enumerate() {
            let (key, path) = (
                item["key"].as_str().unwrap(),
                item["path"].as_str().unwrap(),
            );
            let entry = review.get(key).unwrap();
            let other = &items[(n * step + 37) % items.len()];
            let other_synced: Option<String> = review
                .get(other["key"].as_str().unwrap())
                .ok()
                .and_then(|e| {
                    e["candidates"]
                        .as_array()?
                        .iter()
                        .find_map(|c| c["synced"].as_str().map(str::to_owned))
                });
            let file = PathBuf::from(path);
            let outcome: Result<Value, String> = (|| {
                let tags = mediaverse_metadata_tags::read_track_metadata(&file)
                    .map_err(|e| e.to_string())?;
                let packed = crate::library_defects::decode_file(&file)?;
                let (left, right) = channels(&packed);
                ai.with_engine(|e| {
                    let listening = e.listen(&left, &right, |_| {})?;
                    let open: Vec<&Value> = entry["candidates"].as_array().into_iter().flatten().filter(|c| c["rejected"] != true).collect();
                    let texts: Vec<String> = open.iter().map(|c| text_of(c).map(|t| lyric_lines(t).join("\n")).unwrap_or_default()).collect();
                    let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
                    let fits = fit_each(e, &listening, &refs);
                    let choice = choose_by_fit(&fits, &refs, limits);
                    let (verdict_name, best) = match choice {
                        Verdict::None => ("none", None),
                        Verdict::Likely(i, f) => ("likely", Some((i, f))),
                        Verdict::Sure(i, f) => ("sure", Some((i, f))),
                    };
                    let best_any = fits.iter().enumerate().filter_map(|(i, f)| f.map(|f| (i, f))).max_by(|a, b| a.1.total_cmp(&b.1));
                    let mut rec = json!({
                        "artist": item["artist"], "title": item["title"], "album": item["album"], "confidence": item["candidates"][0]["confidence"],
                        "seconds": listening.seconds.round(), "suggestions": open.len(),
                        "choice": verdict_name, "fits": fits, "best_any": best_any.map(|b| json!({ "index": b.0, "fit": b.1 })),
                        "best_has_synced": best_any.is_some_and(|b| open[b.0]["synced"].is_string()),
                        "voice_letters": listening.voice.letters, "voice_present": listening.voice.present,
                    });
                    if let Some((i, f)) = best_any {
                        if let Some(synced) = open[i]["synced"].as_str() {
                            rec["own"] = own_check(e, &listening, synced);
                        }
                        rec["best_fit"] = json!(f);
                        let _ = best;
                    }
                    if let Some(synced) = &other_synced {
                        let words = lyric_lines(synced).join("\n");
                        rec["negative_fit"] = json!(e.fit(&listening, &words));
                        rec["negative_own"] = own_check(e, &listening, synced);
                    }
                    Ok(rec)
                })
                .map(|mut r| {
                    r["tags_title"] = json!(tags.title);
                    r
                })
            })();
            let line = match outcome {
                Ok(r) => r,
                Err(e) => json!({ "artist": item["artist"], "title": item["title"], "error": e }),
            };
            writeln!(out, "{line}").unwrap();
        }
    }

    /// Flag calibration data (read only): songs whose suggestion carries people-made time stamps that agree with the singing are timed afresh and every line
    /// is written with its error against those stamps next to what the flag rules see (word scores, gaps). One JSON line a song into `LYRIC_FLAG_OUT`.
    /// `LYRIC_JUDGE_DATA`, `LYRIC_JUDGE_N`, `LYRIC_JUDGE_READER` as in the other real-data tests.
    #[test]
    #[ignore = "needs the models and the owner's library (see the comment)"]
    fn a_flag_calibration_run() {
        use std::io::Write;
        let data = PathBuf::from(std::env::var("LYRIC_JUDGE_DATA").expect("LYRIC_JUDGE_DATA"));
        let out_path = std::env::var("LYRIC_FLAG_OUT").expect("LYRIC_FLAG_OUT");
        let wanted: usize = std::env::var("LYRIC_JUDGE_N")
            .ok()
            .and_then(|n| n.parse().ok())
            .unwrap_or(60);
        let review = crate::lyrics_review::LyricsReview::new(&data);
        let items: Vec<Value> = review.list()["items"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|i| {
                review.get(i["key"].as_str().unwrap_or("")).is_ok_and(|e| {
                    e["candidates"].as_array().is_some_and(|c| {
                        c.iter()
                            .any(|c| c["synced"].is_string() && c["source"] != "lyric-ai")
                    })
                })
            })
            .collect();
        println!("{} songs with time stamps in To review", items.len());
        let step = (items.len() / wanted.max(1)).max(1);
        let ai = LyricAi::new(&ai_settings(&data));
        let mut out = std::fs::OpenOptions::new()
            .create(true)
            .append(true)
            .open(&out_path)
            .unwrap();
        for item in items.iter().step_by(step).take(wanted) {
            let (key, path) = (
                item["key"].as_str().unwrap(),
                item["path"].as_str().unwrap(),
            );
            let entry = review.get(key).unwrap();
            let file = PathBuf::from(path);
            let outcome: Result<Value, String> = (|| {
                let packed = crate::library_defects::decode_file(&file)?;
                let (left, right) = channels(&packed);
                ai.with_engine(|e| {
                    let listening = e.listen(&left, &right, |_| {})?;
                    let open: Vec<&Value> = entry["candidates"]
                        .as_array()
                        .into_iter()
                        .flatten()
                        .filter(|c| {
                            c["rejected"] != true
                                && c["synced"].is_string()
                                && c["source"] != "lyric-ai"
                        })
                        .collect();
                    let texts: Vec<String> = open
                        .iter()
                        .map(|c| lyric_lines(c["synced"].as_str().unwrap_or("")).join("\n"))
                        .collect();
                    let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
                    let fits = fit_each(e, &listening, &refs);
                    let Some((best, fit)) = fits
                        .iter()
                        .enumerate()
                        .filter_map(|(i, f)| f.map(|f| (i, f)))
                        .max_by(|a, b| a.1.total_cmp(&b.1))
                    else {
                        return Err("no fit".to_owned());
                    };
                    let own = timed_lines(open[best]["synced"].as_str().unwrap_or(""));
                    let lines: Vec<String> = own.iter().map(|(_, t)| t.clone()).collect();
                    let aligned = e.time(&listening, &lines);
                    let rows: Vec<Value> = own
                        .iter()
                        .zip(&aligned)
                        .map(|((at, _), a)| {
                            let w = &a.words;
                            let gaps: Vec<f64> = (1..w.len()).map(|i| w[i].start - w[i - 1].end).collect();
                            let (gap_max, gap_at) = gaps
                                .iter()
                                .enumerate()
                                .fold((0.0f64, 0usize), |m, (i, g)| if *g > m.0 { (*g, i + 1) } else { m });
                            json!({
                                "o": at, "s": a.start, "e": a.end, "sc": a.score, "f": a.flags,
                                "n": w.len(), "w0": w.first().map(|x| x.score), "w0d": w.first().map(|x| ((x.end - x.start) * 100.0).round() / 100.0),
                                "gmax": (gap_max * 100.0).round() / 100.0, "gat": gap_at,
                                "ws": w.iter().map(|x| x.score).collect::<Vec<_>>(),
                            })
                        })
                        .collect();
                    Ok(json!({
                        "artist": item["artist"], "title": item["title"], "fit": fit,
                        "seconds": listening.seconds.round(), "lines": rows,
                    }))
                })
            })();
            let line = match outcome {
                Ok(r) => r,
                Err(e) => json!({ "artist": item["artist"], "title": item["title"], "error": e }),
            };
            writeln!(out, "{line}").unwrap();
            println!("{} - {}", item["artist"], item["title"]);
        }
    }

    /// The folder whose `lyric-ai.json` the real-data tests use: the owner's, or with `LYRIC_JUDGE_READER=music` a copy that reads with the music-lyrics model from
    /// `LYRIC_JUDGE_MODELS` (a folder holding the ONNX file and `vocab.json`), so the owner's settings are never touched.
    fn ai_settings(data: &Path) -> PathBuf {
        if std::env::var("LYRIC_JUDGE_READER").as_deref() != Ok("music") {
            return data.to_owned();
        }
        let dir = std::env::temp_dir().join("mv-judge-music-settings");
        std::fs::create_dir_all(&dir).unwrap();
        let mut saved: Value = std::fs::read(data.join("lyric-ai.json"))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| json!({}));
        saved["reader_model"] = json!("music");
        saved["models"] = json!(std::env::var("LYRIC_JUDGE_MODELS").expect("LYRIC_JUDGE_MODELS"));
        if let Ok(file) = std::env::var("LYRIC_JUDGE_ONNX") {
            saved["music_onnx"] = json!(file);
        }
        std::fs::write(
            dir.join("lyric-ai.json"),
            serde_json::to_vec_pretty(&saved).unwrap(),
        )
        .unwrap();
        dir
    }

    fn pick(artist: &str, album: &str, found_under: Option<&str>) -> Value {
        match found_under {
            Some(by) => {
                json!({ "artist": artist, "album": album, "task": "judge", "lrc": "[00:01.00]x", "identity": { "candidate": { "artist": by } } })
            }
            None => json!({ "artist": artist, "album": album, "task": "judge" }),
        }
    }

    #[test]
    fn a_chorus_is_found_and_offered_first() {
        let song: Vec<String> = [
            "verse one a",
            "verse one b",
            "chorus a",
            "chorus b",
            "verse two a",
            "verse two b",
            "chorus a",
            "chorus b",
            "outro",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        assert_eq!(repeated_block(&song), Some((2, 2)));
        let options = arrangements(&song);
        assert_eq!(options.len(), 2);
        assert_eq!(&options[0][..2], ["chorus a", "chorus b"]);
        assert_eq!(
            options[0].len(),
            song.len() + 2,
            "the chorus first, then the whole song"
        );
        assert_eq!(
            options[1].len(),
            song.len(),
            "the chorus moved to the front"
        );
        assert_eq!(options[1][2], "verse one a");
        // already opening with the chorus, or no repeats: nothing to try
        let opens: Vec<String> = ["chorus a", "chorus b", "verse a", "chorus a", "chorus b"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        assert!(arrangements(&opens).is_empty());
        let plain: Vec<String> = ["a", "b", "c", "d"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        assert!(arrangements(&plain).is_empty());
    }

    #[test]
    fn an_ai_pick_shows_a_match_percentage_by_how_well_it_fits() {
        assert_eq!(
            ai_confidence(&json!({ "need": "sure", "identity": { "fit": -1.0 } })),
            100
        );
        assert_eq!(
            ai_confidence(&json!({ "need": "review", "identity": { "fit": 0.0 } })),
            95
        );
        assert_eq!(
            ai_confidence(&json!({ "need": "review", "identity": { "fit": -3.5 } })),
            70
        );
        let middle = ai_confidence(&json!({ "need": "review", "identity": { "fit": -1.75 } }));
        assert!((80..90).contains(&middle), "{middle}");
    }

    #[test]
    fn artist_names_with_a_typo_are_the_same_artist() {
        assert!(near_name("Operation Ivy", "Overation Ivy"));
        assert!(near_name("Operation Ivy", "operation ivy"));
        assert!(!near_name("Operation Ivy", "Rancid"));
        assert!(
            !near_name("Green Day", "Green Dog"),
            "short names must match exactly"
        );
        assert!(!near_name("Operation Ivy", "Operation Iron Man"));
    }

    #[test]
    fn a_cover_album_is_found_when_most_lyrics_come_from_one_other_artist() {
        let results = vec![
            pick("Catbite", "Live at the Empty Bottle", Some("Operation Ivy")),
            pick("Catbite", "Live at the Empty Bottle", Some("Operation Ivy")),
            pick("Catbite", "Live at the Empty Bottle", Some("operation ivy")),
            pick("Catbite", "Live at the Empty Bottle", Some("Green Day")),
            pick("Catbite", "Live at the Empty Bottle", None),
            // an album of the band's own songs: found under the band itself (or its collaboration), never a cover album
            pick("Band", "Own Songs", Some("Band")),
            pick("Band", "Own Songs", Some("Band, Guest")),
            pick("Band", "Own Songs", Some("Band")),
            // too few songs agree
            pick("Other", "Mixed", Some("A")),
            pick("Other", "Mixed", Some("A")),
            pick("Other", "Mixed", None),
            // no album: nothing to group by
            pick("Solo", "", Some("Someone")),
            pick("Solo", "", Some("Someone")),
            pick("Solo", "", Some("Someone")),
        ];
        let covers = cover_artists(&results);
        assert_eq!(covers.len(), 1);
        assert_eq!(
            covers[&(name_key("Catbite"), name_key("Live at the Empty Bottle"))],
            "Operation Ivy"
        );
        // songs found under the band itself do not count, so an album can be mostly "own artist" records and still be a cover album
        let mut mixed: Vec<Value> = (0..5).map(|_| pick("X", "Y", Some("X, Guest"))).collect();
        mixed.extend((0..3).map(|_| pick("X", "Y", Some("Z"))));
        mixed.push(pick("X", "Y", Some("W")));
        assert_eq!(cover_artists(&mixed)[&(name_key("X"), name_key("Y"))], "Z");
        // picks split between several artists: no original
        let split: Vec<Value> = ["A", "A", "B", "B", "C", "C"]
            .iter()
            .map(|a| pick("X", "Y", Some(a)))
            .collect();
        assert!(cover_artists(&split).is_empty());
        // two songs are enough when the album's title names the artist
        let named = vec![
            pick(
                "Catbite",
                "Operation Ivy Live at The Empty Bottle",
                Some("Operation Ivy"),
            ),
            pick(
                "Catbite",
                "Operation Ivy Live at The Empty Bottle",
                Some("Operation Ivy"),
            ),
            pick(
                "Catbite",
                "Operation Ivy Live at The Empty Bottle",
                Some("Green Day"),
            ),
            pick(
                "Catbite",
                "Operation Ivy Live at The Empty Bottle",
                Some("Rancid"),
            ),
        ];
        assert_eq!(cover_artists(&named).len(), 1);
    }

    #[test]
    fn an_lrc_text_gives_its_stamped_lines_in_time_order() {
        let got = timed_lines(
            "[ar:Someone]\n[00:12.50]Second\n[00:01.00] First\n[00:30.00][01:00.25]Chorus\nno stamp\n[00:40.00]",
        );
        assert_eq!(
            got,
            [
                (1.0, "First".to_owned()),
                (12.5, "Second".to_owned()),
                (30.0, "Chorus".to_owned()),
                (60.25, "Chorus".to_owned())
            ]
        );
    }

    #[test]
    fn a_fitting_own_timing_is_kept_but_its_first_line_follows_the_singing() {
        let aligned = vec![
            line("one", Some(9.0), Some(0.8)),
            line("two", Some(14.1), Some(0.7)),
        ];
        // the aligner runs 0.2 s late, so a first stamp at 8.0 against singing "heard" at 9.0 is a real 0.8 s difference
        let own = vec![(8.0, "one".to_owned()), (14.0, "two".to_owned())];
        let (lines, marked) = finish_lines(&aligned, &own, true, true);
        assert_eq!(marked, 0);
        assert_eq!(
            lines[0].start,
            Some(9.0),
            "the first line moved to the singing"
        );
        let written = to_lrc(&lines);
        assert!(
            written.starts_with("[00:08.80]one\n[00:14.00]two"),
            "the other lines are written exactly as stamped, got {written:?}"
        );
        // 0.1 s apart once the lateness is allowed for: left alone, and written exactly as stamped
        let (close, _) = finish_lines(
            &aligned,
            &[(8.9, "one".to_owned()), (14.0, "two".to_owned())],
            true,
            true,
        );
        assert!(to_lrc(&close).starts_with("[00:08.90]one\n[00:14.00]two"));
        // a jump of many seconds is more likely the aligner than a correction
        let (far, _) = finish_lines(
            &aligned,
            &[(2.0, "one".to_owned()), (14.0, "two".to_owned())],
            true,
            true,
        );
        assert!(to_lrc(&far).starts_with("[00:02.00]one"));
    }

    #[test]
    fn a_timing_that_does_not_fit_is_replaced_by_the_singing() {
        let aligned = vec![
            line("one", Some(9.0), Some(0.8)),
            line("two", Some(14.1), Some(0.7)),
        ];
        let own = vec![(1.0, "one".to_owned()), (3.0, "two".to_owned())];
        let (lines, _) = finish_lines(&aligned, &own, false, true);
        assert_eq!((lines[0].start, lines[1].start), (Some(9.0), Some(14.1)));
    }

    #[test]
    fn lines_that_are_not_sung_get_a_star_but_only_when_they_stand_out() {
        let mut aligned: Vec<LineTime> = (0..10)
            .map(|n| line(&format!("line {n}"), Some(f64::from(n) * 5.0), Some(0.7)))
            .collect();
        aligned[3].score = Some(0.05);
        aligned[6].start = None;
        let (lines, marked) = finish_lines(&aligned, &[], false, true);
        assert_eq!(marked, 2);
        assert_eq!(lines[3].text, "* line 3");
        assert_eq!(lines[6].text, "* line 6");
        assert_eq!(lines[0].text, "line 0");
        assert_eq!(
            finish_lines(&aligned, &[], false, false).1,
            0,
            "switched off"
        );
        // a song whose every line scores low is not marked line by line
        let weak: Vec<LineTime> = (0..10)
            .map(|n| line("x", Some(f64::from(n)), Some(0.05)))
            .collect();
        assert_eq!(finish_lines(&weak, &[], false, true).1, 0);
        // nor one where most lines would be marked
        let mut mostly: Vec<LineTime> = (0..10)
            .map(|n| line("x", Some(f64::from(n)), Some(0.7)))
            .collect();
        for l in mostly.iter_mut().take(5) {
            l.start = None;
        }
        assert_eq!(finish_lines(&mostly, &[], false, true).1, 0);
    }
}
