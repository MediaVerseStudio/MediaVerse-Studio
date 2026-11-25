//! Repairs what reading stylized lettering gets wrong, using a word list counted from lyrics the person already has: words run
//! together ("Iftomorrow"), a swash "C" read as "(" or dropped, a "U" read as "V", a letter dropped. A word that is in the list is
//! never touched; a word that is not is replaced only by listed words a small step away. The result is still checked by the person
//! (it lands on the To review page); this just makes it much closer.

use std::collections::HashMap;
use std::sync::OnceLock;

/// How many times each word was seen, in lower case, with apostrophes kept inside words ("don't").
#[derive(Debug, Default, Clone)]
pub struct Vocabulary {
    counts: HashMap<String, u32>,
    total: f64,
    /// Every common word of five letters or more with one letter taken out, to the count of the likeliest word it came from: finds
    /// words whose letter was dropped by the reader. Built when first needed.
    deletes: OnceLock<HashMap<String, u32>>,
}

/// The words of one or two letters a cut may use (any other short piece is more likely a reading mistake than a word).
const SHORT_WORDS: &[&str] = &[
    "a", "i", "o", "an", "am", "as", "at", "be", "by", "do", "go", "he", "if", "in", "is", "it",
    "me", "my", "no", "of", "oh", "on", "or", "so", "to", "up", "us", "we", "ya",
];

/// Letters a reader of decorative capitals confuses: what it says, and what it may be.
const LOOK_ALIKES: &[(char, &[char])] = &[
    ('v', &['u']),
    ('u', &['v']),
    ('0', &['o']),
    ('1', &['l', 'i']),
    ('5', &['s']),
    ('|', &['l', 'i']),
    ('!', &['l', 'i']),
];

const COMMON: u32 = 3;
const LONGEST_PIECE: usize = 20;

fn is_word_char(c: char) -> bool {
    c.is_alphabetic() || c == '\'' || c == '’'
}

fn words_of(text: &str) -> impl Iterator<Item = String> + '_ {
    text.split(|c: char| !is_word_char(c))
        .map(|w| {
            w.trim_matches(|c| c == '\'' || c == '’')
                .replace('’', "'")
                .to_lowercase()
        })
        .filter(|w| !w.is_empty())
}

impl Vocabulary {
    /// Counts the words of every text.
    pub fn from_texts<'a>(texts: impl IntoIterator<Item = &'a str>) -> Self {
        let mut vocab = Self::default();
        for text in texts {
            vocab.add(text);
        }
        vocab
    }

    /// A list saved earlier (word, count).
    pub fn from_counts(counts: impl IntoIterator<Item = (String, u32)>) -> Self {
        let mut vocab = Self::default();
        for (word, n) in counts {
            vocab.total += f64::from(n);
            *vocab.counts.entry(word).or_insert(0) += n;
        }
        vocab
    }

    /// Every word and how many times it was seen, to save the list.
    pub fn counts(&self) -> impl Iterator<Item = (&str, u32)> {
        self.counts.iter().map(|(w, n)| (w.as_str(), *n))
    }

    pub fn add(&mut self, text: &str) {
        for word in words_of(text) {
            *self.counts.entry(word).or_insert(0) += 1;
            self.total += 1.0;
        }
        self.deletes = OnceLock::new();
    }

    /// 0..1: how much of a line is words this list knows well (1.0: every word). A line with no words counts as fully known.
    pub fn known_fraction(&self, line: &str) -> f32 {
        let words: Vec<String> = words_of(line).collect();
        if words.is_empty() {
            return 1.0;
        }
        words.iter().filter(|w| self.count(w) >= COMMON).count() as f32 / words.len() as f32
    }

    pub fn len(&self) -> usize {
        self.counts.len()
    }

    pub fn is_empty(&self) -> bool {
        self.counts.is_empty()
    }

    /// The spelling with an apostrophe when the library's lyrics write this word that way far more often ("dont" -> "don't", "ive" -> "i've"),
    /// else `None`. Only the usual endings are tried: n't, 're, 've, 'll, 'd, 'm, 's.
    pub(crate) fn apostrophe_form(&self, word: &str) -> Option<String> {
        let chars: Vec<char> = word.chars().collect();
        let n = chars.len();
        let mut candidates: Vec<String> = Vec::new();
        let join =
            |keep: usize, end: &str| -> String { chars[..keep].iter().collect::<String>() + end };
        if n >= 4 && word.ends_with("nt") {
            candidates.push(join(n - 2, "n't"));
        }
        for (suffix, with) in [("re", "'re"), ("ve", "'ve"), ("ll", "'ll")] {
            if n >= 3 && word.ends_with(suffix) {
                candidates.push(join(n - 2, with));
            }
        }
        if n >= 2 && word.ends_with('m') {
            candidates.push(join(n - 1, "'m"));
        }
        if n >= 4 && word.ends_with('d') {
            candidates.push(join(n - 1, "'d"));
        }
        if n >= 4 && word.ends_with('s') {
            candidates.push(join(n - 1, "'s"));
        }
        let plain = self.count(word);
        candidates
            .into_iter()
            .map(|c| (self.count(&c), c))
            .filter(|(seen, _)| *seen >= 5 && *seen >= plain.saturating_mul(5))
            .max_by_key(|(seen, _)| *seen)
            .map(|(_, c)| c)
    }

    pub(crate) fn count(&self, word: &str) -> u32 {
        self.counts.get(word).copied().unwrap_or(0)
    }

    fn deletes(&self) -> &HashMap<String, u32> {
        self.deletes.get_or_init(|| {
            let mut index: HashMap<String, u32> = HashMap::new();
            for (word, &n) in &self.counts {
                let chars: Vec<char> = word.chars().collect();
                if n < COMMON * 2 || chars.len() < 5 {
                    continue;
                }
                for skip in 0..chars.len() {
                    let variant: String = chars
                        .iter()
                        .enumerate()
                        .filter(|(i, _)| *i != skip)
                        .map(|(_, c)| *c)
                        .collect();
                    let best = index.entry(variant).or_insert(0);
                    *best = (*best).max(n);
                }
            }
            index
        })
    }

    /// A line of lyrics with the reader's usual mistakes repaired. Punctuation, spacing around it and capitals are kept where a word is unchanged.
    pub fn correct_line(&self, line: &str) -> String {
        if self.is_empty() {
            return line.to_owned();
        }
        let chars: Vec<char> = line.chars().collect();
        let mut out = String::new();
        let mut i = 0;
        while i < chars.len() {
            let c = chars[i];
            // A run of letters; a "(" in front of letters (not after one) is a possible swash "C" and belongs to the run.
            let swash = c == '('
                && chars.get(i + 1).is_some_and(|n| n.is_alphabetic())
                && (i == 0 || !chars[i - 1].is_alphabetic());
            if is_word_char(c) || swash {
                let mut j = i + 1;
                while j < chars.len() && is_word_char(chars[j]) {
                    j += 1;
                }
                let run: String = chars[i..j].iter().collect();
                out.push_str(&self.repair_run(&run));
                i = j;
            } else {
                out.push(c);
                i += 1;
            }
        }
        // a run split into words can leave two spaces where the line already had one
        out.split_whitespace().collect::<Vec<_>>().join(" ")
    }

    fn repair_run(&self, run: &str) -> String {
        let (swash, bare) = match run.strip_prefix('(') {
            Some(rest) => (true, rest),
            None => (false, run),
        };
        let word = bare.replace('’', "'").to_lowercase();
        let trimmed = word.trim_matches('\'');
        if trimmed.is_empty() {
            return run.to_owned();
        }
        // A listed word stays as it is; a "(" in front of one is a real bracket.
        if self.count(trimmed) > 0 {
            return run.to_owned();
        }
        // variants of what the reader may have meant, best guess first: a swash "C" first when there was a bracket
        let mut variants: Vec<String> = Vec::new();
        if swash {
            variants.push(format!("c{trimmed}"));
        }
        variants.push(trimmed.to_owned());
        for variant in &variants {
            if self.count(variant) > 0 {
                return match_case(run, variant);
            }
            if let Some(fixed) = self.look_alike_fix(variant) {
                return match_case(run, &fixed);
            }
        }
        for variant in &variants {
            if let Some(parts) = self.split(variant) {
                return match_case(run, &parts.join(" "));
            }
        }
        for variant in &variants {
            if variant.chars().count() >= 3 {
                if let Some(fixed) = self.one_step(variant) {
                    return match_case(run, &fixed);
                }
                // the swash "C" dropped altogether ("ards" for "cards")
                if let Some(fixed) = self
                    .one_step(&format!("c{variant}"))
                    .filter(|f| f.starts_with('c'))
                {
                    return match_case(run, &fixed);
                }
            }
        }
        run.to_owned()
    }

    fn look_alike_fix(&self, word: &str) -> Option<String> {
        let chars: Vec<char> = word.chars().collect();
        let mut best: Option<(u32, String)> = None;
        for (i, c) in chars.iter().enumerate() {
            for (from, to) in LOOK_ALIKES {
                if c != from {
                    continue;
                }
                for replacement in *to {
                    let mut candidate = chars.clone();
                    candidate[i] = *replacement;
                    let candidate: String = candidate.into_iter().collect();
                    let n = self.count(&candidate);
                    if n > 0 && best.as_ref().is_none_or(|(b, _)| n > *b) {
                        best = Some((n, candidate));
                    }
                }
            }
        }
        best.map(|(_, w)| w)
    }

    /// What a piece of a run-together word may be, and how likely: a listed word; a listed word after one look-alike letter is put right
    /// (it keeps the repaired spelling); or a listed word of five letters or more missing one letter (the reader dropped it; the
    /// piece is replaced by the whole word). Costs make an exact word the best reading.
    fn piece(&self, piece: &str) -> Option<(f64, String)> {
        let length = piece.chars().count();
        if length <= 2 {
            return (SHORT_WORDS.contains(&piece) && self.count(piece) > 0)
                .then(|| (self.log_p(piece), piece.to_owned()));
        }
        if self.count(piece) >= COMMON {
            return Some((self.log_p(piece) - 6.0, piece.to_owned()));
        }
        if let Some(fixed) = self
            .look_alike_fix(piece)
            .filter(|f| self.count(f) >= COMMON)
        {
            return Some((self.log_p(&fixed) - 9.0, fixed));
        }
        if length >= 4 && self.deletes().contains_key(piece) {
            // find the word it came from: put one letter back
            let chars: Vec<char> = piece.chars().collect();
            let mut best: Option<(u32, String)> = None;
            for at in 0..=chars.len() {
                for letter in "abcdefghijklmnopqrstuvwxyz'".chars() {
                    let mut with = chars.clone();
                    with.insert(at, letter);
                    let candidate: String = with.into_iter().collect();
                    let n = self.count(&candidate);
                    if n >= COMMON * 2 && best.as_ref().is_none_or(|(b, _)| n > *b) {
                        best = Some((n, candidate));
                    }
                }
            }
            if let Some((_, word)) = best {
                return Some((self.log_p(&word) - 11.0, word));
            }
        }
        // the swash "C" at the start of a word lost altogether ("ops" for "cops", "rash" for "crash")
        if length >= 3 {
            let with_c = format!("c{piece}");
            if self.count(&with_c) >= COMMON * 2 {
                return Some((self.log_p(&with_c) - 12.0, with_c));
            }
        }
        None
    }

    fn log_p(&self, word: &str) -> f64 {
        (f64::from(self.count(word).max(1)) / self.total.max(1.0)).ln()
    }

    /// Cuts a run of letters into words, preferring the likeliest cut; `None` when it cannot be done well (or there was nothing to cut).
    fn split(&self, word: &str) -> Option<Vec<String>> {
        let chars: Vec<char> = word.chars().collect();
        let n = chars.len();
        if !(4..=70).contains(&n) {
            return None;
        }
        // best[i]: the best score for the first i letters, with where the last word began and what it became
        let mut best: Vec<Option<(f64, usize, String)>> = vec![None; n + 1];
        best[0] = Some((0.0, 0, String::new()));
        for end in 1..=n {
            for start in end.saturating_sub(LONGEST_PIECE)..end {
                let Some((score, _, _)) = best[start].clone() else {
                    continue;
                };
                let text: String = chars[start..end].iter().collect();
                let Some((cost, becomes)) = self.piece(&text) else {
                    continue;
                };
                let value = score + cost - 2.0;
                if best[end].as_ref().is_none_or(|(b, _, _)| value > *b) {
                    best[end] = Some((value, start, becomes));
                }
            }
        }
        best[n].as_ref()?;
        let mut parts = Vec::new();
        let mut end = n;
        while end > 0 {
            let (_, start, becomes) = best[end].clone()?;
            parts.push(becomes);
            end = start;
        }
        parts.reverse();
        // one word as it was is no repair; a cut into mostly tiny pieces is a guess
        if parts.len() == 1 && parts[0] == word {
            return None;
        }
        if parts.len() >= 4
            && parts.iter().filter(|p| p.chars().count() <= 2).count() * 2 > parts.len()
        {
            return None;
        }
        Some(parts)
    }

    /// The most common listed word one letter away (dropped, extra, wrong, or two swapped), or `None`.
    fn one_step(&self, word: &str) -> Option<String> {
        const ALPHABET: &str = "abcdefghijklmnopqrstuvwxyz'";
        let chars: Vec<char> = word.chars().collect();
        let mut candidates: Vec<String> = Vec::new();
        for i in 0..=chars.len() {
            for a in ALPHABET.chars() {
                let mut with = chars.clone();
                with.insert(i, a);
                candidates.push(with.into_iter().collect());
            }
        }
        for i in 0..chars.len() {
            let mut without = chars.clone();
            without.remove(i);
            candidates.push(without.into_iter().collect());
            for a in ALPHABET.chars() {
                if a != chars[i] {
                    let mut replaced = chars.clone();
                    replaced[i] = a;
                    candidates.push(replaced.into_iter().collect());
                }
            }
            if i + 1 < chars.len() {
                let mut swapped = chars.clone();
                swapped.swap(i, i + 1);
                candidates.push(swapped.into_iter().collect());
            }
        }
        candidates
            .into_iter()
            .map(|c| (self.count(&c), c))
            .filter(|(n, _)| *n >= 2)
            .max_by_key(|(n, _)| *n)
            .map(|(_, c)| c)
    }
}

/// A repaired word wears the capitals of the original: all capitals stay capitals, a capital first letter stays.
fn match_case(original: &str, fixed: &str) -> String {
    let letters: Vec<char> = original.chars().filter(|c| c.is_alphabetic()).collect();
    if letters.len() > 1 && letters.iter().all(|c| c.is_uppercase()) {
        return fixed.to_uppercase();
    }
    // "I" and "I'm" are always capitals; a leading capital stays
    let mut words: Vec<String> = fixed.split(' ').map(str::to_owned).collect();
    for word in &mut words {
        if word == "i" || word.starts_with("i'") {
            word.replace_range(0..1, "I");
        }
    }
    if original
        .trim_start_matches('(')
        .chars()
        .next()
        .is_some_and(char::is_uppercase)
    {
        let first = &mut words[0];
        let mut chars = first.chars();
        if let Some(c) = chars.next() {
            *first = c.to_uppercase().collect::<String>() + chars.as_str();
        }
    }
    words.join(" ")
}

#[cfg(test)]
mod tests {
    use super::*;

    fn vocab() -> Vocabulary {
        let text = "control control control learn some mind learn some mind you must control what your mind can take \
            if tomorrow never happens if tomorrow let it burn out we don't have forever future future the the the \
            almost like controlling the future future future out out out out together together through thought \
            thought i i i i i'm i'm cause cause cause a a a cross cross it it twice twice when feels like just getting started started";
        // seen often enough to count as common words
        Vocabulary::from_texts([text, text, text, text, text, text])
    }

    #[test]
    fn listed_words_are_never_touched() {
        let v = vocab();
        assert_eq!(
            v.correct_line("You must control what your mind can take"),
            "You must control what your mind can take"
        );
    }

    #[test]
    fn a_swash_c_read_as_a_bracket_is_put_right_but_a_real_bracket_stays() {
        let v = vocab();
        assert_eq!(v.correct_line("(ontrol what"), "control what");
        assert_eq!(v.correct_line("(Cause I"), "(Cause I");
        assert_eq!(v.correct_line("(ONTROL"), "CONTROL");
        assert_eq!(
            v.correct_line("(CONTROL"),
            "(CONTROL",
            "a bracket before a real word is a bracket"
        );
        assert_eq!(
            v.correct_line("(rossittwice"),
            "cross it twice",
            "a bracket and run-together words"
        );
    }

    #[test]
    fn a_u_read_as_v_is_put_right() {
        let v = vocab();
        assert_eq!(v.correct_line("ovt"), "out");
        assert_eq!(
            v.correct_line("vp"),
            "vp",
            "no listed word to go to: left alone"
        );
    }

    #[test]
    fn run_together_words_are_split() {
        let v = vocab();
        assert_eq!(v.correct_line("Iftomorrow never"), "If tomorrow never");
        assert_eq!(v.correct_line("let itburn out"), "let it burn out");
        assert_eq!(
            v.correct_line("we don'thave forever"),
            "we don't have forever"
        );
    }

    #[test]
    fn run_together_words_with_a_dropped_or_look_alike_letter_are_split_and_repaired() {
        let v = vocab();
        assert_eq!(
            v.correct_line("You mustontrolwhat your mind"),
            "You must control what your mind"
        );
        assert_eq!(
            v.correct_line("Whenitfeelslikeyov"),
            "When it feels like you"
        );
        assert_eq!(v.correct_line("justgettingstarted"), "just getting started");
    }

    #[test]
    fn punctuation_inside_a_token_separates_the_words() {
        let v = vocab();
        assert_eq!(
            v.correct_line("tell you\"you'rewrng\""),
            "tell you\"you'rewrng\"",
            "nothing known to go to: left alone"
        );
        assert_eq!(v.correct_line("burn,letitburn"), "burn,let it burn");
    }

    #[test]
    fn a_dropped_letter_is_put_back_and_punctuation_stays() {
        let v = vocab();
        assert_eq!(
            v.correct_line("Almost like controlling the futre,"),
            "Almost like controlling the future,"
        );
        assert_eq!(v.correct_line("togther"), "together");
    }

    #[test]
    fn an_empty_vocabulary_changes_nothing() {
        assert_eq!(
            Vocabulary::default().correct_line("Letitburn ovt"),
            "Letitburn ovt"
        );
    }
}
