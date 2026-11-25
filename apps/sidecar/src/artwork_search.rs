//! Finding album artwork online. MusicBrainz is searched by the tagged release id, then barcode, catalogue
//! number, then artist and title (a few spellings), then the title alone. The Cover Art Archive is asked for
//! each likely release's front cover, or the release group's front when that pressing has none. Below a sure
//! match, iTunes and Deezer cover addresses already in their search replies are offered (those hosts only).
//! The person sees small previews and chooses; Review can also take a sure match by itself. The chosen cover
//! is fetched full size and goes through the ordinary picture editor. File paths are read only for tags
//! already on the songs. No audio is sent. Discogs images are not fetched.

use crate::cover_art::{
    fetch_front_cover, fetch_front_cover_sizes, fetch_group_front, fetch_image_url, is_release_id,
};
use crate::drives::Drives;
use crate::helper::HelperError;
use crate::library_cover::base64;
use crate::lookup::http_get;
use lofty::file::TaggedFileExt;
use lofty::tag::ItemKey;
use mediaverse_disc_metadata::musicbrainz;
use mediaverse_disc_metadata::streaming::{self, CatalogueCover};
use mediaverse_metadata_tags::{TagField, read_tag_fields};
use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;

/// Releases offered at most (each costs one request to the Cover Art Archive for its preview).
const MAX_CANDIDATES: usize = 6;
/// MusicBrainz's own match score below which a release is not offered.
const MIN_SCORE: u64 = 60;

/// Escapes a value for a MusicBrainz (Lucene) phrase query: backslash and double quote.
fn phrase(value: &str) -> String {
    let mut out = String::with_capacity(value.len() + 2);
    out.push('"');
    for c in value.chars() {
        if c == '"' || c == '\\' {
            out.push('\\');
        }
        out.push(c);
    }
    out.push('"');
    out
}

fn encode(value: &str) -> String {
    mediaverse_disc_metadata::musicbrainz::percent_encode(value)
}

/// The MusicBrainz release-search address for an album by an artist.
pub fn release_search_url(base_url: &str, artist: &str, album: &str) -> String {
    let mut query = format!("release:{}", phrase(album.trim()));
    let artist = artist.trim();
    if !artist.is_empty() && !artist.eq_ignore_ascii_case("various artists") {
        query.push_str(&format!(" AND artist:{}", phrase(artist)));
    }
    format!(
        "{}/ws/2/release/?query={}&fmt=json&limit=15",
        base_url.trim_end_matches('/'),
        encode(&query)
    )
}

/// The releases in a MusicBrainz search reply worth offering: score at least `MIN_SCORE`, best first, one
/// per title, country and year. When two pressings would otherwise collapse, the one Cover Art Archive says has a
/// front cover is kept. At most `MAX_CANDIDATES`, covers first.
pub fn parse_releases(reply: &str) -> Result<Vec<Value>, String> {
    let value: Value = serde_json::from_str(reply)
        .map_err(|e| format!("MusicBrainz sent a reply that could not be read: {e}"))?;
    let mut chosen: std::collections::HashMap<(String, String, String), Value> =
        std::collections::HashMap::new();
    for release in value["releases"].as_array().into_iter().flatten() {
        let (Some(id), Some(title)) = (release["id"].as_str(), release["title"].as_str()) else {
            continue;
        };
        let score = release["score"].as_u64().unwrap_or(0);
        if !is_release_id(id) || score < MIN_SCORE {
            continue;
        }
        let artist: String = release["artist-credit"]
            .as_array()
            .into_iter()
            .flatten()
            .map(|credit| {
                format!(
                    "{}{}",
                    credit["name"].as_str().unwrap_or(""),
                    credit["joinphrase"].as_str().unwrap_or("")
                )
            })
            .collect();
        let date = release["date"].as_str().unwrap_or("").to_owned();
        let country = release["country"].as_str().unwrap_or("").to_owned();
        let has_front = release["cover-art-archive"]["front"] == true;
        let group = release["release-group"]["id"]
            .as_str()
            .filter(|id| is_release_id(id))
            .unwrap_or("");
        let row = json!({
            "release_id": id, "title": title, "artist": artist, "date": date, "country": country,
            "score": score, "tracks": release["track-count"],
            "has_front": has_front, "release_group_id": group,
        });
        let key = (
            title.to_lowercase(),
            country.clone(),
            date.chars().take(4).collect::<String>(),
        );
        match chosen.get(&key) {
            Some(old)
                if old["has_front"] == true
                    || (has_front == false && score <= old["score"].as_u64().unwrap_or(0)) => {}
            _ => {
                chosen.insert(key, row);
            }
        }
    }
    let mut out: Vec<Value> = chosen.into_values().collect();
    out.sort_by(|a, b| {
        let front = |v: &Value| v["has_front"] == true;
        let score = |v: &Value| v["score"].as_u64().unwrap_or(0);
        front(b)
            .cmp(&front(a))
            .then(score(b).cmp(&score(a)))
            .then(a["release_id"].as_str().cmp(&b["release_id"].as_str()))
    });
    out.truncate(MAX_CANDIDATES);
    Ok(out)
}

/// Artist spellings worth asking MusicBrainz about, the tag's own first: straight apostrophe, without a leading
/// "The", and the first name when the tag lists several. At most three, so a search does not become a flood.
pub fn artist_queries(artist: &str) -> Vec<String> {
    let mut out = Vec::new();
    let push = |out: &mut Vec<String>, value: &str| {
        let value = value.trim();
        if value.is_empty() || out.iter().any(|have| have.eq_ignore_ascii_case(value)) {
            return;
        }
        out.push(value.to_owned());
    };
    push(&mut out, artist);
    let straight = artist.replace(['\u{2019}', '\u{2018}', '\u{02BC}'], "'");
    push(&mut out, &straight);
    if let Some(rest) = straight
        .trim()
        .strip_prefix("The ")
        .or_else(|| straight.trim().strip_prefix("the "))
    {
        push(&mut out, rest);
    }
    if let Some(lead) = crate::lyrics_lookup::lead_artist(artist) {
        push(&mut out, &lead);
    }
    out.truncate(3);
    out
}

/// Digits of a barcode, or nothing if it is not a barcode (8 to 14 digits).
pub fn barcode_digits(value: &str) -> Option<String> {
    let digits: String = value.chars().filter(|c| c.is_ascii_digit()).collect();
    (8..=14).contains(&digits.len()).then_some(digits)
}

pub fn barcode_search_url(base_url: &str, barcode: &str) -> String {
    format!(
        "{}/ws/2/release/?query={}&fmt=json&limit=5",
        base_url.trim_end_matches('/'),
        encode(&format!("barcode:{barcode}"))
    )
}

pub fn catalog_search_url(base_url: &str, catalog: &str) -> String {
    format!(
        "{}/ws/2/release/?query={}&fmt=json&limit=5",
        base_url.trim_end_matches('/'),
        encode(&format!("catno:{}", phrase(catalog.trim())))
    )
}

/// Fills empty clue fields from the first few files' tags. A missing file is skipped, not an error.
fn fill_clues(clues: ArtClues) -> ArtClues {
    let mut clues = clues;
    for path in clues.paths.iter().take(8) {
        if clues.release_id.is_empty() || clues.release_group_id.is_empty() {
            if let Ok(fields) = read_tag_fields(
                Path::new(path),
                &[
                    TagField::MusicBrainzReleaseId,
                    TagField::MusicBrainzReleaseGroupId,
                ],
            ) {
                for (field, value) in fields {
                    let Some(value) = value.filter(|v| !v.trim().is_empty()) else {
                        continue;
                    };
                    match field {
                        TagField::MusicBrainzReleaseId if clues.release_id.is_empty() => {
                            clues.release_id = value;
                        }
                        TagField::MusicBrainzReleaseGroupId
                            if clues.release_group_id.is_empty() =>
                        {
                            clues.release_group_id = value;
                        }
                        _ => {}
                    }
                }
            }
        }
        if clues.barcode.is_empty() || clues.catalog.is_empty() {
            if let Ok(tagged) = lofty::read_from_path(path) {
                if let Some(tag) = tagged.primary_tag().or_else(|| tagged.first_tag()) {
                    if clues.barcode.is_empty() {
                        clues.barcode = tag.get_string(&ItemKey::Barcode).unwrap_or("").to_owned();
                    }
                    if clues.catalog.is_empty() {
                        clues.catalog = tag
                            .get_string(&ItemKey::CatalogNumber)
                            .unwrap_or("")
                            .to_owned();
                    }
                }
            }
        }
        if !clues.release_id.is_empty()
            && !clues.release_group_id.is_empty()
            && !clues.barcode.is_empty()
        {
            break;
        }
    }
    clues
}

fn catalogue_match(
    wanted_artist: &str,
    wanted_album: &str,
    cover: &CatalogueCover,
    year: Option<u32>,
) -> u64 {
    let normal = mediaverse_tag_repair::names::normalise;
    let artist_ok =
        !wanted_artist.trim().is_empty() && normal(wanted_artist) == normal(&cover.artist);
    let album_ok = normal(wanted_album) == normal(&cover.title);
    let mut score: u64 = if artist_ok && album_ok {
        96
    } else if album_ok {
        80
    } else {
        60
    };
    if let (Some(want), Some(have)) = (year, cover.year)
        && want != have
    {
        score = score.saturating_sub(5);
    }
    score
}

/// Ids and codes already on the files, or passed in with the search. Empty strings mean "not known".
#[derive(Clone, Debug, Default)]
pub struct ArtClues {
    pub paths: Vec<String>,
    pub release_id: String,
    pub release_group_id: String,
    pub barcode: String,
    pub catalog: String,
}

/// What the album in the library has, to score how well each release fits it.
#[derive(Clone, Copy, Debug, Default)]
pub struct Wanted {
    pub tracks: Option<usize>,
    pub year: Option<u32>,
    /// Fetch a small preview of each release's cover (false for the automatic covers, which need only the
    /// match percent: one request instead of up to seven).
    pub previews: bool,
}

/// A match this good is offered for a one-click approval (owner, 2026-11-05: "If there is a 95% or better match
/// with the first source, like MusicBrainz, the user can just approve it").
pub const SURE_MATCH: u64 = 95;

/// How well a release fits the album, 0 to 100: MusicBrainz's own search score, less 15 when its track count
/// differs from the album's, 5 when its year differs (another edition's cover may still be right), and 20 when it
/// was found by the title alone.
pub fn match_percent(release: &Value, wanted: Wanted, title_only: bool) -> u64 {
    let mut percent = release["score"].as_u64().unwrap_or(0) as i64;
    if let (Some(want), Some(have)) = (wanted.tracks, release["tracks"].as_u64())
        && want as u64 != have
    {
        percent -= 15;
    }
    let year = release["date"]
        .as_str()
        .and_then(|d| d.get(..4))
        .and_then(|y| y.parse::<u32>().ok());
    if let (Some(want), Some(have)) = (wanted.year, year)
        && want != have
    {
        percent -= 5;
    }
    if title_only {
        percent -= 20;
    }
    percent.clamp(0, 100) as u64
}

/// The first release in a Discogs database search reply: its page on discogs.com, title and year. Only the page
/// address and CC0 text are used; Discogs' images are restricted data under its API terms (ADR 0009) and are
/// never fetched: the person looks at the cover on Discogs' own page.
pub fn discogs_page(reply: &str) -> Option<Value> {
    let value: Value = serde_json::from_str(reply).ok()?;
    let first = value["results"].as_array()?.iter().find(|r| {
        r["uri"]
            .as_str()
            .is_some_and(|u| u.starts_with("/release/") || u.starts_with("/master/"))
    })?;
    let uri = first["uri"].as_str()?;
    if uri.contains(['?', '#', ' ']) || uri.contains("..") {
        return None;
    }
    Some(
        json!({ "url": format!("https://www.discogs.com{uri}"), "title": first["title"].as_str().unwrap_or(""), "year": first["year"] }),
    )
}

/// From a Cover Art Archive release listing: the addresses of the front and back covers' 1200 px copies (else
/// the largest given). Only https addresses on the Cover Art Archive or the Internet Archive are accepted; the
/// listing gives http ones, which are asked for over https.
pub fn picture_urls(listing: &str) -> (Option<String>, Option<String>) {
    let Ok(value) = serde_json::from_str::<Value>(listing) else {
        return (None, None);
    };
    let url_of = |image: &Value| -> Option<String> {
        let raw = image["thumbnails"]["1200"]
            .as_str()
            .or_else(|| image["thumbnails"]["large"].as_str())
            .or_else(|| image["image"].as_str())?;
        let url = raw
            .strip_prefix("http://")
            .map_or_else(|| raw.to_owned(), |rest| format!("https://{rest}"));
        let host = url
            .strip_prefix("https://")?
            .split('/')
            .next()?
            .to_ascii_lowercase();
        let trusted = ["coverartarchive.org", "archive.org"]
            .iter()
            .any(|h| host == *h || host.ends_with(&format!(".{h}")));
        (trusted && !url.contains(['"', ' ', '\\'])).then_some(url)
    };
    let images = value["images"].as_array().cloned().unwrap_or_default();
    let has = |image: &Value, kind: &str| {
        image["types"]
            .as_array()
            .is_some_and(|t| t.iter().any(|x| x == kind))
    };
    let front = images
        .iter()
        .find(|i| i["front"] == true || has(i, "Front"))
        .and_then(url_of);
    let back = images
        .iter()
        .find(|i| i["back"] == true || has(i, "Back"))
        .and_then(url_of);
    (front, back)
}

/// How long a cover search waits for MusicBrainz or Discogs before saying so and offering the web search instead
/// (owner: "if MusicBrainz and Discogs don't respond right away, display a message and go straight to the browser
/// search").
const QUICK: Duration = Duration::from_secs(8);

impl Drives {
    fn art_user_agent(&self) -> String {
        let contact = self.metadata.current().identity.contact.trim().to_owned();
        musicbrainz::user_agent(
            "MediaVerseStudio",
            env!("CARGO_PKG_VERSION"),
            if contact.is_empty() {
                "https://github.com/MediaVerseStudio/MediaVerse-Studio"
            } else {
                &contact
            },
        )
    }

    /**
     * The `find_album_art` job. Order: the tagged MusicBrainz release, then barcode, catalogue number, then
     * artist and title (a few spellings), then the title alone. Each likely release gets a front-cover preview
     * from the Cover Art Archive (the release group if that pressing has none). Best match first, each with a
     * `match` percent. Below [`SURE_MATCH`], iTunes and Deezer covers from their search replies are added, and
     * if Discogs is set up its page is linked (not its images). `problems` names a service that was slow, busy
     * or switched off. A service that fails is a problem, not an error: the job always answers.
     */
    pub(crate) fn run_find_album_art(
        &self,
        artist: &str,
        album: &str,
        wanted: Wanted,
        clues: ArtClues,
    ) -> Result<Value, HelperError> {
        let settings = self.metadata.current();
        if album.trim().is_empty() {
            return Err((
                "invalid_arguments".to_owned(),
                "The album has no name to search for. Fix its tags first.".to_owned(),
            ));
        }
        let agent = self.art_user_agent();
        let mut problems: Vec<Value> = Vec::new();
        let mut candidates = Vec::new();
        if settings.musicbrainz.enabled && settings.cover_art.enabled {
            let search_at = |url: String| -> Result<Vec<Value>, HelperError> {
                self.metadata.wait_turn(
                    "musicbrainz",
                    Duration::from_millis(settings.musicbrainz.min_interval_ms),
                );
                let reply = http_get(
                    &url,
                    &agent,
                    QUICK.min(Duration::from_secs(
                        settings.musicbrainz.timeout_seconds.max(1),
                    )),
                )?;
                match reply.status {
                    200 => {
                        self.metadata.outcome("musicbrainz", false, None);
                        parse_releases(&String::from_utf8_lossy(&reply.body))
                            .map_err(|m| ("bad_reply".to_owned(), m))
                    }
                    429 | 503 => {
                        self.metadata
                            .outcome("musicbrainz", true, reply.retry_after);
                        Err((
                            "rate_limited".to_owned(),
                            "MusicBrainz is busy and is not answering this computer just now."
                                .to_owned(),
                        ))
                    }
                    other => Err((
                        "http_error".to_owned(),
                        format!("MusicBrainz answered HTTP {other}."),
                    )),
                }
            };
            let filled = fill_clues(clues);
            let mut found_releases = Vec::new();
            let mut title_only = false;
            let mut search_error = None;
            if is_release_id(&filled.release_id) {
                found_releases.push(json!({
                    "release_id": filled.release_id,
                    "release_group_id": filled.release_group_id,
                    "title": album,
                    "artist": artist,
                    "date": wanted.year.map(|y| y.to_string()).unwrap_or_default(),
                    "country": "",
                    "score": 100,
                    "tracks": wanted.tracks,
                    "has_front": true,
                    "from_tag": true,
                }));
            }
            let base = settings.musicbrainz.base_url.as_str();
            if found_releases.iter().all(|r| r["from_tag"] == true) {
                if let Some(digits) = barcode_digits(&filled.barcode) {
                    match search_at(barcode_search_url(base, &digits)) {
                        Ok(found) if !found.is_empty() => found_releases.extend(found),
                        Ok(_) => {}
                        Err(error) => search_error = Some(error),
                    }
                }
            }
            if search_error.is_none()
                && found_releases.iter().all(|r| r["from_tag"] == true)
                && !filled.catalog.trim().is_empty()
            {
                match search_at(catalog_search_url(base, &filled.catalog)) {
                    Ok(found) if !found.is_empty() => found_releases.extend(found),
                    Ok(_) => {}
                    Err(error) => search_error = Some(error),
                }
            }
            // Apostrophe, "The" and a featured-artist list are tried before the title alone. A title-only hit is
            // marked so the person checks it is the right album.
            if search_error.is_none() && found_releases.iter().all(|r| r["from_tag"] == true) {
                let mut queries = artist_queries(artist);
                if queries.is_empty() {
                    queries.push(String::new());
                }
                let mut name_hits = Vec::new();
                for query in &queries {
                    match search_at(release_search_url(base, query, album)) {
                        Ok(found) if !found.is_empty() => {
                            name_hits = found;
                            break;
                        }
                        Ok(_) => {}
                        Err(error) => {
                            search_error = Some(error);
                            break;
                        }
                    }
                }
                if search_error.is_none() && name_hits.is_empty() && !artist.trim().is_empty() {
                    match search_at(release_search_url(base, "", album)) {
                        Ok(found) => {
                            title_only = !found.is_empty();
                            name_hits = found;
                        }
                        Err(error) => search_error = Some(error),
                    }
                }
                found_releases.extend(name_hits);
            }
            let found = match search_error {
                Some(error) if found_releases.is_empty() => Err(error),
                Some((_, message)) => {
                    problems.push(json!({ "source": "MusicBrainz", "message": message }));
                    Ok((found_releases, title_only))
                }
                None => Ok((found_releases, title_only)),
            };
            match found {
                Ok((releases, title_only)) => {
                    for mut release in releases {
                        release["matched_by_title_only"] = json!(title_only);
                        release["match"] = json!(match_percent(&release, wanted, title_only));
                        if !wanted.previews {
                            candidates.push(release);
                            continue;
                        }
                        let id = release["release_id"].as_str().unwrap_or("").to_owned();
                        self.metadata
                            .wait_turn("coverart", Duration::from_millis(1000));
                        match fetch_front_cover_sizes(
                            &settings.cover_art.base_url,
                            &id,
                            &agent,
                            QUICK,
                            &["front-250", "front-500"],
                        ) {
                            Ok(image) => {
                                self.metadata.outcome("coverart", false, None);
                                release["preview_mime"] =
                                    json!(if image.info.kind == crate::cover_art::Kind::Png {
                                        "image/png"
                                    } else {
                                        "image/jpeg"
                                    });
                                release["preview_base64"] = json!(base64(&image.bytes));
                                candidates.push(release);
                            }
                            Err((code, message))
                                if !matches!(
                                    code.as_str(),
                                    "no_cover" | "bad_image" | "bad_release_id"
                                ) =>
                            {
                                // Busy, slow or unreachable: keep what was found and say so.
                                if code == "rate_limited" {
                                    self.metadata.outcome("coverart", true, None);
                                }
                                problems.push(
                                    json!({ "source": "Cover Art Archive", "message": message }),
                                );
                                break;
                            }
                            Err(_) => {
                                let group = release["release_group_id"].as_str().unwrap_or("");
                                if !is_release_id(group) {
                                    continue;
                                }
                                self.metadata
                                    .wait_turn("coverart", Duration::from_millis(1000));
                                match fetch_group_front(
                                    &settings.cover_art.base_url,
                                    group,
                                    &agent,
                                    QUICK,
                                    &["front-250", "front-500"],
                                ) {
                                    Ok(image) => {
                                        self.metadata.outcome("coverart", false, None);
                                        release["preview_mime"] = json!(if image.info.kind
                                            == crate::cover_art::Kind::Png
                                        {
                                            "image/png"
                                        } else {
                                            "image/jpeg"
                                        });
                                        release["preview_base64"] = json!(base64(&image.bytes));
                                        release["art_from"] = json!("release-group");
                                        candidates.push(release);
                                    }
                                    Err((code, message))
                                        if !matches!(
                                            code.as_str(),
                                            "no_cover" | "bad_image" | "bad_release_id"
                                        ) =>
                                    {
                                        if code == "rate_limited" {
                                            self.metadata.outcome("coverart", true, None);
                                        }
                                        problems.push(json!({
                                            "source": "Cover Art Archive",
                                            "message": message
                                        }));
                                        break;
                                    }
                                    Err(_) => {}
                                }
                            }
                        }
                    }
                }
                Err((_, message)) => {
                    problems.push(json!({ "source": "MusicBrainz", "message": message }))
                }
            }
        } else {
            problems.push(json!({ "source": "MusicBrainz", "message": "MusicBrainz or cover art is switched off in Settings > Lookups." }));
        }
        candidates.sort_by_key(|c| std::cmp::Reverse(c["match"].as_u64().unwrap_or(0)));
        let mut best = candidates
            .first()
            .and_then(|c| c["match"].as_u64())
            .unwrap_or(0);

        // Not a sure match: covers iTunes and Deezer already name in a search (D106). Their picture hosts only.
        if best < SURE_MATCH {
            let normal_year = wanted.year;
            let take = |covers: Vec<CatalogueCover>, problems: &mut Vec<Value>, source: &str| {
                let mut added = Vec::new();
                for cover in covers {
                    let percent = catalogue_match(artist, album, &cover, normal_year);
                    if percent < MIN_SCORE {
                        continue;
                    }
                    let mut row = json!({
                        "release_id": "",
                        "title": cover.title,
                        "artist": cover.artist,
                        "date": cover.year.map(|y| y.to_string()).unwrap_or_default(),
                        "country": "",
                        "score": percent,
                        "match": percent,
                        "source": cover.source,
                        "image_url": cover.image_url,
                    });
                    if !wanted.previews {
                        added.push(row);
                        continue;
                    }
                    match fetch_image_url(&cover.image_url, &agent, QUICK) {
                        Ok(image) => {
                            row["preview_mime"] =
                                json!(if image.info.kind == crate::cover_art::Kind::Png {
                                    "image/png"
                                } else {
                                    "image/jpeg"
                                });
                            row["preview_base64"] = json!(base64(&image.bytes));
                            added.push(row);
                        }
                        Err((code, message))
                            if !matches!(code.as_str(), "no_cover" | "bad_image") =>
                        {
                            problems.push(json!({ "source": source, "message": message }));
                            break;
                        }
                        Err(_) => {}
                    }
                }
                added
            };
            let itunes = http_get(&streaming::itunes_search_url(artist, album), &agent, QUICK);
            match itunes {
                Ok(reply) if reply.status == 200 => candidates.extend(take(
                    streaming::itunes_covers(&String::from_utf8_lossy(&reply.body)),
                    &mut problems,
                    "iTunes",
                )),
                Ok(reply) => problems.push(
                    json!({ "source": "iTunes", "message": format!("iTunes answered HTTP {}.", reply.status) }),
                ),
                Err((_, message)) => {
                    problems.push(json!({ "source": "iTunes", "message": message }))
                }
            }
            let deezer = http_get(&streaming::deezer_search_url(artist, album), &agent, QUICK);
            match deezer {
                Ok(reply) if reply.status == 200 => candidates.extend(take(
                    streaming::deezer_covers(&String::from_utf8_lossy(&reply.body)),
                    &mut problems,
                    "Deezer",
                )),
                Ok(reply) => problems.push(
                    json!({ "source": "Deezer", "message": format!("Deezer answered HTTP {}.", reply.status) }),
                ),
                Err((_, message)) => {
                    problems.push(json!({ "source": "Deezer", "message": message }))
                }
            }
            candidates.sort_by_key(|c| std::cmp::Reverse(c["match"].as_u64().unwrap_or(0)));
            best = candidates
                .first()
                .and_then(|c| c["match"].as_u64())
                .unwrap_or(0);
        }

        // Not a sure match: the album's page on Discogs, for the person to look at (never its images).
        let mut discogs = Value::Null;
        if best < SURE_MATCH && wanted.previews && crate::tag_repair::discogs_ready(&settings) {
            let base = settings.discogs.base_url.trim_end_matches('/');
            let mut url = format!(
                "{base}/database/search?type=release&per_page=5&release_title={}",
                crate::tag_repair::url_encode(album)
            );
            if !artist.trim().is_empty() && !artist.eq_ignore_ascii_case("various artists") {
                url.push_str(&format!(
                    "&artist={}",
                    crate::tag_repair::url_encode(artist)
                ));
            }
            match crate::tag_repair::discogs_get(&url, &settings, &self.metadata) {
                Ok(Some(body)) => discogs = discogs_page(&body).unwrap_or(Value::Null),
                Ok(None) => {}
                Err((_, message)) => {
                    problems.push(json!({ "source": "Discogs", "message": message }))
                }
            }
        }
        Ok(
            json!({ "candidates": candidates, "best_match": best, "sure_match": SURE_MATCH, "discogs": discogs, "problems": problems, "searched": { "artist": artist, "album": album } }),
        )
    }

    /**
     * The `fetch_album_art {release_id}` job: the chosen release's front cover, full size (1200, else 500 px), and
     * its back cover when the Cover Art Archive has one (owner, 2026-11-05: approve them together; nothing else is
     * looked for, to keep the requests down: the release's picture list is asked for only once a release is chosen).
     * `{mime, data_base64, width, height, back: {..} | null}`.
     */
    pub(crate) fn run_fetch_album_art(
        &self,
        release_id: &str,
        release_group_id: &str,
        image_url: &str,
    ) -> Result<Value, HelperError> {
        if !image_url.is_empty() {
            let agent = self.art_user_agent();
            let image = fetch_image_url(image_url, &agent, Duration::from_secs(20))?;
            return Ok(json!({
                "mime": if image.info.kind == crate::cover_art::Kind::Png { "image/png" } else { "image/jpeg" },
                "data_base64": base64(&image.bytes),
                "width": image.info.width,
                "height": image.info.height,
                "back": Value::Null,
            }));
        }
        if !is_release_id(release_id) {
            return Err((
                "invalid_arguments".to_owned(),
                "That is not a MusicBrainz release id.".to_owned(),
            ));
        }
        let settings = self.metadata.current();
        let agent = self.art_user_agent();
        let base = settings.cover_art.base_url.trim_end_matches('/').to_owned();
        let as_json = |image: &crate::cover_art::CoverImage| {
            json!({
                "mime": if image.info.kind == crate::cover_art::Kind::Png { "image/png" } else { "image/jpeg" },
                "data_base64": base64(&image.bytes),
                "width": image.info.width, "height": image.info.height,
            })
        };
        // The release's picture list: which pictures there are and where their 1200 px copies are.
        self.metadata
            .wait_turn("coverart", Duration::from_millis(1000));
        let listing = http_get(
            &format!("{base}/release/{release_id}"),
            &agent,
            Duration::from_secs(20),
        )
        .ok()
        .filter(|r| r.status == 200);
        let (front_url, back_url) = listing
            .map(|r| picture_urls(&String::from_utf8_lossy(&r.body)))
            .unwrap_or_default();
        let fetch = |url: &str| -> Option<crate::cover_art::CoverImage> {
            self.metadata
                .wait_turn("coverart", Duration::from_millis(1000));
            let reply = http_get(url, &agent, Duration::from_secs(30))
                .ok()
                .filter(|r| r.status == 200)?;
            let info = crate::cover_art::validate_image(&reply.body).ok()?;
            Some(crate::cover_art::CoverImage {
                bytes: reply.body,
                info,
            })
        };
        let front = match front_url.as_deref().and_then(fetch) {
            Some(image) => image,
            None => {
                self.metadata
                    .wait_turn("coverart", Duration::from_millis(1000));
                match fetch_front_cover(
                    &settings.cover_art.base_url,
                    release_id,
                    &agent,
                    Duration::from_secs(30),
                ) {
                    Ok(image) => image,
                    Err((code, _)) if code == "no_cover" && is_release_id(release_group_id) => {
                        self.metadata
                            .wait_turn("coverart", Duration::from_millis(1000));
                        fetch_group_front(
                            &settings.cover_art.base_url,
                            release_group_id,
                            &agent,
                            Duration::from_secs(30),
                            &["front-1200", "front-500"],
                        )?
                    }
                    Err(error) => return Err(error),
                }
            }
        };
        self.metadata.outcome("coverart", false, None);
        let mut out = as_json(&front);
        out["back"] = back_url
            .as_deref()
            .and_then(fetch)
            .map_or(Value::Null, |image| as_json(&image));
        Ok(out)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_search_address_quotes_and_encodes_the_names() {
        let url = release_search_url(
            "https://musicbrainz.org/",
            "Swingin' Utters",
            "Here, Under Protest \"Live\"",
        );
        assert!(
            url.starts_with("https://musicbrainz.org/ws/2/release/?query="),
            "{url}"
        );
        assert!(url.ends_with("&fmt=json&limit=15"));
        let query = url
            .split("query=")
            .nth(1)
            .unwrap()
            .split('&')
            .next()
            .unwrap();
        assert!(
            !query.contains(' ') && !query.contains('"') && !query.contains('&'),
            "everything is encoded: {query}"
        );
        assert!(
            query.contains("%5C%22Live%5C%22"),
            "inner quotes are escaped for the query: {query}"
        );
        // Various Artists is not a useful artist to search with.
        assert!(
            !release_search_url("https://musicbrainz.org", "Various Artists", "Fat Music")
                .contains("artist%3A")
        );
    }

    #[test]
    fn the_match_percent_falls_for_another_track_count_year_or_a_title_only_search() {
        let release = json!({ "score": 100, "tracks": 15, "date": "1997-06-17" });
        let wanted = Wanted {
            tracks: Some(15),
            year: Some(1997),
            previews: true,
        };
        assert_eq!(match_percent(&release, wanted, false), 100);
        assert_eq!(
            match_percent(
                &release,
                Wanted {
                    tracks: Some(16),
                    ..wanted
                },
                false
            ),
            85,
            "a bonus-track edition"
        );
        assert_eq!(
            match_percent(
                &release,
                Wanted {
                    year: Some(2001),
                    ..wanted
                },
                false
            ),
            95,
            "another year is still a sure match"
        );
        assert_eq!(match_percent(&release, wanted, true), 80);
        assert_eq!(
            match_percent(&release, Wanted::default(), false),
            100,
            "nothing known to compare"
        );
        assert_eq!(
            match_percent(&json!({ "score": 10, "tracks": 3 }), wanted, true),
            0
        );
    }

    #[test]
    fn a_release_listing_gives_the_front_and_back_covers_over_https() {
        let listing = json!({ "images": [
            { "types": ["Booklet"], "front": false, "back": false, "image": "http://coverartarchive.org/release/x/1.jpg", "thumbnails": { "1200": "http://coverartarchive.org/release/x/1-1200.jpg" } },
            { "types": ["Back", "Spine"], "front": false, "back": true, "image": "http://coverartarchive.org/release/x/2.jpg", "thumbnails": { "1200": "http://coverartarchive.org/release/x/2-1200.jpg" } },
            { "types": ["Front"], "front": true, "back": false, "image": "http://coverartarchive.org/release/x/3.jpg", "thumbnails": { "large": "https://ia800.us.archive.org/x/3-500.jpg" } },
        ]});
        let (front, back) = picture_urls(&listing.to_string());
        assert_eq!(
            front.as_deref(),
            Some("https://ia800.us.archive.org/x/3-500.jpg")
        );
        assert_eq!(
            back.as_deref(),
            Some("https://coverartarchive.org/release/x/2-1200.jpg")
        );
        let elsewhere = json!({ "images": [{ "front": true, "thumbnails": { "1200": "https://evil.example/x.jpg" } }] });
        assert_eq!(
            picture_urls(&elsewhere.to_string()),
            (None, None),
            "only the archive's own addresses"
        );
        assert_eq!(picture_urls("not json"), (None, None));
    }

    #[test]
    fn a_discogs_search_gives_only_the_page_address_title_and_year() {
        let reply = json!({ "results": [
            { "uri": "/artist/1-x", "title": "not a release" },
            { "uri": "/release/42-Bad-Religion-Stranger-Than-Fiction", "title": "Bad Religion - Stranger Than Fiction", "year": "1994",
              "cover_image": "https://i.discogs.com/x.jpg", "thumb": "https://i.discogs.com/t.jpg" },
        ]});
        let page = discogs_page(&reply.to_string()).unwrap();
        assert_eq!(
            page["url"],
            "https://www.discogs.com/release/42-Bad-Religion-Stranger-Than-Fiction"
        );
        assert_eq!(page["year"], "1994");
        assert!(
            !page.to_string().contains("i.discogs.com"),
            "no image address is passed on: {page}"
        );
        assert_eq!(
            discogs_page(
                &json!({ "results": [{ "uri": "/release/1?x=..", "title": "t" }] }).to_string()
            ),
            None
        );
        assert_eq!(discogs_page("[]"), None);
    }

    #[test]
    fn releases_are_filtered_by_score_deduplicated_and_capped() {
        let release = |id: u8, title: &str, score: u64, country: &str, date: &str| {
            json!({ "id": format!("{id:08x}-0000-0000-0000-000000000000"), "score": score, "title": title, "country": country, "date": date,
                    "track-count": 12, "artist-credit": [{ "name": "1876", "joinphrase": "" }] })
        };
        let reply = json!({ "releases": [
            release(1, "Pow Wow Punk Rock", 100, "US", "2018-05-04"),
            release(2, "Pow Wow Punk Rock", 98, "US", "2018-06-01"),   // same title, country and year: left out
            release(3, "Pow Wow Punk Rock", 95, "GB", "2018"),
            release(4, "Something Else", 40, "US", "2001"),            // below the score: left out
            { "id": "not-an-id", "score": 100, "title": "Bad" },        // not a release id: left out
        ]});
        let found = parse_releases(&reply.to_string()).unwrap();
        assert_eq!(found.len(), 2);
        assert_eq!(found[0]["country"], "US");
        assert_eq!(found[1]["country"], "GB");
        assert_eq!(found[0]["artist"], "1876");
        let many = json!({ "releases": (0..20u8).map(|i| release(i, &format!("Album {i}"), 90, "US", "2000")).collect::<Vec<_>>() });
        assert_eq!(
            parse_releases(&many.to_string()).unwrap().len(),
            MAX_CANDIDATES
        );
        assert!(parse_releases("not json").is_err());
    }

    #[test]
    fn a_pressing_with_a_front_cover_is_kept_over_a_higher_score_without_one() {
        let release = |id: u8, score: u64, front: bool| {
            json!({
                "id": format!("{id:08x}-0000-0000-0000-000000000000"),
                "score": score, "title": "Same Album", "country": "US", "date": "1994",
                "cover-art-archive": { "front": front },
                "release-group": { "id": "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee" },
            })
        };
        let found = parse_releases(
            &json!({ "releases": [release(1, 100, false), release(2, 80, true)] }).to_string(),
        )
        .unwrap();
        assert_eq!(found.len(), 1);
        assert_eq!(found[0]["has_front"], true);
        assert_eq!(
            found[0]["release_group_id"],
            "aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee"
        );
    }

    #[test]
    fn artist_queries_try_the_apostrophe_and_a_leading_the() {
        let queries = artist_queries("The Swingin\u{2019} Utters feat. Guest");
        assert_eq!(queries[0], "The Swingin\u{2019} Utters feat. Guest");
        assert!(
            queries
                .iter()
                .any(|q| q == "The Swingin' Utters feat. Guest")
        );
        assert!(queries.iter().any(|q| q == "Swingin' Utters feat. Guest"));
        assert!(queries.len() <= 3);
        assert_eq!(
            barcode_digits("0 123456 78905 5"),
            Some("0123456789055".to_owned())
        );
        assert_eq!(barcode_digits("nope"), None);
    }
}
