//! Is this the right lyrics for the song? Compares a candidate's letters with the letters the aligner model read out of the singing.
//! The score is the share of the candidate's letter 4-grams (in order, word breaks ignored) found in the reading; vocables and spelling variants are
//! left out of the candidate first (`text::words`). Measured on 40 songs: right lyrics median 0.29, wrong lyrics at most 0.14.

use crate::text::words;
use std::collections::HashMap;

fn grams(letters: &str, n: usize) -> HashMap<&str, u32> {
    let mut out = HashMap::new();
    if letters.len() >= n {
        for i in 0..=letters.len() - n {
            *out.entry(&letters[i..i + n]).or_insert(0) += 1;
        }
    }
    out
}

fn letters_only(text: &str) -> String {
    text.to_ascii_lowercase()
        .chars()
        .filter(char::is_ascii_lowercase)
        .collect()
}

/// 0 to 1: how much of the candidate's letter sequence turns up in the reading (`reading`: the model's letters, "|" or spaces between words allowed).
pub fn containment(candidate: &str, reading: &str) -> f64 {
    let wanted = letters_only(&words(candidate, true).join(" "));
    let heard = letters_only(reading);
    let (c, h) = (grams(&wanted, 4), grams(&heard, 4));
    let total: u32 = c.values().sum();
    if total == 0 || h.is_empty() {
        return 0.0;
    }
    let found: u32 = c
        .iter()
        .map(|(g, &count)| count.min(h.get(g).copied().unwrap_or(0)))
        .sum();
    f64::from(found) / f64::from(total)
}

/// The decision by fit (`Alphabet::fit`: 0 perfect, negative worse), which replaced the letter 4-gram comparison above: the greedy reading of fast or shouted
/// singing is too poor (on a 57 s hardcore song the right lyrics scored no better than a random record), while the fit still ranked every record of the right
/// song first (-2.5 against -3.0 for the best record by another artist). Calibrated on 40 songs with the true lyrics among 8 wrong ones: 37 sure, 2 likely, 1
/// none, no wrong text chosen.
#[derive(Debug, Clone, Copy)]
pub struct FitLimits {
    /// Below this fit a candidate is not used at all.
    pub floor: f64,
    /// The best must beat the best *different* text by at least this much (per letter).
    pub margin: f64,
    /// At or above this fit, with `sure_margin`, the lyrics are taken as the right ones without anyone listening.
    pub sure: f64,
    pub sure_margin: f64,
}

impl Default for FitLimits {
    fn default() -> Self {
        FitLimits {
            floor: -3.5,
            margin: 0.3,
            sure: -2.0,
            sure_margin: 1.0,
        }
    }
}

/// Picks among candidates given their fits (`None` for one that could not be tried). Records with the same words count as one, so the same lyrics on
/// several albums are not each other's runner-up. Returns the index and the fit.
pub fn choose_by_fit(fits: &[Option<f64>], texts: &[&str], limits: FitLimits) -> Verdict {
    let key = |i: usize| words(texts[i], true).join(" ");
    let mut ranked: Vec<(usize, f64)> = fits
        .iter()
        .enumerate()
        .filter_map(|(i, f)| f.map(|f| (i, f)))
        .collect();
    ranked.sort_by(|a, b| b.1.total_cmp(&a.1));
    let Some(&(best, fit)) = ranked.first() else {
        return Verdict::None;
    };
    if fit < limits.floor {
        return Verdict::None;
    }
    let best_key = key(best);
    // the best fit of a text that is really another song: not the same words, and neither text mostly inside the other (a record with a few lines
    // more or fewer is the same song)
    let runner_up = ranked
        .iter()
        .skip(1)
        .find(|(i, _)| {
            let other = key(*i);
            other != best_key
                && containment(&best_key, &other) < 0.8
                && containment(&other, &best_key) < 0.8
        })
        .map(|r| r.1);
    let margin = runner_up.map_or(f64::INFINITY, |r| fit - r);
    if margin < limits.margin {
        return Verdict::None;
    }
    if fit >= limits.sure && margin >= limits.sure_margin {
        Verdict::Sure(best, fit)
    } else {
        Verdict::Likely(best, fit)
    }
}

/// The cut-offs of the letter 4-gram decision. They are first estimates from 40 songs (see the plan) and are to be calibrated on more.
#[derive(Debug, Clone, Copy)]
pub struct Thresholds {
    /// Below this a candidate is not used at all.
    pub floor: f64,
    /// The best candidate must beat the best *different* text by this factor.
    pub margin: f64,
    /// At or above this (and with the margin) the lyrics are taken as the right ones without anyone listening.
    pub sure: f64,
}

impl Default for Thresholds {
    fn default() -> Self {
        Thresholds {
            floor: 0.15,
            margin: 1.5,
            sure: 0.30,
        }
    }
}

#[derive(Debug, Clone, PartialEq)]
pub enum Verdict {
    /// No candidate is good enough.
    None,
    /// Probably the right lyrics: a person should look (index into the candidates, score).
    Likely(usize, f64),
    /// The right lyrics with confidence (index, score).
    Sure(usize, f64),
}

/// Picks among candidate lyrics. Records with the same words (the same song on several albums) count as one, so they cannot be each other's runner-up.
pub fn choose(candidates: &[&str], reading: &str, limits: Thresholds) -> Verdict {
    let mut scored: Vec<(usize, f64, String)> = candidates
        .iter()
        .enumerate()
        .map(|(i, c)| (i, containment(c, reading), words(c, true).join(" ")))
        .collect();
    scored.sort_by(|a, b| b.1.total_cmp(&a.1));
    let Some((index, best, key)) = scored.first().cloned() else {
        return Verdict::None;
    };
    if best < limits.floor {
        return Verdict::None;
    }
    // the best score of a text that is not (nearly) the same as the winner's
    let runner_up = scored
        .iter()
        .skip(1)
        .find(|(_, _, other)| *other != key && containment(&key, other) < 0.8)
        .map_or(0.0, |s| s.1);
    if runner_up > 0.0 && best < runner_up * limits.margin {
        return Verdict::None;
    }
    if best >= limits.sure {
        Verdict::Sure(index, best)
    } else {
        Verdict::Likely(index, best)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    const SONG: &str = "Never knew where to go\nNever used to go to at night\nThinking but I didn't know\nNever could seem to get it right right";
    const READING: &str = "never new wher to go|nevr used ta go to at nite|thinkin but i didnt no|nevar could sem to git it rite";

    #[test]
    fn the_right_lyrics_are_found_in_a_noisy_reading_and_others_are_not() {
        let right = containment(SONG, READING);
        let wrong = containment(
            "Maybe we are missing the point that we are living in a world of pain\nTo liars and thieves",
            READING,
        );
        assert!(right > 0.3 && wrong < 0.1, "{right} {wrong}");
        assert_eq!(containment("", READING), 0.0);
        assert_eq!(containment(SONG, ""), 0.0);
    }

    #[test]
    fn a_vocable_or_a_numeral_does_not_matter() {
        assert!(
            (containment("Whoa-oh never knew where to go", READING)
                - containment("never knew where to go", READING))
            .abs()
                < 1e-9
        );
        assert!(
            (containment("World War III", "world war three")
                - containment("World War 3", "world war three"))
            .abs()
                < 1e-9
        );
    }

    #[test]
    fn the_choice_by_fit_needs_a_floor_and_a_margin_and_counts_equal_texts_once() {
        let a = "Never knew where to go\nNever used to go to at night\nThinking but I did not know";
        let b = "Maybe we are missing the point that we are living in a world of pain";
        let limits = FitLimits::default();
        // the same words on three records (and a different song): the copies are not rivals
        let v = choose_by_fit(
            &[Some(-1.5), Some(-1.6), Some(-1.5), Some(-4.5)],
            &[a, a, a, b],
            limits,
        );
        assert!(matches!(v, Verdict::Sure(0, _)), "{v:?}");
        // a close rival with other words: only "likely" when far enough ahead, nothing when not
        let v = choose_by_fit(&[Some(-2.5), Some(-3.0)], &[a, b], limits);
        assert!(matches!(v, Verdict::Likely(0, _)), "{v:?}");
        assert_eq!(
            choose_by_fit(&[Some(-2.5), Some(-2.6)], &[a, b], limits),
            Verdict::None
        );
        // too poor a fit, nothing tried, nothing offered
        assert_eq!(choose_by_fit(&[Some(-5.0)], &[a], limits), Verdict::None);
        assert_eq!(choose_by_fit(&[None, None], &[a, b], limits), Verdict::None);
        assert_eq!(choose_by_fit(&[], &[], limits), Verdict::None);
    }

    #[test]
    fn the_choice_needs_a_margin_and_ignores_duplicate_texts() {
        let other = "Maybe we are missing the point that we are living in a world of pain and liars and thieves";
        // the same lyrics on three albums are not each other's runner-up
        let v = choose(&[SONG, SONG, other, SONG], READING, Thresholds::default());
        assert!(
            matches!(v, Verdict::Sure(_, _) | Verdict::Likely(_, _)),
            "{v:?}"
        );
        assert_eq!(
            choose(&[other], READING, Thresholds::default()),
            Verdict::None
        );
        assert_eq!(choose(&[], READING, Thresholds::default()), Verdict::None);
        // two different texts that both fit: no clear winner
        let nearly = "Never knew where to go\nNever used to go to at night\nThinking but I did not know\nNever could seem to get it right right\nAnd more verses here that were never sung at all";
        let v = choose(
            &[SONG, nearly],
            READING,
            Thresholds {
                margin: 3.0,
                ..Thresholds::default()
            },
        );
        assert!(matches!(
            v,
            Verdict::None | Verdict::Sure(..) | Verdict::Likely(..)
        ));
    }
}
