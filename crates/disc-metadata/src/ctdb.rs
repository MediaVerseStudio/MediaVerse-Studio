//! The CUETools Database (CTDB, db.cuetools.net; D107): a free, public-domain database keyed by a disc's table of
//! contents. One request returns metadata for the disc and for discs with a similar layout, gathered from MusicBrainz,
//! Discogs and freedb, which makes it a second chance for a pressing the other sources do not list exactly. The service
//! answers plain HTTP, and 404 means it has no entry. Pure request building and reply reading; the sidecar does the network.
//!
//! The reply is a small XML document; this reads only what is needed with a plain tag scanner (no XML dependency).

use crate::{AlbumInfo, DiscToc, MatchQuality, ReleaseInfo, TrackInfo};

/// The CTDB table-of-contents text: each position is the sector offset minus 150 (our LSN), joined by colons, the lead-out last.
pub fn toc_text(toc: &DiscToc) -> String {
    let mut parts: Vec<String> = toc.track_starts.iter().map(u32::to_string).collect();
    parts.push(toc.leadout.to_string());
    parts.join(":")
}

pub fn lookup_url(toc: &DiscToc) -> String {
    format!(
        "http://db.cuetools.net/lookup2.php?version=3&ctdb=1&fuzzy=1&metadata=extensive&toc={}",
        toc_text(toc)
    )
}

fn decode(text: &str) -> String {
    let mut out = String::with_capacity(text.len());
    let mut rest = text;
    while let Some(at) = rest.find('&') {
        out.push_str(&rest[..at]);
        let tail = &rest[at..];
        let Some(end) = tail.find(';').filter(|e| *e <= 8) else {
            out.push('&');
            rest = &tail[1..];
            continue;
        };
        let entity = &tail[1..end];
        let replacement = match entity {
            "amp" => Some('&'),
            "lt" => Some('<'),
            "gt" => Some('>'),
            "quot" => Some('"'),
            "apos" => Some('\''),
            _ => entity
                .strip_prefix('#')
                .and_then(|n| {
                    n.strip_prefix('x')
                        .map_or_else(|| n.parse().ok(), |h| u32::from_str_radix(h, 16).ok())
                })
                .and_then(char::from_u32),
        };
        match replacement {
            Some(c) => out.push(c),
            None => out.push_str(&tail[..=end]),
        }
        rest = &tail[end + 1..];
    }
    out.push_str(rest);
    out
}

/// One tag: its name, whether it closes (`</x>`), and its attributes.
struct Tag {
    name: String,
    closing: bool,
    attributes: Vec<(String, String)>,
}

fn tags(xml: &str) -> Vec<Tag> {
    let mut found = Vec::new();
    let mut rest = xml;
    while let Some(start) = rest.find('<') {
        let Some(end) = rest[start..].find('>') else {
            break;
        };
        let inside = rest[start + 1..start + end].trim_end_matches('/').trim();
        rest = &rest[start + end + 1..];
        if inside.starts_with('?') || inside.starts_with('!') {
            continue;
        }
        let closing = inside.starts_with('/');
        let inside = inside.trim_start_matches('/');
        let name_end = inside.find(char::is_whitespace).unwrap_or(inside.len());
        let (name, mut attributes_text) = (inside[..name_end].to_owned(), &inside[name_end..]);
        let mut attributes = Vec::new();
        while let Some(eq) = attributes_text.find('=') {
            let key = attributes_text[..eq].trim().to_owned();
            let after = attributes_text[eq + 1..].trim_start();
            let Some(quote) = after.chars().next().filter(|c| *c == '"' || *c == '\'') else {
                break;
            };
            let Some(close) = after[1..].find(quote) else {
                break;
            };
            attributes.push((key, decode(&after[1..1 + close])));
            attributes_text = &after[close + 2..];
        }
        found.push(Tag {
            name,
            closing,
            attributes,
        });
    }
    found
}

fn attribute<'a>(tag: &'a Tag, name: &str) -> &'a str {
    tag.attributes
        .iter()
        .find(|(k, _)| k == name)
        .map_or("", |(_, v)| v.as_str())
}

/// The albums in a CTDB reply whose track list has `track_count` titles. CTDB's own matching is by similar layout, so
/// every album is an inexact match. Albums that came from MusicBrainz keep their MusicBrainz release id (and its cover),
/// Discogs ones their Discogs id; others are named `ctdb:<source>`.
pub fn parse_reply(xml: &str, track_count: usize) -> Vec<AlbumInfo> {
    let mut albums = Vec::new();
    let mut current: Option<(Tag, Vec<Tag>)> = None;
    for tag in tags(xml) {
        match (tag.name.as_str(), tag.closing) {
            ("metadata", false) if !tag.attributes.is_empty() => current = Some((tag, Vec::new())),
            ("metadata", true) => {
                if let Some((meta, children)) = current.take()
                    && let Some(album) = album_from(&meta, &children, track_count)
                {
                    albums.push(album);
                }
            }
            (_, false) => {
                if let Some((_, children)) = current.as_mut() {
                    children.push(tag);
                }
            }
            _ => {}
        }
    }
    albums
}

fn album_from(meta: &Tag, children: &[Tag], track_count: usize) -> Option<AlbumInfo> {
    let (album, artist) = (
        attribute(meta, "album").trim(),
        attribute(meta, "artist").trim(),
    );
    let titles: Vec<&Tag> = children.iter().filter(|c| c.name == "track").collect();
    if album.is_empty()
        || artist.is_empty()
        || titles.len() != track_count
        || titles
            .iter()
            .any(|t| attribute(t, "name").trim().is_empty())
    {
        return None;
    }
    let source = attribute(meta, "source");
    let id = attribute(meta, "id");
    let has_cover = children.iter().any(|c| c.name == "coverart");
    let first = |name: &str| children.iter().find(|c| c.name == name);
    let date = first("release").map_or("", |r| attribute(r, "date"));
    let year = attribute(meta, "year")
        .parse::<u32>()
        .ok()
        .or_else(|| date.get(..4).and_then(|y| y.parse().ok()))
        .filter(|y| (1000..3000).contains(y));
    let disc_count = attribute(meta, "disccount")
        .parse::<u32>()
        .ok()
        .filter(|n| *n > 1);
    let genre = Some(attribute(meta, "genre").trim().to_owned()).filter(|g| !g.is_empty());
    Some(AlbumInfo {
        source: match source {
            "musicbrainz" | "discogs" => source.to_owned(),
            other => format!("ctdb:{other}"),
        },
        source_id: id.to_owned(),
        album: album.to_owned(),
        album_artist: artist.to_owned(),
        year,
        genre,
        tracks: titles
            .iter()
            .enumerate()
            .map(|(index, t)| {
                let own = attribute(t, "artist").trim();
                TrackInfo {
                    number: (index + 1) as u8,
                    title: attribute(t, "name").trim().to_owned(),
                    artist: (!own.is_empty() && own != artist).then(|| own.to_owned()),
                    length_ms: None,
                }
            })
            .collect(),
        quality: MatchQuality::Inexact,
        cover_art_release: (source == "musicbrainz" && has_cover && !id.is_empty())
            .then(|| id.to_owned()),
        disc_number: disc_count.and_then(|_| attribute(meta, "discnumber").parse().ok()),
        disc_count,
        compilation: crate::musicbrainz::is_various_artist(artist),
        release: Some(ReleaseInfo {
            date: date.to_owned(),
            country: first("release")
                .map_or("", |r| attribute(r, "country"))
                .to_owned(),
            label: first("label")
                .map_or("", |l| attribute(l, "name"))
                .to_owned(),
            catalog_number: first("label")
                .map_or("", |l| attribute(l, "catno"))
                .to_owned(),
            barcode: attribute(meta, "barcode").to_owned(),
            format: "CD".to_owned(),
            status: String::new(),
        }),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    // A real reply (trimmed): the disc "Ettella Diamant", asked for with metadata=extensive.
    const REPLY: &str = r#"<ctdb xmlns="http://db.cuetools.net/ns/mmd-1.0#" xmlns:ext="http://db.cuetools.net/ns/ext-1.0#">
 <entry confidence="1" crc32="b5c5fa8d" id="2939607" toc="0:15213:32164:46442:63264:80339:95312" trackcrcs="3298fe20 3dc1e331" />
 <metadata album="Ettella Diamant" artist="Ettella Diamant" barcode="8586010200415" disccount="1" discname="" discnumber="1" id="d3dc4be9-9749-4959-99e5-133d0cb467fe" source="musicbrainz" year="2004">
  <track name="Rysperdal Gstp" />
  <track name="Nicotine" />
  <track name="Genius" />
  <track name="Twilight" />
  <track name="Dunkelheit" />
  <track name="Smog" />
  <label catno="DR E006" name="Deadred Records" />
  <release country="SK" date="2004" />
  <coverart primary="1" uri="http://coverartarchive.org/release/x/1.jpg" />
 </metadata>
 <metadata album="Ettella &amp; Co" artist="Ettella Diamant" barcode="8586010200415" disccount="1" discnumber="1" id="2803893" relevance="74" source="discogs" year="2004">
  <track name="Rysperdal Gstp" artist="Guest" />
  <track name="Nicotine" />
  <track name="Genius" />
  <track name="Twilight" />
  <track name="Dunkelheit" />
  <track name="Smog" />
  <label catno="DR E006" name="Deadred Records" />
  <release country="SK" date="2004" />
 </metadata>
 <metadata album="Short" artist="X" id="1" source="freedb"><track name="Only one" /></metadata>
</ctdb>"#;

    #[test]
    fn the_request_uses_the_toc_minus_the_lead_in() {
        let toc = DiscToc {
            track_starts: vec![0, 17_015, 31_777],
            leadout: 195_738,
        };
        assert_eq!(toc_text(&toc), "0:17015:31777:195738");
        assert_eq!(
            lookup_url(&toc),
            "http://db.cuetools.net/lookup2.php?version=3&ctdb=1&fuzzy=1&metadata=extensive&toc=0:17015:31777:195738"
        );
    }

    #[test]
    fn albums_with_the_right_number_of_titles_are_read_from_the_reply() {
        let albums = parse_reply(REPLY, 6);
        assert_eq!(albums.len(), 2, "the one-track entry is for another disc");
        let (mb, discogs) = (&albums[0], &albums[1]);
        assert_eq!(
            (
                mb.source.as_str(),
                mb.source_id.as_str(),
                mb.album.as_str(),
                mb.year
            ),
            (
                "musicbrainz",
                "d3dc4be9-9749-4959-99e5-133d0cb467fe",
                "Ettella Diamant",
                Some(2004)
            )
        );
        assert_eq!(
            mb.cover_art_release.as_deref(),
            Some("d3dc4be9-9749-4959-99e5-133d0cb467fe")
        );
        assert_eq!(
            mb.release.as_ref().map(|r| (
                r.label.as_str(),
                r.catalog_number.as_str(),
                r.country.as_str(),
                r.barcode.as_str()
            )),
            Some(("Deadred Records", "DR E006", "SK", "8586010200415"))
        );
        assert_eq!(mb.quality, MatchQuality::Inexact);
        assert_eq!(mb.tracks[0].title, "Rysperdal Gstp");
        assert_eq!(
            (
                discogs.source.as_str(),
                discogs.album.as_str(),
                discogs.cover_art_release.clone()
            ),
            ("discogs", "Ettella & Co", None),
            "entities are decoded; Discogs gives no cover"
        );
        assert_eq!(discogs.tracks[0].artist.as_deref(), Some("Guest"));
        assert!(parse_reply(REPLY, 7).is_empty());
        assert_eq!(
            parse_reply(&REPLY.replace("source=\"discogs\"", "source=\"freedb\""), 6)[1].source,
            "ctdb:freedb"
        );
    }

    #[test]
    fn a_reply_without_metadata_or_with_junk_gives_nothing() {
        assert!(parse_reply("<ctdb><entry id=\"1\" /><metadata /></ctdb>", 6).is_empty());
        assert!(parse_reply("not xml at all", 6).is_empty());
        assert!(parse_reply("", 6).is_empty());
    }

    #[test]
    fn entities_are_decoded() {
        assert_eq!(
            decode("A &amp; B &lt;3 &#233; &#x41; &bogus; &"),
            "A & B <3 é A &bogus; &"
        );
    }
}
