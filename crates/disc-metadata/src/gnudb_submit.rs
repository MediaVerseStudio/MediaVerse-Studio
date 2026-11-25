//! Submitting a disc to gnudb (D107): building the entry and checking it before anything is sent. The rules are gnudb's own
//! (https://gnudb.org/howtognudb.php): a real email address typed by the person, a disc artist and title typed or confirmed
//! by them, a real title for every track (never a placeholder), the entry text sent raw as UTF-8, category one of the
//! eleven freedb categories, revision 0 for a new entry. Pure; the sidecar does the network.

use crate::{DiscToc, discid};

/// The categories gnudb accepts.
pub const CATEGORIES: [&str; 11] = [
    "blues",
    "classical",
    "country",
    "data",
    "folk",
    "jazz",
    "misc",
    "newage",
    "reggae",
    "rock",
    "soundtrack",
];

/// What is being submitted: the person's confirmed details for this disc.
#[derive(Clone, Debug)]
pub struct Submission {
    pub artist: String,
    pub album: String,
    pub year: Option<u32>,
    pub genre: String,
    /// One entry per track in disc order: the title and, when it differs from the disc artist, the track's artist.
    pub tracks: Vec<(String, Option<String>)>,
    pub compilation: bool,
    pub category: String,
    pub email: String,
}

/// The category that suits a genre best; "misc" when none does.
pub fn category_for(genre: &str) -> &'static str {
    let g = genre.to_lowercase();
    let has = |words: &[&str]| words.iter().any(|w| g.contains(w));
    if has(&["reggae", "ska", "dub", "dancehall"]) {
        "reggae"
    } else if has(&[
        "rock",
        "punk",
        "metal",
        "grunge",
        "indie",
        "alternative",
        "hardcore",
        "emo",
        "pop",
    ]) {
        "rock"
    } else if has(&["classical", "opera", "orchestra"]) {
        "classical"
    } else if has(&["jazz", "swing", "bebop"]) {
        "jazz"
    } else if has(&["blues", "r&b", "soul"]) {
        "blues"
    } else if has(&["country", "bluegrass", "americana"]) {
        "country"
    } else if has(&["folk", "acoustic", "singer"]) {
        "folk"
    } else if has(&["soundtrack", "score", "musical"]) {
        "soundtrack"
    } else if has(&["new age", "ambient"]) {
        "newage"
    } else {
        "misc"
    }
}

fn plausible_email(email: &str) -> bool {
    let email = email.trim();
    match email.split_once('@') {
        Some((name, host)) => {
            !name.is_empty()
                && host.contains('.')
                && !host.starts_with('.')
                && !host.ends_with('.')
                && !email.contains(char::is_whitespace)
                && !host.contains('@')
        }
        None => false,
    }
}

fn is_placeholder(title: &str) -> bool {
    let t = title.trim().to_lowercase();
    t.is_empty()
        || t == "unknown"
        || t == "untitled"
        || t.strip_prefix("track")
            .is_some_and(|rest| rest.trim().chars().all(|c| c.is_ascii_digit()))
}

/// What is wrong with a submission, in words for the person, or None when it may be sent.
pub fn problem(toc: &DiscToc, submission: &Submission) -> Option<String> {
    if !plausible_email(&submission.email) {
        return Some(
            "gnudb needs your own email address (it uses it to tell you if an entry is rejected)."
                .to_owned(),
        );
    }
    if submission.artist.trim().is_empty() || submission.album.trim().is_empty() {
        return Some("The artist and the album title are both needed.".to_owned());
    }
    if submission.tracks.len() != toc.track_count() {
        return Some(format!(
            "The disc has {} tracks but {} titles were given.",
            toc.track_count(),
            submission.tracks.len()
        ));
    }
    if let Some(index) = submission
        .tracks
        .iter()
        .position(|(title, _)| is_placeholder(title))
    {
        return Some(format!(
            "Track {} has no real title. gnudb does not accept placeholders such as \"Track 01\".",
            index + 1
        ));
    }
    if !CATEGORIES.contains(&submission.category.as_str()) {
        return Some(format!(
            "\"{}\" is not a gnudb category.",
            submission.category
        ));
    }
    None
}

fn clean(text: &str) -> String {
    text.chars()
        .map(|c| {
            if c == '\n' || c == '\r' || c == '\t' {
                ' '
            } else {
                c
            }
        })
        .collect::<String>()
        .trim()
        .to_owned()
}

/// `KEY=value` lines; a value longer than 230 bytes continues on further lines with the same key, which gnudb joins.
fn field(key: &str, value: &str, out: &mut String) {
    let value = clean(value);
    if value.len() <= 230 {
        out.push_str(&format!("{key}={value}\n"));
        return;
    }
    let mut rest = value.as_str();
    while !rest.is_empty() {
        let mut cut = rest.len().min(230);
        while !rest.is_char_boundary(cut) {
            cut -= 1;
        }
        out.push_str(&format!("{key}={}\n", &rest[..cut]));
        rest = &rest[cut..];
    }
}

/// The entry text in gnudb's file format (a new entry: revision 0).
pub fn entry_text(toc: &DiscToc, submission: &Submission, program: &str) -> String {
    let mut out = String::from("# xmcd\n#\n# Track frame offsets:\n");
    for start in &toc.track_starts {
        out.push_str(&format!("#\t{}\n", start + 150));
    }
    out.push_str(&format!(
        "#\n# Disc length: {} seconds\n#\n# Revision: 0\n# Submitted via: {}\n#\n",
        (toc.leadout + 150) / 75,
        clean(program)
    ));
    out.push_str(&format!("DISCID={}\n", discid::cddb_id(toc)));
    let disc_artist = if submission.compilation {
        "Various"
    } else {
        submission.artist.trim()
    };
    field(
        "DTITLE",
        &format!("{} / {}", clean(disc_artist), clean(&submission.album)),
        &mut out,
    );
    if let Some(year) = submission.year {
        out.push_str(&format!("DYEAR={year}\n"));
    }
    if !submission.genre.trim().is_empty() {
        field("DGENRE", &submission.genre, &mut out);
    }
    for (index, (title, artist)) in submission.tracks.iter().enumerate() {
        let text = match artist.as_deref().map(str::trim).filter(|a| !a.is_empty()) {
            Some(a) if submission.compilation || a != submission.artist.trim() => {
                format!("{} / {}", clean(a), clean(title))
            }
            _ => clean(title),
        };
        field(&format!("TTITLE{index}"), &text, &mut out);
    }
    out.push_str("EXTD=\n");
    for index in 0..submission.tracks.len() {
        out.push_str(&format!("EXTT{index}=\n"));
    }
    out.push_str("PLAYORDER=\n");
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    fn toc() -> DiscToc {
        DiscToc {
            track_starts: vec![0, 17_015, 31_777],
            leadout: 43_280,
        }
    }

    fn submission() -> Submission {
        Submission {
            artist: "WitchDoktors".into(),
            album: "Timeless & Dimeless".into(),
            year: Some(2019),
            genre: "Punk".into(),
            tracks: vec![
                ("Voodoo Eye".into(), None),
                ("No Pain No Gain".into(), None),
                ("Dr John".into(), None),
            ],
            compilation: false,
            category: "rock".into(),
            email: "me@example.com".into(),
        }
    }

    #[test]
    fn a_complete_submission_makes_a_gnudb_entry() {
        assert_eq!(problem(&toc(), &submission()), None);
        let text = entry_text(&toc(), &submission(), "MediaVerseStudio 0.1.0");
        let id = discid::cddb_id(&toc());
        assert_eq!(
            text,
            format!(
                "# xmcd\n#\n# Track frame offsets:\n#\t150\n#\t17165\n#\t31927\n#\n# Disc length: 579 seconds\n#\n# Revision: 0\n# Submitted via: MediaVerseStudio 0.1.0\n#\nDISCID={id}\nDTITLE=WitchDoktors / Timeless & Dimeless\nDYEAR=2019\nDGENRE=Punk\nTTITLE0=Voodoo Eye\nTTITLE1=No Pain No Gain\nTTITLE2=Dr John\nEXTD=\nEXTT0=\nEXTT1=\nEXTT2=\nPLAYORDER=\n"
            )
        );
    }

    #[test]
    fn compilations_and_guest_artists_use_the_artist_slash_title_form_and_long_titles_continue() {
        let mut s = submission();
        s.compilation = true;
        s.tracks[0] = ("Song".into(), Some("Band A".into()));
        let text = entry_text(&toc(), &s, "P 1");
        assert!(
            text.contains("DTITLE=Various / Timeless & Dimeless\n")
                && text.contains("TTITLE0=Band A / Song\n"),
            "{text}"
        );
        let mut long = submission();
        long.tracks[1].0 = "é".repeat(200); // 400 bytes
        let text = entry_text(&toc(), &long, "P 1");
        let parts: Vec<&str> = text.lines().filter(|l| l.starts_with("TTITLE1=")).collect();
        assert_eq!(parts.len(), 2, "{parts:?}");
        assert_eq!(
            parts
                .iter()
                .map(|p| p.trim_start_matches("TTITLE1="))
                .collect::<String>(),
            "é".repeat(200)
        );
        assert!(parts.iter().all(|p| p.len() <= 8 + 230));
        // A track by a guest on a one-artist album keeps the guest's name.
        let mut guest = submission();
        guest.tracks[2].1 = Some("Guest".into());
        assert!(entry_text(&toc(), &guest, "P").contains("TTITLE2=Guest / Dr John\n"));
    }

    #[test]
    fn submissions_that_break_gnudbs_rules_are_refused_with_the_reason() {
        let mut s = submission();
        s.email = "not an address".into();
        assert!(problem(&toc(), &s).unwrap().contains("email"));
        for bad in ["a@b", "@x.com", "a@@x.com", "a b@x.com"] {
            s.email = bad.into();
            assert!(problem(&toc(), &s).is_some(), "{bad}");
        }
        let mut s = submission();
        s.tracks[1].0 = "Track 02".into();
        assert!(
            problem(&toc(), &s)
                .unwrap()
                .contains("Track 2 has no real title")
        );
        s.tracks[1].0 = "  ".into();
        assert!(problem(&toc(), &s).is_some());
        let mut s = submission();
        s.tracks.pop();
        assert!(
            problem(&toc(), &s)
                .unwrap()
                .contains("3 tracks but 2 titles")
        );
        let mut s = submission();
        s.category = "punk".into();
        assert!(
            problem(&toc(), &s)
                .unwrap()
                .contains("not a gnudb category")
        );
        let mut s = submission();
        s.album = " ".into();
        assert!(problem(&toc(), &s).is_some());
    }

    #[test]
    fn genres_map_to_the_nearest_category() {
        assert_eq!(category_for("Punk Rock"), "rock");
        assert_eq!(category_for("Reggae"), "reggae");
        assert_eq!(category_for("Ska Punk"), "reggae");
        assert_eq!(category_for("Jazz"), "jazz");
        assert_eq!(category_for("Gabber"), "misc");
        assert_eq!(category_for(""), "misc");
        assert!(CATEGORIES.contains(&category_for("Folk")));
    }
}
