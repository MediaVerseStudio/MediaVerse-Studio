//! MusicBrainz: building the disc lookup request and reading its reply.
//!
//! The service rules (https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting): every request
//! needs a User-Agent of the form `Application/version ( contact )`, and one source IP may make
//! about one request per second; excess requests get HTTP 503. Those rules are enforced by the
//! sidecar (see `rate`); this module only builds the request and parses the reply.

use crate::{AlbumInfo, MatchQuality, ReleaseInfo, TrackInfo};
use serde_json::Value;

/// `<base>/ws/2/discid/<id>?inc=...&fmt=json`, with a trailing slash on `base` tolerated.
pub fn discid_url(base: &str, disc_id: &str) -> String {
    format!(
        "{}/ws/2/discid/{}?inc=artist-credits+labels+recordings+release-groups+genres&fmt=json",
        base.trim_end_matches('/'),
        disc_id
    )
}

/// A fuzzy search by table of contents (ADR 0009): `<base>/ws/2/discid/-?toc=1+N+leadout+offsets…`, offsets
/// as MusicBrainz counts them (LSN + 150). Used for files, whose disc ID is unknown; MusicBrainz then lists
/// releases with a medium of the same track count and similar track lengths. Genres come with it.
pub fn toc_search_url(base: &str, toc: &crate::DiscToc) -> String {
    let mut parts = vec![
        "1".to_owned(),
        toc.track_count().to_string(),
        (toc.leadout + 150).to_string(),
    ];
    parts.extend(
        toc.track_starts
            .iter()
            .map(|start| (start + 150).to_string()),
    );
    format!(
        "{}/ws/2/discid/-?toc={}&cdstubs=no&inc=artist-credits+labels+recordings+release-groups+genres&fmt=json",
        base.trim_end_matches('/'),
        parts.join("+")
    )
}

fn lucene_phrase(text: &str) -> String {
    let clean: String = text
        .chars()
        .map(|c| if c == '"' || c == '\\' { ' ' } else { c })
        .collect();
    format!("\"{}\"", clean.trim())
}

/// Percent-encodes a query-string value (RFC 3986 unreserved characters kept). One encoder for every
/// request this program builds, so a title cannot be read as part of the address.
pub fn percent_encode(text: &str) -> String {
    let mut out = String::new();
    for byte in text.bytes() {
        match byte {
            b'A'..=b'Z' | b'a'..=b'z' | b'0'..=b'9' | b'-' | b'.' | b'_' | b'~' => {
                out.push(byte as char)
            }
            other => out.push_str(&format!("%{other:02X}")),
        }
    }
    out
}

fn url_encode(text: &str) -> String {
    percent_encode(text)
}

/// A search for releases by album title and (when known) artist, for a disc MusicBrainz does not know by its disc ID.
pub fn search_url(base: &str, artist: &str, album: &str) -> String {
    let mut query = format!("release:{}", lucene_phrase(album));
    if !artist.trim().is_empty() {
        query.push_str(&format!(" AND artist:{}", lucene_phrase(artist)));
    }
    format!(
        "{}/ws/2/release/?query={}&limit=30&fmt=json",
        base.trim_end_matches('/'),
        url_encode(&query)
    )
}

/// One release with everything the lookup needs (the same data a disc ID lookup returns).
pub fn release_url(base: &str, release_id: &str) -> String {
    format!(
        "{}/ws/2/release/{}?inc=artist-credits+labels+recordings+release-groups+genres&fmt=json",
        base.trim_end_matches('/'),
        url_encode(release_id)
    )
}

/// The ids of releases in a search reply that have a medium of exactly `track_count` tracks, best score first and
/// official releases ahead of the rest, at most `limit`.
pub fn search_hits(json: &str, track_count: usize, limit: usize) -> Result<Vec<String>, String> {
    let root: Value =
        serde_json::from_str(json).map_err(|e| format!("MusicBrainz sent unreadable data: {e}"))?;
    if let Some(error) = root["error"].as_str() {
        return Err(format!("MusicBrainz said: {error}"));
    }
    let mut hits: Vec<(bool, u64, String)> = root["releases"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| {
            r["media"].as_array().is_some_and(|media| {
                media
                    .iter()
                    .any(|m| m["track-count"].as_u64() == Some(track_count as u64))
            })
        })
        .filter_map(|r| {
            Some((
                r["status"] == "Official",
                r["score"].as_u64().unwrap_or(0),
                r["id"].as_str()?.to_owned(),
            ))
        })
        .collect();
    hits.sort_by(|a, b| b.0.cmp(&a.0).then(b.1.cmp(&a.1)));
    Ok(hits.into_iter().take(limit).map(|h| h.2).collect())
}

/// A single release (from `release_url`) as an album for the medium that has `track_count` tracks. The disc is not
/// listed on the release, so the match is never exact.
pub fn parse_release_response(json: &str, track_count: usize) -> Result<Vec<AlbumInfo>, String> {
    let mut release: Value =
        serde_json::from_str(json).map_err(|e| format!("MusicBrainz sent unreadable data: {e}"))?;
    if let Some(error) = release["error"].as_str() {
        return Err(format!("MusicBrainz said: {error}"));
    }
    let media: Vec<Value> = release["media"].as_array().cloned().unwrap_or_default();
    let Some(medium) = media
        .iter()
        .find(|m| {
            m["tracks"]
                .as_array()
                .is_some_and(|t| t.len() == track_count)
        })
        .cloned()
    else {
        return Ok(Vec::new());
    };
    // Keep every medium's count so a multi-disc release is still recognised, but put the matching one first.
    let mut ordered = vec![medium.clone()];
    ordered.extend(media.into_iter().filter(|m| *m != medium));
    release["media"] = Value::Array(ordered);
    parse_discid_response(
        &serde_json::json!({ "releases": [release] }).to_string(),
        "-no-such-disc-",
    )
}

/// The required header value, for example `MediaVerseStudio/0.1 ( me@example.com )`.
pub fn user_agent(app: &str, version: &str, contact: &str) -> String {
    format!("{app}/{version} ( {contact} )")
}

/// The artist-credit list as MusicBrainz displays it: names joined by their join phrases.
fn credit_text(credit: &Value) -> String {
    credit
        .as_array()
        .map(|parts| {
            parts
                .iter()
                .map(|part| {
                    let name = part["name"]
                        .as_str()
                        .or_else(|| part["artist"]["name"].as_str())
                        .unwrap_or("");
                    format!("{name}{}", part["joinphrase"].as_str().unwrap_or(""))
                })
                .collect::<String>()
        })
        .unwrap_or_default()
        .trim()
        .to_owned()
}

/// "Various Artists" and its common spellings.
pub fn is_various_artist(name: &str) -> bool {
    matches!(
        name.trim().to_lowercase().as_str(),
        "various" | "various artists" | "va" | "v.a." | "[various artists]"
    )
}

/// The edition's details from a MusicBrainz release (and the medium the disc is on).
fn release_info(release: &Value, medium: &Value) -> ReleaseInfo {
    let text = |value: &Value| value.as_str().unwrap_or_default().trim().to_owned();
    let label = release["label-info"].as_array().and_then(|labels| {
        labels
            .iter()
            .find(|l| l["label"]["name"].is_string())
            .or_else(|| labels.first())
    });
    ReleaseInfo {
        date: text(&release["date"]),
        country: text(&release["country"]),
        label: label.map(|l| text(&l["label"]["name"])).unwrap_or_default(),
        catalog_number: label
            .map(|l| text(&l["catalog-number"]))
            .unwrap_or_default(),
        barcode: text(&release["barcode"]),
        format: text(&medium["format"]),
        status: text(&release["status"]),
    }
}

/// The album's most-voted genre ("punk rock" becomes "Punk Rock"), from the release group's genres or the release's own.
fn top_genre(release: &Value) -> Option<String> {
    let list = release["release-group"]["genres"]
        .as_array()
        .or_else(|| release["genres"].as_array())?;
    let best = list
        .iter()
        .filter_map(|g| Some((g["name"].as_str()?.trim(), g["count"].as_u64().unwrap_or(0))))
        .filter(|(name, _)| !name.is_empty())
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(a.0)))?;
    Some(
        best.0
            .split_whitespace()
            .map(|word| {
                word.split('-')
                    .map(|part| {
                        part.chars().next().map_or(String::new(), |c| {
                            c.to_uppercase().collect::<String>() + &part[c.len_utf8()..]
                        })
                    })
                    .collect::<Vec<_>>()
                    .join("-")
            })
            .collect::<Vec<_>>()
            .join(" "),
    )
}

fn year_of(date: &str) -> Option<u32> {
    date.get(..4)
        .and_then(|y| y.parse().ok())
        .filter(|y| *y > 1000)
}

/// Reads the reply to a disc lookup into one album per matching release.
///
/// For multi-disc releases the medium that carries `disc_id` is used; its track positions are the
/// numbers on that disc. Returns an error for an unreadable reply or a reply that is an error
/// document (an unknown disc id is HTTP 404 and never reaches this function).
pub fn parse_discid_response(json: &str, disc_id: &str) -> Result<Vec<AlbumInfo>, String> {
    let root: Value =
        serde_json::from_str(json).map_err(|e| format!("MusicBrainz sent unreadable data: {e}"))?;
    if let Some(error) = root["error"].as_str() {
        return Err(format!("MusicBrainz said: {error}"));
    }
    let releases = root["releases"]
        .as_array()
        .ok_or("MusicBrainz sent no release list.")?;

    let mut albums = Vec::new();
    for release in releases {
        let media = release["media"].as_array().cloned().unwrap_or_default();
        let by_disc = media.iter().find(|medium| {
            medium["discs"].as_array().is_some_and(|discs| {
                discs
                    .iter()
                    .any(|disc| disc["id"].as_str() == Some(disc_id))
            })
        });
        let quality = if by_disc.is_some() {
            MatchQuality::Exact
        } else {
            MatchQuality::Inexact
        };
        let Some(medium) = by_disc.or_else(|| media.first()) else {
            continue;
        };
        let disc_number = medium["position"].as_u64().map(|n| n as u32);
        let disc_count = (media.len() > 1).then_some(media.len() as u32);

        let album_artist = credit_text(&release["artist-credit"]);
        let tracks: Vec<TrackInfo> = medium["tracks"]
            .as_array()
            .map(|tracks| {
                tracks
                    .iter()
                    .enumerate()
                    .map(|(index, track)| {
                        let title = track["title"]
                            .as_str()
                            .or_else(|| track["recording"]["title"].as_str())
                            .unwrap_or("")
                            .to_owned();
                        let artist = credit_text(&track["artist-credit"]);
                        TrackInfo {
                            number: track["position"]
                                .as_u64()
                                .map_or(index as u8 + 1, |n| n as u8),
                            title,
                            artist: (!artist.is_empty() && artist != album_artist)
                                .then_some(artist),
                            length_ms: track["length"]
                                .as_u64()
                                .or_else(|| track["recording"]["length"].as_u64())
                                .and_then(|ms| u32::try_from(ms).ok())
                                .filter(|ms| *ms > 0),
                        }
                    })
                    .collect()
            })
            .unwrap_or_default();
        if tracks.is_empty() {
            continue;
        }

        // Only genuine "Various Artists" albums are flagged. MusicBrainz also labels one artist's
        // best-of collections "Compilation", but flagging those would file them under compilations in
        // players that follow the Navidrome rules, which is not what a one-artist album should do.
        let compilation = is_various_artist(&album_artist);
        let id = release["id"].as_str().unwrap_or_default().to_owned();
        albums.push(AlbumInfo {
            source: "musicbrainz".to_owned(),
            source_id: id.clone(),
            album: release["title"].as_str().unwrap_or("").to_owned(),
            album_artist,
            year: release["date"].as_str().and_then(year_of).or_else(|| {
                release["release-group"]["first-release-date"]
                    .as_str()
                    .and_then(year_of)
            }),
            genre: top_genre(release),
            tracks,
            quality,
            cover_art_release: (release["cover-art-archive"]["front"] == true && !id.is_empty())
                .then_some(id),
            disc_number: if disc_count.is_some() {
                disc_number
            } else {
                None
            },
            disc_count,
            compilation,
            release: Some(release_info(release, medium)),
        });
    }
    Ok(albums)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_toc_rebuilt_from_file_lengths_makes_a_fuzzy_search_url() {
        // Three files of 3:00.000, 4:00.010 and 2:00.500: 13500, 18001 (rounded) and 9038 sectors (rounded).
        let toc = crate::DiscToc::from_track_lengths(&[180_000, 240_010, 120_500]).unwrap();
        assert_eq!(toc.track_starts, vec![0, 13_500, 31_501]);
        assert_eq!(toc.leadout, 31_501 + 9_038);
        let url = toc_search_url("https://musicbrainz.org/", &toc);
        assert!(
            url.starts_with(
                "https://musicbrainz.org/ws/2/discid/-?toc=1+3+40689+150+13650+31651&cdstubs=no"
            ),
            "{url}"
        );
        assert!(url.contains("genres"));
        assert!(crate::DiscToc::from_track_lengths(&[]).is_none());
        assert!(crate::DiscToc::from_track_lengths(&[1_000; 100]).is_none());
    }

    #[test]
    fn a_name_search_finds_releases_with_the_discs_track_count_and_reads_them_as_inexact() {
        assert_eq!(
            search_url("https://musicbrainz.org/", "Random Hand", "Random Hand"),
            "https://musicbrainz.org/ws/2/release/?query=release%3A%22Random%20Hand%22%20AND%20artist%3A%22Random%20Hand%22&limit=30&fmt=json"
        );
        assert!(
            search_url("https://x", "", "A \"quoted\" title")
                .contains("release%3A%22A%20%20quoted%20%20title%22&limit")
        );
        let reply = r#"{"releases":[
          {"id":"bootleg","score":100,"status":"Bootleg","media":[{"track-count":10}]},
          {"id":"twelve","score":100,"status":"Official","media":[{"track-count":12}]},
          {"id":"official-low","score":80,"status":"Official","media":[{"track-count":10}]},
          {"id":"official-high","score":95,"status":"Official","media":[{"track-count":10}]}]}"#;
        assert_eq!(
            search_hits(reply, 10, 5).unwrap(),
            ["official-high", "official-low", "bootleg"]
        );
        assert_eq!(search_hits(reply, 10, 1).unwrap(), ["official-high"]);
        assert!(search_hits(r#"{"error":"nope"}"#, 10, 5).is_err());

        let release = r#"{"id":"r1","title":"Self Titled","date":"2023-09-29","status":"Official","artist-credit":[{"name":"Band","joinphrase":""}],
          "media":[{"position":1,"tracks":[{"position":1,"title":"Only"}]},{"position":2,"tracks":[{"position":1,"title":"A"},{"position":2,"title":"B"}]}]}"#;
        let albums = parse_release_response(release, 2).unwrap();
        assert_eq!(
            (
                albums[0].album.as_str(),
                albums[0].tracks.len(),
                albums[0].quality
            ),
            ("Self Titled", 2, MatchQuality::Inexact)
        );
        assert_eq!(albums[0].year, Some(2023));
        assert!(
            parse_release_response(release, 7).unwrap().is_empty(),
            "no medium of that length"
        );
    }

    const WATCHMEN: &str = include_str!("../tests/fixtures/musicbrainz-watchmen.json");
    const OPERATION_IVY: &str = include_str!("../tests/fixtures/musicbrainz-operation-ivy.json");

    #[test]
    fn builds_the_request_url_and_user_agent() {
        assert_eq!(
            discid_url("https://musicbrainz.org/", "abc-"),
            "https://musicbrainz.org/ws/2/discid/abc-?inc=artist-credits+labels+recordings+release-groups+genres&fmt=json"
        );
        assert_eq!(
            user_agent("MediaVerseStudio", "0.1", "me@example.com"),
            "MediaVerseStudio/0.1 ( me@example.com )"
        );
    }

    #[test]
    fn reads_the_real_response_for_the_watchmen_disc() {
        let albums = parse_discid_response(WATCHMEN, "C9Ixgq666BRi1vBlyVjf1Bwd1e8-").unwrap();
        assert_eq!(albums.len(), 1);
        let album = &albums[0];
        assert_eq!(album.source, "musicbrainz");
        assert_eq!(album.album, "Brand New Day");
        assert_eq!(album.album_artist, "The Watchmen");
        assert_eq!(album.year, Some(1996));
        assert_eq!(album.quality, MatchQuality::Exact);
        assert_eq!(
            (album.disc_number, album.disc_count, album.compilation),
            (None, None, false),
            "a single-disc album"
        );
        assert_eq!(album.source_id, "84ab68ed-29fe-49af-9145-dbb9de093b7f");
        assert_eq!(album.tracks.len(), 12);
        assert_eq!(
            (album.tracks[0].number, album.tracks[0].title.as_str()),
            (1, "Zoom")
        );
        assert!(
            album.tracks.iter().all(|t| t.artist.is_none()),
            "a single-artist album has no per-track artists"
        );
        assert!(
            album
                .tracks
                .windows(2)
                .all(|w| w[1].number == w[0].number + 1)
        );
    }

    #[test]
    fn reads_the_real_response_for_the_operation_ivy_disc() {
        let albums = parse_discid_response(OPERATION_IVY, "iDRhOllRt7Not_cT3AlBv8ZH.6c-").unwrap();
        assert_eq!(albums.len(), 1);
        assert_eq!(albums[0].album, "Operation Ivy");
        assert_eq!(albums[0].album_artist, "Operation Ivy");
        assert_eq!(albums[0].year, Some(2007));
        assert_eq!(albums[0].tracks.len(), 27);
        assert_eq!(albums[0].tracks[0].title, "Knowledge");
        assert_eq!(albums[0].quality, MatchQuality::Exact);
    }

    #[test]
    fn a_one_artist_best_of_is_not_flagged_as_a_compilation_but_various_artists_is() {
        let best_of = r#"{"releases":[{"id":"r","title":"Greatest Hits","artist-credit":[{"name":"One Band","joinphrase":""}],
            "release-group":{"secondary-types":["Compilation"]},"media":[{"discs":[{"id":"D"}],"tracks":[{"position":1,"title":"A"}]}]}]}"#;
        assert!(!parse_discid_response(best_of, "D").unwrap()[0].compilation);
        let various = best_of.replace("One Band", "Various Artists");
        assert!(parse_discid_response(&various, "D").unwrap()[0].compilation);
    }

    #[test]
    fn a_different_disc_id_makes_the_match_inexact_not_missing() {
        let albums = parse_discid_response(WATCHMEN, "some-other-disc-id-------").unwrap();
        assert_eq!(albums[0].quality, MatchQuality::Inexact);
    }

    #[test]
    fn multi_artist_credits_and_track_artists_are_joined_and_kept() {
        let json = r#"{"releases":[{"id":"r1","title":"Collab","date":"2001-05","artist-credit":[
            {"name":"A","joinphrase":" & ","artist":{"name":"A"}},{"name":"B","joinphrase":"","artist":{"name":"B"}}],
          "media":[{"discs":[{"id":"D"}],"tracks":[
            {"position":1,"title":"One","artist-credit":[{"name":"A","joinphrase":" & "},{"name":"B","joinphrase":""}]},
            {"position":2,"title":"Two","artist-credit":[{"name":"Guest","joinphrase":""}]}]}]}]}"#;
        let album = &parse_discid_response(json, "D").unwrap()[0];
        assert_eq!(album.album_artist, "A & B");
        assert_eq!(album.year, Some(2001));
        assert_eq!(album.tracks[0].artist, None);
        assert_eq!(album.tracks[1].artist.as_deref(), Some("Guest"));
    }

    #[test]
    fn the_medium_carrying_the_disc_id_is_the_one_used() {
        let json = r#"{"releases":[{"id":"r","title":"Two Discs","artist-credit":[{"name":"X","joinphrase":""}],"media":[
            {"discs":[{"id":"FIRST"}],"tracks":[{"position":1,"title":"CD1 song"}]},
            {"discs":[{"id":"SECOND"}],"tracks":[{"position":1,"title":"CD2 song"},{"position":2,"title":"CD2 b"}]}]}]}"#;
        let album = &parse_discid_response(json, "SECOND").unwrap()[0];
        assert_eq!(
            (album.disc_number, album.disc_count),
            (None, Some(2)),
            "this json has no medium position, so the disc number is unknown"
        );
        assert_eq!(album.tracks.len(), 2);
        assert_eq!(album.tracks[0].title, "CD2 song");
        assert_eq!(album.quality, MatchQuality::Exact);
    }

    #[test]
    fn the_edition_details_come_from_the_release_and_its_medium() {
        let release = serde_json::json!({ "date": "1998-03-02", "country": "GB", "barcode": "0123", "status": "Official", "label-info": [{ "catalog-number": "ABC 1", "label": { "name": "Hellcat" } }] });
        let info = release_info(&release, &serde_json::json!({ "format": "CD" }));
        assert_eq!(
            (
                info.date.as_str(),
                info.country.as_str(),
                info.label.as_str(),
                info.catalog_number.as_str(),
                info.barcode.as_str(),
                info.format.as_str(),
                info.status.as_str()
            ),
            (
                "1998-03-02",
                "GB",
                "Hellcat",
                "ABC 1",
                "0123",
                "CD",
                "Official"
            )
        );
        assert_eq!(
            release_info(&serde_json::json!({}), &serde_json::json!({})),
            ReleaseInfo::default()
        );
    }

    #[test]
    fn the_most_voted_genre_is_used_in_title_case() {
        let release = serde_json::json!({ "release-group": { "genres": [{ "name": "ska", "count": 2 }, { "name": "punk rock", "count": 9 }, { "name": "post-punk", "count": 9 }] } });
        // Equal votes: the name that sorts first.
        assert_eq!(top_genre(&release).as_deref(), Some("Post-Punk"));
        assert_eq!(
            top_genre(&serde_json::json!({ "genres": [{ "name": "punk rock", "count": 3 }] }))
                .as_deref(),
            Some("Punk Rock")
        );
        assert_eq!(top_genre(&serde_json::json!({})), None);
    }

    #[test]
    fn track_lengths_are_read_from_the_track_or_its_recording() {
        let reply = r#"{"releases":[{"id":"r1","title":"A","artist-credit":[{"name":"B","joinphrase":""}],"media":[{"position":1,"discs":[{"id":"D"}],"tracks":[
          {"position":1,"title":"One","length":201500},{"position":2,"title":"Two","recording":{"length":180000}},{"position":3,"title":"Three","length":null}]}]}]}"#;
        let found = parse_discid_response(reply, "D").unwrap();
        assert_eq!(
            found[0]
                .tracks
                .iter()
                .map(|t| t.length_ms)
                .collect::<Vec<_>>(),
            [Some(201_500), Some(180_000), None]
        );
    }

    #[test]
    fn errors_and_junk_are_reported_not_swallowed() {
        assert!(parse_discid_response("not json", "x").is_err());
        assert!(
            parse_discid_response(r#"{"error":"Not found"}"#, "x")
                .unwrap_err()
                .contains("Not found")
        );
        assert!(parse_discid_response(r#"{"nothing":1}"#, "x").is_err());
        assert_eq!(
            parse_discid_response(r#"{"releases":[]}"#, "x").unwrap(),
            vec![]
        );
        // A release with no tracks is skipped rather than producing an empty album.
        let empty = r#"{"releases":[{"id":"r","title":"T","media":[{"discs":[],"tracks":[]}]}]}"#;
        assert_eq!(parse_discid_response(empty, "x").unwrap(), vec![]);
    }
}
