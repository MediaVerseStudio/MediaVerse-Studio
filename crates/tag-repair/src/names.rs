//! What file and folder names and placeholder tag values tell us (ADR 0009).

/// True when a tag value says nothing: empty, or a placeholder written by a ripping program or shown by
/// Windows, such as "Unknown artist", "Unknown Album (2/20/2008 10:12:34 PM)" (Windows Media Player) or
/// "Track 3". The first version of tag repair fills only these (owner, 2026-11-03).
pub fn is_placeholder(value: Option<&str>) -> bool {
    let Some(value) = value else { return true };
    let text = value.trim().to_lowercase();
    if text.is_empty() {
        return true;
    }
    const UNKNOWN: [&str; 6] = [
        "unknown artist",
        "unknown album",
        "unknown genre",
        "unknown title",
        "unknown",
        "<unknown>",
    ];
    if UNKNOWN
        .iter()
        .any(|placeholder| text == *placeholder || text.starts_with(&format!("{placeholder} (")))
    {
        return true;
    }
    const OTHER: [&str; 5] = ["various", "untitled", "no title", "artist", "album"];
    if OTHER.contains(&text.as_str()) {
        return true;
    }
    // "Track 3", "Track 03", "Audio Track 3", "Piste 3", "AudioTrack 03"
    let words: Vec<&str> = text.split_whitespace().collect();
    if let Some(last) = words.last()
        && last.chars().all(|c| c.is_ascii_digit())
    {
        let prefix = words[..words.len() - 1].join(" ");
        if matches!(
            prefix.as_str(),
            "track" | "audio track" | "audiotrack" | "piste" | "titel" | "pista"
        ) {
            return true;
        }
    }
    false
}

/// What a file's name gives: a disc and track number and a title, as in "01 Annihilation", "01 - Imagine",
/// "1-03 Title" (disc 1, track 3), "03. Title" or "A Perfect Circle - 05 - Passive".
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FromFileName {
    pub disc: Option<u32>,
    pub track: Option<u32>,
    pub title: Option<String>,
}

pub fn from_file_name(stem: &str) -> FromFileName {
    let stem = stem.trim();
    let mut out = FromFileName::default();
    // "Artist - 05 - Title": the number is the middle part.
    let parts: Vec<&str> = stem.split(" - ").collect();
    if parts.len() >= 3
        && let Ok(number) = parts[1].trim().parse::<u32>()
    {
        out.track = Some(number);
        out.title = clean_title(&parts[2..].join(" - "));
        return out;
    }
    // A leading number, perhaps "1-03" or "103" style disc-and-track, then separators, then the title.
    let digits: String = stem.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() {
        out.title = clean_title(stem);
        return out;
    }
    let mut rest = &stem[digits.len()..];
    let mut number: u32 = digits.parse().unwrap_or(0);
    if let Some(after) = rest.strip_prefix('-')
        && let Some(track_digits) = Some(
            after
                .chars()
                .take_while(|c| c.is_ascii_digit())
                .collect::<String>(),
        )
        && !track_digits.is_empty()
    {
        out.disc = Some(number);
        number = track_digits.parse().unwrap_or(0);
        rest = &after[track_digits.len()..];
    }
    out.track = (number > 0 && number < 100).then_some(number);
    let rest = rest.trim_start_matches(|c: char| {
        c.is_whitespace() || matches!(c, '.' | '-' | '_' | ')' | ']')
    });
    out.title = clean_title(rest);
    out
}

/**
 * A title tag that carries more than the song's name, tidied (owner, 2026-11-04): a leading track number
 * ("01.AFI - Prelude", "1-01 Title", "03 - Title"), the artist's name in front ("AFI - Title"), and a web address at
 * the end (" - www.file24ever.com"). Only when something was taken off and a name is left; a number that is the
 * song's name ("3 1/2", "1-800-273-8255", "99 Red Balloons") stays. `artists`: the song's artist and album artist.
 */
pub fn tidy_title(title: &str, artists: &[&str]) -> Option<String> {
    let original = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let mut text = original.clone();
    loop {
        let before = text.clone();
        // A web address at the end, after " - " or in brackets.
        if let Some(at) = text.rfind(" - ")
            && looks_like_web_address(&text[at + 3..])
        {
            text.truncate(at);
        }
        for (open, close) in [('(', ')'), ('[', ']')] {
            if text.ends_with(close)
                && let Some(at) = text.rfind(open)
                && looks_like_web_address(&text[at + 1..text.len() - 1])
            {
                text.truncate(at);
            }
        }
        text = text.trim().to_owned();
        // A leading track number with a separator ("01.", "01 -", "01_", "1-01 ", "03)").
        let digits: String = text.chars().take_while(|c| c.is_ascii_digit()).collect();
        if !digits.is_empty() && digits.len() <= 3 {
            let mut rest = &text[digits.len()..];
            if let Some(after) = rest.strip_prefix('-')
                && let Some(n) = Some(after.chars().take_while(|c| c.is_ascii_digit()).count())
                && (1..=3).contains(&n)
                && after[n..].starts_with(' ')
            {
                rest = &after[n..]; // "1-01 Title": disc and track
            }
            // Separated by punctuation ("01.", "01_", "03)", "01 - ", "1-01 "), or a zero-padded number and a space
            // ("05 Title"); a plain "3 1/2" or "99 Red Balloons" is the song's own name.
            let disc_and_track = rest.len() < text.len() - digits.len();
            let separated = disc_and_track
                || rest.starts_with(['.', '_', ')', ']'])
                || rest.trim_start().starts_with("- ")
                || (rest.starts_with(' ') && digits.len() == 2 && digits.starts_with('0'));
            let cut = rest.trim_start_matches(|c: char| {
                c.is_whitespace() || matches!(c, '.' | '-' | '_' | ')' | ']')
            });
            if separated
                && cut.starts_with(|c: char| c.is_alphabetic() || c == '(' || c == '\'' || c == '"')
            {
                text = cut.to_owned();
            }
        }
        // The artist's name in front: "AFI - Title" (also when written "A.F.I.").
        if let Some(at) = text.find(" - ") {
            let head = normalise(&text[..at]);
            if !head.is_empty()
                && artists.iter().any(|a| normalise(a) == head)
                && !text[at + 3..].trim().is_empty()
            {
                text = text[at + 3..].trim().to_owned();
            }
        }
        if text == before {
            break;
        }
    }
    let text = text.trim().to_owned();
    (text != original && !text.is_empty()).then_some(text)
}

/// [`tidy_title`] plus one more case, for a song whose track number is known: a title that begins with exactly that number
/// and a space ("14 Donut Dan" on track 14) has the number taken off, although a bare number is otherwise left alone ("99 Red
/// Balloons"). Nothing is taken off when the number differs from the track's, or when it is the whole title.
pub fn tidy_title_for_track(title: &str, artists: &[&str], track: Option<u32>) -> Option<String> {
    if let Some(tidy) = tidy_title(title, artists) {
        return Some(tidy);
    }
    let track = track.filter(|n| (1..1000).contains(n))?;
    let text = title.split_whitespace().collect::<Vec<_>>().join(" ");
    let digits: String = text.chars().take_while(|c| c.is_ascii_digit()).collect();
    if digits.is_empty() || digits.len() > 3 || digits.parse::<u32>().ok() != Some(track) {
        return None;
    }
    let rest = text[digits.len()..].strip_prefix(' ')?.trim();
    rest.starts_with(|c: char| c.is_alphabetic() || c == '(' || c == '\'' || c == '"')
        .then(|| rest.to_owned())
}

/// The song's title as its file name gives it, without the artist's name in front ("01 - Wagon Christ - Track 1"
/// is "Track 1" when the artist is Wagon Christ; owner, 2026-11-05).
pub fn title_from_file_name(stem: &str, artists: &[&str]) -> Option<String> {
    let title = from_file_name(stem).title?;
    Some(tidy_title(&title, artists).unwrap_or(title))
}

fn looks_like_web_address(text: &str) -> bool {
    let t = text.trim().to_lowercase();
    if t.is_empty() || t.contains(' ') {
        return false;
    }
    t.starts_with("www.")
        || t.starts_with("http")
        || [
            ".com", ".net", ".org", ".ru", ".info", ".biz", ".to", ".co.uk",
        ]
        .iter()
        .any(|end| t.ends_with(end))
}

fn clean_title(text: &str) -> Option<String> {
    let text = text.replace('_', " ");
    let text = text.split_whitespace().collect::<Vec<_>>().join(" ");
    (!text.is_empty()).then_some(text)
}

/// What the folders above a file give: the album (its folder) and the artist (the folder above), with a year
/// in brackets taken off ("eMOTIVe (2004)"), a disc folder skipped ("CD1", "Disc 2"), and "Artist - Album"
/// folder names split. `parents` runs from the file's own folder upwards and should stop at the library root.
#[derive(Clone, Debug, Default, PartialEq, Eq)]
pub struct FromFolders {
    pub artist: Option<String>,
    pub album: Option<String>,
    pub year: Option<u32>,
    pub disc: Option<u32>,
}

pub fn from_folders(parents: &[&str]) -> FromFolders {
    let mut out = FromFolders::default();
    let mut names = parents
        .iter()
        .map(|name| name.trim())
        .filter(|name| !name.is_empty());
    let mut album = names.next();
    if let Some(name) = album
        && let Some(disc) = disc_folder(name)
    {
        out.disc = Some(disc);
        album = names.next();
    }
    let Some(album) = album else { return out };
    let (album, disc) = take_disc(album);
    if disc.is_some() {
        out.disc = disc;
    }
    let (album, year) = take_year(&album);
    out.year = year;
    if let Some((artist, title)) = album.split_once(" - ") {
        out.artist = clean_title(artist);
        out.album = clean_title(title);
        return out;
    }
    out.album = clean_title(&album);
    out.artist = names.next().and_then(clean_title);
    out
}

/// "CD1", "CD-01", "Disc 2", "disk_3": a folder that is one disc of a set.
fn disc_folder(name: &str) -> Option<u32> {
    let lower = name.to_lowercase();
    for prefix in ["cd", "disc", "disk"] {
        if let Some(rest) = lower.strip_prefix(prefix) {
            let rest = rest.trim().trim_start_matches(['-', '_', ' ', '.']);
            if let Ok(number) = rest.parse::<u32>() {
                return Some(number);
            }
        }
    }
    None
}

/// "Wrecktrospective [Disc 2]" → ("Wrecktrospective", Some(2)); also "(CD 2)", "- Disc 2".
fn take_disc(name: &str) -> (String, Option<u32>) {
    let lower = name.to_lowercase();
    for (open, close) in [("[", "]"), ("(", ")")] {
        if let (Some(start), Some(end)) = (lower.rfind(open), lower.rfind(close))
            && end > start
            && let Some(disc) = disc_folder(lower[start + 1..end].trim())
        {
            let rest = format!("{}{}", &name[..start], &name[end + 1..]);
            return (
                rest.trim().trim_end_matches('-').trim().to_owned(),
                Some(disc),
            );
        }
    }
    if let Some((before, after)) = name.rsplit_once(" - ")
        && let Some(disc) = disc_folder(after.trim())
    {
        return (before.trim().to_owned(), Some(disc));
    }
    (name.to_owned(), None)
}

/// A name without its bracketed qualifiers, for comparing: "Only a Lad (Remastered & Expanded Edition)" and
/// "Garbage (20th Anniversary Super Deluxe Edition (Remastered))" compare as "Only a Lad" and "Garbage".
pub fn without_qualifiers(name: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for c in name.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            _ if depth == 0 => out.push(c),
            _ => {}
        }
    }
    let out = out.split_whitespace().collect::<Vec<_>>().join(" ");
    if out.is_empty() { name.to_owned() } else { out }
}

/// Name similarity that also tries both names without bracketed qualifiers (editions, "(Single)", "[Live]").
pub fn name_similarity(a: &str, b: &str) -> f64 {
    similarity(a, b).max(similarity(&without_qualifiers(a), &without_qualifiers(b)))
}

/// True for the compilation credit "Various Artists" (and its common spellings).
pub fn is_various(name: &str) -> bool {
    matches!(
        normalise(name).as_str(),
        "variousartists" | "various" | "va"
    )
}

fn take_year(name: &str) -> (String, Option<u32>) {
    for (open, close) in [('(', ')'), ('[', ']')] {
        if let (Some(start), Some(end)) = (name.rfind(open), name.rfind(close))
            && end > start
        {
            let inside = name[start + 1..end].trim();
            if inside.len() == 4
                && let Ok(year) = inside.parse::<u32>()
                && (1900..=2100).contains(&year)
            {
                let rest = format!("{}{}", &name[..start], &name[end + 1..]);
                return (
                    rest.trim().trim_end_matches('-').trim().to_owned(),
                    Some(year),
                );
            }
        }
    }
    (name.to_owned(), None)
}

/// How alike two names are, 0.0 to 1.0, ignoring case, punctuation, accents of the common kind and a leading
/// "The": the share of letter pairs they have in common (Sørensen–Dice on bigrams).
pub fn similarity(a: &str, b: &str) -> f64 {
    let a = normalise(a);
    let b = normalise(b);
    if a.is_empty() || b.is_empty() {
        return 0.0;
    }
    if a == b {
        return 1.0;
    }
    let pairs = |text: &str| -> Vec<(char, char)> {
        let chars: Vec<char> = text.chars().collect();
        chars.windows(2).map(|w| (w[0], w[1])).collect()
    };
    let left = pairs(&a);
    let mut right = pairs(&b);
    if left.is_empty() || right.is_empty() {
        return 0.0;
    }
    let total = left.len() + right.len();
    let mut shared = 0;
    for pair in left {
        if let Some(index) = right.iter().position(|other| *other == pair) {
            right.swap_remove(index);
            shared += 1;
        }
    }
    2.0 * shared as f64 / total as f64
}

/// Lower case letters and digits only, with "&" read as "and" and a leading "the" dropped.
pub fn normalise(text: &str) -> String {
    let mut out = String::new();
    for c in text.to_lowercase().replace('&', " and ").chars() {
        let c = match c {
            'à' | 'á' | 'â' | 'ã' | 'ä' | 'å' => 'a',
            'è' | 'é' | 'ê' | 'ë' => 'e',
            'ì' | 'í' | 'î' | 'ï' => 'i',
            'ò' | 'ó' | 'ô' | 'õ' | 'ö' | 'ø' => 'o',
            'ù' | 'ú' | 'û' | 'ü' => 'u',
            'ñ' => 'n',
            'ç' => 'c',
            other => other,
        };
        if c.is_alphanumeric() {
            out.push(c);
        } else if !out.ends_with(' ') {
            out.push(' ');
        }
    }
    let out = out.trim();
    out.strip_prefix("the ").unwrap_or(out).replace(' ', "")
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn titles_lose_track_numbers_artist_names_and_web_addresses() {
        let afi = ["A.F.I.", "A.F.I."];
        // The owner's AFI live album.
        assert_eq!(
            tidy_title(
                "01.AFI - Prelude 1221 (Live Arena Long Beach CA) - www.file24ever.com",
                &afi
            )
            .as_deref(),
            Some("Prelude 1221 (Live Arena Long Beach CA)")
        );
        assert_eq!(
            tidy_title("1-01 Throw Your Arms Around Me", &["Pearl Jam"]).as_deref(),
            Some("Throw Your Arms Around Me")
        );
        assert_eq!(
            tidy_title("03 - Wake-Up Call", &afi).as_deref(),
            Some("Wake-Up Call")
        );
        assert_eq!(
            tidy_title("05 Perfect Fit", &afi).as_deref(),
            Some("Perfect Fit")
        );
        assert_eq!(
            tidy_title("NoFX - Fat Music For Fat People", &["NOFX"]).as_deref(),
            Some("Fat Music For Fat People")
        );
        assert_eq!(
            tidy_title("Song [www.example.ru]", &[]).as_deref(),
            Some("Song")
        );
        // A number that is the song's name stays, and so do clean titles.
        for kept in [
            "3 1/2",
            "1-800-273-8255",
            "99 Red Balloons",
            "2-4-6-8 Motorway",
            "1876",
            "Girl's Not Grey",
            "Smells Like Teen Spirit - Live",
            "7 Seconds",
        ] {
            assert_eq!(tidy_title(kept, &afi), None, "{kept}");
        }
        assert_eq!(
            tidy_title("Other Band - Song", &afi),
            None,
            "another artist's name is not taken off"
        );
    }

    #[test]
    fn a_number_equal_to_the_tracks_own_number_comes_off_the_title() {
        let band = ["Goldfinger"];
        assert_eq!(
            tidy_title_for_track("14 Donut Dan", &band, Some(14)).as_deref(),
            Some("Donut Dan")
        );
        assert_eq!(
            tidy_title_for_track("73 Yips", &band, Some(73)).as_deref(),
            Some("Yips")
        );
        assert_eq!(
            tidy_title_for_track("05 Perfect Fit", &band, Some(5)).as_deref(),
            Some("Perfect Fit"),
            "what tidy_title already does"
        );
        assert_eq!(
            tidy_title_for_track("14 Donut Dan", &band, Some(2)),
            None,
            "another number is the song's own"
        );
        assert_eq!(
            tidy_title_for_track("99 Red Balloons", &band, Some(3)),
            None
        );
        assert_eq!(
            tidy_title_for_track("14 Donut Dan", &band, None),
            None,
            "without the track number nothing says it is one"
        );
        assert_eq!(
            tidy_title_for_track("7", &band, Some(7)),
            None,
            "a number alone is the title"
        );
        assert_eq!(
            tidy_title_for_track("7 1/2 Minutes", &band, Some(7)),
            None,
            "what follows must be a word"
        );
    }

    #[test]
    fn a_file_name_title_loses_the_artist_in_front() {
        assert_eq!(
            title_from_file_name("01 - Wagon Christ - Track 1", &["Wagon Christ"]).as_deref(),
            Some("Track 1")
        );
        assert_eq!(
            title_from_file_name("02 Piano Lesson", &["Wagon Christ"]).as_deref(),
            Some("Piano Lesson")
        );
        assert_eq!(
            title_from_file_name("03 - Other Band - Song", &["Wagon Christ"]).as_deref(),
            Some("Other Band - Song"),
            "another name stays"
        );
    }

    #[test]
    fn placeholders_are_recognised_and_real_values_are_not() {
        for empty in [
            None,
            Some(""),
            Some("  "),
            Some("Unknown artist"),
            Some("Unknown Album (2/20/2008 10:12:34 PM)"),
            Some("Unknown genre"),
            Some("Track 1"),
            Some("Track 12"),
            Some("Audio Track 03"),
        ] {
            assert!(is_placeholder(empty), "{empty:?}");
        }
        for real in [
            "Tool",
            "Track",
            "Track 1 (Remix)",
            "Unknown Pleasures",
            "Annihilation",
            "1999",
        ] {
            assert!(!is_placeholder(Some(real)), "{real}");
        }
    }

    #[test]
    fn file_names_give_numbers_and_titles() {
        let cases = [
            ("01 Annihilation", None, Some(1), Some("Annihilation")),
            ("02 - Imagine", None, Some(2), Some("Imagine")),
            (
                "03. Peace Love And Understanding",
                None,
                Some(3),
                Some("Peace Love And Understanding"),
            ),
            (
                "1-04 What's Going On",
                Some(1),
                Some(4),
                Some("What's Going On"),
            ),
            (
                "A Perfect Circle - 05 - Passive",
                None,
                Some(5),
                Some("Passive"),
            ),
            (
                "Gimmie_Gimmie_Gimmie",
                None,
                None,
                Some("Gimmie Gimmie Gimmie"),
            ),
        ];
        for (stem, disc, track, title) in cases {
            let got = from_file_name(stem);
            assert_eq!(
                (got.disc, got.track, got.title.as_deref()),
                (disc, track, title),
                "{stem}"
            );
        }
    }

    #[test]
    fn folders_give_artist_album_year_and_disc() {
        assert_eq!(
            from_folders(&["eMOTIVe", "A Perfect Circle"]),
            FromFolders {
                artist: Some("A Perfect Circle".into()),
                album: Some("eMOTIVe".into()),
                year: None,
                disc: None
            }
        );
        assert_eq!(
            from_folders(&["Lateralus (2001)", "Tool"]),
            FromFolders {
                artist: Some("Tool".into()),
                album: Some("Lateralus".into()),
                year: Some(2001),
                disc: None
            }
        );
        assert_eq!(
            from_folders(&["CD2", "Mellon Collie [1995]", "The Smashing Pumpkins"]).disc,
            Some(2)
        );
        assert_eq!(
            from_folders(&["Nirvana - Nevermind"]).artist.as_deref(),
            Some("Nirvana")
        );
        // From the owner's library.
        let disc2 = from_folders(&["Wrecktrospective [Disc 2]", "Various Artists"]);
        assert_eq!(
            (disc2.album.as_deref(), disc2.disc),
            (Some("Wrecktrospective"), Some(2))
        );
        let wish = from_folders(&["CD-01", "Wish", "The Cure"]);
        assert_eq!(
            (wish.album.as_deref(), wish.artist.as_deref(), wish.disc),
            (Some("Wish"), Some("The Cure"), Some(1))
        );
        assert_eq!(
            from_folders(&["Pulse [Live] [Disc 1]", "Pink Floyd"])
                .album
                .as_deref(),
            Some("Pulse [Live]")
        );
    }

    #[test]
    fn qualifiers_and_compilations() {
        assert!(name_similarity("Only a Lad (Remasterd & Expanded Edition)", "Only a Lad") > 0.99);
        assert!(
            name_similarity(
                "Garbage (20th Anniversary Super Deluxe Edition (Remastered))",
                "Garbage"
            ) > 0.99
        );
        assert!(name_similarity("Sin (Single)", "Sin") > 0.99);
        assert!(name_similarity("Tolerance", "Annihilation") < 0.3);
        assert!(
            is_various("Various Artists") && is_various("VA") && !is_various("Various Cruelties")
        );
    }

    #[test]
    fn similar_names_score_high_and_different_ones_low() {
        assert!(
            similarity(
                "Peace Love And Understanding",
                "(What's So Funny 'Bout) Peace, Love, and Understanding"
            ) > 0.6
        );
        assert!(similarity("The Beatles", "Beatles") > 0.99);
        assert!(similarity("Guns & Roses", "Guns and Roses") > 0.99);
        assert!(similarity("Annihilation", "Imagine") < 0.3);
    }
}
