//! CTC forced alignment: given the log-odds a speech model gave each letter for every 20 ms of a song and the letters of the lyrics, find the most
//! likely frame for every letter (a Viterbi search through the letters with "nothing" frames between them). Same result as torchaudio's
//! `forced_align` plus `merge_tokens`.

/// One letter of the target and where it was placed: frames `start..end` (end exclusive) and the mean probability over those frames.
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Span {
    pub token: usize,
    pub start: usize,
    pub end: usize,
    pub score: f32,
}

/// `emission`: `frames x classes` log-probabilities, row by row; `tokens`: class numbers of the letters in order (none is the blank class);
/// `blank`: the class of "nothing" (0 for these models). `None` when the letters cannot fit in the frames or the input is malformed.
pub fn forced_align(
    emission: &[f32],
    frames: usize,
    classes: usize,
    tokens: &[usize],
    blank: usize,
) -> Option<Vec<Span>> {
    forced_align_scored(emission, frames, classes, tokens, blank).map(|(spans, _)| spans)
}

/// Like `forced_align`, and the log-likelihood of the best path too (the sum over all frames of the log-probability of the state the path is in): how well
/// the letters fit the audio. Compared with the same audio's best path of any letters (the sum of each frame's highest log-probability) it says how much
/// worse the given letters are than anything the model could hear: see `identity::fit`.
pub fn forced_align_scored(
    emission: &[f32],
    frames: usize,
    classes: usize,
    tokens: &[usize],
    blank: usize,
) -> Option<(Vec<Span>, f32)> {
    let n = tokens.len();
    if n == 0
        || frames == 0
        || emission.len() != frames * classes
        || tokens.iter().any(|&t| t >= classes || t == blank)
    {
        return None;
    }
    // repeated letters need a "nothing" frame between them
    let repeats = tokens.windows(2).filter(|w| w[0] == w[1]).count();
    if n + repeats > frames {
        return None;
    }
    let states = 2 * n + 1;
    let label = |j: usize| {
        if j.is_multiple_of(2) {
            blank
        } else {
            tokens[j / 2]
        }
    };
    let at = |t: usize, class: usize| emission[t * classes + class];
    const NEG: f32 = f32::NEG_INFINITY;
    let mut previous = vec![NEG; states];
    let mut current = vec![NEG; states];
    // 0: stay, 1: came from the state before, 2: came from two before
    let mut came = vec![0u8; frames * states];
    previous[0] = at(0, blank);
    previous[1] = at(0, tokens[0]);
    for t in 1..frames {
        for j in 0..states {
            let mut best = previous[j];
            let mut how = 0u8;
            if j >= 1 && previous[j - 1] > best {
                best = previous[j - 1];
                how = 1;
            }
            if j >= 2 && j % 2 == 1 && label(j) != label(j - 2) && previous[j - 2] > best {
                best = previous[j - 2];
                how = 2;
            }
            current[j] = if best == NEG {
                NEG
            } else {
                best + at(t, label(j))
            };
            came[t * states + j] = how;
        }
        std::mem::swap(&mut previous, &mut current);
    }
    // the path ends on the last letter or on the "nothing" after it
    let mut state = if previous[states - 1] >= previous[states - 2] {
        states - 1
    } else {
        states - 2
    };
    let total = previous[state];
    if total == NEG {
        return None;
    }
    let mut path = vec![0usize; frames];
    for t in (0..frames).rev() {
        path[t] = state;
        state -= match came[t * states + state] {
            0 => 0,
            1 => 1,
            _ => 2,
        };
    }
    // merge: runs of frames in the same letter state are one span (letters are told apart by their state, not their class)
    let mut spans: Vec<Span> = Vec::with_capacity(n);
    let mut t = 0;
    while t < frames {
        let j = path[t];
        let mut end = t;
        while end < frames && path[end] == j {
            end += 1;
        }
        if j % 2 == 1 {
            let token = tokens[j / 2];
            let mean = (t..end).map(|f| at(f, token).exp()).sum::<f32>() / (end - t) as f32;
            spans.push(Span {
                token,
                start: t,
                end,
                score: mean,
            });
        }
        t = end;
    }
    (spans.len() == n).then_some((spans, total))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// frames where each class in `plan` is clearly the most likely one (class 0 is "nothing")
    fn emission(plan: &[usize], classes: usize) -> Vec<f32> {
        let mut out = Vec::new();
        for &c in plan {
            for k in 0..classes {
                out.push(if k == c {
                    (0.9f32).ln()
                } else {
                    (0.1f32 / (classes - 1) as f32).ln()
                });
            }
        }
        out
    }

    #[test]
    fn letters_are_placed_where_they_are_loudest() {
        let plan = [0, 0, 1, 1, 0, 2, 2, 2, 0, 0, 3, 0];
        let spans = forced_align(&emission(&plan, 4), plan.len(), 4, &[1, 2, 3], 0).unwrap();
        assert_eq!(
            spans
                .iter()
                .map(|s| (s.token, s.start, s.end))
                .collect::<Vec<_>>(),
            [(1, 2, 4), (2, 5, 8), (3, 10, 11)]
        );
        assert!(spans.iter().all(|s| (s.score - 0.9).abs() < 1e-4));
    }

    #[test]
    fn a_repeated_letter_needs_a_gap_and_gets_two_spans() {
        let plan = [1, 1, 0, 1, 1, 1];
        let spans = forced_align(&emission(&plan, 3), plan.len(), 3, &[1, 1], 0).unwrap();
        assert_eq!(
            spans.iter().map(|s| (s.start, s.end)).collect::<Vec<_>>(),
            [(0, 2), (3, 6)]
        );
        assert!(
            forced_align(&emission(&[1, 1], 3), 2, 3, &[1, 1], 0).is_none(),
            "no room for the gap"
        );
    }

    #[test]
    fn impossible_input_is_refused() {
        assert!(forced_align(&[], 0, 3, &[1], 0).is_none());
        assert!(
            forced_align(&emission(&[1], 3), 1, 3, &[1, 2], 0).is_none(),
            "more letters than frames"
        );
        assert!(
            forced_align(&emission(&[1, 1], 3), 2, 3, &[0], 0).is_none(),
            "the blank is not a letter"
        );
    }
}
