//! How lyrics are usually written, learned from the lyrics the person already has: which words carry capitals in the middle of a line
//! ("Saturday", "TV"), which words are spelled with an apostrophe ("don't", "I've"), and between which two words a comma usually falls.
//! A booklet's small lettering loses exactly these (commas, apostrophes, capitals), so this puts them back. It only ever adds what the
//! library's own lyrics show, and it never changes a letter of a word.

use crate::vocab::Vocabulary;
use std::collections::HashMap;

/// Seen at least this often to be believed.
const MIN_SEEN: u32 = 5;
/// A comma goes between two words when at least this share of their meetings had one, and at least `MIN_COMMAS` did.
const COMMA_SHARE: u32 = 55;
const MIN_COMMAS: u32 = 3;
/// The per-word comma rule, tuned on four songs a person corrected (2026-11-20, `tuning_the_word_comma_rule` in the sidecar): of 44 missing commas it put back\n/// 16 and added 9 that were not there.
const BEFORE_SHARE: u32 = 10;
const AFTER_SHARE: u32 = 5;

#[derive(Debug, Clone)]
pub struct Habits {
    /// A comma goes between two words when at least this percentage of their meetings had one, and at least `min_commas` did.
    comma_share: u32,
    min_commas: u32,
    /// word -> (written with a capital, written in capitals, times seen inside a line)
    shapes: HashMap<String, (u32, u32, u32)>,
    /// "word next" -> (meetings with a comma between, meetings without)
    commas: HashMap<String, (u32, u32)>,
    /// word -> (times a comma came right before it inside a line, times it stood after another word inside a line)
    before: HashMap<String, (u32, u32)>,
    /// word -> (times a comma came right after it with words following, times it stood before another word)
    after: HashMap<String, (u32, u32)>,
    /// A comma also goes between two words when the second is at least this percent of the time preceded by one and the first is at least
    /// `after_share` percent of the time followed by one (0 and 0: the rule is off).
    before_share: u32,
    after_share: u32,
}

/// A token split into what is in front of the word, the word, and what follows it.
struct Token<'a> {
    lead: &'a str,
    core: &'a str,
    tail: &'a str,
}

fn is_letter_or_digit(c: char) -> bool {
    c.is_alphanumeric()
}

fn split_token(token: &str) -> Token<'_> {
    let start = token.find(is_letter_or_digit).unwrap_or(token.len());
    let end = token.rfind(is_letter_or_digit).map_or(start, |i| {
        i + token[i..].chars().next().map_or(1, char::len_utf8)
    });
    if end <= start {
        return Token {
            lead: token,
            core: "",
            tail: "",
        };
    }
    Token {
        lead: &token[..start],
        core: &token[start..end],
        tail: &token[end..],
    }
}

fn normal(core: &str) -> String {
    core.replace('’', "'").to_lowercase()
}

fn shouting(line: &str) -> bool {
    let letters: Vec<char> = line.chars().filter(|c| c.is_alphabetic()).collect();
    letters.len() >= 4
        && letters.iter().filter(|c| c.is_uppercase()).count() * 10 >= letters.len() * 9
}

impl Default for Habits {
    fn default() -> Self {
        Self {
            comma_share: COMMA_SHARE,
            min_commas: MIN_COMMAS,
            shapes: HashMap::new(),
            commas: HashMap::new(),
            before: HashMap::new(),
            after: HashMap::new(),
            before_share: BEFORE_SHARE,
            after_share: AFTER_SHARE,
        }
    }
}

impl Habits {
    /// The per-word comma rule (for tuning against corrected lyrics); 0 and 0 switch it off.
    pub fn with_word_rule(mut self, before_share: u32, after_share: u32) -> Self {
        self.before_share = before_share;
        self.after_share = after_share;
        self
    }

    /// How sure the library must be before a comma is put between two words (for tuning against corrected lyrics).
    pub fn with_comma_rule(mut self, share_percent: u32, min_commas: u32) -> Self {
        self.comma_share = share_percent;
        self.min_commas = min_commas;
        self
    }

    /// Learns from one song's lyrics.
    pub fn add(&mut self, text: &str) {
        let mixed_case =
            text.chars().any(char::is_uppercase) && text.chars().any(char::is_lowercase);
        // A song written without commas says nothing about where they go (its pairs would all count as "without").
        let punctuated = text.matches(',').count() >= 3;
        for line in text.lines() {
            if shouting(line) {
                continue;
            }
            let tokens: Vec<Token<'_>> = line.split_whitespace().map(split_token).collect();
            for (i, token) in tokens.iter().enumerate() {
                if token.core.is_empty() || !token.core.chars().any(char::is_alphabetic) {
                    continue;
                }
                let word = normal(token.core);
                let letters = token.core.chars().filter(|c| c.is_alphabetic()).count();
                let all_caps = letters >= 2
                    && token
                        .core
                        .chars()
                        .filter(|c| c.is_alphabetic())
                        .all(char::is_uppercase);
                if mixed_case && (i > 0 || all_caps) {
                    let entry = self.shapes.entry(word.clone()).or_insert((0, 0, 0));
                    entry.2 += 1;
                    if all_caps {
                        entry.1 += 1;
                    } else if token.core.chars().next().is_some_and(char::is_uppercase) {
                        entry.0 += 1;
                    }
                }
                if punctuated {
                    if let Some(next) = tokens.get(i + 1).filter(|n| !n.core.is_empty()) {
                        let has_comma = token.tail.contains(',');
                        let a = self.after.entry(word.clone()).or_insert((0, 0));
                        a.1 += 1;
                        if has_comma {
                            a.0 += 1;
                        }
                        let b = self.before.entry(normal(next.core)).or_insert((0, 0));
                        b.1 += 1;
                        if has_comma {
                            b.0 += 1;
                        }
                        let entry = self
                            .commas
                            .entry(format!("{word} {}", normal(next.core)))
                            .or_insert((0, 0));
                        if token.tail.contains(',') {
                            entry.0 += 1;
                        } else {
                            entry.1 += 1;
                        }
                    }
                }
            }
        }
    }

    /// Every learned fact worth keeping, to save: shapes seen at least 3 times, comma pairs that ever had a comma twice.
    pub fn shapes(&self) -> impl Iterator<Item = (&str, (u32, u32, u32))> {
        self.shapes
            .iter()
            .filter(|(_, v)| v.2 >= 3)
            .map(|(k, v)| (k.as_str(), *v))
    }

    pub fn commas(&self) -> impl Iterator<Item = (&str, (u32, u32))> {
        self.commas
            .iter()
            .filter(|(_, v)| v.0 >= 2)
            .map(|(k, v)| (k.as_str(), *v))
    }

    /// Words and how often a comma came before them / after them (only words seen often enough to say), to save.
    pub fn before(&self) -> impl Iterator<Item = (&str, (u32, u32))> {
        self.before
            .iter()
            .filter(|(_, v)| v.1 >= 20 && v.0 >= 2)
            .map(|(k, v)| (k.as_str(), *v))
    }

    pub fn after(&self) -> impl Iterator<Item = (&str, (u32, u32))> {
        self.after
            .iter()
            .filter(|(_, v)| v.1 >= 20 && v.0 >= 2)
            .map(|(k, v)| (k.as_str(), *v))
    }

    pub fn from_parts(
        shapes: impl IntoIterator<Item = (String, (u32, u32, u32))>,
        commas: impl IntoIterator<Item = (String, (u32, u32))>,
        before: impl IntoIterator<Item = (String, (u32, u32))>,
        after: impl IntoIterator<Item = (String, (u32, u32))>,
    ) -> Self {
        Self {
            shapes: shapes.into_iter().collect(),
            commas: commas.into_iter().collect(),
            before: before.into_iter().collect(),
            after: after.into_iter().collect(),
            ..Self::default()
        }
    }

    /// Whether the words around a gap say a comma belongs there: this pair usually has one, or the second word usually follows a comma and
    /// the first usually has one after it.
    fn comma_between(&self, first: &str, second: &str, words_before: usize) -> bool {
        if let Some(&(with, without)) = self.commas.get(&format!("{first} {second}"))
            && with >= self.min_commas
            && with * 100 >= self.comma_share * (with + without)
        {
            return true;
        }
        if self.before_share == 0 || words_before < 2 {
            return false;
        }
        let rate = |map: &HashMap<String, (u32, u32)>, word: &str, share: u32| {
            map.get(word)
                .is_some_and(|&(with, seen)| seen >= 20 && with * 100 >= share * seen)
        };
        rate(&self.before, second, self.before_share) && rate(&self.after, first, self.after_share)
    }

    pub fn is_empty(&self) -> bool {
        self.shapes.is_empty() && self.commas.is_empty()
    }

    /// The line with apostrophes, capitals and commas put back, and a space after every comma. Word letters are never changed except for
    /// the apostrophe and a capital.
    pub fn restore_line(&self, line: &str, vocab: &Vocabulary) -> String {
        let tokens: Vec<Token<'_>> = line.split_whitespace().map(split_token).collect();
        // each word with its apostrophe put back where the library writes one ("dont" -> "don't"), to look up commas by the words as they will read
        let cores: Vec<String> = tokens
            .iter()
            .map(|t| {
                let word = normal(t.core);
                match (word.contains('\''), vocab.apostrophe_form(&word)) {
                    (false, Some(fixed)) => fixed,
                    _ => word,
                }
            })
            .collect();
        let mut out: Vec<String> = Vec::with_capacity(tokens.len());
        for (i, token) in tokens.iter().enumerate() {
            if token.core.is_empty() {
                out.push(format!("{}{}", token.lead, token.tail));
                continue;
            }
            let mut core = token.core.replace('’', "'");
            let word = cores[i].clone();
            // an apostrophe the booklet's small print lost: "dont" -> "don't", "ive" -> "I've"
            if !normal(token.core).contains('\'') && word.contains('\'') {
                core = word.clone();
            }
            // capitals: "TV", "Saturday", "I'm"
            core = self.shaped(&word, &core, i);
            let mut tail = token.tail.to_owned();
            // a comma between two words that usually have one
            if i + 1 < tokens.len()
                && !tail.contains(|c: char| matches!(c, ',' | '.' | '?' | '!' | ';' | ':'))
                && tokens[i + 1].lead.is_empty()
                && !cores[i + 1].is_empty()
            {
                if self.comma_between(&word, &cores[i + 1], i) {
                    tail.insert(0, ',');
                }
            }
            out.push(format!("{}{}{}", token.lead, core, tail));
        }
        let joined = out.join(" ");
        // a space after every comma that has letters after it ("out,we")
        let mut spaced = String::with_capacity(joined.len() + 4);
        let chars: Vec<char> = joined.chars().collect();
        for (i, c) in chars.iter().enumerate() {
            spaced.push(*c);
            if *c == ',' && chars.get(i + 1).is_some_and(|n| n.is_alphabetic()) {
                spaced.push(' ');
            }
        }
        spaced
    }

    /// The word wearing the capitals this library gives it.
    fn shaped(&self, word: &str, core: &str, index: usize) -> String {
        if word == "i" || word.starts_with("i'") {
            let mut chars = core.chars();
            chars.next();
            return format!("I{}", chars.as_str());
        }
        let Some(&(capital, shouted, seen)) = self.shapes.get(word) else {
            return core.to_owned();
        };
        if seen < MIN_SEEN {
            return core.to_owned();
        }
        if shouted * 10 >= seen * 6 {
            return core.to_uppercase();
        }
        if index > 0 && capital * 10 >= seen * 7 {
            let mut chars = core.chars();
            return match chars.next() {
                Some(first) => first.to_uppercase().collect::<String>() + chars.as_str(),
                None => String::new(),
            };
        }
        core.to_owned()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn learned() -> (Habits, Vocabulary) {
        let song = "Let it burn out, we don't have forever\nIf we go out, we go out together\nI'll be there on Saturday, I've seen the TV\nWe meet on Saturday, my friend\nWatch the TV tonight, I'm told\nHe said it's all right, I think so\n";
        let mut habits = Habits::default();
        let mut vocab = Vocabulary::default();
        for _ in 0..8 {
            habits.add(song);
            vocab.add(song);
        }
        (habits, vocab)
    }

    #[test]
    fn apostrophes_commas_and_capitals_come_back() {
        let (habits, vocab) = learned();
        assert_eq!(
            habits.restore_line("Let it burn out we dont have forever", &vocab),
            "Let it burn out, we don't have forever"
        );
        assert_eq!(
            habits.restore_line("Ill be there on saturday ive seen the tv", &vocab),
            "I'll be there on Saturday, I've seen the TV"
        );
        assert_eq!(
            habits.restore_line("If we go out,we go out together", &vocab),
            "If we go out, we go out together"
        );
    }

    #[test]
    fn nothing_is_added_that_the_library_does_not_show() {
        let (habits, vocab) = learned();
        assert_eq!(
            habits.restore_line("You must control what your mind can take", &vocab),
            "You must control what your mind can take"
        );
        // a pair that is rarely written with a comma gets none
        assert_eq!(habits.restore_line("I think so", &vocab), "I think so");
    }

    #[test]
    fn a_song_without_commas_teaches_nothing_about_them() {
        let mut habits = Habits::default();
        for _ in 0..10 {
            habits.add("Let it burn out we go\nSo it goes out we go");
        }
        assert_eq!(habits.commas().count(), 0);
    }

    #[test]
    fn the_learned_facts_survive_being_saved_and_loaded() {
        let (habits, vocab) = learned();
        let again = Habits::from_parts(
            habits.shapes().map(|(k, v)| (k.to_owned(), v)),
            habits.commas().map(|(k, v)| (k.to_owned(), v)),
            habits.before().map(|(k, v)| (k.to_owned(), v)),
            habits.after().map(|(k, v)| (k.to_owned(), v)),
        );
        assert_eq!(
            again.restore_line("Let it burn out we dont have forever", &vocab),
            "Let it burn out, we don't have forever"
        );
    }
}
