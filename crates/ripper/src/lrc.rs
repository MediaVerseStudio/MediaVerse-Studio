//! Reads lyrics in the common `.lrc` format: lines like `[01:23.45]Words`, one or several time
//! stamps per line, optional `[ar:..]`-style information lines, and an `[offset:+500]` correction.
//! Plain text with no time stamps is accepted too. Used for typed or pasted lyrics (the library
//! page) and for lyrics from lookup services.

use crate::id3::SyncedLine;

#[derive(Clone, Debug, Default, Eq, PartialEq)]
pub struct Lyrics {
    /// Time-stamped lines in time order; empty for plain text.
    pub synced: Vec<SyncedLine>,
    /// The words only, one line per line, with no time stamps.
    pub plain: String,
}

/// Parses `mm:ss`, `mm:ss.x`, `mm:ss.xx` or `mm:ss.xxx` into milliseconds.
fn timestamp(text: &str) -> Option<u32> {
    let (minutes, rest) = text.split_once(':')?;
    let (seconds, fraction) = rest.split_once(['.', ':']).unwrap_or((rest, ""));
    let (minutes, seconds): (u32, u32) =
        (minutes.trim().parse().ok()?, seconds.trim().parse().ok()?);
    if seconds >= 60 || minutes > 999 || !fraction.chars().all(|c| c.is_ascii_digit()) {
        return None;
    }
    let milliseconds = match fraction.len() {
        0 => 0,
        1 => fraction.parse::<u32>().ok()? * 100,
        2 => fraction.parse::<u32>().ok()? * 10,
        3 => fraction.parse::<u32>().ok()?,
        _ => return None,
    };
    Some((minutes * 60 + seconds) * 1000 + milliseconds)
}

/// Strips enhanced-LRC word timings (`<00:12.34>`) from a line of words.
fn strip_word_timings(text: &str) -> String {
    let mut out = String::new();
    let mut inside = false;
    for c in text.chars() {
        match c {
            '<' if text.contains('>') => inside = true,
            '>' if inside => inside = false,
            _ if !inside => out.push(c),
            _ => {}
        }
    }
    out
}

pub fn parse(text: &str) -> Lyrics {
    let normalised = text.replace("\r\n", "\n").replace('\r', "\n");
    let mut synced: Vec<SyncedLine> = Vec::new();
    let mut plain: Vec<String> = Vec::new();
    let mut offset: i64 = 0;
    let mut any_timestamp = false;

    for raw in normalised.lines() {
        let mut rest = raw.trim_start();
        let mut stamps = Vec::new();
        while let Some(body) = rest.strip_prefix('[') {
            let Some((inside, after)) = body.split_once(']') else {
                break;
            };
            if let Some(ms) = timestamp(inside) {
                stamps.push(ms);
            } else if let Some(value) = inside.strip_prefix("offset:") {
                offset = value.trim().parse().unwrap_or(0);
                stamps.clear();
                rest = "";
                break;
            } else if inside.contains(':')
                && inside
                    .split(':')
                    .next()
                    .is_some_and(|k| k.chars().all(|c| c.is_ascii_alphabetic()))
                && stamps.is_empty()
                && !inside.chars().next().is_some_and(|c| c.is_ascii_digit())
            {
                // An information line such as [ar:Artist] or [ti:Title]: not lyrics.
                rest = "";
                break;
            } else {
                break;
            }
            rest = after;
        }
        if stamps.is_empty() {
            let words = strip_word_timings(rest).trim().to_owned();
            if !words.is_empty() && !any_timestamp_line(raw) {
                plain.push(words);
            } else if raw.trim().is_empty() && !plain.is_empty() {
                plain.push(String::new());
            }
            continue;
        }
        any_timestamp = true;
        let words = strip_word_timings(rest).trim().to_owned();
        for ms in stamps {
            let shifted = (i64::from(ms) - offset).max(0) as u32;
            synced.push(SyncedLine {
                milliseconds: shifted,
                text: words.clone(),
            });
        }
        plain.push(words);
    }
    synced.sort_by_key(|line| line.milliseconds);
    // For synced lyrics the plain text follows time order, which matters when a line has several stamps.
    let plain_text = if any_timestamp {
        synced
            .iter()
            .map(|l| l.text.clone())
            .collect::<Vec<_>>()
            .join("\n")
    } else {
        plain.join("\n")
    };
    Lyrics {
        synced,
        plain: plain_text.trim_matches('\n').to_owned(),
    }
}

fn any_timestamp_line(raw: &str) -> bool {
    raw.trim_start()
        .strip_prefix('[')
        .and_then(|b| b.split_once(']'))
        .is_some_and(|(inside, _)| timestamp(inside).is_some())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_time_stamps_in_every_common_precision() {
        assert_eq!(timestamp("01:23.45"), Some(83_450));
        assert_eq!(timestamp("00:00.5"), Some(500));
        assert_eq!(timestamp("12:00.123"), Some(720_123));
        assert_eq!(timestamp("03:07"), Some(187_000));
        assert_eq!(timestamp("00:61.00"), None);
        assert_eq!(timestamp("ar:Name"), None);
        assert_eq!(timestamp("00:01.1234"), None);
    }

    #[test]
    fn synced_lyrics_are_ordered_and_have_plain_text() {
        let lyrics = parse(
            "[ti:Song]\n[ar:Band]\n[00:12.00]Second\n[00:05.50]First\n[00:30.00][01:00.00]Chorus\n",
        );
        assert_eq!(
            lyrics
                .synced
                .iter()
                .map(|l| (l.milliseconds, l.text.as_str()))
                .collect::<Vec<_>>(),
            [
                (5_500, "First"),
                (12_000, "Second"),
                (30_000, "Chorus"),
                (60_000, "Chorus")
            ]
        );
        assert_eq!(lyrics.plain, "First\nSecond\nChorus\nChorus");
    }

    #[test]
    fn plain_text_stays_plain_and_keeps_blank_lines_between_verses() {
        let lyrics = parse("Verse one line\nanother line\n\nVerse two\r\nlast\r\n");
        assert!(lyrics.synced.is_empty());
        assert_eq!(
            lyrics.plain,
            "Verse one line\nanother line\n\nVerse two\nlast"
        );
    }

    #[test]
    fn offsets_and_word_timings_are_handled() {
        let lyrics =
            parse("[offset:+500]\n[00:10.00]<00:10.00>Hello <00:10.50>world\n[00:00.20]Early\n");
        assert_eq!(
            lyrics.synced[0],
            SyncedLine {
                milliseconds: 0,
                text: "Early".into()
            }
        );
        assert_eq!(
            lyrics.synced[1],
            SyncedLine {
                milliseconds: 9_500,
                text: "Hello world".into()
            }
        );
    }

    #[test]
    fn junk_and_empty_input_are_harmless() {
        assert_eq!(parse(""), Lyrics::default());
        assert_eq!(parse("\n\n   \n"), Lyrics::default());
        let odd = parse("[unterminated\n[99:99.99]bad time\n[00:01.00]");
        assert!(odd.synced.iter().all(|l| l.milliseconds == 1_000));
    }
}
