//! Phase 1 of the lyrics work is "do these words belong to this song?"; phase 2 is "time them" (owner, 2026-11-22). Lyrics a band put into its own MP3s, and lyrics a
//! person confirmed, are settled for phase 1 and go straight to phase 2. This module tells which songs those are.
//!
//! The program never writes lyrics into a song that already has some, and every lyrics write it makes is journalled (`lyrics_added` in
//! `<data>/picture-batches/<batch>/journal.tsv`). So a song that has lyrics and no journal line has the band's own words. A song's key is its last three path parts
//! (artist, album, file), lower case, so it survives the library moving to another drive or share.

use serde_json::Value;
use std::collections::HashSet;
use std::path::Path;
use std::sync::{Arc, Mutex};
use std::time::{Duration, Instant};

/// The last three parts of a path, lower case, `\` as the separator, without a `\\?\` prefix.
pub fn tail_key(path: &str) -> String {
    let path = path.trim_start_matches(r"\\?\").replace('/', "\\");
    let parts: Vec<&str> = path.split('\\').filter(|p| !p.is_empty()).collect();
    parts[parts.len().saturating_sub(3)..]
        .join("\\")
        .to_lowercase()
}

/// Which songs had their lyrics written by the program, and which lyrics a person confirmed.
#[derive(Default)]
pub struct Trust {
    written: HashSet<String>,
    confirmed: HashSet<String>,
}

impl Trust {
    pub fn load(data_dir: &Path) -> Self {
        let mut trust = Self::default();
        let batches = data_dir.join("picture-batches");
        for batch in std::fs::read_dir(batches).into_iter().flatten().flatten() {
            let Ok(text) = std::fs::read_to_string(batch.path().join("journal.tsv")) else {
                continue;
            };
            for line in text.lines() {
                if let Some(path) = line.strip_prefix("lyrics_added\t") {
                    trust.written.insert(tail_key(path));
                }
            }
        }
        if let Ok(text) = std::fs::read_to_string(data_dir.join("lyrics-confirmed.txt")) {
            trust.confirmed = text.lines().map(str::to_owned).collect();
        }
        trust
    }

    /// Whether the words in this song's file are known to be its own: the band's (the program never wrote them) or confirmed by a person.
    pub fn words_settled(&self, path: &str) -> bool {
        let key = tail_key(path);
        self.confirmed.contains(&key) || !self.written.contains(&key)
    }
}

static CACHE: Mutex<Option<(Instant, Arc<Trust>)>> = Mutex::new(None);

/// Forgets the cached answer: called when a run starts and when words are confirmed, so what was written or confirmed a moment ago counts at once.
pub fn forget() {
    if let Ok(mut cache) = CACHE.lock() {
        *cache = None;
    }
}

/// The same `Trust` for a minute at a time: a run asks about thousands of songs.
pub fn current(data_dir: &Path) -> Arc<Trust> {
    let Ok(mut cache) = CACHE.lock() else {
        return Arc::new(Trust::load(data_dir));
    };
    if let Some((at, trust)) = cache.as_ref()
        && at.elapsed() < Duration::from_secs(60)
    {
        return trust.clone();
    }
    let trust = Arc::new(Trust::load(data_dir));
    *cache = Some((Instant::now(), trust.clone()));
    trust
}

/// Records that a person confirmed the words of this song (they then skip phase 1 from now on).
pub fn confirm(data_dir: &Path, path: &str) {
    use std::io::Write;
    if let Ok(mut file) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(data_dir.join("lyrics-confirmed.txt"))
    {
        let _ = writeln!(file, "{}", tail_key(path));
    }
    forget();
}

/// Section labels a band writes between verses; they are not sung, so they are not timed.
/// A line wrapped in square brackets is always a label (`[Chorus]`, `[Verse 2: Sam]`); one in parentheses only when it says a label word (`(Instrumental)`),
/// because backing vocals are written that way too (`(Ooh, ooh)`, `(Hey!)`) and are sung.
fn is_section_mark(line: &str) -> bool {
    let t = line.trim();
    if t.strip_prefix('[')
        .and_then(|r| r.strip_suffix(']'))
        .is_some()
    {
        return true;
    }
    match t.strip_prefix('(').and_then(|r| r.strip_suffix(')')) {
        Some(inner) => is_label_word(inner),
        None => is_label_word(t),
    }
}

/// `Chorus`, `Verse 2`, `Guitar solo:` and the like, on their own.
fn is_label_word(text: &str) -> bool {
    let word = text
        .trim()
        .trim_end_matches(|c: char| c.is_ascii_digit() || c.is_whitespace() || c == ':')
        .to_lowercase();
    matches!(
        word.as_str(),
        "chorus"
            | "verse"
            | "bridge"
            | "intro"
            | "outro"
            | "instrumental"
            | "solo"
            | "guitar solo"
            | "refrain"
            | "pre-chorus"
            | "pre chorus"
            | "hook"
            | "interlude"
            | "break"
    )
}

/// The sung lines of a band's lyrics: section labels like `[Chorus]`, `(Instrumental)` or `Verse 2` are dropped, and a trailing `(x2)` is cut off a line.
pub fn sung_lines(lines: Vec<String>) -> Vec<String> {
    lines
        .into_iter()
        .filter(|l| !is_section_mark(l))
        .map(|l| {
            let t = l.trim_end();
            for open in ['(', '['] {
                if let Some(at) = t.rfind(open) {
                    let tail = t[at + 1..]
                        .trim_end_matches([')', ']'])
                        .trim()
                        .to_lowercase();
                    let times = tail.strip_prefix('x').or_else(|| tail.strip_suffix('x'));
                    if times.is_some_and(|n| {
                        !n.is_empty() && n.trim().chars().all(|c| c.is_ascii_digit())
                    }) {
                        return t[..at].trim_end().to_owned();
                    }
                }
            }
            l
        })
        .filter(|l| !l.trim().is_empty())
        .collect()
}

/// Whether this `track_lyrics` answer holds untimed words and no timed lines: what phase 2 works on.
pub fn untimed(existing: &Value) -> bool {
    existing["lines"].as_array().is_none_or(Vec::is_empty)
        && existing["plain"]
            .as_str()
            .is_some_and(|p| p.split_whitespace().count() >= 8)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_key_survives_a_change_of_drive() {
        assert_eq!(
            tail_key(r"\\?\C:\Users\X\Music\Band\Album\01 Song.mp3"),
            tail_key(r"M:\Band\Album\01 Song.mp3")
        );
    }

    #[test]
    fn section_labels_and_repeat_notes_are_not_sung() {
        let lines = [
            "[Chorus]",
            "Hey ho (x2)",
            "(Instrumental)",
            "Verse 2",
            "Let's go",
            "She said (really)",
            "(Ooh, ooh)",
            "(Hey!)",
            "[Verse 2: Sam]",
        ]
        .map(str::to_owned)
        .to_vec();
        assert_eq!(
            sung_lines(lines),
            [
                "Hey ho",
                "Let's go",
                "She said (really)",
                "(Ooh, ooh)",
                "(Hey!)"
            ],
            "backing vocals in parentheses are sung; labels are not"
        );
    }

    #[test]
    fn words_the_program_wrote_are_not_settled_unless_confirmed() {
        let mut trust = Trust::default();
        trust.written.insert(tail_key(r"M:\A\B\1.mp3"));
        assert!(!trust.words_settled(r"M:\A\B\1.mp3"));
        assert!(trust.words_settled(r"M:\A\B\2.mp3"));
        trust.confirmed.insert(tail_key(r"M:\A\B\1.mp3"));
        assert!(trust.words_settled(r"M:\A\B\1.mp3"));
    }
}
