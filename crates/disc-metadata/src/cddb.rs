//! The CDDB protocol family (freedb, gnudb, and compatible servers): building queries, and parsing
//! the replies and the track-listing ("xmcd") records.
//!
//! The same commands travel over two transports: plain TCP (CDDBP, usually port 8880) and HTTP
//! (a CGI script, usually port 80). Protocol levels 1-6 differ mainly in text encoding: levels
//! below 6 use ISO-8859-1, level 6 uses UTF-8.
//!
//! These parsers follow the published CDDB protocol description. They have been exercised against
//! the record layout in tests but not yet against a live server, because gnudb rejects
//! applications it does not know (see ADR 0006).

use crate::{AlbumInfo, DiscToc, MatchQuality, TrackInfo};

/// The identification every CDDB client sends: `hello=user host client version`.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Hello {
    pub user: String,
    pub host: String,
    pub client: String,
    pub version: String,
}

/// Whether `text` looks like an email address: one `@`, something on each side, and a dot in the
/// domain. This is the "valid-looking" test gnudb describes, not proof that the address works.
pub fn looks_like_email(text: &str) -> bool {
    let text = text.trim();
    match text.split_once('@') {
        Some((local, domain)) => {
            !local.is_empty()
                && !domain.is_empty()
                && !domain.contains('@')
                && domain.contains('.')
                && !domain.starts_with('.')
                && !domain.ends_with('.')
                && !text.chars().any(char::is_whitespace)
        }
        None => false,
    }
}

impl Hello {
    /// The identification gnudb requires: the user's email address split at the `@` into the user
    /// and host fields, then the application name and version
    /// (`hello=emailname+emailhost.com+applicationname+v0.1`).
    pub fn from_email(email: &str, client: &str, version: &str) -> Result<Self, String> {
        if !looks_like_email(email) {
            return Err(
                "A valid email address is required (for example name@example.com).".to_owned(),
            );
        }
        let (user, host) = email.trim().split_once('@').expect("checked above");
        Ok(Self {
            user: user.to_owned(),
            host: host.to_owned(),
            client: client.to_owned(),
            version: version.to_owned(),
        })
    }

    /// Fields may not contain spaces; replace anything else the protocol would split on.
    fn clean(field: &str) -> String {
        let cleaned: String = field
            .chars()
            .map(|c| {
                if c.is_whitespace() || c.is_control() {
                    '_'
                } else {
                    c
                }
            })
            .collect();
        if cleaned.is_empty() {
            "unknown".to_owned()
        } else {
            cleaned
        }
    }

    pub fn fields(&self) -> String {
        [&self.user, &self.host, &self.client, &self.version]
            .map(|f| Self::clean(f))
            .join(" ")
    }
}

/// `cddb query <id> <tracks> <offset>... <seconds>` with offsets in frames (LSN + 150).
pub fn query_command(toc: &DiscToc, disc_id: &str) -> String {
    let offsets: Vec<String> = toc
        .track_starts
        .iter()
        .map(|start| (start + 150).to_string())
        .collect();
    format!(
        "cddb query {disc_id} {} {} {}",
        toc.track_count(),
        offsets.join(" "),
        toc.seconds()
    )
}

pub fn read_command(category: &str, disc_id: &str) -> String {
    format!("cddb read {category} {disc_id}")
}

/// One disc a server says may match.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Match {
    pub category: String,
    pub disc_id: String,
    /// `Artist / Album` as the server lists it.
    pub title: String,
    pub quality: MatchQuality,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum QueryReply {
    Matches(Vec<Match>),
    NoMatch,
    /// The server refused or failed; the code and its text are kept for the user.
    Failed {
        code: u16,
        message: String,
    },
}

fn status_line(text: &str) -> Option<(u16, &str)> {
    let first = text.lines().next()?.trim();
    let (code, rest) = first.split_once(' ').unwrap_or((first, ""));
    Some((code.parse().ok()?, rest.trim()))
}

fn parse_match(line: &str, quality: MatchQuality) -> Option<Match> {
    let mut parts = line.trim().splitn(3, ' ');
    let (category, disc_id, title) = (parts.next()?, parts.next()?, parts.next().unwrap_or(""));
    if category.is_empty() || disc_id.len() != 8 || !disc_id.bytes().all(|b| b.is_ascii_hexdigit())
    {
        return None;
    }
    Some(Match {
        category: category.to_owned(),
        disc_id: disc_id.to_ascii_lowercase(),
        title: title.trim().to_owned(),
        quality,
    })
}

/// Parses the reply to `cddb query`: 200 (one exact match on the status line), 210 (several exact
/// matches), 211 (inexact matches), 202 (none), anything else is a failure.
pub fn parse_query_reply(text: &str) -> QueryReply {
    let Some((code, rest)) = status_line(text) else {
        return QueryReply::Failed {
            code: 0,
            message: "The server sent an empty or unreadable reply.".to_owned(),
        };
    };
    match code {
        200 => parse_match(rest, MatchQuality::Exact).map_or(
            QueryReply::Failed {
                code,
                message: format!("Unreadable match: {rest}"),
            },
            |m| QueryReply::Matches(vec![m]),
        ),
        210 | 211 => {
            let quality = if code == 210 {
                MatchQuality::Exact
            } else {
                MatchQuality::Inexact
            };
            let matches: Vec<Match> = text
                .lines()
                .skip(1)
                .map(str::trim)
                .take_while(|line| *line != ".")
                .filter_map(|line| parse_match(line, quality))
                .collect();
            if matches.is_empty() {
                QueryReply::NoMatch
            } else {
                QueryReply::Matches(matches)
            }
        }
        202 => QueryReply::NoMatch,
        _ => QueryReply::Failed {
            code,
            message: rest.to_owned(),
        },
    }
}

/// Decodes a reply according to the protocol level: UTF-8 for level 6, otherwise ISO-8859-1
/// (every byte is the code point of the same value).
pub fn decode_text(bytes: &[u8], protocol_level: u8) -> String {
    if protocol_level >= 6 {
        String::from_utf8_lossy(bytes).into_owned()
    } else {
        bytes.iter().map(|&b| char::from(b)).collect()
    }
}

/// Joins repeated `KEY=` lines (long values are split across lines by the format).
fn gather(record: &str, key: &str) -> Option<String> {
    let mut found = false;
    let mut value = String::new();
    for line in record.lines() {
        if let Some(part) = line
            .strip_prefix(key)
            .and_then(|rest| rest.strip_prefix('='))
        {
            found = true;
            value.push_str(part.trim_end_matches('\r'));
        }
    }
    found.then_some(value)
}

/// Reverses the format's escapes: `\n`, `\t` and `\\` in values stand for a newline, a tab and a
/// backslash. Any other backslash sequence is left as written.
fn unescape(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut chars = text.chars();
    while let Some(c) = chars.next() {
        if c != '\\' {
            out.push(c);
            continue;
        }
        match chars.next() {
            Some('n') => out.push('\n'),
            Some('t') => out.push('\t'),
            Some('\\') => out.push('\\'),
            Some(other) => {
                out.push('\\');
                out.push(other);
            }
            None => out.push('\\'),
        }
    }
    out
}

/// The MusicBrainz release id in the first `# Artid:` comment, which gnudb adds for cover art.
fn artid(record: &str) -> Option<String> {
    record
        .lines()
        .filter_map(|line| line.trim().strip_prefix('#')?.trim().strip_prefix("Artid:"))
        .map(|id| id.trim().to_owned())
        .find(|id| !id.is_empty())
}

/// Splits `Artist / Title` (the CDDB convention) at the first ` / `.
fn split_artist(text: &str) -> Option<(&str, &str)> {
    text.split_once(" / ")
        .map(|(artist, title)| (artist.trim(), title.trim()))
}

fn is_various(artist: &str) -> bool {
    matches!(
        artist.trim().to_lowercase().as_str(),
        "various" | "various artists" | "va" | "v.a." | "soundtrack"
    )
}

/// Parses the record returned by `cddb read` (status line 210, then `KEY=value` lines, then `.`).
pub fn parse_record(
    text: &str,
    source: &str,
    category: &str,
    disc_id: &str,
    quality: MatchQuality,
) -> Result<AlbumInfo, String> {
    let body = match status_line(text) {
        Some((210, _)) => text.split_once('\n').map_or("", |(_, rest)| rest),
        Some((code, message)) => return Err(format!("The server answered {code}: {message}")),
        None => return Err("The server sent an empty or unreadable record.".to_owned()),
    };
    let record: String = body
        .lines()
        .take_while(|line| line.trim() != ".")
        .collect::<Vec<_>>()
        .join("\n");

    let cover_art_release = artid(&record);
    let dtitle = gather(&record, "DTITLE")
        .map(|text| unescape(&text))
        .ok_or("The record has no disc title (DTITLE).")?;
    let (album_artist, album) = match split_artist(&dtitle) {
        Some((artist, album)) => (artist.to_owned(), album.to_owned()),
        None => (dtitle.trim().to_owned(), dtitle.trim().to_owned()), // no separator: artist and title are the same text
    };
    let compilation = is_various(&album_artist);

    let mut tracks = Vec::new();
    for number in 0..99 {
        let Some(raw) = gather(&record, &format!("TTITLE{number}")).map(|text| unescape(&text))
        else {
            break;
        };
        let (artist, title) = match split_artist(&raw) {
            Some((artist, title)) if compilation => (Some(artist.to_owned()), title.to_owned()),
            _ => (None, raw.trim().to_owned()),
        };
        tracks.push(TrackInfo {
            number: number as u8 + 1,
            title,
            artist,
            length_ms: None,
        });
    }
    if tracks.is_empty() {
        return Err("The record lists no tracks.".to_owned());
    }

    Ok(AlbumInfo {
        source: source.to_owned(),
        source_id: format!("{category}/{disc_id}"),
        album,
        album_artist,
        year: gather(&record, "DYEAR").and_then(|y| y.trim().parse().ok()),
        genre: gather(&record, "DGENRE")
            .map(|g| unescape(g.trim()))
            .filter(|g| !g.is_empty()),
        tracks,
        quality,
        cover_art_release,
        disc_number: None,
        disc_count: None,
        compilation,
        release: None,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn watchmen() -> DiscToc {
        DiscToc {
            track_starts: vec![
                0, 15770, 32932, 48082, 64527, 79350, 93247, 109050, 125150, 143145, 162400, 182457,
            ],
            leadout: 198_077,
        }
    }

    #[test]
    fn builds_the_query_with_frame_offsets_and_the_length_in_seconds() {
        let query = query_command(&watchmen(), "860a510c");
        assert_eq!(
            query,
            "cddb query 860a510c 12 150 15920 33082 48232 64677 79500 93397 109200 125300 143295 162550 182607 2641"
        );
        assert_eq!(read_command("rock", "860a510c"), "cddb read rock 860a510c");
    }

    #[test]
    fn the_hello_is_the_email_address_split_at_the_at_sign() {
        let hello = Hello::from_email("  alex@example.com ", "MediaVerseStudio", "v0.1").unwrap();
        assert_eq!(hello.fields(), "alex example.com MediaVerseStudio v0.1");
        for bad in [
            "",
            "alex",
            "alex@",
            "@example.com",
            "alex@example",
            "a@b@c.com",
            "kr is@example.com",
            "alex@.com",
            "alex@example.",
        ] {
            assert!(
                Hello::from_email(bad, "App", "1").is_err(),
                "{bad:?} should not look like an email"
            );
        }
        assert!(looks_like_email("first.last+tag@sub.example.co.uk"));
    }

    #[test]
    fn hello_fields_never_contain_spaces() {
        let hello = Hello {
            user: "Alex T".into(),
            host: "my pc".into(),
            client: "MediaVerseStudio".into(),
            version: "0.1".into(),
        };
        assert_eq!(hello.fields(), "Alex_T my_pc MediaVerseStudio 0.1");
        let blank = Hello {
            user: "".into(),
            host: "h".into(),
            client: "c".into(),
            version: "1".into(),
        };
        assert_eq!(blank.fields(), "unknown h c 1");
    }

    #[test]
    fn parses_every_kind_of_query_reply() {
        let exact = parse_query_reply("200 rock 860a510c The Watchmen / Brand New Day\n");
        assert_eq!(
            exact,
            QueryReply::Matches(vec![Match {
                category: "rock".into(),
                disc_id: "860a510c".into(),
                title: "The Watchmen / Brand New Day".into(),
                quality: MatchQuality::Exact
            }])
        );

        let several = parse_query_reply(
            "210 Found exact matches, list follows (until terminating `.')\nrock 860a510c The Watchmen / Brand New Day\nmisc 860A510C Watchmen / Brand New Day (US)\n.\n",
        );
        match several {
            QueryReply::Matches(list) => {
                assert_eq!(list.len(), 2);
                assert_eq!(list[1].disc_id, "860a510c");
                assert!(list.iter().all(|m| m.quality == MatchQuality::Exact));
            }
            other => panic!("{other:?}"),
        }

        let inexact = parse_query_reply(
            "211 Found inexact matches, list follows (until terminating `.')\nrock 860a510d Someone / Something\n.",
        );
        assert!(
            matches!(inexact, QueryReply::Matches(ref l) if l[0].quality == MatchQuality::Inexact)
        );

        assert_eq!(parse_query_reply("202 No match found"), QueryReply::NoMatch);
        assert_eq!(parse_query_reply("211 none\n.\n"), QueryReply::NoMatch);
    }

    #[test]
    fn server_refusals_keep_their_code_and_text() {
        assert_eq!(
            parse_query_reply("500 Unknown application, developer email for MediaVerseStudio 0.1"),
            QueryReply::Failed {
                code: 500,
                message: "Unknown application, developer email for MediaVerseStudio 0.1".into()
            }
        );
        assert!(matches!(
            parse_query_reply("403 Database entry is corrupt"),
            QueryReply::Failed { code: 403, .. }
        ));
        assert!(matches!(
            parse_query_reply(""),
            QueryReply::Failed { code: 0, .. }
        ));
        assert!(matches!(
            parse_query_reply("garbage"),
            QueryReply::Failed { code: 0, .. }
        ));
    }

    const RECORD: &str = "210 rock 860a510c CD database entry follows (until terminating `.')
# xmcd
#
# Track frame offsets:
#\t150
DISCID=860a510c
DTITLE=The Watchmen / Brand New Day
DYEAR=1994
DGENRE=Rock
TTITLE0=Cracks in the Sidewalk
TTITLE1=Stuck in a Car
TTITLE2=Brand New Day
EXTD=
PLAYORDER=
.
";

    #[test]
    fn parses_a_track_listing() {
        let album = parse_record(RECORD, "gnudb", "rock", "860a510c", MatchQuality::Exact).unwrap();
        assert_eq!(album.album_artist, "The Watchmen");
        assert_eq!(album.album, "Brand New Day");
        assert_eq!(album.year, Some(1994));
        assert_eq!(album.genre.as_deref(), Some("Rock"));
        assert_eq!(album.source_id, "rock/860a510c");
        assert_eq!(album.tracks.len(), 3);
        assert_eq!(
            (album.tracks[0].number, album.tracks[0].title.as_str()),
            (1, "Cracks in the Sidewalk")
        );
        assert!(album.tracks.iter().all(|t| t.artist.is_none()));
    }

    #[test]
    fn long_values_split_across_lines_are_joined() {
        let record = "210 ok\nDTITLE=An Artist With A Very Long / An Extremely\nDTITLE=Long Album Title\nTTITLE0=First\nTTITLE0= half and second half\n.\n";
        let album = parse_record(record, "s", "misc", "00000001", MatchQuality::Inexact).unwrap();
        assert_eq!(album.album_artist, "An Artist With A Very Long");
        assert_eq!(album.album, "An ExtremelyLong Album Title");
        assert_eq!(album.tracks[0].title, "First half and second half");
        assert_eq!(album.quality, MatchQuality::Inexact);
    }

    #[test]
    fn escapes_are_decoded_and_the_cover_art_id_is_kept() {
        let record = "210 data 860a8c0c CD database entry follows (until terminating `.')\n# xmcd\n# Cover: https://coverartarchive.org/release/8763f781/x-500.jpg\n# Artid: 8763f781-57b1-4c84-90da-5cb7180873da\n# Cover: https://coverartarchive.org/release/95ade33a/y-500.jpg\n# Artid: 95ade33a-58ff-4466-9d12-239dcdba0ccc\n#\nDISCID=860a8c0c\nDTITLE=Katie Melua / Piece By Piece\nDYEAR=2005\nDGENRE=Pop\nTTITLE0=Shy Boy\nTTITLE1=Back\\\\slash and a\\ttab\nTTITLE2=Two\\nlines\nEXTD= YEAR: 2005\nEXTT0=\nPLAYORDER=\n.\n";
        let album = parse_record(record, "gnudb", "data", "860a8c0c", MatchQuality::Exact).unwrap();
        assert_eq!(
            album.cover_art_release.as_deref(),
            Some("8763f781-57b1-4c84-90da-5cb7180873da"),
            "the first Artid wins"
        );
        assert_eq!(album.tracks[1].title, "Back\\slash and a\ttab");
        assert_eq!(album.tracks[2].title, "Two\nlines");
        assert_eq!(album.source_id, "data/860a8c0c");
        assert_eq!(album.year, Some(2005));
    }

    #[test]
    fn unknown_escapes_are_left_alone() {
        assert_eq!(unescape("a\\qb\\"), "a\\qb\\");
        assert_eq!(unescape("plain"), "plain");
    }

    #[test]
    fn compilations_get_per_track_artists() {
        let record = "210 ok\nDTITLE=Various Artists / Hits Of The Day\nTTITLE0=Band A / Song One\nTTITLE1=Band B / Song / Two\n.\n";
        let album = parse_record(record, "s", "misc", "00000002", MatchQuality::Exact).unwrap();
        assert_eq!(album.tracks[0].artist.as_deref(), Some("Band A"));
        assert_eq!(album.tracks[0].title, "Song One");
        assert_eq!(album.tracks[1].title, "Song / Two");

        // The same text on an ordinary album is just a title with a slash in it.
        let normal = "210 ok\nDTITLE=Some Band / Some Album\nTTITLE0=AC / DC Tribute\n.\n";
        let album = parse_record(normal, "s", "misc", "00000003", MatchQuality::Exact).unwrap();
        assert_eq!(album.tracks[0].title, "AC / DC Tribute");
        assert_eq!(album.tracks[0].artist, None);
    }

    #[test]
    fn bad_records_are_errors_not_empty_albums() {
        assert!(
            parse_record(
                "401 Specified CDDB entry not found.",
                "s",
                "c",
                "00000000",
                MatchQuality::Exact
            )
            .is_err()
        );
        assert!(
            parse_record(
                "210 ok\nDYEAR=1999\n.\n",
                "s",
                "c",
                "00000000",
                MatchQuality::Exact
            )
            .is_err()
        );
        assert!(
            parse_record(
                "210 ok\nDTITLE=A / B\n.\n",
                "s",
                "c",
                "00000000",
                MatchQuality::Exact
            )
            .is_err()
        );
        assert!(parse_record("", "s", "c", "00000000", MatchQuality::Exact).is_err());
    }

    #[test]
    fn decodes_by_protocol_level() {
        let latin1 = [b'C', b'a', b'f', 0xE9]; // "Café" in ISO-8859-1
        assert_eq!(decode_text(&latin1, 5), "Café");
        assert_eq!(decode_text("Café".as_bytes(), 6), "Café");
        assert!(
            decode_text(&latin1, 6).contains('\u{FFFD}'),
            "invalid UTF-8 is replaced, not trusted"
        );
    }
}
