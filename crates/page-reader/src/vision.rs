//! From what the vision reader (GLM-OCR) wrote for a photo to song panels: the text has no layout, only lines, so the songs are found by
//! the album's own track titles standing alone on a line. Capitals-only print is put into sentence case, the booklet's decorative "C"
//! (read as an opening bracket) is repaired with the word list, and a paragraph of run-on sentences (a booklet that prints a lyric as
//! one paragraph) is cut into lines again. Plain logic with no models, so it is unit tested.

use crate::layout::{Panel, sentence_case, title_ratio};
use crate::vocab::Vocabulary;

/// How close a lone line must be to a track title to be taken as that song's heading.
const HEADING_SIMILARITY: f32 = 0.85;
/// A line longer than this is a paragraph of run-on sentences, not one lyric line.
const PARAGRAPH_CHARS: usize = 110;

/// The songs in `raw`, one panel each (the heading as printed, the words), in reading order. A reading without any heading is one panel
/// with an empty title. `score` is left at 0: the caller sets it after repairing the words.
pub fn songs_from_reading(raw: &str, titles: &[String], vocab: &Vocabulary) -> Vec<Panel> {
    let lines = tidy_lines(raw, vocab);
    let mut used = vec![false; titles.len()];
    let mut heads: Vec<(usize, String)> = Vec::new();
    for (i, line) in lines.iter().enumerate() {
        if line.is_empty() || line.chars().count() > 70 {
            continue;
        }
        let candidate = strip_number(line);
        let best = titles
            .iter()
            .enumerate()
            .filter(|(t, _)| !used[*t])
            .map(|(t, title)| (t, title_ratio(&candidate, title)))
            .max_by(|a, b| a.1.partial_cmp(&b.1).unwrap_or(std::cmp::Ordering::Equal));
        let Some((track, similarity)) = best else {
            continue;
        };
        // a heading stands after a gap (or is a near-perfect match), is about as long as the title, and is the first such line for that title
        let after_gap = i == 0 || lines[i - 1].is_empty();
        let near_length = candidate.chars().count() <= titles[track].chars().count() + 14;
        if similarity >= HEADING_SIMILARITY && near_length && (after_gap || similarity >= 0.95) {
            used[track] = true;
            heads.push((i, candidate));
        }
    }
    let mut panels = Vec::new();
    let mut push = |title: String, body: &[String]| {
        let lines = body_lines(body);
        if lines.iter().filter(|l| !l.is_empty()).count() >= if title.is_empty() { 4 } else { 1 } {
            let left = panels.len() as f32;
            panels.push(Panel {
                title,
                lines,
                score: 0.0,
                left,
                bounds: [0.0; 4],
            });
        }
    };
    if heads.is_empty() {
        push(String::new(), &lines);
        return panels;
    }
    push(String::new(), &lines[..heads[0].0]);
    for (n, (at, title)) in heads.iter().enumerate() {
        let end = heads.get(n + 1).map_or(lines.len(), |h| h.0);
        push(title.clone(), &lines[at + 1..end]);
    }
    panels
}

/// The reading's lines tidied: curly quotes made plain, markdown marks removed, decorative-C brackets repaired, blank lines kept once.
fn tidy_lines(raw: &str, vocab: &Vocabulary) -> Vec<String> {
    let mut out: Vec<String> = Vec::new();
    for raw_line in raw.lines() {
        let line: String = raw_line
            .replace(['’', '‘'], "'")
            .replace(['“', '”'], "\"")
            .replace("**", "")
            .trim_start_matches('#')
            .split_whitespace()
            .collect::<Vec<_>>()
            .join(" ");
        if line.is_empty() || !line.chars().any(char::is_alphanumeric) {
            if out.last().is_some_and(|l| !l.is_empty()) {
                out.push(String::new());
            }
            continue;
        }
        out.push(fix_brackets(&line, vocab));
    }
    while out.last().is_some_and(|l| l.is_empty()) {
        out.pop();
    }
    out
}

/// The booklet's swash "C" is read as an opening bracket, sometimes with the letter after it and sometimes in place of it: "(HASING"
/// and "(CONTROL". An opening bracket that is never closed is dropped, with the "C" put back when that makes a known word.
fn fix_brackets(line: &str, vocab: &Vocabulary) -> String {
    if line.contains(')') {
        return line.to_owned();
    }
    line.split(' ')
        .map(|word| {
            let Some(rest) = word.strip_prefix('(') else {
                return word.to_owned();
            };
            if rest.is_empty() {
                return String::new();
            }
            let first = rest.chars().next().unwrap_or(' ');
            if !first.is_alphabetic() {
                return word.to_owned();
            }
            let c = if rest.chars().all(|ch| !ch.is_lowercase()) {
                'C'
            } else {
                'c'
            };
            let with_c = format!("{c}{rest}");
            let plain_known = vocab.known_fraction(rest);
            let with_c_known = vocab.known_fraction(&with_c);
            if with_c_known > plain_known
                || (with_c_known >= plain_known && !rest.starts_with(['c', 'C']))
            {
                with_c
            } else {
                rest.to_owned()
            }
        })
        .filter(|w| !w.is_empty())
        .collect::<Vec<_>>()
        .join(" ")
}

/// A heading's number in front of it ("01 The Good Days", "3. Mind Control") is not part of the title.
fn strip_number(line: &str) -> String {
    let trimmed = line.trim_start_matches(|c: char| c.is_ascii_digit());
    if trimmed.len() == line.len() {
        return line.to_owned();
    }
    trimmed
        .trim_start_matches(['.', ')', '-', ' '])
        .trim()
        .to_owned()
}

/// One song's lines: capitals-only text in sentence case, paragraphs cut into lines, blank edges removed.
fn body_lines(body: &[String]) -> Vec<String> {
    let letters: Vec<char> = body
        .iter()
        .flat_map(|l| l.chars())
        .filter(|c| c.is_alphabetic())
        .collect();
    let upper = letters.iter().filter(|c| c.is_uppercase()).count();
    let shouting = letters.len() >= 12 && upper * 10 >= letters.len() * 7;
    let mut out: Vec<String> = Vec::new();
    for line in body {
        if line.is_empty() {
            if out.last().is_some_and(|l| !l.is_empty()) {
                out.push(String::new());
            }
            continue;
        }
        for piece in split_paragraph(line) {
            out.push(if shouting {
                sentence_case(&piece)
            } else {
                piece
            });
        }
    }
    while out.last().is_some_and(|l| l.is_empty()) {
        out.pop();
    }
    out
}

/// A long line of run-on sentences is cut after each ". " (or "? ", "! ") that is followed by a capital; short lines are left alone.
fn split_paragraph(line: &str) -> Vec<String> {
    if line.chars().count() <= PARAGRAPH_CHARS {
        return vec![line.to_owned()];
    }
    let chars: Vec<char> = line.chars().collect();
    let mut pieces = Vec::new();
    let mut start = 0;
    for i in 0..chars.len().saturating_sub(2) {
        if matches!(chars[i], '.' | '?' | '!')
            && chars[i + 1] == ' '
            && chars[i + 2..]
                .iter()
                .find(|c| !c.is_whitespace())
                .is_some_and(|c| c.is_uppercase() || matches!(c, '"' | '\'' | '('))
        {
            let piece: String = chars[start..=i].iter().collect();
            pieces.push(piece.trim().to_owned());
            start = i + 2;
        }
    }
    let rest: String = chars[start..].iter().collect();
    if !rest.trim().is_empty() {
        pieces.push(rest.trim().to_owned());
    }
    pieces
}

/// Stanza breaks borrowed from a second reading of the same page: `lines` are a song's lines as read from the whole photo (an empty entry is
/// a stanza gap), `other` is the same song read from its own cut-out page, which keeps the gaps better. Each gap in `other` is put in
/// `lines` after the line it follows, found by lining the two readings up (lines count as the same when they are nearly alike). No word
/// is changed. When the two readings do not line up (fewer than six in ten lines found in both) `lines` is returned as it was.
pub fn borrow_breaks(lines: &[String], other: &str) -> Vec<String> {
    let mine: Vec<(usize, &String)> = lines
        .iter()
        .enumerate()
        .filter(|(_, l)| !l.is_empty())
        .collect();
    let theirs: Vec<(&str, bool)> = {
        let raw: Vec<&str> = other.lines().map(str::trim).collect();
        raw.iter()
            .enumerate()
            .filter(|(_, l)| !l.is_empty())
            .map(|(i, l)| (*l, raw.get(i + 1).is_some_and(|n| n.is_empty())))
            .collect()
    };
    if mine.is_empty() || theirs.is_empty() {
        return lines.to_vec();
    }
    let alike = |a: &str, b: &str| title_ratio(a, b) >= 0.8;
    // longest common subsequence of alike lines
    let (n, m) = (mine.len(), theirs.len());
    let mut table = vec![vec![0u16; m + 1]; n + 1];
    for i in (0..n).rev() {
        for j in (0..m).rev() {
            table[i][j] = if alike(mine[i].1, theirs[j].0) {
                table[i + 1][j + 1] + 1
            } else {
                table[i + 1][j].max(table[i][j + 1])
            };
        }
    }
    if (table[0][0] as usize) * 10 < n * 6 {
        return lines.to_vec();
    }
    let mut gap_after = vec![false; lines.len()];
    let (mut i, mut j) = (0, 0);
    while i < n && j < m {
        if alike(mine[i].1, theirs[j].0) && table[i][j] == table[i + 1][j + 1] + 1 {
            if theirs[j].1 {
                gap_after[mine[i].0] = true;
            }
            i += 1;
            j += 1;
        } else if table[i + 1][j] >= table[i][j + 1] {
            i += 1;
        } else {
            j += 1;
        }
    }
    let mut out: Vec<String> = Vec::new();
    for (k, line) in lines.iter().enumerate() {
        out.push(line.clone());
        let last = k + 1 == lines.len();
        let next_blank = lines.get(k + 1).is_some_and(|l| l.is_empty());
        if gap_after[k] && !line.is_empty() && !last && !next_blank {
            out.push(String::new());
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vocab() -> Vocabulary {
        let mut v = Vocabulary::default();
        for _ in 0..20 {
            v.add("chasing the thunder control your mind can take catch me in the throws let it burn out we don't have forever");
        }
        v
    }

    fn titles() -> Vec<String> {
        ["The Good Days", "Mind Control", "Panic Attack"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect()
    }

    #[test]
    fn songs_are_found_by_their_titles_and_capitals_become_sentences() {
        let raw = "THE GOOD DAYS\nTHESE ARE THE GOOD DAYS\nIF TOMORROW NEVER HAPPENS\n\nLET IT BURN OUT, WE DON'T HAVE FOREVER\n\nMIND CONTROL\nYOU MUST CONTROL WHAT YOUR MIND CAN TAKE\nALMOST LIKE CONTROLLING THE FUTURE\n";
        let panels = songs_from_reading(raw, &titles(), &vocab());
        assert_eq!(panels.len(), 2);
        assert_eq!(panels[0].title, "THE GOOD DAYS");
        assert_eq!(
            panels[0].lines,
            vec![
                "These are the good days",
                "If tomorrow never happens",
                "",
                "Let it burn out, we don't have forever"
            ]
        );
        assert_eq!(panels[1].title, "MIND CONTROL");
        assert_eq!(panels[1].lines.len(), 2);
    }

    #[test]
    fn the_decorative_c_read_as_a_bracket_is_repaired() {
        let raw = "THE GOOD DAYS\n(HASING THE THUNDER\nYOU MUST (CONTROL WHAT YOUR MIND (AN TAKE\n(CATCH ME IN THE THROWS\nEXTRA LINE HERE\n";
        let panels = songs_from_reading(raw, &titles(), &vocab());
        assert_eq!(panels[0].lines[0], "Chasing the thunder");
        assert_eq!(
            panels[0].lines[1],
            "You must control what your mind can take"
        );
        assert_eq!(panels[0].lines[2], "Catch me in the throws");
    }

    #[test]
    fn real_brackets_are_left_alone() {
        let raw = "THE GOOD DAYS\n(Catch me in the throws)\nOne\nTwo\nThree\n";
        let panels = songs_from_reading(raw, &titles(), &vocab());
        assert_eq!(panels[0].lines[0], "(Catch me in the throws)");
    }

    #[test]
    fn a_lyric_line_that_repeats_the_title_is_not_a_second_heading() {
        let raw = "Mind Control\nlearn some\nMind Control\nsteady\nas she goes\n";
        let panels = songs_from_reading(raw, &titles(), &vocab());
        assert_eq!(panels.len(), 1);
        assert_eq!(panels[0].lines.len(), 4);
    }

    #[test]
    fn a_reading_without_headings_is_one_untitled_panel_and_short_scraps_are_dropped() {
        let raw = "line one\nline two\nline three\nline four\nline five\n";
        let panels = songs_from_reading(raw, &titles(), &vocab());
        assert_eq!(panels.len(), 1);
        assert_eq!(panels[0].title, "");
        assert!(songs_from_reading("credits\nthanks", &titles(), &vocab()).is_empty());
    }

    #[test]
    fn numbers_before_headings_and_curly_quotes_are_tidied() {
        let raw = "01. The Good Days\nDon’t stop\nWe’re here\n";
        let panels = songs_from_reading(raw, &titles(), &vocab());
        assert_eq!(panels[0].title, "The Good Days");
        assert_eq!(panels[0].lines, vec!["Don't stop", "We're here"]);
    }

    #[test]
    fn a_lyric_line_that_contains_a_short_title_is_not_its_heading() {
        let titles: Vec<String> = ["On Saturday", "Not Me"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let raw = "ON SATURDAY
ONE\nTWO\nTHREE

NO WAY NOT ME
FOUR

NOT ME
FIVE
SIX
SEVEN
";
        let panels = songs_from_reading(raw, &titles, &vocab());
        assert_eq!(panels.len(), 2);
        assert_eq!(panels[0].title, "ON SATURDAY");
        assert_eq!(panels[0].lines.len(), 6);
        assert_eq!(panels[1].title, "NOT ME");
    }

    #[test]
    fn a_paragraph_is_cut_into_its_sentences() {
        let paragraph = "In this world today there ain't nobody to thank. Just blame it on the kids and toss 'em into the tank. And if they yell for justice we'll hide them from the light.";
        let raw = format!("Panic Attack\n{paragraph}\n");
        let panels = songs_from_reading(&raw, &titles(), &vocab());
        assert_eq!(panels[0].lines.len(), 3);
        assert!(panels[0].lines[0].ends_with("thank."));
        assert!(panels[0].lines[2].starts_with("And if they yell"));
    }

    #[test]
    fn stanza_gaps_are_borrowed_from_the_second_reading_without_changing_words() {
        let mine: Vec<String> = [
            "One two three",
            "Four five six",
            "Seven eight",
            "Nine ten",
            "Eleven twelve",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        let other = "One two three\nFour five sixx\n\nSeven eight\nNine ten\n\nEleven twelve\n";
        let out = borrow_breaks(&mine, other);
        assert_eq!(
            out,
            vec![
                "One two three",
                "Four five six",
                "",
                "Seven eight",
                "Nine ten",
                "",
                "Eleven twelve"
            ]
        );
    }

    #[test]
    fn a_second_reading_that_does_not_line_up_changes_nothing() {
        let mine: Vec<String> = ["One two three", "Four five six", "Seven eight"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        assert_eq!(borrow_breaks(&mine, "Something\n\nelse entirely\n"), mine);
    }

    #[test]
    fn existing_gaps_are_kept_and_not_doubled() {
        let mine: Vec<String> = ["Aaa bbb ccc", "", "Ddd eee fff", "Ggg hhh iii"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let out = borrow_breaks(&mine, "Aaa bbb ccc\n\nDdd eee fff\n\nGgg hhh iii\n");
        assert_eq!(
            out,
            vec!["Aaa bbb ccc", "", "Ddd eee fff", "", "Ggg hhh iii"]
        );
    }
}
