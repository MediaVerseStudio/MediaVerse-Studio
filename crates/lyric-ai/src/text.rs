//! Text preparation: the letters a speech model can read, the comparable words of lyrics, and spellings of a title to search for.
//! The rules are those of tools/lyric-sync (`align.tidy_words`, `match.words`), including their quirks, so results agree.

/// Folds accented Latin letters to plain ones (the aligner models read unaccented letters only).
pub fn fold_accents(c: char) -> Option<char> {
    Some(match c {
        'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' | 'ā' | 'ă' | 'ą' => 'a',
        'À' | 'Á' | 'Â' | 'Ã' | 'Ä' | 'Å' | 'Ā' | 'Ă' | 'Ą' => 'A',
        'ç' | 'ć' | 'č' => 'c',
        'Ç' | 'Ć' | 'Č' => 'C',
        'ď' | 'đ' => 'd',
        'Ď' | 'Đ' => 'D',
        'è' | 'é' | 'ê' | 'ë' | 'ē' | 'ė' | 'ę' | 'ě' => 'e',
        'È' | 'É' | 'Ê' | 'Ë' | 'Ē' | 'Ė' | 'Ę' | 'Ě' => 'E',
        'ì' | 'í' | 'î' | 'ï' | 'ī' | 'į' | 'ı' => 'i',
        'Ì' | 'Í' | 'Î' | 'Ï' | 'Ī' | 'Į' | 'İ' => 'I',
        'ł' | 'ľ' => 'l',
        'Ł' | 'Ľ' => 'L',
        'ñ' | 'ń' | 'ň' => 'n',
        'Ñ' | 'Ń' | 'Ň' => 'N',
        'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' | 'ō' | 'ő' => 'o',
        'Ò' | 'Ó' | 'Ô' | 'Õ' | 'Ö' | 'Ø' | 'Ō' | 'Ő' => 'O',
        'ř' => 'r',
        'Ř' => 'R',
        'ś' | 'š' | 'ş' => 's',
        'Ś' | 'Š' | 'Ş' => 'S',
        'ť' | 'ţ' => 't',
        'Ť' | 'Ţ' => 'T',
        'ù' | 'ú' | 'û' | 'ü' | 'ū' | 'ů' | 'ű' | 'ų' => 'u',
        'Ù' | 'Ú' | 'Û' | 'Ü' | 'Ū' | 'Ů' | 'Ű' | 'Ų' => 'U',
        'ý' | 'ÿ' => 'y',
        'Ý' | 'Ÿ' => 'Y',
        'ź' | 'ż' | 'ž' => 'z',
        'Ź' | 'Ż' | 'Ž' => 'Z',
        _ => return None,
    })
}

/// ASCII text: accents folded, anything else that is not ASCII dropped (what `unicodedata.normalize("NFKD")` then `encode("ascii", "ignore")` leaves).
fn ascii_fold(text: &str) -> String {
    text.chars()
        .filter_map(|c| {
            if c.is_ascii() {
                Some(c)
            } else {
                fold_accents(c)
            }
        })
        .collect()
}

/// The words of a lyric line as the aligner model reads them: letters and apostrophes only, upper case (`upper`) or lower case, "&" as "and",
/// digits and symbols dropped, apostrophes taken off the ends of a word.
pub fn tidy_words(line: &str, upper: bool) -> Vec<String> {
    let text = ascii_fold(&line.replace('\u{2019}', "'")).replace('&', " and ");
    let text = if upper {
        text.to_uppercase()
    } else {
        text.to_lowercase()
    };
    let cleaned: String = text
        .chars()
        .map(|c| {
            if c.is_ascii_alphabetic() || c == '\'' || c == ' ' {
                c
            } else {
                ' '
            }
        })
        .collect();
    cleaned
        .split_whitespace()
        .map(|w| w.trim_matches('\'').to_owned())
        .filter(|w| !w.is_empty())
        .collect()
}

const VOCABLES: &[&str] = &[
    "oh", "ooh", "oooh", "ohh", "ah", "aah", "aaah", "ahh", "whoa", "woah", "woo", "wo", "oo",
    "uh", "um", "hmm", "mm", "mmm", "hm", "ha", "hah", "yeah", "yea", "yeh", "hey", "heh", "eh",
    "ay", "ayy", "ayo", "la", "na", "da", "doo", "dum", "ba", "bom", "sha", "shoo", "wah", "ooo",
    "ohhh", "huh", "uhh", "ahhh", "yo", "ow", "oi", "ey",
];

fn roman(word: &str) -> Option<&'static str> {
    Some(match word {
        "i" => "one",
        "ii" => "two",
        "iii" => "three",
        "iv" => "four",
        "v" => "five",
        "vi" => "six",
        "vii" => "seven",
        "viii" => "eight",
        "ix" => "nine",
        "x" => "ten",
        _ => return None,
    })
}

fn number(word: &str) -> Option<&'static str> {
    Some(match word {
        "0" => "zero",
        "1" => "one",
        "2" => "two",
        "3" => "three",
        "4" => "four",
        "5" => "five",
        "6" => "six",
        "7" => "seven",
        "8" => "eight",
        "9" => "nine",
        "10" => "ten",
        "11" => "eleven",
        "12" => "twelve",
        "13" => "thirteen",
        "14" => "fourteen",
        "15" => "fifteen",
        "16" => "sixteen",
        "17" => "seventeen",
        "18" => "eighteen",
        "19" => "nineteen",
        "20" => "twenty",
        _ => return None,
    })
}

fn spelling(word: &str) -> Option<&'static str> {
    Some(match word {
        "gonna" => "going to",
        "wanna" => "want to",
        "gotta" => "got to",
        "cause" | "cos" => "because",
        "til" | "till" => "until",
        "tho" => "though",
        "thru" => "through",
        "ya" => "you",
        "yer" => "your",
        "em" => "them",
        "nothin" => "nothing",
        "somethin" => "something",
        "lovin" => "loving",
        "goin" => "going",
        "n" => "and",
        "ain't" => "aint",
        "alright" => "all right",
        "okay" => "ok",
        "gimme" => "give me",
        "lemme" => "let me",
        "dunno" => "do not know",
        "kinda" => "kind of",
        _ => return None,
    })
}

/// A word made only of vocable pieces ("lalala", "nanana", "oohooh", "lana"), in any mix.
fn is_vocable_run(word: &str) -> bool {
    const UNITS: [&str; 10] = [
        "la", "na", "da", "oh", "ah", "ooh", "woah", "whoa", "hey", "yeah",
    ];
    if word.is_empty() {
        return false;
    }
    let mut reachable = vec![false; word.len() + 1];
    reachable[0] = true;
    for at in 0..word.len() {
        if reachable[at] {
            for unit in UNITS {
                if word[at..].starts_with(unit) {
                    reachable[at + unit.len()] = true;
                }
            }
        }
    }
    reachable[word.len()]
}

/// The comparable words of a text: case, accents, punctuation, "&"/"and", numbers and Roman numerals as words, usual spelling variants; sung vocables
/// ("oh", "whoa", "la la") left out when `drop_vocables` (they are the wildcards of the comparison).
pub fn words(text: &str, drop_vocables: bool) -> Vec<String> {
    let folded = ascii_fold(text).replace('&', " and ");
    let folded = folded.replace('\u{2019}', "'");
    let mut out = Vec::new();
    let bytes: Vec<char> = folded.chars().collect();
    let mut i = 0;
    while i < bytes.len() {
        if !(bytes[i].is_ascii_alphanumeric() || bytes[i] == '\'') {
            i += 1;
            continue;
        }
        let start = i;
        while i < bytes.len() && (bytes[i].is_ascii_alphanumeric() || bytes[i] == '\'') {
            i += 1;
        }
        let raw: String = bytes[start..i].iter().collect();
        let stripped = raw.trim_matches('\'');
        if stripped.is_empty() {
            continue;
        }
        let mut lower = stripped.to_lowercase();
        // "III" written in capitals is a numeral, not the word "I"
        if stripped.len() > 1
            && stripped.chars().all(|c| c.is_ascii_uppercase())
            && let Some(r) = roman(&lower)
        {
            lower = r.to_owned();
        }
        if let Some(n) = number(&lower) {
            lower = n.to_owned();
        }
        let expanded = spelling(&lower).map_or(lower.clone(), str::to_owned);
        for piece in expanded.split_whitespace() {
            let piece = piece.replace('\'', "");
            if drop_vocables && (VOCABLES.contains(&piece.as_str()) || is_vocable_run(&piece)) {
                continue;
            }
            out.push(piece);
        }
    }
    out
}

/// Other spellings of a title worth searching for: numbers and Roman numerals both ways, "&"/"and", without a bracketed or dashed version note, without a
/// leading track number, without "feat.". The title as written comes first; the list has no repeats.
/// The same text with look-alike characters made plain: curly and other apostrophes and quote marks, long dashes and other hyphens, no-break and wide spaces,
/// the ellipsis character. Services spell the same name in different ways ("Don’t" and "Don't", "Mötley Crüe – Live" and "- Live").
pub fn plain_punctuation(text: &str) -> String {
    let folded: String =
        text.chars()
            .map(|c| match c {
                '\u{2018}' | '\u{2019}' | '\u{201B}' | '\u{02BC}' | '\u{00B4}' | '`'
                | '\u{2032}' => '\'',
                '\u{201C}' | '\u{201D}' | '\u{201E}' | '\u{2033}' => '"',
                '\u{2010}'..='\u{2015}' | '\u{2212}' => '-',
                '\u{00A0}' | '\u{2002}'..='\u{200A}' | '\u{3000}' | '\u{202F}' => ' ',
                other => other,
            })
            .collect::<String>()
            .replace('\u{2026}', "...");
    folded.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// Other spellings of an artist's or a title's name that services use for the same thing, the name as written first: with the look-alike characters made
/// plain, without "!", "?" or a trailing full stop ("Against Me!"), without apostrophes ("Guns N' Roses"), with or without a leading "The", "&" and "and".
/// A search for each finds records an exact search misses (2026-11-17: MusicBrainz's spellings differ from tags in just these small ways).
pub fn name_variants(name: &str) -> Vec<String> {
    fn push(list: &mut Vec<String>, value: String) {
        let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
        if !value.is_empty() && !list.iter().any(|v| v == &value) {
            list.push(value);
        }
    }
    let mut out = Vec::new();
    push(&mut out, name.trim().to_owned());
    let plain = plain_punctuation(name);
    push(&mut out, plain.clone());
    let sources = out.clone();
    for source in sources {
        push(
            &mut out,
            source
                .replace(['!', '?'], "")
                .trim_end_matches('.')
                .to_owned(),
        );
        push(&mut out, source.replace('\'', ""));
        let lower = source.to_lowercase();
        if let Some(rest) = lower.strip_prefix("the ") {
            push(&mut out, source[source.len() - rest.len()..].to_owned());
        } else {
            push(&mut out, format!("The {source}"));
        }
        push(&mut out, source.replace(" & ", " and "));
        push(&mut out, source.replace(" and ", " & "));
    }
    out
}

pub fn title_variants(title: &str) -> Vec<String> {
    fn push(list: &mut Vec<String>, value: String) {
        let value = value.split_whitespace().collect::<Vec<_>>().join(" ");
        if !value.is_empty() && !list.iter().any(|v| v.eq_ignore_ascii_case(&value)) {
            list.push(value);
        }
    }
    let mut out = Vec::new();
    push(&mut out, title.trim().to_owned());
    let mut base = title.trim().to_owned();
    // a track number in front: "14 Donut Dan", "01 - Song"
    let digits = base.chars().take_while(char::is_ascii_digit).count();
    if (1..=3).contains(&digits) {
        let rest = base[digits..].trim_start_matches(|c: char| {
            c.is_whitespace() || matches!(c, '.' | '-' | '_' | ')' | ']')
        });
        if rest.len() < base.len() - digits && rest.starts_with(|c: char| c.is_alphabetic()) {
            base = rest.to_owned();
            push(&mut out, base.clone());
        }
    }
    // a bracketed version note at the end: "(Live)", "[Remastered 2011]", "(feat. X)"
    let mut core = base.clone();
    loop {
        let before = core.clone();
        for (open, close) in [('(', ')'), ('[', ']')] {
            if core.ends_with(close)
                && let Some(at) = core.rfind(open)
                && at > 0
            {
                core = core[..at].trim_end().to_owned();
            }
        }
        if core == before {
            break;
        }
    }
    if let Some(at) = core.rfind(" - ") {
        core = core[..at].trim_end().to_owned();
    }
    push(&mut out, core.clone());
    let sources = out.clone();
    for source in sources {
        let spaced: Vec<&str> = source.split_whitespace().collect();
        // numbers and Roman numerals both ways
        let mut as_words = Vec::new();
        let mut as_digits = Vec::new();
        let mut changed_words = false;
        let mut changed_digits = false;
        for token in &spaced {
            let bare = token.trim_matches(|c: char| !c.is_alphanumeric());
            if let Some(w) = number(bare).or_else(|| {
                if bare.len() > 1 && bare.chars().all(|c| c.is_ascii_uppercase()) {
                    roman(&bare.to_lowercase())
                } else {
                    None
                }
            }) {
                as_words.push(token.replace(bare, w));
                changed_words = true;
            } else {
                as_words.push((*token).to_owned());
            }
            let digit = match bare.to_lowercase().as_str() {
                "one" => Some("1"),
                "two" => Some("2"),
                "three" => Some("3"),
                "four" => Some("4"),
                "five" => Some("5"),
                "six" => Some("6"),
                "seven" => Some("7"),
                "eight" => Some("8"),
                "nine" => Some("9"),
                "ten" => Some("10"),
                _ => None,
            };
            let numeral = if bare.len() > 1 && bare.chars().all(|c| c.is_ascii_uppercase()) {
                roman(&bare.to_lowercase()).and_then(|w| {
                    [
                        "zero", "one", "two", "three", "four", "five", "six", "seven", "eight",
                        "nine", "ten",
                    ]
                    .iter()
                    .position(|x| *x == w)
                    .map(|p| p.to_string())
                })
            } else {
                None
            };
            if let Some(d) = digit.map(str::to_owned).or(numeral) {
                as_digits.push(token.replace(bare, &d));
                changed_digits = true;
            } else {
                as_digits.push((*token).to_owned());
            }
        }
        if changed_words {
            push(&mut out, as_words.join(" "));
        }
        if changed_digits {
            push(&mut out, as_digits.join(" "));
        }
        push(&mut out, source.replace('&', "and"));
        push(&mut out, source.replace(" and ", " & "));
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn model_words_are_unaccented_letters() {
        assert_eq!(
            tidy_words("Don’t stop, señor — 99 red balloons & fire!", true),
            ["DON'T", "STOP", "SENOR", "RED", "BALLOONS", "AND", "FIRE"]
        );
        assert_eq!(tidy_words("'Tis the 'bomb'", false), ["tis", "the", "bomb"]);
        assert!(tidy_words("1979 ...", true).is_empty());
    }

    #[test]
    fn comparable_words_ignore_vocables_numerals_and_spelling() {
        assert_eq!(words("World War III", true), ["world", "war", "three"]);
        assert_eq!(words("World War 3", true), ["world", "war", "three"]);
        assert_eq!(
            words("I want to go", true),
            ["i", "want", "to", "go"],
            "a lone I stays a word"
        );
        assert_eq!(
            words("Whoa-oh, gonna lalala ya", true),
            ["going", "to", "you"]
        );
        assert_eq!(
            words("Ooh yeah, Rock & Roll", false),
            ["ooh", "yeah", "rock", "and", "roll"]
        );
    }

    #[test]
    fn look_alike_characters_are_made_plain() {
        assert_eq!(
            plain_punctuation("Don\u{2019}t – stop\u{00A0}me\u{2014}now…"),
            "Don't - stop me-now..."
        );
        assert_eq!(plain_punctuation("“Quoted”  name"), "\"Quoted\" name");
    }

    #[test]
    fn names_are_offered_with_the_small_differences_services_make() {
        let v = name_variants("Against Me!");
        assert_eq!(v[0], "Against Me!");
        assert!(
            v.contains(&"Against Me".to_owned()) && v.contains(&"The Against Me!".to_owned()),
            "{v:?}"
        );
        let v = name_variants("The Black Keys");
        assert!(v.contains(&"Black Keys".to_owned()), "{v:?}");
        let v = name_variants("Guns N’ Roses");
        assert!(
            v.contains(&"Guns N' Roses".to_owned()) && v.contains(&"Guns N Roses".to_owned()),
            "{v:?}"
        );
        let v = name_variants("Simon & Garfunkel");
        assert!(v.contains(&"Simon and Garfunkel".to_owned()), "{v:?}");
        assert!(v.len() <= 12, "no endless lists: {}", v.len());
    }

    #[test]
    fn title_spellings_are_offered_both_ways() {
        let v = title_variants("World War III");
        assert_eq!(v[0], "World War III");
        assert!(
            v.contains(&"World War 3".to_owned()) && v.contains(&"World War three".to_owned()),
            "{v:?}"
        );
        let v = title_variants("14 Donut Dan (Live) [Remastered]");
        assert!(v.contains(&"Donut Dan".to_owned()), "{v:?}");
        let v = title_variants("Rock & Roll");
        assert!(v.contains(&"Rock and Roll".to_owned()), "{v:?}");
        assert_eq!(title_variants("Song").len(), 1);
    }
}
