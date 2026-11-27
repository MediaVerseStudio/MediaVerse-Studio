//! Free artist photos from Wikimedia Commons (D100), with no server needed. For each artist: MusicBrainz names the artist
//! (through one of their albums' release group when the tags carry one, else by name), MusicBrainz's links give the
//! artist's Wikidata entry (or an image link), Wikidata names the photo (property P18) and Commons serves it scaled to
//! at most 1000 pixels. Photos are kept in `<data>/artist-photos/` with a credits file (Commons photos need their
//! author and licence named; the file name and page are kept for that), and written into the songs on request as the
//! "Artist" picture with the same journal and Undo as every picture change. Asking is polite: about one MusicBrainz
//! question a second, and answers (photo or "none") are remembered, so nothing is asked twice.

use crate::library_media::update_track_media;
use crate::lookup::{MetadataState, http_get};
use crate::tag_repair::{ScanState, musicbrainz_get, url_encode};
use mediaverse_disc_metadata::musicbrainz;
use mediaverse_disc_metadata::settings::MetadataSettings;
use mediaverse_tag_repair::names::normalise;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::time::Duration;

const MAX_BYTES: usize = 450 * 1024;
const WIDTHS: [u32; 3] = [1000, 700, 500];
const SKIP: [&str; 5] = [
    "unknown artist",
    "various artists",
    "various",
    "unknown",
    "soundtrack",
];

fn dir(data_dir: &Path) -> PathBuf {
    data_dir.join("artist-photos")
}

fn key(name: &str) -> String {
    normalise(name)
}

fn load(data_dir: &Path) -> BTreeMap<String, Value> {
    let value: Value = std::fs::read_to_string(dir(data_dir).join("results.json"))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    value
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| (k.clone(), v.clone()))
        .collect()
}

fn save(data_dir: &Path, results: &BTreeMap<String, Value>) -> Result<(), String> {
    std::fs::create_dir_all(dir(data_dir)).map_err(|e| e.to_string())?;
    let partial = dir(data_dir).join("results.json.tmp");
    std::fs::write(
        &partial,
        serde_json::to_vec(&Value::Object(
            results
                .iter()
                .map(|(k, v)| (k.clone(), v.clone()))
                .collect(),
        ))
        .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&partial, dir(data_dir).join("results.json")).map_err(|e| e.to_string())
}

/// Standard base64 (the picture request carries pictures as base64 text).
pub(crate) fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        for i in 0..4 {
            if i <= chunk.len() {
                out.push(TABLE[((n >> (18 - 6 * i)) & 63) as usize] as char);
            } else {
                out.push('=');
            }
        }
    }
    out
}

fn is_picture(bytes: &[u8]) -> bool {
    bytes.starts_with(&[0xFF, 0xD8, 0xFF]) || bytes.starts_with(&[0x89, b'P', b'N', b'G'])
}

/// "File:Some name.jpg" or a Commons page address -> "Some name.jpg".
fn commons_file(text: &str) -> Option<String> {
    let name = text.rsplit("File:").next()?.trim();
    let name = name.split('?').next()?.replace('_', " ");
    let name = name.trim();
    (!name.is_empty() && name.contains('.') && text.contains("File:")
        || !text.contains('/') && name.contains('.'))
    .then(|| name.to_owned())
}

struct Found {
    /// Where the photo came from: "wikimedia", "theaudiodb" or "fanart.tv".
    source: &'static str,
    /// The Commons file name, or the service's name, for the credits file.
    file: String,
    /// The photo's page (the credit link).
    page: String,
    mbid: String,
    bytes: Vec<u8>,
}

/// TheAudioDB's artist picture address from its `artist-mb.php` answer.
fn audiodb_thumb(value: &Value) -> Option<String> {
    value["artists"].as_array()?.first()?["strArtistThumb"]
        .as_str()
        .map(str::trim)
        .filter(|u| u.starts_with("https://") || u.starts_with("http://"))
        .map(str::to_owned)
}

/// The best-liked artist picture in Fanart.tv's answer (most likes first; the list is not always sorted).
fn fanart_thumb(value: &Value) -> Option<String> {
    value["artistthumb"]
        .as_array()?
        .iter()
        .filter_map(|t| {
            Some((
                t["likes"]
                    .as_str()
                    .and_then(|n| n.parse::<u64>().ok())
                    .or_else(|| t["likes"].as_u64())
                    .unwrap_or(0),
                t["url"].as_str()?,
            ))
        })
        .max_by_key(|(likes, _)| *likes)
        .map(|(_, url)| url.to_owned())
}

/// Fanart.tv serves a smaller copy under /preview/ instead of /fanart/.
fn fanart_preview(url: &str) -> String {
    url.replacen("/fanart/", "/preview/", 1)
}

fn ua(settings: &MetadataSettings) -> String {
    let contact = settings.identity.contact.trim();
    musicbrainz::user_agent(
        "MediaVerseStudio",
        env!("CARGO_PKG_VERSION"),
        if contact.is_empty() {
            "https://mediaverse.studio"
        } else {
            contact
        },
    )
}

fn get_json(
    url: &str,
    settings: &MetadataSettings,
    state: &MetadataState,
    musicbrainz_host: bool,
) -> Result<Option<Value>, String> {
    let body = if musicbrainz_host {
        musicbrainz_get(url, settings, state).map_err(|(_, m)| m)?
    } else {
        state.wait_turn("wikimedia", Duration::from_millis(600));
        let reply = http_get(url, &ua(settings), Duration::from_secs(20)).map_err(|(_, m)| m)?;
        match reply.status {
            200 => Some(String::from_utf8_lossy(&reply.body).into_owned()),
            404 => None,
            other => return Err(format!("Wikimedia answered HTTP {other}.")),
        }
    };
    Ok(body.and_then(|b| serde_json::from_str(&b).ok()))
}

/// The artist's MusicBrainz id: from an album's release group when one is known, else the best exact-name match.
fn artist_mbid(
    name: &str,
    groups: &[String],
    settings: &MetadataSettings,
    state: &MetadataState,
) -> Result<Option<String>, String> {
    let base = format!(
        "{}/ws/2",
        settings.musicbrainz.base_url.trim_end_matches('/')
    );
    for group in groups.iter().take(2) {
        if let Some(v) = get_json(
            &format!("{base}/release-group/{group}?inc=artists&fmt=json"),
            settings,
            state,
            true,
        )? {
            for credit in v["artist-credit"].as_array().into_iter().flatten() {
                if key(credit["name"].as_str().unwrap_or_default()) == key(name)
                    || key(credit["artist"]["name"].as_str().unwrap_or_default()) == key(name)
                {
                    if let Some(id) = credit["artist"]["id"].as_str() {
                        return Ok(Some(id.to_owned()));
                    }
                }
            }
        }
    }
    let query = url_encode(&format!("artist:\"{}\"", name.replace('"', "")));
    let Some(v) = get_json(
        &format!("{base}/artist/?query={query}&limit=5&fmt=json"),
        settings,
        state,
        true,
    )?
    else {
        return Ok(None);
    };
    Ok(v["artists"]
        .as_array()
        .into_iter()
        .flatten()
        .find(|a| {
            a["score"].as_u64().unwrap_or(0) >= 90
                && (key(a["name"].as_str().unwrap_or_default()) == key(name)
                    || key(a["sort-name"].as_str().unwrap_or_default()) == key(name))
        })
        .and_then(|a| a["id"].as_str().map(str::to_owned)))
}

/// The Commons file name MusicBrainz or Wikidata gives for the artist.
fn commons_name(
    mbid: &str,
    settings: &MetadataSettings,
    state: &MetadataState,
) -> Result<Option<String>, String> {
    let base = format!(
        "{}/ws/2",
        settings.musicbrainz.base_url.trim_end_matches('/')
    );
    let Some(v) = get_json(
        &format!("{base}/artist/{mbid}?inc=url-rels&fmt=json"),
        settings,
        state,
        true,
    )?
    else {
        return Ok(None);
    };
    let relations = v["relations"].as_array().cloned().unwrap_or_default();
    let resource = |kind: &str| {
        relations
            .iter()
            .find(|r| r["type"] == kind)
            .and_then(|r| r["url"]["resource"].as_str().map(str::to_owned))
    };
    if let Some(file) = resource("image")
        .filter(|u| u.contains("commons.wikimedia.org"))
        .and_then(|u| commons_file(&u))
    {
        return Ok(Some(file));
    }
    let Some(entity) = resource("wikidata")
        .and_then(|u| u.rsplit('/').next().map(str::to_owned))
        .filter(|q| q.starts_with('Q'))
    else {
        return Ok(None);
    };
    let Some(data) = get_json(
        &format!("https://www.wikidata.org/wiki/Special:EntityData/{entity}.json"),
        settings,
        state,
        false,
    )?
    else {
        return Ok(None);
    };
    Ok(
        data["entities"][&entity]["claims"]["P18"][0]["mainsnak"]["datavalue"]["value"]
            .as_str()
            .map(str::to_owned),
    )
}

fn download(
    file: &str,
    settings: &MetadataSettings,
    state: &MetadataState,
) -> Result<Option<Vec<u8>>, String> {
    for width in WIDTHS {
        state.wait_turn("wikimedia", Duration::from_millis(600));
        let url = format!(
            "https://commons.wikimedia.org/wiki/Special:FilePath/{}?width={width}",
            url_encode(file)
        );
        let reply = http_get(&url, &ua(settings), Duration::from_secs(30)).map_err(|(_, m)| m)?;
        if reply.status != 200 {
            return Ok(None);
        }
        if !is_picture(&reply.body) {
            return Ok(None);
        }
        if reply.body.len() <= MAX_BYTES {
            return Ok(Some(reply.body));
        }
    }
    Ok(None)
}

/// Whether the person has given a key for any of the extra photo sources.
fn has_other_sources(settings: &MetadataSettings) -> bool {
    settings.photos.audiodb_key.is_set() || settings.photos.fanart_key.is_set()
}

/// One picture from a plain address (the first of `urls` that is a small enough JPEG or PNG).
fn fetch_picture(
    urls: &[String],
    source: &str,
    settings: &MetadataSettings,
    state: &MetadataState,
) -> Result<Option<Vec<u8>>, String> {
    for url in urls {
        state.wait_turn(source, Duration::from_millis(1_000));
        let reply = http_get(url, &ua(settings), Duration::from_secs(30)).map_err(|(_, m)| m)?;
        if reply.status == 200 && is_picture(&reply.body) && reply.body.len() <= MAX_BYTES {
            return Ok(Some(reply.body));
        }
    }
    Ok(None)
}

/// The services that need the person's own key, tried in turn for an artist Wikimedia has no photo for.
fn other_sources(
    mbid: &str,
    settings: &MetadataSettings,
    state: &MetadataState,
) -> Result<Option<Found>, String> {
    let ask = |url: &str, source: &str| -> Result<Option<Value>, String> {
        state.wait_turn(source, Duration::from_millis(1_000));
        let reply = http_get(url, &ua(settings), Duration::from_secs(20)).map_err(|(_, m)| m)?;
        match reply.status {
            200 => Ok(serde_json::from_slice(&reply.body).ok()),
            404 => Ok(None),
            401 | 403 => Err(format!("{source} refused the key: check it in Settings.")),
            other => Err(format!("{source} answered HTTP {other}.")),
        }
    };
    let audiodb = settings.photos.audiodb_key.expose();
    if !audiodb.is_empty()
        && let Some(thumb) = ask(
            &format!("https://www.theaudiodb.com/api/v1/json/{audiodb}/artist-mb.php?i={mbid}"),
            "theaudiodb",
        )?
        .and_then(|v| audiodb_thumb(&v))
        && let Some(bytes) = fetch_picture(
            &[
                format!("{thumb}/medium"),
                format!("{thumb}/preview"),
                thumb.clone(),
            ],
            "theaudiodb",
            settings,
            state,
        )?
    {
        return Ok(Some(Found {
            source: "theaudiodb",
            file: "TheAudioDB".to_owned(),
            page: "https://www.theaudiodb.com".to_owned(),
            mbid: mbid.to_owned(),
            bytes,
        }));
    }
    let fanart = settings.photos.fanart_key.expose();
    if !fanart.is_empty()
        && let Some(thumb) = ask(
            &format!("https://webservice.fanart.tv/v3/music/{mbid}?api_key={fanart}"),
            "fanart",
        )?
        .and_then(|v| fanart_thumb(&v))
        && let Some(bytes) = fetch_picture(
            &[fanart_preview(&thumb), thumb.clone()],
            "fanart",
            settings,
            state,
        )?
    {
        return Ok(Some(Found {
            source: "fanart.tv",
            file: "Fanart.tv".to_owned(),
            page: format!("https://fanart.tv/artist/{mbid}/"),
            mbid: mbid.to_owned(),
            bytes,
        }));
    }
    Ok(None)
}

fn find(
    name: &str,
    groups: &[String],
    settings: &MetadataSettings,
    state: &MetadataState,
) -> Result<Option<Found>, String> {
    let Some(mbid) = artist_mbid(name, groups, settings, state)? else {
        return Ok(None);
    };
    if let Some(file) = commons_name(&mbid, settings, state)?
        && let Some(bytes) = download(&file, settings, state)?
    {
        let page = format!(
            "https://commons.wikimedia.org/wiki/File:{}",
            url_encode(&file)
        );
        return Ok(Some(Found {
            source: "wikimedia",
            file,
            page,
            mbid,
            bytes,
        }));
    }
    other_sources(&mbid, settings, state)
}

/// The job: `artists` is `[{name, groups: [release group ids]}]`. Every artist not answered before is looked up; a
/// photo is saved in the cache, a "no photo" answer is remembered. Network trouble leaves the artist for next time.
pub fn find_photos(
    args: &Value,
    data_dir: &Path,
    settings: &MetadataSettings,
    state: &MetadataState,
    stop: &AtomicBool,
    progress: &ScanState,
    emit: &dyn Fn(&ScanState),
) -> Result<Value, String> {
    let artists = args["artists"]
        .as_array()
        .ok_or("'artists' must be a list.")?;
    let mut results = load(data_dir);
    let todo: Vec<(&str, Vec<String>)> = artists
        .iter()
        .filter_map(|a| {
            Some((
                a["name"].as_str()?.trim(),
                a["groups"]
                    .as_array()
                    .into_iter()
                    .flatten()
                    .filter_map(|g| g.as_str().map(str::to_owned))
                    .collect(),
            ))
        })
        .filter(|(name, _)| {
            !name.is_empty()
                && !SKIP.contains(&key(name).as_str())
                && !SKIP.contains(&name.to_lowercase().as_str())
        })
        // Answered before, except "no photo" answers given before the other sources had keys: those are asked again.
        .filter(|(name, _)| {
            results.get(&key(name)).is_none_or(|old| {
                old["status"] == "none" && old["extra"] != true && has_other_sources(settings)
            })
        })
        .collect();
    progress.total.store(todo.len(), Ordering::Relaxed);
    emit(progress);
    std::fs::create_dir_all(dir(data_dir)).map_err(|e| e.to_string())?;
    let (mut stopped, mut trouble) = (false, 0usize);
    for (name, groups) in todo {
        if stop.load(Ordering::Relaxed) {
            stopped = true;
            break;
        }
        if let Ok(mut current) = progress.current.lock() {
            *current = name.to_owned();
        }
        match find(name, &groups, settings, state) {
            Ok(Some(found)) => {
                let file_name = format!("{}.jpg", url_encode(&key(name)));
                std::fs::write(dir(data_dir).join(&file_name), &found.bytes)
                    .map_err(|e| e.to_string())?;
                results.insert(key(name), json!({ "name": name, "status": "found", "file": file_name, "source": found.source, "commons_file": found.file, "mbid": found.mbid, "page": found.page }));
                progress.identified.fetch_add(1, Ordering::Relaxed);
            }
            Ok(None) => {
                results.insert(
                    key(name),
                    json!({ "name": name, "status": "none", "extra": has_other_sources(settings) }),
                );
                progress.unmatched.fetch_add(1, Ordering::Relaxed);
            }
            Err(_) => trouble += 1,
        }
        let done = progress.done.fetch_add(1, Ordering::Relaxed) + 1;
        if done % 5 == 0 {
            save(data_dir, &results)?;
            emit(progress);
        }
    }
    save(data_dir, &results)?;
    let found = results.values().filter(|v| v["status"] == "found").count();
    Ok(
        json!({ "stopped": stopped, "found": found, "none": results.values().filter(|v| v["status"] == "none").count(), "trouble": trouble }),
    )
}

/// `write_wiki_photos {artists: [{name, paths}], batch, replace}`: embeds each artist's cached photo as the Artist picture
/// in their songs. Artists without a cached photo are skipped. Returns `{artists, songs, problems}`.
pub fn write_photos(
    args: &Value,
    library_root: Option<&Path>,
    data_dir: &Path,
    progress: &dyn Fn(usize, usize),
) -> Result<Value, String> {
    let artists = args["artists"]
        .as_array()
        .ok_or("'artists' must be a list.")?;
    let batch = args["batch"].as_str().ok_or("'batch' is missing.")?;
    let results = load(data_dir);
    let (mut done_artists, mut songs, mut problems) = (0usize, 0usize, Vec::new());
    let total = artists.len();
    for (i, artist) in artists.iter().enumerate() {
        progress(i, total);
        let name = artist["name"].as_str().unwrap_or_default();
        let Some(entry) = results.get(&key(name)).filter(|e| e["status"] == "found") else {
            continue;
        };
        // The page sends the photo made to fit a song (`data_base64`); without it the cached file is used as it is,
        // and refused by the writer if it does not fit.
        let prepared = artist["data_base64"].as_str().map(str::to_owned);
        let Some(picture) = prepared.or_else(|| {
            std::fs::read(dir(data_dir).join(entry["file"].as_str().unwrap_or_default()))
                .ok()
                .map(|bytes| base64(&bytes))
        }) else {
            continue;
        };
        let paths: Vec<&str> = artist["paths"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .collect();
        if paths.is_empty() {
            continue;
        }
        let request = json!({ "paths": paths, "pictures": [{ "kind": "artist_photo", "data_base64": picture }], "batch": batch });
        match update_track_media(&request, library_root, data_dir) {
            Ok(reply) => {
                let results = reply["results"].as_array().cloned().unwrap_or_default();
                songs += results.iter().filter(|r| r["ok"] == true).count();
                problems.extend(
                    results
                        .iter()
                        .filter(|r| r["ok"] != true)
                        .map(|r| json!({ "path": r["path"], "message": r["error"] })),
                );
                done_artists += 1;
            }
            Err(message) => problems.push(json!({ "path": name, "message": message })),
        }
    }
    progress(total, total);
    Ok(json!({ "artists": done_artists, "songs": songs, "problems": problems }))
}

/// `wiki_photo {name}`: the cached photo of one artist as `{data_base64}`, or `null`, for the page to make fit a song.
pub fn photo(name: &str, data_dir: &Path) -> Value {
    load(data_dir)
        .get(&key(name))
        .filter(|e| e["status"] == "found")
        .and_then(|e| std::fs::read(dir(data_dir).join(e["file"].as_str()?)).ok())
        .map_or(
            Value::Null,
            |bytes| json!({ "data_base64": base64(&bytes) }),
        )
}

/// `list_wiki_photos`: what the cache holds, for the page.
pub fn summary(data_dir: &Path) -> Value {
    let results = load(data_dir);
    let found: Vec<Value> = results.values().filter(|v| v["status"] == "found").map(|v| json!({ "name": v["name"], "source": v["source"], "commons_file": v["commons_file"], "page": v["page"] })).collect();
    json!({ "found": found.len(), "none": results.values().filter(|v| v["status"] == "none").count(), "names": results.values().filter(|v| v["status"] == "found").filter_map(|v| v["name"].as_str()).collect::<Vec<_>>() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_other_services_answers_are_read() {
        let audiodb = json!({ "artists": [{ "idArtist": "1", "strArtistThumb": "https://r2.theaudiodb.com/images/media/artist/thumb/abc.jpg" }] });
        assert_eq!(
            audiodb_thumb(&audiodb).as_deref(),
            Some("https://r2.theaudiodb.com/images/media/artist/thumb/abc.jpg")
        );
        assert_eq!(audiodb_thumb(&json!({ "artists": null })), None);
        assert_eq!(
            audiodb_thumb(&json!({ "artists": [{ "strArtistThumb": "" }] })),
            None
        );
        assert_eq!(
            audiodb_thumb(&json!({ "artists": [{ "strArtistThumb": "javascript:x" }] })),
            None
        );
        let fanart = json!({ "artistthumb": [{ "url": "https://assets.fanart.tv/fanart/music/a/artistthumb/low.jpg", "likes": "1" }, { "url": "https://assets.fanart.tv/fanart/music/a/artistthumb/best.jpg", "likes": "7" }] });
        assert_eq!(
            fanart_thumb(&fanart).as_deref(),
            Some("https://assets.fanart.tv/fanart/music/a/artistthumb/best.jpg")
        );
        assert_eq!(fanart_thumb(&json!({ "name": "x" })), None);
        assert_eq!(
            fanart_preview("https://assets.fanart.tv/fanart/music/a/artistthumb/best.jpg"),
            "https://assets.fanart.tv/preview/music/a/artistthumb/best.jpg"
        );
    }

    #[test]
    fn extra_sources_need_a_key_and_earlier_no_photo_answers_are_asked_again_once_there_is_one() {
        let mut settings = MetadataSettings::default();
        assert!(!has_other_sources(&settings));
        settings = settings
            .with_update(&json!({ "photos": { "audiodb_key": "12345" } }))
            .unwrap();
        assert!(has_other_sources(&settings));
        assert!(
            settings
                .with_update(&json!({ "photos": { "fanart_key": "bad key" } }))
                .is_err()
        );
    }

    #[test]
    fn base64_matches_the_standard_examples() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
        assert_eq!(
            crate::library_cover::unbase64(&base64(&[0, 255, 7, 8, 9, 200])),
            Some(vec![0, 255, 7, 8, 9, 200])
        );
    }

    #[test]
    fn commons_names_come_from_links_and_bare_names() {
        assert_eq!(
            commons_file("https://commons.wikimedia.org/wiki/File:AFI_2010.jpg").as_deref(),
            Some("AFI 2010.jpg")
        );
        assert_eq!(
            commons_file("AFI 2010.jpg").as_deref(),
            Some("AFI 2010.jpg")
        );
        assert_eq!(commons_file("https://example.com/x"), None);
    }

    #[test]
    fn only_jpeg_and_png_bytes_are_taken_as_pictures() {
        assert!(is_picture(&[0xFF, 0xD8, 0xFF, 0xE0]));
        assert!(is_picture(&[0x89, b'P', b'N', b'G', 1]));
        assert!(!is_picture(b"<html>"));
    }
}
