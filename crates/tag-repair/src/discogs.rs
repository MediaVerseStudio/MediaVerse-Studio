//! Releases as Discogs describes them (`GET /releases/{id}`), in the same shape as MusicBrainz's so the matcher
//! treats both alike. Only Discogs' CC0 catalogue data is read (titles, artists, track lists with durations,
//! dates, labels, identifiers, formats), plus genres and styles; never images (API Terms of Use, ADR 0009).

use crate::musicbrainz::{Medium, Release, ReleaseTrack};
use serde_json::Value;

/// "Nirvana (2)" → "Nirvana": Discogs numbers artists who share a name.
fn artist_name(name: &str) -> String {
    let name = name.trim();
    if let Some(open) = name.rfind(" (")
        && name.ends_with(')')
        && name[open + 2..name.len() - 1]
            .chars()
            .all(|c| c.is_ascii_digit())
    {
        return name[..open].to_owned();
    }
    name.to_owned()
}

/// "Artist", "Artist & Other", with Discogs' join words.
fn artists(value: &Value) -> String {
    let Some(list) = value.as_array() else {
        return String::new();
    };
    let mut out = String::new();
    for (i, artist) in list.iter().enumerate() {
        let shown = artist["anv"]
            .as_str()
            .filter(|a| !a.is_empty())
            .or_else(|| artist["name"].as_str())
            .unwrap_or_default();
        out.push_str(&artist_name(shown));
        let join = artist["join"].as_str().unwrap_or("").trim();
        if i + 1 < list.len() {
            out.push_str(if join.is_empty() || join == "," {
                ", "
            } else {
                ""
            });
            if !join.is_empty() && join != "," {
                out.push(' ');
                out.push_str(join);
                out.push(' ');
            }
        }
    }
    out.trim().to_owned()
}

/// "4:31" or "1:02:03" → milliseconds.
fn duration_ms(text: &str) -> Option<u64> {
    let parts: Vec<u64> = text
        .trim()
        .split(':')
        .map(|p| p.trim().parse().ok())
        .collect::<Option<_>>()?;
    let seconds = parts.iter().fold(0u64, |total, part| total * 60 + part);
    (seconds > 0).then_some(seconds * 1000)
}

/// The disc a track position belongs to: "2-5", "CD2-5" and "2.5" are disc 2; "5" and vinyl sides ("A1") are 1.
fn disc_of(position: &str) -> u32 {
    let position = position
        .trim()
        .trim_start_matches(|c: char| c.is_ascii_alphabetic() && c != 'A' && c != 'B');
    for separator in ['-', '.'] {
        if let Some((disc, _)) = position.split_once(separator)
            && let Ok(number) = disc
                .trim_start_matches(|c: char| c.is_ascii_alphabetic())
                .parse::<u32>()
        {
            return number.max(1);
        }
    }
    1
}

/// One Discogs release; `None` when it has no tracks.
pub fn parse_release(json: &str) -> Result<Option<Release>, String> {
    let value: Value =
        serde_json::from_str(json).map_err(|e| format!("Discogs sent unreadable data: {e}"))?;
    if let Some(message) = value["message"].as_str()
        && value["id"].is_null()
    {
        return Err(format!("Discogs said: {message}"));
    }
    let album_artist = artists(&value["artists"]);
    let mut tracks: Vec<(u32, ReleaseTrack)> = Vec::new();
    let mut add = |track: &Value| {
        let title = track["title"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_owned();
        if title.is_empty() {
            return;
        }
        let own = artists(&track["artists"]);
        let position = track["position"].as_str().unwrap_or_default();
        tracks.push((
            disc_of(position),
            ReleaseTrack {
                number: 0,
                title,
                artist: if own.is_empty() || own == album_artist {
                    String::new()
                } else {
                    own
                },
                length_ms: track["duration"].as_str().and_then(duration_ms),
                recording_id: String::new(),
            },
        ));
    };
    for track in value["tracklist"].as_array().into_iter().flatten() {
        match track["type_"].as_str().unwrap_or("track") {
            "track" => add(track),
            "index" => track["sub_tracks"]
                .as_array()
                .into_iter()
                .flatten()
                .for_each(&mut add),
            _ => {} // headings
        }
    }
    if tracks.is_empty() {
        return Ok(None);
    }
    let format = value["formats"]
        .as_array()
        .and_then(|f| f.first())
        .and_then(|f| f["name"].as_str())
        .unwrap_or_default()
        .to_owned();
    let mut media: Vec<Medium> = Vec::new();
    for (disc, mut track) in tracks {
        if media.last().is_none_or(|m| m.position != disc) {
            media.push(Medium {
                position: disc,
                format: format.clone(),
                tracks: Vec::new(),
            });
        }
        let medium = media.last_mut().expect("just pushed");
        track.number = medium.tracks.len() as u32 + 1;
        medium.tracks.push(track);
    }
    let label = value["labels"].as_array().and_then(|l| l.first());
    let barcode = value["identifiers"]
        .as_array()
        .and_then(|ids| ids.iter().find(|id| id["type"].as_str() == Some("Barcode")))
        .and_then(|id| id["value"].as_str())
        .map(|b| b.chars().filter(char::is_ascii_digit).collect::<String>())
        .unwrap_or_default();
    let strings = |key: &str| -> Vec<String> {
        value[key]
            .as_array()
            .map(|a| {
                a.iter()
                    .filter_map(|v| v.as_str().map(ToOwned::to_owned))
                    .collect()
            })
            .unwrap_or_default()
    };
    // Styles are the more specific ("Punk", "Hardcore"); genres the broad ("Rock").
    let mut genres = strings("styles");
    genres.extend(strings("genres"));
    let date = value["released"]
        .as_str()
        .map(|d| d.replace("-00", ""))
        .filter(|d| !d.is_empty())
        .or_else(|| {
            value["year"]
                .as_u64()
                .filter(|y| *y > 0)
                .map(|y| y.to_string())
        })
        .unwrap_or_default();
    let id = value["id"].as_u64().unwrap_or(0);
    Ok(Some(Release {
        id: format!("discogs:{id}"),
        title: value["title"]
            .as_str()
            .unwrap_or_default()
            .trim()
            .to_owned(),
        artist: album_artist,
        date,
        country: value["country"].as_str().unwrap_or_default().to_owned(),
        barcode,
        label: label
            .and_then(|l| l["name"].as_str())
            .map(artist_name)
            .unwrap_or_default(),
        catalog_number: label
            .and_then(|l| l["catno"].as_str())
            .filter(|c| *c != "none")
            .unwrap_or_default()
            .to_owned(),
        release_group_id: value["master_id"]
            .as_u64()
            .map(|m| format!("discogs-master:{m}"))
            .unwrap_or_default(),
        first_release_date: String::new(),
        genres,
        media,
        source: "discogs".into(),
        url: value["uri"]
            .as_str()
            .map(ToOwned::to_owned)
            .unwrap_or_else(|| format!("https://www.discogs.com/release/{id}")),
    }))
}

/// Release ids from a database search (`GET /database/search?type=release&...`), best first.
pub fn search_ids(json: &str) -> Result<Vec<u64>, String> {
    let value: Value =
        serde_json::from_str(json).map_err(|e| format!("Discogs sent unreadable data: {e}"))?;
    Ok(value["results"]
        .as_array()
        .map(|results| results.iter().filter_map(|r| r["id"].as_u64()).collect())
        .unwrap_or_default())
}

#[cfg(test)]
mod tests {
    use super::*;

    const RELEASE: &str = r#"{
        "id": 123, "title": "Pow Wow Punk Rock 2", "artists": [{"name": "1876 (2)", "anv": "", "join": ""}],
        "released": "2001-00-00", "year": 2001, "country": "US",
        "labels": [{"name": "Some Label (3)", "catno": "SL-01"}],
        "identifiers": [{"type": "Barcode", "value": "0 12345 67890 5"}],
        "genres": ["Rock"], "styles": ["Punk"],
        "formats": [{"name": "CD", "qty": "1"}],
        "uri": "https://www.discogs.com/release/123-1876-Pow-Wow-Punk-Rock-2",
        "tracklist": [
            {"position": "", "type_": "heading", "title": "Side One"},
            {"position": "1", "type_": "track", "title": "First", "duration": "2:05"},
            {"position": "2", "type_": "track", "title": "Second", "duration": "1:01:00", "artists": [{"name": "Guest", "join": ""}]},
            {"position": "3", "type_": "track", "title": "Third", "duration": ""}
        ]
    }"#;

    #[test]
    fn a_discogs_release_reads_like_a_musicbrainz_one() {
        let release = parse_release(RELEASE).unwrap().unwrap();
        assert_eq!(
            (
                release.id.as_str(),
                release.artist.as_str(),
                release.title.as_str()
            ),
            ("discogs:123", "1876", "Pow Wow Punk Rock 2")
        );
        assert_eq!(release.year(), Some(2001));
        assert_eq!(
            (
                release.label.as_str(),
                release.catalog_number.as_str(),
                release.barcode.as_str()
            ),
            ("Some Label", "SL-01", "012345678905")
        );
        assert_eq!(release.genres, vec!["Punk".to_owned(), "Rock".to_owned()]);
        assert_eq!(release.source, "discogs");
        assert!(
            release
                .url
                .starts_with("https://www.discogs.com/release/123")
        );
        let tracks = &release.media[0].tracks;
        assert_eq!(tracks.len(), 3, "the heading is not a track");
        assert_eq!((tracks[0].number, tracks[0].length_ms), (1, Some(125_000)));
        assert_eq!(
            (tracks[1].artist.as_str(), tracks[1].length_ms),
            ("Guest", Some(3_660_000))
        );
        assert_eq!(tracks[2].length_ms, None);
    }

    #[test]
    fn disc_numbers_come_from_positions() {
        assert_eq!(disc_of("2-5"), 2);
        assert_eq!(disc_of("CD2-5"), 2);
        assert_eq!(disc_of("1.3"), 1);
        assert_eq!(disc_of("A1"), 1);
        assert_eq!(disc_of("7"), 1);
    }
}
