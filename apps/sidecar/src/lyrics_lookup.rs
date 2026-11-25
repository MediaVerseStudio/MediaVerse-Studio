//! Online lyrics lookup from LRCLIB (https://lrclib.net), decision D29. Nothing here runs by itself: a lookup
//! happens only when the user asks for one for a song, it sends only the song's title, artist, album and length,
//! and what comes back is shown for the user to accept; it is never saved automatically and never replaces
//! lyrics already saved without a confirmation in the page.
//!
//! API (https://lrclib.net/docs.md): `GET /api/get` with `track_name`, `artist_name`, optional `album_name` and
//! `duration` (seconds, matched within 2), and `GET /api/search` with `track_name` and `artist_name`. Answers
//! carry `plainLyrics`, `syncedLyrics` (an LRC text), `instrumental`, `duration`. 404 means not found; 429 comes
//! with `Retry-After`. Clients should identify themselves in the User-Agent and pause 200 to 500 ms between
//! requests; the program waits 500 ms.

use crate::lookup::{HttpReply, SourceResult, fail, http_get};
use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;

pub const DEFAULT_BASE_URL: &str = "https://lrclib.net";
const MAX_RESULTS: usize = 8;
const MAX_LYRICS_CHARS: usize = 60_000;
/// Closest accepted difference between the file's length and a search result's, in seconds, for calling them the
/// same recording. A little further than that still has usable words; the time stamps are kept and marked so the
/// person can line them up, rather than thrown away.
const SEARCH_DURATION_SLACK: f64 = 5.0;
const ALIGN_SLACK: f64 = 20.0;

/// Whether `url` is an address the program will talk to for lyrics: https, or http only on this computer
/// (so tests can use a local fake without ever sending a song's details across the network unencrypted).
pub fn allowed_base_url(url: &str) -> bool {
    let lower = url.trim().to_ascii_lowercase();
    lower.starts_with("https://")
        || lower.starts_with("http://127.0.0.1")
        || lower.starts_with("http://localhost")
}

fn encode(text: &str) -> String {
    mediaverse_disc_metadata::musicbrainz::percent_encode(text)
}

/// One answer, trimmed to what the page shows.
fn candidate(item: &Value) -> Option<Value> {
    let clip = |value: &Value| {
        value
            .as_str()
            .map(|s| s.chars().take(MAX_LYRICS_CHARS).collect::<String>())
            .filter(|s| !s.trim().is_empty())
    };
    let plain = clip(&item["plainLyrics"]);
    let synced = clip(&item["syncedLyrics"]);
    let instrumental = item["instrumental"] == true;
    if plain.is_none() && synced.is_none() && !instrumental {
        return None;
    }
    let text = |key: &str| {
        item[key].as_str().map(|s| {
            s.chars()
                .filter(|c| !c.is_control())
                .take(200)
                .collect::<String>()
        })
    };
    Some(json!({
        "id": item["id"],
        "track": text("trackName"),
        "artist": text("artistName"),
        "album": text("albumName"),
        "duration": item["duration"],
        "instrumental": instrumental,
        "plain": plain,
        "synced": synced,
    }))
}

fn reply_problem(reply: &HttpReply) -> Option<(String, String)> {
    match reply.status {
        200 => None,
        404 => None,
        429 => Some((
            "rate_limited".to_owned(),
            format!(
                "LRCLIB asks for a pause{}. Try again in a little while.",
                reply.retry_after.map_or(String::new(), |d| format!(
                    " of {} seconds",
                    d.as_secs().max(1)
                ))
            ),
        )),
        500..=599 => Some((
            "service_unavailable".to_owned(),
            "LRCLIB is not answering properly right now. Try again later.".to_owned(),
        )),
        other => Some((
            "bad_reply".to_owned(),
            format!("LRCLIB answered with an unexpected status ({other})."),
        )),
    }
}

/// A title without a track number written in front of it ("14 Donut Dan", "1. All For Nothing", "01 - Song"): what is
/// left, when it starts with a word. `None` when the title has no such number. A title that really starts with a number
/// ("99 Red Balloons") is only asked about this way after it was asked about as written and nothing was found.
pub fn without_track_number(title: &str) -> Option<String> {
    let text = title.trim();
    let digits = text.chars().take_while(char::is_ascii_digit).count();
    if digits == 0 || digits > 3 {
        return None;
    }
    let rest = text[digits..].trim_start_matches(|c: char| {
        c.is_whitespace() || matches!(c, '.' | '-' | '_' | ')' | ']')
    });
    let separated = text.len() - digits - rest.len() > 0;
    (separated
        && rest.starts_with(|c: char| c.is_alphabetic() || c == '(' || c == '\'' || c == '"'))
    .then(|| rest.trim_end().to_owned())
}

/// Looks up one song. Tries the exact signature first, then a search; returns `{via, results}` with the
/// best matches first (an exact signature match is the only result when there is one). A title that starts with a
/// track number and finds nothing as written is asked about once more without the number (`title_used` says so).
pub fn find_lyrics(
    base_url: &str,
    title: &str,
    artist: &str,
    album: Option<&str>,
    duration_seconds: Option<f64>,
    user_agent: &str,
    pause: &dyn Fn(),
) -> SourceResult<Value> {
    let mut answer = find_once(
        base_url,
        title,
        artist,
        album,
        duration_seconds,
        user_agent,
        pause,
    )?;
    if answer["results"].as_array().is_some_and(Vec::is_empty)
        && let Some(cleaned) = without_track_number(title)
    {
        let again = find_once(
            base_url,
            &cleaned,
            artist,
            album,
            duration_seconds,
            user_agent,
            pause,
        )?;
        if again["results"].as_array().is_some_and(|r| !r.is_empty()) {
            answer = again;
            answer["title_used"] = json!(cleaned);
        }
    }
    Ok(answer)
}

fn find_once(
    base_url: &str,
    title: &str,
    artist: &str,
    album: Option<&str>,
    duration_seconds: Option<f64>,
    user_agent: &str,
    pause: &dyn Fn(),
) -> SourceResult<Value> {
    if title.trim().is_empty() || artist.trim().is_empty() {
        return fail(
            "missing_details",
            "Lyrics can only be looked up for a song with a title and an artist. Fix its tags first.",
        );
    }
    let base = base_url.trim_end_matches('/');
    let timeout = Duration::from_secs(20);

    let mut exact = format!(
        "{base}/api/get?track_name={}&artist_name={}",
        encode(title),
        encode(artist)
    );
    if let Some(album) = album.filter(|a| !a.trim().is_empty()) {
        exact.push_str(&format!("&album_name={}", encode(album)));
    }
    if let Some(seconds) = duration_seconds.filter(|s| (1.0..=3600.0).contains(s)) {
        exact.push_str(&format!("&duration={}", seconds.round() as u32));
    }
    pause();
    let reply = http_get(&exact, user_agent, timeout)?;
    if let Some((code, message)) = reply_problem(&reply) {
        return fail(&code, message);
    }
    if reply.status == 200 {
        if let Some(mut found) = serde_json::from_slice::<Value>(&reply.body)
            .ok()
            .as_ref()
            .and_then(candidate)
        {
            found["confidence"] = json!(100);
            return Ok(json!({ "via": "exact", "results": [found] }));
        }
    }

    // Owner, 2026-11-05: the words are the songwriter's, not the album's. The same song on another album, live, or
    // remastered has the same lyrics, and a cover has the original's. So: the artist's own versions of any length
    // (time-stamped lyrics only from a version of the same length, as they fit only that recording), then the title
    // without "(Live)", "[Remastered]" and the like, then the same title by any artist (the original of a cover).
    let fetch = |query: String| -> SourceResult<Vec<Value>> {
        pause();
        let address = format!("{base}/api/search?{query}");
        let reply = http_get(&address, user_agent, timeout)?;
        if let Some((code, message)) = reply_problem(&reply) {
            return fail(&code, message);
        }
        let items = serde_json::from_slice::<Value>(&reply.body)
            .ok()
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        Ok(items.iter().filter_map(candidate).collect())
    };
    let search = |track: &str, by: Option<&str>| -> SourceResult<Vec<Value>> {
        let mut query = format!("track_name={}", encode(track));
        if let Some(by) = by {
            query.push_str(&format!("&artist_name={}", encode(by)));
        }
        fetch(query)
    };
    let normal = mediaverse_tag_repair::names::normalise;
    let mut found = rank(search(title, Some(artist))?, duration_seconds);
    let mut via = "search";
    let plain_title = core_title(title);
    if found.is_empty() && plain_title != title.trim() {
        found = rank(search(&plain_title, Some(artist))?, duration_seconds);
    }
    // The artist's name may be written differently on LRCLIB: the first of several ("A feat. B", "A; B"), or the
    // whole list asked as one free-text search. Only answers whose artist really is this one (spelling, "The",
    // "&" and punctuation aside) count as the artist's own recordings.
    if found.is_empty()
        && let Some(lead) = lead_artist(artist)
    {
        let wanted = normal(&lead);
        let mine = |c: &Value| c["artist"].as_str().is_some_and(|a| normal(a) == wanted);
        found = rank(
            search(&plain_title, Some(&lead))?
                .into_iter()
                .filter(mine)
                .collect(),
            duration_seconds,
        );
    }
    if found.is_empty() {
        let wanted_artist = normal(artist);
        let wanted_title = normal(&plain_title);
        let lead = lead_artist(artist).map(|l| normal(&l));
        found = rank(
            fetch(format!("q={}", encode(&format!("{plain_title} {artist}"))))?
                .into_iter()
                .filter(|c| {
                    c["track"]
                        .as_str()
                        .is_some_and(|t| normal(&core_title(t)) == wanted_title)
                        && c["artist"].as_str().is_some_and(|a| {
                            let a = normal(a);
                            a == wanted_artist || lead.as_deref() == Some(a.as_str())
                        })
                })
                .collect(),
            duration_seconds,
        );
    }
    // A few other spellings (curly apostrophe, "The", "&" / "and") when the title as written found nothing.
    // Stop at the first hit so an ordinary lookup does not become a long list of requests.
    if found.is_empty() {
        let titles: Vec<String> = mediaverse_lyric_ai::text::title_variants(title)
            .into_iter()
            .take(2)
            .collect();
        let artists: Vec<String> = mediaverse_lyric_ai::text::name_variants(artist)
            .into_iter()
            .take(2)
            .collect();
        'variants: for track in &titles {
            for by in &artists {
                if track.trim() == title.trim() && by.eq_ignore_ascii_case(artist.trim()) {
                    continue;
                }
                let hits = rank(search(track, Some(by))?, duration_seconds);
                if !hits.is_empty() {
                    found = hits;
                    break 'variants;
                }
            }
        }
    }
    if found.is_empty() {
        via = "other_artists";
        let wanted = mediaverse_tag_repair::names::normalise(&plain_title);
        found = search(&plain_title, None)?
            .into_iter()
            .filter(|c| {
                c["track"].as_str().is_some_and(|t| {
                    mediaverse_tag_repair::names::normalise(&core_title(t)) == wanted
                })
            })
            .map(|mut c| {
                // Another artist's recording: the words, not their timing.
                c["other_artist"] = json!(true);
                c["synced"] = Value::Null;
                c
            })
            .filter(|c| c["plain"].is_string())
            .collect();
    }
    for c in &mut found {
        c["confidence"] = json!(confidence(c, title, album, duration_seconds));
    }
    // Best first by confidence, keeping the ranking's order among equals.
    found.sort_by(|a, b| b["confidence"].as_u64().cmp(&a["confidence"].as_u64()));
    found.truncate(MAX_RESULTS);
    Ok(json!({ "via": via, "results": found }))
}

/// Every LRCLIB record that roughly matches the artist and title (lyric AI, D127): the title as written and in other spellings (numbers and Roman numerals both
/// ways, "&"/"and", without a track number, bracketed notes or "feat."), with the artist as written and without a "feat." list or a leading "The", then a free-text
/// search. The AI (letters read from the singing) decides which of them is this song, so this casts wide: records by other artists are kept too (after the
/// artist's own). Quick by default: it stops as soon as a record by the same artist with lyrics is found; `thorough` goes on through every spelling.
/// Each answer is `candidate()`'s shape plus `"same_artist": bool`. At most 60, the artist's own first.
pub fn loose_candidates(
    base_url: &str,
    title: &str,
    artist: &str,
    thorough: bool,
    user_agent: &str,
    pause: &dyn Fn(),
) -> SourceResult<Vec<Value>> {
    if title.trim().is_empty() || artist.trim().is_empty() {
        return fail(
            "missing_details",
            "Lyrics can only be looked up for a song with a title and an artist. Fix its tags first.",
        );
    }
    let base = base_url.trim_end_matches('/');
    let timeout = Duration::from_secs(20);
    let normal = mediaverse_tag_repair::names::normalise;
    // Spellings of the title (numbers, brackets, track numbers) and the look-alike characters made plain; and of the artist (apostrophes, dashes, "!", "The",
    // "&"): the small differences that make exact matches fail. Few of each, the likeliest first.
    let mut titles: Vec<String> = mediaverse_lyric_ai::text::title_variants(title)
        .into_iter()
        .take(3)
        .collect();
    let plain_title = mediaverse_lyric_ai::text::plain_punctuation(title);
    if !titles.contains(&plain_title) {
        titles.insert(1.min(titles.len()), plain_title);
    }
    titles.truncate(4);
    let mut artists: Vec<String> = mediaverse_lyric_ai::text::name_variants(artist)
        .into_iter()
        .take(3)
        .collect();
    if let Some(lead) = lead_artist(artist) {
        artists.push(lead);
    }
    // every spelling counts as "the artist's own" when the records are compared (case, punctuation and "The" aside)
    let wanted: Vec<String> = mediaverse_lyric_ai::text::name_variants(artist)
        .iter()
        .map(|a| normal(a))
        .chain(artists.iter().map(|a| normal(a)))
        .collect();
    let search = |query: String| -> SourceResult<Vec<Value>> {
        pause();
        let reply = http_get(&format!("{base}/api/search?{query}"), user_agent, timeout)?;
        if let Some((code, message)) = reply_problem(&reply) {
            return fail(&code, message);
        }
        let items = serde_json::from_slice::<Value>(&reply.body)
            .ok()
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        Ok(items
            .iter()
            .filter_map(candidate)
            .map(|mut item| {
                let mine = item["artist"]
                    .as_str()
                    .is_some_and(|a| wanted.contains(&normal(a)));
                item["same_artist"] = json!(mine);
                item
            })
            .collect())
    };
    let mut found: Vec<Value> = Vec::new();
    let mut seen = std::collections::HashSet::new();
    let mut absorb = |found: &mut Vec<Value>, items: Vec<Value>| {
        for item in items {
            if item["id"].as_i64().is_none_or(|id| seen.insert(id)) {
                found.push(item);
            }
        }
    };
    let has_own = |found: &[Value]| {
        found.iter().any(|c| {
            c["same_artist"] == true && (c["plain"].is_string() || c["synced"].is_string())
        })
    };
    'queries: {
        for t in &titles {
            for a in &artists {
                absorb(
                    &mut found,
                    search(format!(
                        "track_name={}&artist_name={}",
                        encode(t),
                        encode(a)
                    ))?,
                );
                if !thorough && has_own(&found) {
                    break 'queries;
                }
            }
        }
        for t in titles.iter().take(2) {
            absorb(
                &mut found,
                search(format!("q={}", encode(&format!("{t} {artist}"))))?,
            );
            if !thorough && has_own(&found) {
                break 'queries;
            }
        }
        // the same title by anyone: the words may be filed under another spelling of the artist
        absorb(
            &mut found,
            search(format!("track_name={}", encode(&titles[0])))?,
        );
    }
    found.sort_by_key(|c| c["same_artist"] != true);
    found.truncate(60);
    Ok(found)
}
/// How likely a search answer is this song's lyrics, 0 to 99 (100 is kept for LRCLIB's exact match). Owner, 2026-11-20 (D155): the words are decided by the
/// artist's name and the song's name, never by length. The artist's own song of that title is very likely right whatever its length (a live version or another
/// release has the same words); another artist's recording of that title is a fair guess (the original of a cover, which the Lyric AI then checks against the
/// singing). Length only helps pick the best *pre-timed* lyrics: a version of the same length (its time stamps fit) scores highest, one close enough to be
/// lined up a little less, and a version of any other length keeps its words at the same base score. The same title as written, the same album and time-stamped
/// lyrics add a little.
fn confidence(c: &Value, title: &str, album: Option<&str>, duration_seconds: Option<f64>) -> u64 {
    let normal = mediaverse_tag_repair::names::normalise;
    let base: f64 = if c["other_artist"] == true {
        56.0
    } else {
        let bonus = match (duration_seconds, c["duration"].as_f64()) {
            (Some(ours), Some(theirs)) if (ours - theirs).abs() <= SEARCH_DURATION_SLACK => 8.0,
            (Some(ours), Some(theirs)) if (ours - theirs).abs() <= ALIGN_SLACK => 4.0,
            _ => 0.0,
        };
        // One of the two lengths is unknown: nothing says it is the same recording, so it earns no length bonus and the person decides (see `rank`).
        84.0 + bonus
    };
    let same_title = c["track"]
        .as_str()
        .is_some_and(|t| normal(t) == normal(title));
    let same_album = album
        .filter(|a| !a.trim().is_empty())
        .is_some_and(|a| c["album"].as_str().is_some_and(|b| normal(a) == normal(b)));
    // Time-stamped lyrics are only kept for a recording of the same length, so they are a small sign of a good fit.
    let synced = c["synced"].is_string();
    let score = base
        + if same_title { 4.0 } else { 0.0 }
        + if same_album { 3.0 } else { 0.0 }
        + if synced { 3.0 } else { 0.0 };
    score.round().clamp(1.0, 99.0) as u64
}
/// The artist's versions, best first: a version of the same length (within a few seconds) keeps its time-stamped
/// lyrics; another version (live, an edit, another album) offers its plain lyrics only, marked `other_version`.
fn rank(candidates: Vec<Value>, duration_seconds: Option<f64>) -> Vec<Value> {
    let mut found: Vec<(f64, Value)> = candidates
        .into_iter()
        .map(|mut c| {
            let gap = match (duration_seconds, c["duration"].as_f64()) {
                (Some(ours), Some(theirs)) => (ours - theirs).abs(),
                _ => 0.0,
            };
            if gap > SEARCH_DURATION_SLACK {
                c["other_version"] = json!(true);
                if gap > ALIGN_SLACK {
                    c["synced"] = Value::Null;
                } else if c["synced"].is_string() {
                    c["needs_alignment"] = json!(true);
                }
            }
            // Without the song's own length nothing says this is the same recording: the person decides (the
            // automatic lyrics leave these alone).
            if duration_seconds.is_none() {
                c["length_unknown"] = json!(true);
            }
            (gap, c)
        })
        .filter(|(_, c)| {
            c["plain"].is_string() || c["synced"].is_string() || c["instrumental"] == true
        })
        .collect();
    // Same length first, synced lyrics first among those, then the closest length.
    found.sort_by(|a, b| {
        let same = |g: f64| g <= SEARCH_DURATION_SLACK;
        let synced = |c: &Value| c["synced"].is_string();
        same(b.0)
            .cmp(&same(a.0))
            .then(synced(&b.1).cmp(&synced(&a.1)))
            .then(a.0.total_cmp(&b.0))
    });
    found.into_iter().map(|(_, c)| c).collect()
}

/// The first name of an artist tag that lists several ("Band feat. Guest", "A; B", "A / B", "A, B"); `None` for a single
/// name. ("A & B" and "A and B" are left whole: many bands are named so.)
pub fn lead_artist(artist: &str) -> Option<String> {
    let text = artist.trim();
    let lower = text.to_ascii_lowercase(); // same byte positions as `text`
    let cut = [
        " feat. ",
        " feat ",
        " ft. ",
        " featuring ",
        " with ",
        "; ",
        ";",
        " / ",
        ", ",
    ]
    .iter()
    .filter_map(|marker| lower.find(marker))
    .filter(|at| *at > 0)
    .min()?;
    let lead = text[..cut].trim();
    (!lead.is_empty()).then(|| lead.to_owned())
}

/// A song title without what tells versions apart: bracketed or dashed "Live", "Remastered 2011", "Acoustic",
/// "Demo", "Radio Edit", "Mono", "Bonus Track", "Explicit" and "feat." credits ("Song (Live at Wembley) [Remastered]"
/// is "Song"). The title stays as it is when nothing like that is found.
pub fn core_title(title: &str) -> String {
    const VERSION_WORDS: [&str; 15] = [
        "live",
        "remaster",
        "remastered",
        "acoustic",
        "demo",
        "edit",
        "version",
        "mono",
        "stereo",
        "bonus",
        "explicit",
        "clean",
        "unplugged",
        "mix",
        "session",
    ];
    let is_version = |text: &str| {
        let lower = text.to_lowercase();
        lower.starts_with("feat")
            || lower.starts_with("ft.")
            || lower.starts_with("with ")
            || VERSION_WORDS.iter().any(|w| {
                lower
                    .split(|c: char| !c.is_alphanumeric())
                    .any(|word| word == *w)
            })
    };
    let mut text = title.trim().to_owned();
    loop {
        let before = text.clone();
        // A bracketed part at the end: "(Live)", "[Remastered 2011]", "(feat. Someone)".
        for (open, close) in [('(', ')'), ('[', ']')] {
            if text.ends_with(close)
                && let Some(at) = text.rfind(open)
                && at > 0
                && is_version(&text[at + 1..text.len() - 1])
            {
                text = text[..at].trim_end().to_owned();
            }
        }
        // A dashed part at the end: "Song - Live at Wembley", "Song - 2011 Remaster".
        if let Some(at) = text.rfind(" - ")
            && at > 0
            && is_version(&text[at + 3..])
        {
            text = text[..at].trim_end().to_owned();
        }
        // "Song feat. Someone" without brackets.
        for marker in [" feat. ", " ft. ", " featuring "] {
            if let Some(at) = text.to_lowercase().find(marker)
                && at > 0
            {
                text = text[..at].trim_end().to_owned();
            }
        }
        if text == before {
            break;
        }
    }
    if text.is_empty() {
        title.trim().to_owned()
    } else {
        text
    }
}

const CACHE_TTL: Duration = Duration::from_secs(30 * 24 * 60 * 60);

fn cache_name(
    title: &str,
    artist: &str,
    album: Option<&str>,
    duration_seconds: Option<f64>,
) -> String {
    let mut hash: u64 = 0xcbf29ce484222325;
    let key = format!(
        "{}\n{}\n{}\n{}",
        title.trim().to_lowercase(),
        artist.trim().to_lowercase(),
        album.unwrap_or("").trim().to_lowercase(),
        duration_seconds.unwrap_or(-1.0).round() as i64
    );
    for byte in key.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x100000001b3);
    }
    format!("{hash:016x}.json")
}

/// A successful LRCLIB reply kept on disk, so the same song is not asked about again for a month. Misses and
/// errors are not kept: a song can be added to LRCLIB later.
pub fn cached_lyrics(
    dir: &Path,
    title: &str,
    artist: &str,
    album: Option<&str>,
    duration_seconds: Option<f64>,
) -> Option<Value> {
    let path = dir.join(cache_name(title, artist, album, duration_seconds));
    let modified = path.metadata().ok()?.modified().ok()?;
    if modified.elapsed().ok()? > CACHE_TTL {
        let _ = std::fs::remove_file(&path);
        return None;
    }
    let text = std::fs::read_to_string(path).ok()?;
    let value: Value = serde_json::from_str(&text).ok()?;
    value["results"]
        .as_array()
        .is_some_and(|r| !r.is_empty())
        .then_some(value)
}

pub fn store_lyrics(
    dir: &Path,
    title: &str,
    artist: &str,
    album: Option<&str>,
    duration_seconds: Option<f64>,
    value: &Value,
) {
    if value["results"].as_array().is_none_or(Vec::is_empty) {
        return;
    }
    if std::fs::create_dir_all(dir).is_err() {
        return;
    }
    let path = dir.join(cache_name(title, artist, album, duration_seconds));
    let _ = std::fs::write(path, value.to_string());
}

/// MusicBrainz recording search, then that recording's work, then the work's other recordings. Used only when
/// LRCLIB has nothing, and only the artist names come back (the lyrics themselves still come from LRCLIB).
pub fn recording_search_url(base: &str, artist: &str, title: &str) -> String {
    let query = format!(
        "recording:\"{}\" AND artist:\"{}\"",
        title.replace(['"', '\\'], " "),
        artist.replace(['"', '\\'], " ")
    );
    format!(
        "{}/ws/2/recording/?query={}&fmt=json&limit=3",
        base.trim_end_matches('/'),
        encode(&query)
    )
}

pub fn recording_lookup_url(base: &str, id: &str) -> String {
    format!(
        "{}/ws/2/recording/{}?inc=work-rels&fmt=json",
        base.trim_end_matches('/'),
        encode(id)
    )
}

pub fn work_lookup_url(base: &str, id: &str) -> String {
    format!(
        "{}/ws/2/work/{}?inc=recording-rels+artist-credits&fmt=json",
        base.trim_end_matches('/'),
        encode(id)
    )
}

fn mb_id(value: &str) -> bool {
    value.len() == 36 && value.bytes().all(|b| b.is_ascii_hexdigit() || b == b'-')
}

pub fn first_recording_id(reply: &str) -> Option<String> {
    let value: Value = serde_json::from_str(reply).ok()?;
    value["recordings"]
        .as_array()?
        .iter()
        .filter_map(|r| r["id"].as_str())
        .find(|id| mb_id(id))
        .map(str::to_owned)
}

pub fn work_id_from_recording(reply: &str) -> Option<String> {
    let value: Value = serde_json::from_str(reply).ok()?;
    value["relations"].as_array()?.iter().find_map(|rel| {
        rel["work"]["id"]
            .as_str()
            .filter(|id| mb_id(id))
            .map(str::to_owned)
    })
}

/// Artist names on a work's other recordings, not the artist already asked about. At most three.
pub fn other_artists_from_work(reply: &str, exclude: &str) -> Vec<String> {
    let Ok(value) = serde_json::from_str::<Value>(reply) else {
        return Vec::new();
    };
    let normal = mediaverse_tag_repair::names::normalise;
    let skip = normal(exclude);
    let mut out = Vec::new();
    for rel in value["relations"].as_array().into_iter().flatten() {
        let name = rel["recording"]["artist-credit"]
            .as_array()
            .map(|credits| {
                credits
                    .iter()
                    .map(|c| {
                        format!(
                            "{}{}",
                            c["name"].as_str().unwrap_or(""),
                            c["joinphrase"].as_str().unwrap_or("")
                        )
                    })
                    .collect::<String>()
            })
            .filter(|n| !n.trim().is_empty());
        let Some(name) = name else { continue };
        if normal(&name) == skip
            || out
                .iter()
                .any(|have: &String| normal(have) == normal(&name))
        {
            continue;
        }
        out.push(name);
        if out.len() == 3 {
            break;
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_secure_or_local_addresses_are_allowed() {
        assert!(allowed_base_url("https://lrclib.net"));
        assert!(allowed_base_url("http://127.0.0.1:8080"));
        assert!(allowed_base_url("http://localhost:1"));
        assert!(!allowed_base_url("http://lrclib.net"));
        assert!(!allowed_base_url("http://evil.example/127.0.0.1"));
        assert!(!allowed_base_url("ftp://x"));
    }

    #[test]
    fn answers_are_trimmed_and_empty_ones_dropped() {
        let full = json!({ "id": 7, "trackName": "Song\u{0}", "artistName": "Band", "albumName": "LP", "duration": 201.0, "instrumental": false, "plainLyrics": "words", "syncedLyrics": "[00:01.00]words" });
        let c = candidate(&full).unwrap();
        assert_eq!(c["track"], "Song");
        assert_eq!(c["synced"], "[00:01.00]words");
        assert!(
            candidate(&json!({ "plainLyrics": "  ", "syncedLyrics": null, "instrumental": false }))
                .is_none()
        );
        assert_eq!(
            candidate(&json!({ "instrumental": true })).unwrap()["instrumental"],
            true
        );
    }

    #[test]
    fn titles_and_artists_cannot_change_the_request() {
        assert_eq!(encode("AC/DC & Co?x=1#"), "AC%2FDC%20%26%20Co%3Fx%3D1%23");
        assert_eq!(encode("Zoë"), "Zo%C3%AB");
    }

    #[test]
    fn a_song_without_title_or_artist_is_refused_before_any_request() {
        let never = || panic!("no request may be made");
        assert_eq!(
            find_lyrics("http://127.0.0.1:1", " ", "A", None, None, "ua", &never)
                .unwrap_err()
                .0,
            "missing_details"
        );
        assert_eq!(
            find_lyrics("http://127.0.0.1:1", "T", "", None, None, "ua", &never)
                .unwrap_err()
                .0,
            "missing_details"
        );
    }

    #[test]
    fn version_words_come_off_the_title() {
        assert_eq!(
            core_title("Song (Live at Wembley) [Remastered 2011]"),
            "Song"
        );
        assert_eq!(core_title("Song - 2011 Remaster"), "Song");
        assert_eq!(core_title("Song feat. Someone"), "Song");
        assert_eq!(core_title("Song (feat. Someone)"), "Song");
        assert_eq!(core_title("Hooray for Me..."), "Hooray for Me...");
        assert_eq!(
            core_title("Smells Like Teen Spirit - Live"),
            "Smells Like Teen Spirit"
        );
        assert_eq!(
            core_title("(What's So Funny 'Bout) Peace, Love and Understanding"),
            "(What's So Funny 'Bout) Peace, Love and Understanding",
            "a bracket that is part of the name stays"
        );
        assert_eq!(
            core_title("Live and Let Die"),
            "Live and Let Die",
            "a title that only starts with a version word stays"
        );
    }

    #[test]
    fn a_track_number_in_front_of_a_title_is_found_and_taken_off() {
        assert_eq!(
            without_track_number("14 Donut Dan").as_deref(),
            Some("Donut Dan")
        );
        assert_eq!(
            without_track_number("1. All For Nothing").as_deref(),
            Some("All For Nothing")
        );
        assert_eq!(
            without_track_number("01 - something always happens").as_deref(),
            Some("something always happens")
        );
        assert_eq!(
            without_track_number("03) (Untitled)").as_deref(),
            Some("(Untitled)")
        );
        for none in [
            "Donut Dan",
            "1979",
            "1-800-273-8255",
            "3 1/2",
            "21",
            "1234 Main Street",
            "7",
        ] {
            assert_eq!(without_track_number(none), None, "{none}");
        }
    }

    #[test]
    fn the_first_artist_of_a_list_is_found() {
        assert_eq!(lead_artist("Band feat. Guest").as_deref(), Some("Band"));
        assert_eq!(lead_artist("A; B").as_deref(), Some("A"));
        assert_eq!(lead_artist("A, B").as_deref(), Some("A"));
        assert_eq!(lead_artist("A / B").as_deref(), Some("A"));
        assert_eq!(lead_artist("Simon & Garfunkel"), None);
        assert_eq!(lead_artist("Mumford and Sons"), None);
        assert_eq!(lead_artist("Band"), None);
    }

    #[test]
    fn other_artists_on_a_work_are_kept_and_the_one_already_asked_is_not() {
        let reply = r#"{"relations":[
          {"recording":{"artist-credit":[{"name":"Band","joinphrase":""}]}},
          {"recording":{"artist-credit":[{"name":"Original","joinphrase":" & "},{"name":"Guest","joinphrase":""}]}},
          {"recording":{"artist-credit":[{"name":"band","joinphrase":""}]}},
          {"recording":{"artist-credit":[{"name":"Third","joinphrase":""}]}}
        ]}"#;
        assert_eq!(
            other_artists_from_work(reply, "Band"),
            vec!["Original & Guest".to_owned(), "Third".to_owned()]
        );
        assert!(other_artists_from_work("not json", "Band").is_empty());
    }

    #[test]
    fn other_versions_offer_their_words_but_not_their_timing() {
        let item = |id: u32, duration: f64| {
            candidate(&json!({ "id": id, "trackName": "Song", "artistName": "Band", "duration": duration, "plainLyrics": "words", "syncedLyrics": "[00:01.00]words" })).unwrap()
        };
        let ranked = rank(vec![item(1, 300.0), item(2, 201.0)], Some(200.0));
        assert_eq!(ranked[0]["id"], 2, "the same length first");
        assert!(ranked[0]["synced"].is_string() && ranked[0].get("other_version").is_none());
        assert_eq!(
            (
                ranked[1]["other_version"].clone(),
                ranked[1]["synced"].clone()
            ),
            (json!(true), Value::Null),
            "a live version far from this recording: plain lyrics only"
        );
        let near = rank(vec![item(4, 215.0)], Some(200.0));
        assert_eq!(near[0]["other_version"], true);
        assert_eq!(near[0]["needs_alignment"], true);
        assert!(near[0]["synced"].is_string(), "close enough to line up");
        assert_eq!(
            rank(vec![item(3, 500.0)], None)[0]["synced"],
            "[00:01.00]words",
            "no length to compare: kept"
        );
    }

    #[test]
    fn confidence_follows_the_names_and_length_only_picks_the_pre_timed_version() {
        let c = |extra: Value| {
            let mut v = json!({ "track": "Song", "album": "LP", "duration": 200.0 });
            for (k, x) in extra.as_object().unwrap() {
                v[k] = x.clone();
            }
            confidence(&v, "Song", Some("LP"), Some(201.0))
        };
        let same = c(json!({}));
        let close = c(json!({ "other_version": true, "duration": 212.0 }));
        let live = c(json!({ "other_version": true, "duration": 260.0 }));
        let far = c(json!({ "other_version": true, "duration": 600.0 }));
        let unknown = c(json!({ "length_unknown": true, "duration": Value::Null }));
        let cover = c(json!({ "other_artist": true }));
        assert!(same > close && close > live, "{same} {close} {live}");
        assert_eq!(
            live, far,
            "a different length does not make the words less likely"
        );
        assert_eq!(live, unknown, "no length to compare earns no bonus either");
        assert!(
            live >= 60,
            "the artist's own song of that title is judged by the Lyric AI whatever its length: {live}"
        );
        assert!(
            cover >= 60 && cover < live,
            "a cover's original is judged too, after the artist's own: {cover}"
        );
        assert!(same <= 99, "100 is for the exact match only");
    }
}
