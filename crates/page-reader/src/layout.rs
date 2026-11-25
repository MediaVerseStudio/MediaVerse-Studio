//! From the text lines of a photo to song panels: the lines are grouped into columns (booklet lyrics sit on separate sheets side by
//! side, a photo often holds several), the big letters at the top of a column are its title, the rest are the words with a blank
//! line where the gap between lines is wider than usual. Titles are matched to an album's track titles by how alike the names are.
//! No models and no pictures here, so it is unit tested with made-up lines.

use crate::ocr::TextLine;

/// One song's sheet in a photo.
#[derive(Debug, Clone, PartialEq)]
pub struct Panel {
    /// The heading as read (empty when the column has none, such as a credits sheet's first line being small).
    pub title: String,
    /// The words, one entry per line; an empty entry is the gap between two stanzas.
    pub lines: Vec<String>,
    /// Mean reading confidence of the words (0..1), so a doubtful page can be pointed out.
    pub score: f32,
    /// Where it sits in the photo (left edge, in pixels), to keep the reading order.
    pub left: f32,
    /// The sheet's place in the photo as left, top, right, bottom in pixels (a little room around it), to show the picture the words were read from.
    pub bounds: [f32; 4],
}

impl Panel {
    /// The words as lyrics text (lines joined, stanza gaps kept).
    pub fn text(&self) -> String {
        self.lines.join("\n")
    }

    fn sung_lines(&self) -> usize {
        self.lines.iter().filter(|l| !l.is_empty()).count()
    }
}

/// The top and bottom of a line (a tilted line reaches a little further).
fn vertical_extent(line: &TextLine) -> (f32, f32) {
    let half =
        (line.width / 2.0) * line.angle.sin().abs() + (line.height / 2.0) * line.angle.cos().abs();
    (line.cy - half, line.cy + half)
}

/// The box around some lines with `margin` pixels of room.
fn bounds_of(lines: &[&TextLine], margin: f32) -> [f32; 4] {
    let x0 = lines.iter().map(|l| extent(l).0).fold(f32::MAX, f32::min);
    let x1 = lines.iter().map(|l| extent(l).1).fold(f32::MIN, f32::max);
    let y0 = lines
        .iter()
        .map(|l| vertical_extent(l).0)
        .fold(f32::MAX, f32::min);
    let y1 = lines
        .iter()
        .map(|l| vertical_extent(l).1)
        .fold(f32::MIN, f32::max);
    [
        (x0 - margin).max(0.0),
        (y0 - margin).max(0.0),
        x1 + margin,
        y1 + margin,
    ]
}

fn extent(line: &TextLine) -> (f32, f32) {
    let half =
        (line.width / 2.0) * line.angle.cos().abs() + (line.height / 2.0) * line.angle.sin().abs();
    (line.cx - half, line.cx + half)
}

fn median(mut values: Vec<f32>) -> f32 {
    if values.is_empty() {
        return 0.0;
    }
    values.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    values[values.len() / 2]
}

/// The sheets in a photo, left to right. A column needs at least three lines to count (a stray word of artwork does not).
pub fn panels_from_lines(lines: &[TextLine]) -> Vec<Panel> {
    // columns: lines whose horizontal extents overlap belong together; a gap (the wall between two sheets) ends a column
    let mut order: Vec<usize> = (0..lines.len()).collect();
    order.sort_by(|&a, &b| {
        extent(&lines[a])
            .0
            .partial_cmp(&extent(&lines[b]).0)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut columns: Vec<(f32, f32, Vec<usize>)> = Vec::new();
    for index in order {
        let (x0, x1) = extent(&lines[index]);
        match columns.last_mut() {
            Some((_, right, members)) if x0 < *right => {
                *right = right.max(x1);
                members.push(index);
            }
            _ => columns.push((x0, x1, vec![index])),
        }
    }
    let columns = split_by_centres(columns, lines);
    let body_height = median(lines.iter().map(|l| l.height).collect());
    let mut panels = Vec::new();
    for (left, _, mut members) in columns {
        if members.len() < 3 {
            continue;
        }
        members.sort_by(|&a, &b| {
            lines[a]
                .cy
                .partial_cmp(&lines[b].cy)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let column: Vec<&TextLine> = main_block(members.iter().map(|&i| &lines[i]).collect());
        if column.len() < 3 {
            continue;
        }
        let panel_height = median(column.iter().map(|l| l.height).collect());
        // the heading: the lines at the top set in clearly larger letters than the rest of the sheet
        let big = |l: &TextLine| l.height >= panel_height.max(body_height * 0.6) * 1.3;
        let mut heading = column.iter().take_while(|l| big(l)).count();
        // a heading is not most of the sheet
        if heading * 2 > column.len() {
            heading = 0;
        }
        let title = column[..heading]
            .iter()
            .map(|l| l.text.as_str())
            .collect::<Vec<_>>()
            .join(" ");
        let body = &column[heading..];
        let pitches: Vec<f32> = body
            .windows(2)
            .map(|w| w[1].cy - w[0].cy)
            .filter(|d| *d > 0.0)
            .collect();
        let pitch = median(pitches);
        let mut text: Vec<String> = Vec::new();
        for (i, line) in body.iter().enumerate() {
            if i > 0 && pitch > 0.0 && line.cy - body[i - 1].cy > pitch * 1.45 {
                text.push(String::new());
            }
            text.push(line.text.clone());
        }
        let shouting = {
            let letters: Vec<char> = text
                .iter()
                .flat_map(|l| l.chars())
                .filter(|c| c.is_alphabetic())
                .collect();
            !letters.is_empty()
                && letters.iter().filter(|c| c.is_uppercase()).count() * 10 >= letters.len() * 9
        };
        if shouting {
            text = text.iter().map(|l| sentence_case(l)).collect();
        }
        let score = body.iter().map(|l| l.score).sum::<f32>() / body.len().max(1) as f32;
        panels.push(Panel {
            bounds: bounds_of(&column, panel_height * 1.5),
            title: clean_title(&title),
            lines: text,
            score,
            left,
        });
    }
    panels
}

/// Two sheets side by side can have their widest lines reach over each other, which joins them into one column. The lines of one
/// sheet are centred on the same place, so a column whose line centres fall into groups with a clear gap between them is cut there
/// (a group of fewer than four lines is not a sheet and goes with its neighbour).
fn split_by_centres(
    columns: Vec<(f32, f32, Vec<usize>)>,
    lines: &[TextLine],
) -> Vec<(f32, f32, Vec<usize>)> {
    let mut result = Vec::new();
    for (left, right, mut members) in columns {
        let typical = median(members.iter().map(|&i| lines[i].width).collect());
        members.sort_by(|&a, &b| {
            lines[a]
                .cx
                .partial_cmp(&lines[b].cx)
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut groups: Vec<Vec<usize>> = vec![Vec::new()];
        for (n, &index) in members.iter().enumerate() {
            if n > 0 && lines[index].cx - lines[members[n - 1]].cx > typical * 0.6 {
                groups.push(Vec::new());
            }
            groups.last_mut().expect("a group").push(index);
        }
        // small groups join the group before them (or the one after, for the first)
        let mut kept: Vec<Vec<usize>> = Vec::new();
        for group in groups {
            match kept.last_mut() {
                Some(previous) if group.len() < 4 || previous.len() < 4 => previous.extend(group),
                _ => kept.push(group),
            }
        }
        if kept.len() <= 1 {
            result.push((left, right, members));
            continue;
        }
        for group in kept {
            let x0 = group
                .iter()
                .map(|&i| extent(&lines[i]).0)
                .fold(f32::MAX, f32::min);
            let x1 = group
                .iter()
                .map(|&i| extent(&lines[i]).1)
                .fold(f32::MIN, f32::max);
            result.push((x0, x1, group));
        }
    }
    result
}

/// The lines of a column (top to bottom) that sit together: text far above or below the sheet (the keys of a keyboard, a desk mat
/// under the booklet) is a separate block, and only the biggest block is kept.
fn main_block(column: Vec<&TextLine>) -> Vec<&TextLine> {
    let pitch = median(
        column
            .windows(2)
            .map(|w| w[1].cy - w[0].cy)
            .filter(|d| *d > 0.0)
            .collect(),
    );
    if pitch <= 0.0 {
        return column;
    }
    let mut blocks: Vec<Vec<&TextLine>> = vec![Vec::new()];
    for (i, line) in column.iter().enumerate() {
        if i > 0 && line.cy - column[i - 1].cy > pitch * 6.0 {
            blocks.push(Vec::new());
        }
        blocks.last_mut().expect("a block").push(line);
    }
    blocks.into_iter().max_by_key(Vec::len).unwrap_or_default()
}

fn clean_title(title: &str) -> String {
    let kept: String = title
        .chars()
        .filter(|c| !matches!(c, '"' | '“' | '”' | '«' | '»'))
        .collect();
    kept.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Capitals-only text as lyrics are usually written: lower case with a capital at the start of the line and for "I".
pub fn sentence_case(line: &str) -> String {
    let lower = line.to_lowercase();
    let mut out = String::new();
    let mut at_start = true;
    for word in lower.split(' ') {
        let fixed = if word == "i" || word.starts_with("i'") || word.starts_with("i’") {
            let mut chars = word.chars();
            chars.next();
            format!("I{}", chars.as_str())
        } else {
            word.to_owned()
        };
        let mut part = fixed;
        if at_start {
            // the first letter of the line (a bracket or quote in front of it stays)
            if let Some((at, first)) = part.char_indices().find(|(_, c)| c.is_alphabetic()) {
                let rest = &part[at + first.len_utf8()..];
                part = format!("{}{}{}", &part[..at], first.to_uppercase(), rest);
                at_start = false;
            }
        }
        if !out.is_empty() {
            out.push(' ');
        }
        out.push_str(&part);
    }
    out
}

/// Songs repeat their lines (a chorus four times), and the reader gets each copy wrong in a different place. A line with words the
/// word list does not know is replaced by a near-identical line of the same song whose words are all known: `known` says how much of
/// a line is known words (1.0: all of them). A line that is fully known is never changed, so a verse that really differs in one word
/// stays as sung. Returns how many lines were replaced.
pub fn unify_repeats(lines: &mut [String], known: impl Fn(&str) -> f32) -> usize {
    let plain_lines: Vec<Vec<char>> = lines.iter().map(|l| plain(l).chars().collect()).collect();
    let clean: Vec<bool> = lines.iter().map(|l| known(l) >= 1.0).collect();
    let mut replaced = 0;
    for i in 0..lines.len() {
        if clean[i] || plain_lines[i].len() < 8 {
            continue;
        }
        let mut best: Option<(f32, usize)> = None;
        for j in 0..lines.len() {
            if i == j || !clean[j] || plain_lines[j].len() < 8 {
                continue;
            }
            let longer = plain_lines[i].len().max(plain_lines[j].len());
            let ratio =
                1.0 - edit_distance(&plain_lines[i], &plain_lines[j]) as f32 / longer as f32;
            if ratio >= 0.72 && best.is_none_or(|(b, _)| ratio > b) {
                best = Some((ratio, j));
            }
        }
        if let Some((_, j)) = best {
            lines[i] = lines[j].clone();
            replaced += 1;
        }
    }
    replaced
}

/// A name as letters and digits in lower case.
fn plain(name: &str) -> String {
    name.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn edit_distance(a: &[char], b: &[char]) -> usize {
    let mut previous: Vec<usize> = (0..=b.len()).collect();
    for (i, ca) in a.iter().enumerate() {
        let mut current = vec![i + 1];
        for (j, cb) in b.iter().enumerate() {
            let cost = usize::from(ca != cb);
            current.push(
                (previous[j] + cost)
                    .min(previous[j + 1] + 1)
                    .min(current[j] + 1),
            );
        }
        previous = current;
    }
    previous[b.len()]
}

/// 0..1: how alike two names are by their letters alone (no credit for one being inside the other).
pub fn title_ratio(a: &str, b: &str) -> f32 {
    let (a, b): (Vec<char>, Vec<char>) = (plain(a).chars().collect(), plain(b).chars().collect());
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    1.0 - edit_distance(&a, &b) as f32 / a.len().max(b.len()) as f32
}

/// 0..1: how alike two titles are, ignoring capitals and punctuation. A title wholly inside the other (a heading read with extra
/// words, or a short title in a long one) counts as a close match.
pub fn title_similarity(a: &str, b: &str) -> f32 {
    let (a, b) = (plain(a), plain(b));
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    let (ac, bc): (Vec<char>, Vec<char>) = (a.chars().collect(), b.chars().collect());
    let ratio = 1.0 - edit_distance(&ac, &bc) as f32 / ac.len().max(bc.len()) as f32;
    let (short, long) = if a.len() <= b.len() {
        (&a, &b)
    } else {
        (&b, &a)
    };
    if short.chars().count() >= 4 && long.contains(short.as_str()) {
        return ratio.max(0.85);
    }
    ratio
}

/// A panel matched to one of the album's tracks.
#[derive(Debug, Clone, PartialEq)]
pub struct TrackMatch {
    pub track: usize,
    pub panel: usize,
    pub similarity: f32,
}

/// Which panel holds which track's words: the most alike titles first, each track and each panel once, nothing below `0.55`.
/// Panels with too little text to be a song are never matched.
pub fn match_tracks(panels: &[Panel], titles: &[String]) -> Vec<TrackMatch> {
    let mut pairs: Vec<TrackMatch> = Vec::new();
    for (panel, p) in panels.iter().enumerate() {
        if p.sung_lines() < 3 {
            continue;
        }
        for (track, title) in titles.iter().enumerate() {
            let similarity = title_similarity(&p.title, title);
            if similarity >= 0.55 {
                pairs.push(TrackMatch {
                    track,
                    panel,
                    similarity,
                });
            }
        }
    }
    pairs.sort_by(|a, b| {
        b.similarity
            .partial_cmp(&a.similarity)
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let (mut used_tracks, mut used_panels) = (vec![false; titles.len()], vec![false; panels.len()]);
    let mut chosen = Vec::new();
    for pair in pairs {
        if used_tracks[pair.track] || used_panels[pair.panel] {
            continue;
        }
        used_tracks[pair.track] = true;
        used_panels[pair.panel] = true;
        chosen.push(pair);
    }
    chosen.sort_by_key(|m| m.track);
    chosen
}

#[cfg(test)]
mod tests {
    use super::*;

    fn line(text: &str, cx: f32, cy: f32, width: f32, height: f32) -> TextLine {
        TextLine {
            text: text.to_owned(),
            score: 0.9,
            cx,
            cy,
            width,
            height,
            angle: 0.0,
        }
    }

    /// A made-up sheet: a big title, then stanzas of small lines with a wider gap between stanzas.
    fn sheet(title: &[&str], stanzas: &[&[&str]], cx: f32) -> Vec<TextLine> {
        let mut lines = Vec::new();
        let mut y = 100.0;
        for t in title {
            lines.push(line(t, cx, y, 300.0, 40.0));
            y += 50.0;
        }
        y += 20.0;
        for stanza in stanzas {
            for text in *stanza {
                lines.push(line(text, cx, y, 280.0, 16.0));
                y += 20.0;
            }
            y += 14.0; // the gap between stanzas
        }
        lines
    }

    #[test]
    fn sheets_side_by_side_become_separate_panels_with_titles_and_stanzas() {
        let mut lines = sheet(
            &["MIND CONTROL"],
            &[
                &["YOU MUST CONTROL", "WHAT YOUR MIND CAN TAKE", "ALMOST LIKE"],
                &["FEARS KEEP YOU UP", "RACING THROUGH", "YOUR MIND"],
            ],
            400.0,
        );
        lines.extend(sheet(
            &["WATCHING THE", "SUN COME UP"],
            &[&["WATCHING THE SUN", "AND THE NIGHT", "ALL THE YEARS"]],
            1000.0,
        ));
        let panels = panels_from_lines(&lines);
        assert_eq!(panels.len(), 2);
        assert_eq!(panels[0].title, "MIND CONTROL");
        assert_eq!(panels[0].lines.len(), 7, "two stanzas of three and the gap");
        assert_eq!(panels[0].lines[3], "");
        assert_eq!(
            panels[0].lines[0], "You must control",
            "capitals-only words get sentence case"
        );
        assert_eq!(
            panels[1].title, "WATCHING THE SUN COME UP",
            "a two-line heading is one title"
        );
        assert!(panels[0].left < panels[1].left);
    }

    #[test]
    fn sheets_whose_widest_lines_reach_over_each_other_are_still_two_panels() {
        // centres 400 and 780, lines 440 wide: the extents overlap (180..620 and 560..1000)
        let wide = |title: &str, cx: f32| -> Vec<TextLine> {
            let mut lines = vec![line(title, cx, 100.0, 300.0, 40.0)];
            for i in 0..6 {
                lines.push(line(
                    "SOME WORDS HERE",
                    cx,
                    200.0 + i as f32 * 20.0,
                    440.0,
                    16.0,
                ));
            }
            lines
        };
        let mut lines = wide("DON'T SAY GOODBYE TO ME", 400.0);
        lines.extend(wide("NEVER APOLOGIZE", 780.0));
        let panels = panels_from_lines(&lines);
        assert_eq!(panels.len(), 2);
        assert_eq!(panels[0].title, "DON'T SAY GOODBYE TO ME");
        assert_eq!(panels[1].title, "NEVER APOLOGIZE");
    }

    #[test]
    fn a_line_with_unknown_words_is_replaced_by_its_clean_copy_elsewhere_in_the_song() {
        let known = |l: &str| {
            if l.contains("ovt") || l.contains("yov") {
                0.7
            } else {
                1.0
            }
        };
        let mut lines: Vec<String> = [
            "When it feels like you were just getting started",
            "You get a message from the complaint department",
            "",
            "When it feels like yov were just getting started",
            "Some other line that has nothing in common",
            "Panic attack, it's a thrill, a desire",
            "Panic attack, it's a thrill, my desire",
        ]
        .iter()
        .map(|s| (*s).to_owned())
        .collect();
        let replaced = unify_repeats(&mut lines, known);
        assert_eq!(replaced, 1);
        assert_eq!(lines[3], "When it feels like you were just getting started");
        assert_eq!(lines[5], "Panic attack, it's a thrill, a desire");
        assert_eq!(
            lines[6], "Panic attack, it's a thrill, my desire",
            "a fully known line is never changed"
        );
    }

    #[test]
    fn a_stray_word_is_not_a_panel() {
        let mut lines = sheet(
            &["ON SATURDAY"],
            &[&["I'VE BEEN", "LAYIN ROUND", "THIS HOUSE"]],
            400.0,
        );
        lines.push(line("MXPX", 1500.0, 300.0, 100.0, 30.0));
        assert_eq!(panels_from_lines(&lines).len(), 1);
    }

    #[test]
    fn sentence_case_fixes_i_and_line_starts() {
        assert_eq!(
            sentence_case("I'VE BEEN LAYIN ROUND"),
            "I've been layin round"
        );
        assert_eq!(sentence_case("WHEN I FALL DOWN"), "When I fall down");
        assert_eq!(sentence_case("(CAUSE THAT MIGHT"), "(Cause that might");
    }

    #[test]
    fn titles_are_matched_by_how_alike_they_are() {
        assert!(title_similarity("ONCE IN A LIFETIMES", "Once in a Lifetimes") > 0.99);
        assert!(title_similarity("Never Apologise", "Never Apologize") > 0.9);
        assert!(title_similarity("WATCHING THE SUN COME UP", "Watching the Sun Come Up") > 0.99);
        assert!(title_similarity("Mind Control", "Panic Attack") < 0.4);
        assert!(
            title_similarity("DON'T SAY GOODBYE", "Don't Say Goodbye to Me") >= 0.85,
            "a heading cut short"
        );
    }

    #[test]
    fn each_track_and_panel_is_used_once_and_weak_matches_are_left() {
        let panel = |title: &str| Panel {
            title: title.to_owned(),
            lines: vec!["a".into(), "b".into(), "c".into()],
            score: 0.9,
            left: 0.0,
            bounds: [0.0; 4],
        };
        let panels = vec![
            panel("Panic Attack"),
            panel("MIND CONTROL"),
            panel("Something Else Entirely"),
        ];
        let titles: Vec<String> = ["The Good Days", "Mind Control", "Panic Attack"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        let matches = match_tracks(&panels, &titles);
        assert_eq!(
            matches
                .iter()
                .map(|m| (m.track, m.panel))
                .collect::<Vec<_>>(),
            vec![(1, 1), (2, 0)]
        );
    }
}
