//! Catalogue searches by name on iTunes (Apple's Search API) and Deezer (its public API), neither of which needs a key
//! (D106). They list the digital editions of albums, which often include small or new releases MusicBrainz lacks. A digital
//! edition is not this disc, so every answer is an inexact match the person confirms, and the tags are only as good as
//! their catalogue. Pure request building and reply parsing; the sidecar does the network.

use crate::{AlbumInfo, MatchQuality, ReleaseInfo, TrackInfo, musicbrainz::is_various_artist};
use serde_json::Value;

fn url_encode(text: &str) -> String {
    crate::musicbrainz::percent_encode(text)
}

fn terms(artist: &str, album: &str) -> String {
    [artist.trim(), album.trim()]
        .iter()
        .filter(|s| !s.is_empty())
        .cloned()
        .collect::<Vec<_>>()
        .join(" ")
}

fn year_of(date: &str) -> Option<u32> {
    date.get(..4)
        .and_then(|y| y.parse().ok())
        .filter(|y| (1000..3000).contains(y))
}

fn text(value: &Value) -> String {
    value.as_str().unwrap_or_default().trim().to_owned()
}

/// (track number, title, the track's own artist, its length in milliseconds).
type TitleRow = (u32, String, Option<String>, Option<u32>);

struct Found<'a> {
    source: &'a str,
    id: String,
    album: String,
    artist: String,
    date: &'a str,
    genre: Option<String>,
    label: String,
}

fn album_from(found: Found, titles: Vec<TitleRow>, track_count: usize) -> Option<AlbumInfo> {
    if titles.len() != track_count || titles.iter().any(|(_, title, _, _)| title.is_empty()) {
        return None;
    }
    let compilation = is_various_artist(&found.artist);
    let artist = found.artist;
    Some(AlbumInfo {
        source: found.source.to_owned(),
        source_id: found.id,
        album: found.album,
        album_artist: artist.clone(),
        year: year_of(found.date),
        genre: found.genre.filter(|g| !g.is_empty()),
        tracks: titles
            .into_iter()
            .enumerate()
            .map(|(index, (_, title, own, length_ms))| TrackInfo {
                number: (index + 1) as u8,
                title,
                artist: own.filter(|a| !a.is_empty() && *a != artist),
                length_ms,
            })
            .collect(),
        quality: MatchQuality::Inexact,
        cover_art_release: None,
        disc_number: None,
        disc_count: None,
        compilation,
        release: Some(ReleaseInfo {
            date: found.date.get(..10).unwrap_or(found.date).to_owned(),
            country: String::new(),
            label: found.label,
            catalog_number: String::new(),
            barcode: String::new(),
            format: "Digital release".to_owned(),
            status: String::new(),
        }),
    })
}

// ---- iTunes ----

pub fn itunes_search_url(artist: &str, album: &str) -> String {
    format!(
        "https://itunes.apple.com/search?term={}&media=music&entity=album&limit=15",
        url_encode(&terms(artist, album))
    )
}

pub fn itunes_lookup_url(id: u64) -> String {
    format!("https://itunes.apple.com/lookup?id={id}&entity=song")
}

/// Albums in an iTunes search reply with exactly `track_count` tracks, in the order given, at most `limit`.
pub fn itunes_ids(json: &str, track_count: usize, limit: usize) -> Result<Vec<u64>, String> {
    let root: Value =
        serde_json::from_str(json).map_err(|e| format!("iTunes sent unreadable data: {e}"))?;
    Ok(root["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| {
            r["collectionType"] == "Album" && r["trackCount"].as_u64() == Some(track_count as u64)
        })
        .filter_map(|r| r["collectionId"].as_u64())
        .take(limit)
        .collect())
}

/// An album from an iTunes lookup (the collection plus its songs); only a single-disc listing with `track_count` songs counts.
pub fn parse_itunes_album(json: &str, track_count: usize) -> Result<Option<AlbumInfo>, String> {
    let root: Value =
        serde_json::from_str(json).map_err(|e| format!("iTunes sent unreadable data: {e}"))?;
    let results = root["results"]
        .as_array()
        .ok_or("iTunes sent no results.")?;
    let Some(collection) = results.iter().find(|r| r["wrapperType"] == "collection") else {
        return Ok(None);
    };
    let mut songs: Vec<(u64, u32, String, Option<String>, Option<u32>)> = results
        .iter()
        .filter(|r| r["wrapperType"] == "track" && r["kind"] == "song")
        .map(|r| {
            (
                r["discNumber"].as_u64().unwrap_or(1),
                r["trackNumber"].as_u64().unwrap_or(0) as u32,
                text(&r["trackName"]),
                r["artistName"].as_str().map(str::to_owned),
                r["trackTimeMillis"]
                    .as_u64()
                    .and_then(|ms| u32::try_from(ms).ok()),
            )
        })
        .collect();
    songs.sort_by_key(|s| (s.0, s.1));
    if songs.iter().any(|s| s.0 != 1) {
        return Ok(None); // several discs: not one CD
    }
    let titles = songs
        .into_iter()
        .map(|(_, n, title, artist, length)| (n, title, artist, length))
        .collect();
    Ok(album_from(
        Found {
            source: "itunes",
            id: collection["collectionId"].as_u64().unwrap_or(0).to_string(),
            album: text(&collection["collectionName"]),
            artist: text(&collection["artistName"]),
            date: collection["releaseDate"].as_str().unwrap_or(""),
            genre: collection["primaryGenreName"].as_str().map(str::to_owned),
            label: String::new(),
        },
        titles,
        track_count,
    ))
}

// ---- Deezer ----

pub fn deezer_search_url(artist: &str, album: &str) -> String {
    format!(
        "https://api.deezer.com/search/album?q={}&limit=15",
        url_encode(&terms(artist, album))
    )
}

pub fn deezer_album_url(id: u64) -> String {
    format!("https://api.deezer.com/album/{id}")
}

/// Albums in a Deezer search reply with exactly `track_count` tracks, at most `limit`.
pub fn deezer_ids(json: &str, track_count: usize, limit: usize) -> Result<Vec<u64>, String> {
    let root: Value =
        serde_json::from_str(json).map_err(|e| format!("Deezer sent unreadable data: {e}"))?;
    if let Some(error) = root["error"]["message"].as_str() {
        return Err(format!("Deezer said: {error}"));
    }
    Ok(root["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|a| a["nb_tracks"].as_u64() == Some(track_count as u64))
        .filter_map(|a| a["id"].as_u64())
        .take(limit)
        .collect())
}

/// A cover address this program will fetch: https only, on Apple's, Deezer's, or the cover archive's own hosts.
pub fn allowed_cover_url(url: &str) -> bool {
    let Some(rest) = url.strip_prefix("https://") else {
        return false;
    };
    if rest.contains('@') || url.contains(['"', ' ', '\\']) {
        return false;
    }
    let host = rest
        .split(['/', '?', '#', ':'])
        .next()
        .unwrap_or("")
        .to_ascii_lowercase();
    [
        "mzstatic.com",
        "dzcdn.net",
        "coverartarchive.org",
        "archive.org",
    ]
    .iter()
    .any(|known| host == *known || host.ends_with(&format!(".{known}")))
}

/// iTunes' 100 px artwork address rewritten to the 600 px copy, or nothing if it is not on Apple's host.
pub fn itunes_artwork_url(url: &str) -> Option<String> {
    let large = url.replacen("100x100bb", "600x600bb", 1);
    allowed_cover_url(&large).then_some(large)
}

/// One catalogue cover already named in an iTunes or Deezer search reply. No second lookup: the search itself
/// carries the picture address.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct CatalogueCover {
    pub source: &'static str,
    pub title: String,
    pub artist: String,
    pub year: Option<u32>,
    pub image_url: String,
}

/// Album covers in an iTunes search reply. Track count is not required: a digital edition can still be the
/// cover of the CD the person owns.
pub fn itunes_covers(json: &str) -> Vec<CatalogueCover> {
    let Ok(root) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    root["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["collectionType"] == "Album" || r["wrapperType"] == "collection")
        .filter_map(|r| {
            let image_url = itunes_artwork_url(r["artworkUrl100"].as_str().unwrap_or(""))?;
            Some(CatalogueCover {
                source: "itunes",
                title: text(&r["collectionName"]),
                artist: text(&r["artistName"]),
                year: r["releaseDate"].as_str().and_then(year_of),
                image_url,
            })
        })
        .filter(|c| !c.title.is_empty() && !c.image_url.is_empty())
        .take(3)
        .collect()
}

/// Album covers in a Deezer search reply (`cover_xl` is already a large copy).
pub fn deezer_covers(json: &str) -> Vec<CatalogueCover> {
    let Ok(root) = serde_json::from_str::<Value>(json) else {
        return Vec::new();
    };
    if root["error"]["message"].is_string() {
        return Vec::new();
    }
    root["data"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|album| {
            let image_url = album["cover_xl"]
                .as_str()
                .filter(|u| allowed_cover_url(u))?;
            Some(CatalogueCover {
                source: "deezer",
                title: text(&album["title"]),
                artist: text(&album["artist"]["name"]),
                year: album["release_date"].as_str().and_then(year_of),
                image_url: image_url.to_owned(),
            })
        })
        .filter(|c| !c.title.is_empty())
        .take(3)
        .collect()
}

/// An album from a Deezer album reply.
pub fn parse_deezer_album(json: &str, track_count: usize) -> Result<Option<AlbumInfo>, String> {
    let root: Value =
        serde_json::from_str(json).map_err(|e| format!("Deezer sent unreadable data: {e}"))?;
    if let Some(error) = root["error"]["message"].as_str() {
        return Err(format!("Deezer said: {error}"));
    }
    let tracks = root["tracks"]["data"]
        .as_array()
        .cloned()
        .unwrap_or_default();
    if tracks
        .iter()
        .any(|t| t["disk_number"].as_u64().is_some_and(|d| d > 1))
    {
        return Ok(None);
    }
    let mut titles: Vec<TitleRow> = tracks
        .iter()
        .map(|t| {
            (
                t["track_position"].as_u64().unwrap_or(0) as u32,
                text(&t["title"]),
                t["artist"]["name"].as_str().map(str::to_owned),
                t["duration"]
                    .as_u64()
                    .and_then(|s| u32::try_from(s * 1000).ok())
                    .filter(|ms| *ms > 0),
            )
        })
        .collect();
    titles.sort_by_key(|t| t.0);
    let genre = root["genres"]["data"]
        .as_array()
        .and_then(|g| g.first())
        .and_then(|g| g["name"].as_str())
        .map(str::to_owned);
    Ok(album_from(
        Found {
            source: "deezer",
            id: root["id"].as_u64().unwrap_or(0).to_string(),
            album: text(&root["title"]),
            artist: text(&root["artist"]["name"]),
            date: root["release_date"].as_str().unwrap_or(""),
            genre,
            label: text(&root["label"]),
        },
        titles,
        track_count,
    ))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn catalogue_covers_come_only_from_the_search_reply_and_known_hosts() {
        assert!(allowed_cover_url(
            "https://is1-ssl.mzstatic.com/image/thumb/a/600x600bb.jpg"
        ));
        assert!(allowed_cover_url(
            "https://e-cdns-images.dzcdn.net/images/cover/abc/1000x1000-000000-80-0-0.jpg"
        ));
        assert!(!allowed_cover_url("http://is1-ssl.mzstatic.com/a.jpg"));
        assert!(!allowed_cover_url("https://evil.example/a.jpg"));
        assert!(!allowed_cover_url(
            "https://user:pass@is1-ssl.mzstatic.com/a.jpg"
        ));
        let itunes = r#"{"results":[{"collectionType":"Album","collectionName":"LP","artistName":"Band","releaseDate":"2008-05-06T07:00:00Z","artworkUrl100":"https://is1-ssl.mzstatic.com/image/thumb/a/100x100bb.jpg"}]}"#;
        let covers = itunes_covers(itunes);
        assert_eq!(covers.len(), 1);
        assert_eq!(covers[0].source, "itunes");
        assert!(covers[0].image_url.contains("600x600bb"));
        assert_eq!(covers[0].year, Some(2008));
        let deezer = r#"{"data":[{"title":"LP","artist":{"name":"Band"},"release_date":"2008-01-02","cover_xl":"https://e-cdns-images.dzcdn.net/images/cover/abc/1000x1000-000000-80-0-0.jpg"}]}"#;
        assert_eq!(deezer_covers(deezer)[0].source, "deezer");
        assert!(
            deezer_covers(r#"{"data":[{"title":"LP","cover_xl":"https://evil.example/a.jpg"}]}"#)
                .is_empty()
        );
    }

    #[test]
    fn itunes_albums_with_the_discs_track_count_are_found_and_read() {
        assert_eq!(
            itunes_search_url("Witch Doktors", "Timeless & Dimeless"),
            "https://itunes.apple.com/search?term=Witch%20Doktors%20Timeless%20%26%20Dimeless&media=music&entity=album&limit=15"
        );
        let search = r#"{"results":[{"collectionType":"Album","collectionId":7,"trackCount":3},{"collectionType":"Album","collectionId":8,"trackCount":2},{"collectionType":"Single","collectionId":9,"trackCount":3}]}"#;
        assert_eq!(itunes_ids(search, 3, 5).unwrap(), [7]);
        let album = r#"{"results":[
          {"wrapperType":"collection","collectionId":7,"collectionName":"Timeless & Dimeless","artistName":"WitchDoktors","releaseDate":"2008-05-06T07:00:00Z","primaryGenreName":"Punk"},
          {"wrapperType":"track","kind":"song","trackNumber":2,"discNumber":1,"trackName":"Second","artistName":"WitchDoktors"},
          {"wrapperType":"track","kind":"song","trackNumber":1,"discNumber":1,"trackName":"First","artistName":"WitchDoktors"},
          {"wrapperType":"track","kind":"song","trackNumber":3,"discNumber":1,"trackName":"Third","artistName":"Guest"}]}"#;
        let found = parse_itunes_album(album, 3).unwrap().unwrap();
        assert_eq!(
            (
                found.source.as_str(),
                found.album.as_str(),
                found.album_artist.as_str(),
                found.year,
                found.genre.as_deref()
            ),
            (
                "itunes",
                "Timeless & Dimeless",
                "WitchDoktors",
                Some(2008),
                Some("Punk")
            )
        );
        assert_eq!(
            found
                .tracks
                .iter()
                .map(|t| t.title.as_str())
                .collect::<Vec<_>>(),
            ["First", "Second", "Third"]
        );
        assert_eq!(
            found.tracks[2].artist.as_deref(),
            Some("Guest"),
            "a track by another artist keeps it"
        );
        assert_eq!(found.tracks[0].artist, None);
        assert_eq!(found.quality, MatchQuality::Inexact);
        assert_eq!(
            (
                found.release.as_ref().unwrap().format.as_str(),
                found.release.as_ref().unwrap().date.as_str()
            ),
            ("Digital release", "2008-05-06")
        );
        assert!(
            parse_itunes_album(album, 4).unwrap().is_none(),
            "wrong track count"
        );
        assert!(
            parse_itunes_album(
                &album.replace(
                    "\"discNumber\":1,\"trackName\":\"Third\"",
                    "\"discNumber\":2,\"trackName\":\"Third\""
                ),
                3
            )
            .unwrap()
            .is_none(),
            "two discs"
        );
        assert!(itunes_ids("nope", 3, 5).is_err());
    }

    #[test]
    fn track_lengths_are_read_from_itunes_and_deezer() {
        let itunes = r#"{"results":[{"wrapperType":"collection","collectionId":7,"collectionName":"A","artistName":"B"},
          {"wrapperType":"track","kind":"song","trackNumber":1,"discNumber":1,"trackName":"One","trackTimeMillis":201500},
          {"wrapperType":"track","kind":"song","trackNumber":2,"discNumber":1,"trackName":"Two"}]}"#;
        let found = parse_itunes_album(itunes, 2).unwrap().unwrap();
        assert_eq!(
            found.tracks.iter().map(|t| t.length_ms).collect::<Vec<_>>(),
            [Some(201_500), None]
        );
        let deezer = r#"{"id":5,"title":"A","artist":{"name":"B"},"tracks":{"data":[
          {"track_position":1,"title":"One","duration":201,"artist":{"name":"B"}},{"track_position":2,"title":"Two","duration":0,"artist":{"name":"B"}}]}}"#;
        let found = parse_deezer_album(deezer, 2).unwrap().unwrap();
        assert_eq!(
            found.tracks.iter().map(|t| t.length_ms).collect::<Vec<_>>(),
            [Some(201_000), None],
            "seconds become milliseconds; zero is no length"
        );
    }

    #[test]
    fn deezer_albums_with_the_discs_track_count_are_found_and_read() {
        assert_eq!(
            deezer_search_url("A", "B C"),
            "https://api.deezer.com/search/album?q=A%20B%20C&limit=15"
        );
        assert_eq!(deezer_album_url(5), "https://api.deezer.com/album/5");
        let search = r#"{"data":[{"id":1,"nb_tracks":2},{"id":2,"nb_tracks":3}]}"#;
        assert_eq!(deezer_ids(search, 3, 5).unwrap(), [2]);
        assert!(
            deezer_ids(r#"{"error":{"message":"Quota limit exceeded"}}"#, 3, 5)
                .unwrap_err()
                .contains("Quota")
        );
        let album = r#"{"id":2,"title":"Album","artist":{"name":"Band"},"release_date":"2012-01-02","label":"Indie","genres":{"data":[{"name":"Rock"}]},
          "tracks":{"data":[{"title":"B","track_position":2,"disk_number":1,"artist":{"name":"Band"}},{"title":"A","track_position":1,"disk_number":1,"artist":{"name":"Band"}},{"title":"C","track_position":3,"disk_number":1,"artist":{"name":"Band"}}]}}"#;
        let found = parse_deezer_album(album, 3).unwrap().unwrap();
        assert_eq!(
            (
                found.source.as_str(),
                found.year,
                found.genre.as_deref(),
                found.release.as_ref().unwrap().label.as_str()
            ),
            ("deezer", Some(2012), Some("Rock"), "Indie")
        );
        assert_eq!(
            found
                .tracks
                .iter()
                .map(|t| (t.number, t.title.as_str()))
                .collect::<Vec<_>>(),
            [(1, "A"), (2, "B"), (3, "C")]
        );
        assert!(found.tracks.iter().all(|t| t.artist.is_none()));
        let two_discs = album.replacen("\"disk_number\":1", "\"disk_number\":2", 1);
        assert!(parse_deezer_album(&two_discs, 3).unwrap().is_none());
    }
}
