//! Timing lyrics: the words of each line placed in the song by CTC forced alignment, each line's start and end, and the lines worth a second look.

use crate::ctc::forced_align;
use crate::text::tidy_words;
use serde::Serialize;
use std::collections::HashMap;

/// Seconds in one frame of the aligner models (320 samples at 16 kHz).
pub const FRAME_SECONDS: f64 = 0.02;

/// The letters a model knows, in class order. `labels[0]` is the "nothing" class.
#[derive(Debug, Clone)]
pub struct Alphabet {
    index: HashMap<char, usize>,
    word_break: Option<usize>,
    /// English wav2vec2 reads upper-case letters; the multilingual model lower-case.
    pub upper: bool,
}

impl Alphabet {
    /// How well the words of `text` fit the audio (0 is perfect, more negative is worse): the log-likelihood of the best way to place the letters, less that of
    /// the best path of any letters whatever, per letter. Right lyrics of a song fit far better than other lyrics (40 songs: median -1.4 against -4.8;
    /// the right lyrics beat every one of 8 wrong ones in 39 of 40 songs). `None` when the text has too few words or cannot fit.
    pub fn fit(&self, emission: &[f32], frames: usize, classes: usize, text: &str) -> Option<f64> {
        let words: Vec<String> = text
            .lines()
            .flat_map(|l| tidy_words(l, self.upper))
            .collect();
        if words.len() < 6 {
            return None;
        }
        let mut tokens = Vec::new();
        for (k, word) in words.iter().enumerate() {
            for c in word.chars() {
                tokens.push(*self.index.get(&c)?);
            }
            if let (true, Some(b)) = (k + 1 < words.len(), self.word_break) {
                tokens.push(b);
            }
        }
        let (_, path) = crate::ctc::forced_align_scored(emission, frames, classes, &tokens, 0)?;
        let free: f64 = (0..frames)
            .map(|t| {
                f64::from(
                    emission[t * classes..(t + 1) * classes]
                        .iter()
                        .cloned()
                        .fold(f32::NEG_INFINITY, f32::max),
                )
            })
            .sum();
        Some((f64::from(path) - free) / tokens.len() as f64)
    }

    /// `labels` as the model lists them ("-", "|", "E", "T", ... for wav2vec2; "-", "a", "i", ... for MMS).
    pub fn new(labels: &[String]) -> Self {
        let mut index = HashMap::new();
        let mut word_break = None;
        let mut upper = false;
        for (i, label) in labels.iter().enumerate() {
            let mut chars = label.chars();
            if let (Some(c), None) = (chars.next(), chars.next()) {
                if label == "|" {
                    word_break = Some(i);
                } else if c.is_ascii_alphabetic() || c == '\'' {
                    index.insert(c, i);
                    upper |= c.is_ascii_uppercase();
                }
            }
        }
        Alphabet {
            index,
            word_break,
            upper,
        }
    }
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct WordTime {
    pub word: String,
    pub start: f64,
    pub end: f64,
    pub score: f64,
}

#[derive(Debug, Clone, Serialize, PartialEq)]
pub struct LineTime {
    pub text: String,
    /// Seconds, or `None` when none of the line's words could be placed.
    pub start: Option<f64>,
    pub end: Option<f64>,
    pub score: Option<f64>,
    pub words: Vec<WordTime>,
    /// Reasons to check this line: "stretched first word", "gap inside the line".
    pub flags: Vec<String>,
}

fn round(value: f64, places: i32) -> f64 {
    let m = 10f64.powi(places);
    (value * m).round() / m
}

/// Places every line in the song. `emission`: `frames x classes` log-probabilities from the speech model.
pub fn align_lines(
    emission: &[f32],
    frames: usize,
    classes: usize,
    alphabet: &Alphabet,
    lines: &[String],
) -> Vec<LineTime> {
    let mut result: Vec<LineTime> = lines
        .iter()
        .map(|l| LineTime {
            text: l.clone(),
            start: None,
            end: None,
            score: None,
            words: Vec::new(),
            flags: Vec::new(),
        })
        .collect();
    let mut words: Vec<(usize, String)> = Vec::new();
    for (n, line) in lines.iter().enumerate() {
        words.extend(tidy_words(line, alphabet.upper).into_iter().map(|w| (n, w)));
    }
    if words.is_empty() {
        return result;
    }
    let mut tokens = Vec::new();
    let mut owner = Vec::new(); // the word each letter belongs to (the word break after a word belongs to it)
    for (k, (_, word)) in words.iter().enumerate() {
        for c in word.chars() {
            match alphabet.index.get(&c) {
                Some(&i) => {
                    tokens.push(i);
                    owner.push(k);
                }
                None => return result,
            }
        }
        if let (true, Some(b)) = (k + 1 < words.len(), alphabet.word_break) {
            tokens.push(b);
            owner.push(k);
        }
    }
    let Some(spans) = forced_align(emission, frames, classes, &tokens, 0) else {
        return result;
    };
    // per word: the (start, end, score) of each of its letters
    let mut times: Vec<Vec<(f64, f64, f64)>> = vec![Vec::new(); words.len()];
    for (span, &k) in spans.iter().zip(&owner) {
        times[k].push((
            span.start as f64 * FRAME_SECONDS,
            span.end as f64 * FRAME_SECONDS,
            span.score as f64,
        ));
    }
    let mut first = vec![f64::INFINITY; lines.len()];
    let mut last = vec![0f64; lines.len()];
    let mut quality: Vec<Vec<f64>> = vec![Vec::new(); lines.len()];
    for (k, (n, _)) in words.iter().enumerate() {
        let Some(t) = times[k].first().zip(times[k].last()) else {
            continue;
        };
        first[*n] = first[*n].min(t.0.0);
        last[*n] = last[*n].max(t.1.1);
        quality[*n].extend(times[k].iter().map(|x| x.2));
    }
    for n in 0..lines.len() {
        if first[n].is_finite() {
            result[n].start = Some(round(first[n], 3));
            result[n].end = Some(round(last[n], 3));
            result[n].score = Some(round(
                quality[n].iter().sum::<f64>() / quality[n].len() as f64,
                3,
            ));
        }
    }
    for (k, (n, word)) in words.iter().enumerate() {
        if let Some((a, b)) = times[k].first().zip(times[k].last()) {
            let mean = times[k].iter().map(|x| x.2).sum::<f64>() / times[k].len() as f64;
            result[*n].words.push(WordTime {
                word: word.clone(),
                start: round(a.0, 2),
                end: round(b.1, 2),
                score: round(mean, 2),
            });
        }
    }
    flag_lines(&mut result);
    result
}

/// Places the lines around the ones a person has already timed (owner, 2026-11-23: time the first lines, then let the AI do the rest, or let it run first, fix a few
/// lines and run it again). `anchors`: (line number, the line's start in seconds as the aligner reports it). Each anchored line starts exactly where the person put
/// it, and the lines between two anchors are placed only inside the stretch of the song between them (so a few good fixed points keep the rest from drifting to
/// the wrong verse). Without anchors this is `align_lines`.
pub fn align_anchored(
    emission: &[f32],
    frames: usize,
    classes: usize,
    alphabet: &Alphabet,
    lines: &[String],
    anchors: &[(usize, f64)],
) -> Vec<LineTime> {
    let mut fixed: Vec<(usize, f64)> = anchors
        .iter()
        .copied()
        .filter(|&(n, at)| n < lines.len() && at.is_finite() && at >= 0.0)
        .filter(|&(n, _)| !tidy_words(&lines[n], alphabet.upper).is_empty())
        .collect();
    fixed.sort_by_key(|a| a.0);
    fixed.dedup_by_key(|a| a.0);
    if fixed.is_empty() {
        return align_lines(emission, frames, classes, alphabet, lines);
    }
    let mut result: Vec<LineTime> = lines
        .iter()
        .map(|l| LineTime {
            text: l.clone(),
            start: None,
            end: None,
            score: None,
            words: Vec::new(),
            flags: Vec::new(),
        })
        .collect();
    let total = frames as f64 * FRAME_SECONDS;
    // Each stretch: the lines from `first` up to (not including) `end`, inside the song from `from` to `to` seconds.
    let mut stretches: Vec<(usize, usize, f64, f64)> = Vec::new();
    if fixed[0].0 > 0 {
        stretches.push((0, fixed[0].0, 0.0, fixed[0].1));
    }
    for (k, &(n, at)) in fixed.iter().enumerate() {
        let end = fixed.get(k + 1).map_or(lines.len(), |next| next.0);
        let to = fixed.get(k + 1).map_or(total, |next| next.1);
        // A little before the fixed start: the aligner's letter spans begin a touch early or late of the time a person taps.
        stretches.push((n, end, (at - 0.3).max(0.0), to));
    }
    for (first, end, from, to) in stretches {
        let a = ((from / FRAME_SECONDS).floor() as usize).min(frames);
        let b = ((to / FRAME_SECONDS).ceil() as usize).min(frames);
        if b <= a {
            continue;
        }
        let part = align_lines(
            &emission[a * classes..b * classes],
            b - a,
            classes,
            alphabet,
            &lines[first..end],
        );
        let shift = a as f64 * FRAME_SECONDS;
        for (offset, mut line) in part.into_iter().enumerate() {
            line.start = line.start.map(|s| round(s + shift, 3));
            line.end = line.end.map(|s| round(s + shift, 3));
            for word in &mut line.words {
                word.start = round(word.start + shift, 2);
                word.end = round(word.end + shift, 2);
            }
            result[first + offset] = line;
        }
    }
    for &(n, at) in &fixed {
        let line = &mut result[n];
        line.start = Some(at);
        line.end = Some(line.end.map_or(at, |e| e.max(at)));
        line.flags.clear(); // a person put it there
    }
    result
}

/// A line whose letters were heard this poorly on average is probably not where it was put (D150).
pub const WEAK_LINE_SCORE: f64 = 0.2;
/// A first word held longer than this is a stretch over a sound that is not in the lyrics, however sure it looks (D150).
pub const LONG_FIRST_WORD: f64 = 2.0;
/// A gap this long early in a line means the words before it were pulled back over something else (D150).
pub const LONG_EARLY_GAP: f64 = 3.0;

/// Marks lines whose start is probably wrong, for a person to check (D150: calibrated on 36 songs whose people-made time stamps agree with the singing, music
/// reader: about 8% of lines flagged, half of them really more than 1.5 s off, 43% of the lines that are): a line heard poorly (score under 0.2), a first word
/// that is very long (over 2 s) or long (over 1 s) and unsure (under 0.3), or a gap of over 3 s early in the line.
pub fn flag_lines(lines: &mut [LineTime]) {
    for line in lines {
        if line.start.is_none() {
            continue;
        }
        if line.score.is_some_and(|s| s < WEAK_LINE_SCORE) {
            line.flags.push("line barely heard".to_owned());
        }
        if line.words.len() < 2 {
            continue;
        }
        let words = &line.words;
        let first = words[0].end - words[0].start;
        if first > LONG_FIRST_WORD || (words[0].score < 0.3 && first > 1.0) {
            line.flags.push("stretched first word".to_owned());
        }
        let last_gap =
            (1..words.len()).rfind(|&i| words[i].start - words[i - 1].end > LONG_EARLY_GAP);
        if let Some(gap) = last_gap
            && gap <= (words.len() / 2 + 1).max(1)
        {
            line.flags.push("gap inside the line".to_owned());
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn word(start: f64, end: f64, score: f64) -> WordTime {
        WordTime {
            word: "la".to_owned(),
            start,
            end,
            score,
        }
    }

    fn line(score: f64, words: Vec<WordTime>) -> LineTime {
        LineTime {
            text: "la la la".to_owned(),
            start: words.first().map(|w| w.start),
            end: words.last().map(|w| w.end),
            score: Some(score),
            words,
            flags: Vec::new(),
        }
    }

    fn flags_of(score: f64, words: Vec<WordTime>) -> Vec<String> {
        let mut lines = vec![line(score, words)];
        flag_lines(&mut lines);
        lines.remove(0).flags
    }

    fn steady() -> Vec<WordTime> {
        vec![
            word(1.0, 1.4, 0.6),
            word(1.5, 1.9, 0.6),
            word(2.0, 2.4, 0.6),
        ]
    }

    /// "ab" at 0.2 s, "cd" at 0.6 s, "ab" at 1.0 s, "cd" at 1.4 s, 2 s of song, one frame per 20 ms.
    fn chorus() -> (Alphabet, Vec<f32>, Vec<String>) {
        let labels: Vec<String> = ["-", "|", "a", "b", "c", "d"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let mut plan = vec![0usize; 100];
        for (start, letters) in [(10, [2, 3]), (30, [4, 5]), (50, [2, 3]), (70, [4, 5])] {
            plan[start] = letters[0];
            plan[start + 1] = letters[0];
            plan[start + 2] = letters[1];
            plan[start + 3] = letters[1];
            plan[start + 4] = 1;
        }
        let mut emission = Vec::new();
        for &class in &plan {
            for k in 0..6 {
                emission.push(if k == class {
                    0.9f32.ln()
                } else {
                    (0.1f32 / 5.0).ln()
                });
            }
        }
        let lines = ["ab", "cd", "ab", "cd"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        (Alphabet::new(&labels), emission, lines)
    }

    fn starts(lines: &[LineTime]) -> Vec<Option<f64>> {
        lines
            .iter()
            .map(|l| l.start.map(|s| (s * 100.0).round() / 100.0))
            .collect()
    }

    #[test]
    fn without_anchors_the_lines_are_placed_as_before() {
        let (alphabet, emission, lines) = chorus();
        let plain = align_lines(&emission, 100, 6, &alphabet, &lines);
        assert_eq!(starts(&plain), [Some(0.2), Some(0.6), Some(1.0), Some(1.4)]);
        assert_eq!(
            align_anchored(&emission, 100, 6, &alphabet, &lines, &[]),
            plain
        );
    }

    #[test]
    fn a_line_a_person_timed_starts_where_they_put_it_and_the_rest_fall_around_it() {
        let (alphabet, emission, lines) = chorus();
        let placed = align_anchored(&emission, 100, 6, &alphabet, &lines, &[(2, 1.03)]);
        assert_eq!(
            starts(&placed),
            [Some(0.2), Some(0.6), Some(1.03), Some(1.4)]
        );
        assert!(placed[2].flags.is_empty());
        // Two fixed lines: the lines between them stay between them.
        let both = align_anchored(&emission, 100, 6, &alphabet, &lines, &[(0, 0.2), (3, 1.4)]);
        assert_eq!(starts(&both), [Some(0.2), Some(0.6), Some(1.0), Some(1.4)]);
    }

    #[test]
    fn anchors_that_make_no_sense_are_ignored() {
        let (alphabet, emission, lines) = chorus();
        let plain = align_lines(&emission, 100, 6, &alphabet, &lines);
        assert_eq!(
            align_anchored(
                &emission,
                100,
                6,
                &alphabet,
                &lines,
                &[(9, 1.0), (1, f64::NAN), (0, -1.0)]
            ),
            plain
        );
    }

    #[test]
    fn a_stretch_too_short_for_its_lines_leaves_them_unplaced() {
        let (alphabet, emission, lines) = chorus();
        // Line 1 is fixed at 0.02 s: the stretch before it is one frame, no room for line 0's letters.
        let placed = align_anchored(&emission, 100, 6, &alphabet, &lines, &[(1, 0.02)]);
        assert_eq!(placed[1].start, Some(0.02));
        assert_eq!(placed[0].start, None);
    }

    #[test]
    fn a_line_heard_well_with_short_gaps_is_not_flagged() {
        assert!(flags_of(0.6, steady()).is_empty());
        // a gap of 2 s inside a line is a held note or a breath, not a fault (it was flagged before D150 and was wrong 87% of the time)
        let held = vec![
            word(1.0, 1.4, 0.6),
            word(3.4, 3.8, 0.6),
            word(3.9, 4.3, 0.6),
        ];
        assert!(flags_of(0.6, held).is_empty());
    }

    #[test]
    fn a_line_barely_heard_is_flagged_even_with_one_word() {
        assert_eq!(flags_of(0.15, steady()), ["line barely heard"]);
        assert_eq!(
            flags_of(0.1, vec![word(1.0, 1.4, 0.1)]),
            ["line barely heard"]
        );
        assert!(flags_of(0.25, steady()).is_empty());
    }

    #[test]
    fn a_very_long_or_long_and_unsure_first_word_is_flagged() {
        let very_long = vec![
            word(1.0, 3.5, 0.7),
            word(3.6, 4.0, 0.6),
            word(4.1, 4.5, 0.6),
        ];
        assert_eq!(flags_of(0.6, very_long), ["stretched first word"]);
        let unsure = vec![
            word(1.0, 2.5, 0.2),
            word(2.6, 3.0, 0.6),
            word(3.1, 3.5, 0.6),
        ];
        assert_eq!(flags_of(0.6, unsure), ["stretched first word"]);
        let long_but_sure = vec![
            word(1.0, 2.5, 0.8),
            word(2.6, 3.0, 0.6),
            word(3.1, 3.5, 0.6),
        ];
        assert!(flags_of(0.6, long_but_sure).is_empty());
    }

    #[test]
    fn only_a_gap_over_three_seconds_early_in_the_line_is_flagged() {
        let early = vec![
            word(1.0, 1.4, 0.6),
            word(5.0, 5.4, 0.6),
            word(5.5, 5.9, 0.6),
        ];
        assert_eq!(flags_of(0.6, early), ["gap inside the line"]);
        let late = vec![
            word(1.0, 1.4, 0.6),
            word(1.5, 1.9, 0.6),
            word(2.0, 2.4, 0.6),
            word(2.5, 2.9, 0.6),
            word(3.0, 3.4, 0.6),
            word(7.0, 7.4, 0.6),
        ];
        assert!(flags_of(0.6, late).is_empty());
    }
}
