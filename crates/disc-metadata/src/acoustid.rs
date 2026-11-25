//! AcoustID (ADR 0006): what a recording's audio fingerprint says it is, and what that says about a ripped disc.
//!
//! The lookup is a POST to `{server}/v2/lookup` with the application key as `client`, the track's length in seconds
//! and its Chromaprint fingerprint (https://acoustid.org/webservice). This module builds the request body, reads the
//! reply and compares the answers with the details the person chose for the disc. It never touches the network or
//! any file, so it is tested with recorded replies; the fingerprint itself is made in the sidecar.

use serde::Serialize;
use serde_json::Value;
use std::collections::BTreeMap;

/// Results below this score are ignored: AcoustID reports how sure it is, 1.0 being certain.
pub const MIN_SCORE: f64 = 0.6;

/// An album (release group) a recording appears on.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Group {
    pub title: String,
    pub artist: String,
    /// A studio album: not a compilation, live album, single or the like.
    pub plain_album: bool,
}

/// A recording AcoustID knows by the fingerprint.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Recording {
    pub id: String,
    /// The AcoustID of the result this recording came with (what the `Acoustid Id` tag holds).
    pub acoustid_id: String,
    pub title: String,
    pub artist: String,
    pub groups: Vec<Group>,
}

/// The answer for one fingerprint: the recordings of every result sure enough, best result first.
#[derive(Clone, Debug, PartialEq)]
pub struct Found {
    pub score: f64,
    pub recordings: Vec<Recording>,
}

/// The form body of a lookup. `client` is the application key, so the body (not the address) carries it.
pub fn lookup_body(client: &str, duration_seconds: u32, fingerprint: &str) -> String {
    format!(
        "client={}&format=json&meta=recordings+releasegroups&duration={duration_seconds}&fingerprint={fingerprint}",
        encode(client)
    )
}

fn encode(text: &str) -> String {
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

fn joined_names(artists: &Value) -> String {
    let mut text = String::new();
    for artist in artists.as_array().into_iter().flatten() {
        text.push_str(artist["name"].as_str().unwrap_or(""));
        text.push_str(artist["joinphrase"].as_str().unwrap_or(""));
    }
    text.trim().to_owned()
}

/// Reads a lookup reply. `Ok(None)` is "AcoustID does not know this audio" (no result sure enough, or none linked to a
/// recording); an error is a reply that is not a lookup answer, or AcoustID's own complaint.
pub fn parse_lookup(json: &str) -> Result<Option<Found>, String> {
    let reply: Value =
        serde_json::from_str(json).map_err(|e| format!("not a lookup reply: {e}"))?;
    match reply["status"].as_str() {
        Some("ok") => {}
        _ => {
            return Err(reply["error"]["message"].as_str().map_or_else(
                || "AcoustID gave no answer".to_owned(),
                |m| format!("AcoustID said: {m}"),
            ));
        }
    }
    let mut results: Vec<&Value> = reply["results"]
        .as_array()
        .into_iter()
        .flatten()
        .filter(|r| r["score"].as_f64().unwrap_or(0.0) >= MIN_SCORE)
        .collect();
    results.sort_by(|a, b| {
        b["score"]
            .as_f64()
            .partial_cmp(&a["score"].as_f64())
            .unwrap_or(std::cmp::Ordering::Equal)
    });
    let mut recordings = Vec::new();
    for result in &results {
        for recording in result["recordings"].as_array().into_iter().flatten() {
            let (Some(id), Some(title)) = (recording["id"].as_str(), recording["title"].as_str())
            else {
                continue;
            };
            if recordings.iter().any(|r: &Recording| r.id == id) {
                continue;
            }
            let groups = recording["releasegroups"]
                .as_array()
                .into_iter()
                .flatten()
                .filter_map(|g| {
                    Some(Group {
                        title: g["title"].as_str()?.to_owned(),
                        artist: joined_names(&g["artists"]),
                        plain_album: g["type"].as_str() == Some("Album")
                            && g["secondarytypes"].as_array().is_none_or(|a| a.is_empty()),
                    })
                })
                .collect();
            recordings.push(Recording {
                id: id.to_owned(),
                acoustid_id: result["id"].as_str().unwrap_or("").to_owned(),
                title: title.to_owned(),
                artist: joined_names(&recording["artists"]),
                groups,
            });
        }
    }
    let score = results
        .first()
        .and_then(|r| r["score"].as_f64())
        .unwrap_or(0.0);
    Ok((!recordings.is_empty()).then_some(Found { score, recordings }))
}

/// A title as compared: lower case, letters and digits only, without anything in brackets or after " - " ("Song (Live)",
/// "Song - Remastered 2011"), so spelling decorations do not count as a different song.
pub fn comparable(title: &str) -> String {
    let mut plain = String::new();
    let mut depth = 0usize;
    let mut rest = title;
    if let Some(at) = title.find(" - ") {
        rest = &title[..at];
    }
    for c in rest.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            c if depth == 0 && c.is_alphanumeric() => plain.extend(c.to_lowercase()),
            _ => {}
        }
    }
    plain
}

/// The details chosen for one track of the disc.
#[derive(Clone, Debug)]
pub struct Chosen {
    pub number: u32,
    pub title: String,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum TrackState {
    /// AcoustID names the song the same as the chosen title.
    Agrees,
    /// AcoustID names a different song.
    Other,
    /// AcoustID names the song and no title was chosen to compare with.
    Named,
    /// AcoustID does not know this audio.
    Unknown,
    /// The fingerprint or the question could not be made.
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct TrackCheck {
    pub number: u32,
    pub state: TrackState,
    /// What AcoustID calls it (the first recording, or the one that agrees).
    pub title: Option<String>,
    pub artist: Option<String>,
    pub recording_id: Option<String>,
    /// The AcoustID of the matching result.
    pub acoustid_id: Option<String>,
    pub score: Option<f64>,
    /// True when it is safe to write this track's MusicBrainz recording id and AcoustID into its tags: AcoustID agrees with the
    /// title chosen and is sure (0.85), or names a track nobody titled, unambiguously and very surely (0.9).
    pub tag_ids: bool,
    /// True when a track nobody titled should take AcoustID's title: one name for every recording it offers, and very sure (0.9).
    pub name_it: bool,
    /// For a different song: the chosen track whose title it carries (the tracks may be in another order).
    pub sounds_like: Option<u32>,
    /// Why it failed.
    pub problem: Option<String>,
}

#[derive(Clone, Debug, Serialize)]
pub struct AlbumHint {
    pub title: String,
    pub artist: String,
    /// How many of the recognised tracks are on it.
    pub tracks: usize,
    pub of: usize,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum DiscState {
    /// Every recognised track is the song chosen for it.
    Agrees,
    /// Some are, some are other songs.
    Mixed,
    /// Recognised, but none is the song chosen for it.
    Different,
    /// Recognised, with no titles chosen to compare with.
    Named,
    /// AcoustID knows none of it.
    Unknown,
    /// Nothing could be asked.
    Failed,
}

#[derive(Clone, Debug, Serialize)]
pub struct DiscCheck {
    pub state: DiscState,
    pub headline: String,
    pub tracks: Vec<TrackCheck>,
    pub album_hint: Option<AlbumHint>,
}

fn plural(n: usize, one: &str, many: &str) -> String {
    if n == 1 {
        format!("{n} {one}")
    } else {
        format!("{n} {many}")
    }
}

/// A title that says nothing ("Track 3", empty): there is nothing to compare with.
fn is_placeholder(title: &str) -> bool {
    let plain = comparable(title);
    plain.is_empty()
        || plain
            .strip_prefix("track")
            .is_some_and(|rest| rest.chars().all(|c| c.is_ascii_digit()))
}

/// Compares what AcoustID found for each track with the details chosen for the disc.
pub fn check_disc(
    chosen_album: &str,
    chosen: &[Chosen],
    found: &[(u32, Result<Option<Found>, String>)],
) -> DiscCheck {
    let mut tracks = Vec::new();
    for (number, answer) in found {
        let wanted = chosen
            .iter()
            .find(|c| c.number == *number)
            .map(|c| c.title.as_str())
            .filter(|t| !is_placeholder(t));
        let mut check = TrackCheck {
            number: *number,
            state: TrackState::Unknown,
            title: None,
            artist: None,
            recording_id: None,
            acoustid_id: None,
            score: None,
            tag_ids: false,
            name_it: false,
            sounds_like: None,
            problem: None,
        };
        match answer {
            Err(problem) => {
                check.state = TrackState::Failed;
                check.problem = Some(problem.clone());
            }
            Ok(None) => {}
            Ok(Some(one)) => {
                let same = wanted.and_then(|w| {
                    one.recordings
                        .iter()
                        .find(|r| comparable(&r.title) == comparable(w))
                });
                let shown = same.unwrap_or(&one.recordings[0]);
                check.title = Some(shown.title.clone());
                check.artist = Some(shown.artist.clone());
                check.recording_id = Some(shown.id.clone());
                check.acoustid_id = Some(shown.acoustid_id.clone()).filter(|id| !id.is_empty());
                check.score = Some(one.score);
                let unambiguous = one
                    .recordings
                    .iter()
                    .all(|r| comparable(&r.title) == comparable(&shown.title));
                check.state = match (wanted, same) {
                    (_, Some(_)) => TrackState::Agrees,
                    (Some(_), None) => TrackState::Other,
                    (None, None) => TrackState::Named,
                };
                check.name_it = check.state == TrackState::Named && unambiguous && one.score >= 0.9;
                check.tag_ids = match check.state {
                    TrackState::Agrees => one.score >= 0.85,
                    TrackState::Named => check.name_it,
                    _ => false,
                };
                if check.state == TrackState::Other {
                    check.sounds_like = chosen
                        .iter()
                        .find(|c| {
                            c.number != *number
                                && one
                                    .recordings
                                    .iter()
                                    .any(|r| comparable(&r.title) == comparable(&c.title))
                        })
                        .map(|c| c.number);
                }
            }
        }
        tracks.push(check);
    }
    let count = |state| tracks.iter().filter(|t| t.state == state).count();
    let (agrees, other, named, failed) = (
        count(TrackState::Agrees),
        count(TrackState::Other),
        count(TrackState::Named),
        count(TrackState::Failed),
    );
    let total = tracks.len();
    let state = match (agrees, other, named) {
        (0, 0, 0) if failed == total && total > 0 => DiscState::Failed,
        (0, 0, 0) => DiscState::Unknown,
        (_, 0, _) if agrees > 0 => DiscState::Agrees,
        (0, 0, _) => DiscState::Named,
        (0, _, _) => DiscState::Different,
        _ => DiscState::Mixed,
    };
    let reordered = tracks.iter().filter(|t| t.sounds_like.is_some()).count();
    let headline = match state {
        DiscState::Agrees => format!("AcoustID recognised {} of {total} by the audio, and each is the song you chose.", agrees),
        DiscState::Mixed => format!("AcoustID recognised {} as the songs you chose, but {} {} other songs than {}.", plural(agrees, "track", "tracks"), plural(other, "track", "tracks"), if other == 1 { "sounds like" } else { "sound like" }, if other == 1 { "its title" } else { "their titles" }),
        DiscState::Different => format!(
            "AcoustID recognised the audio, but {} not the songs you chose{}. The details may be for a different album.",
            if other == 1 { "the track is" } else { "the tracks are" },
            if reordered > 0 { " (some carry another track's title, so the order may differ)" } else { "" }
        ),
        DiscState::Named => format!("AcoustID recognised {} but no titles were chosen to compare with.", plural(named, "track", "tracks")),
        DiscState::Unknown => "AcoustID does not know this audio (common for rare or new releases), so there is nothing to compare.".to_owned(),
        DiscState::Failed => "AcoustID could not be asked.".to_owned(),
    };
    let album_hint = if matches!(state, DiscState::Agrees) {
        None
    } else {
        album_hint(chosen_album, found)
    };
    DiscCheck {
        state,
        headline,
        tracks,
        album_hint,
    }
}

/// The album most of the recognised tracks appear on, when it is not the one chosen. Studio albums win ties over
/// compilations.
fn album_hint(
    chosen_album: &str,
    found: &[(u32, Result<Option<Found>, String>)],
) -> Option<AlbumHint> {
    let mut counts: BTreeMap<(String, String), (usize, bool, String, String)> = BTreeMap::new();
    let mut named = 0;
    for (_, answer) in found {
        let Ok(Some(one)) = answer else { continue };
        named += 1;
        let mut seen = Vec::new();
        for group in one.recordings.iter().flat_map(|r| r.groups.iter()) {
            let key = (comparable(&group.title), comparable(&group.artist));
            if key.0.is_empty() || seen.contains(&key) {
                continue;
            }
            seen.push(key.clone());
            let entry =
                counts
                    .entry(key)
                    .or_insert((0, false, group.title.clone(), group.artist.clone()));
            entry.0 += 1;
            entry.1 |= group.plain_album;
        }
    }
    let best = counts
        .into_values()
        .max_by_key(|(n, plain, _, _)| (*n, *plain))?;
    (best.0 >= 2 && best.0 * 2 >= named && comparable(&best.2) != comparable(chosen_album)).then(
        || AlbumHint {
            title: best.2,
            artist: best.3,
            tracks: best.0,
            of: named,
        },
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    fn reply(score: f64, recordings: &str) -> String {
        format!(
            r#"{{"status":"ok","results":[{{"id":"a","score":{score},"recordings":[{recordings}]}}]}}"#
        )
    }

    fn recording(id: &str, title: &str, groups: &str) -> String {
        format!(
            r#"{{"id":"{id}","title":"{title}","artists":[{{"id":"x","name":"AFI","joinphrase":""}}],"releasegroups":[{groups}]}}"#
        )
    }

    fn group(title: &str, kind: &str, secondary: &str) -> String {
        format!(
            r#"{{"id":"g","title":"{title}","type":"{kind}","secondarytypes":[{secondary}],"artists":[{{"name":"AFI"}}]}}"#
        )
    }

    fn found(title: &str, album: &str) -> Result<Option<Found>, String> {
        parse_lookup(&reply(
            0.97,
            &recording("r", title, &group(album, "Album", "")),
        ))
    }

    #[test]
    fn the_request_carries_the_key_in_the_body_encoded() {
        let body = lookup_body("KEY 1&2", 215, "AQAAEw");
        assert_eq!(
            body,
            "client=KEY%201%262&format=json&meta=recordings+releasegroups&duration=215&fingerprint=AQAAEw"
        );
    }

    #[test]
    fn a_reply_gives_recordings_with_their_albums_and_ignores_weak_results() {
        let json = format!(
            r#"{{"status":"ok","results":[{{"id":"weak","score":0.3,"recordings":[{}]}},{{"id":"a","score":0.98,"recordings":[{}]}}]}}"#,
            recording("r0", "Weak", ""),
            recording(
                "r1",
                "Miseria Cantare",
                &format!(
                    "{},{}",
                    group("Sing the Sorrow", "Album", ""),
                    group("Best Of", "Album", r#""Compilation""#)
                )
            )
        );
        let found = parse_lookup(&json).unwrap().unwrap();
        assert_eq!(found.recordings.len(), 1);
        assert_eq!(found.recordings[0].title, "Miseria Cantare");
        assert_eq!(found.recordings[0].artist, "AFI");
        assert!(found.recordings[0].groups[0].plain_album);
        assert!(
            !found.recordings[0].groups[1].plain_album,
            "a compilation is not a plain album"
        );
    }

    #[test]
    fn unknown_audio_and_errors_are_told_apart() {
        assert!(
            parse_lookup(r#"{"status":"ok","results":[]}"#)
                .unwrap()
                .is_none()
        );
        assert!(
            parse_lookup(r#"{"status":"ok","results":[{"id":"a","score":0.99}]}"#)
                .unwrap()
                .is_none(),
            "a result with no recording"
        );
        let error =
            parse_lookup(r#"{"status":"error","error":{"code":4,"message":"invalid API key"}}"#)
                .unwrap_err();
        assert!(error.contains("invalid API key"));
        assert!(parse_lookup("<html>").is_err());
    }

    #[test]
    fn titles_compare_without_decorations() {
        assert_eq!(comparable("Don't Change (Live)"), comparable("Dont change"));
        assert_eq!(comparable("Song - Remastered 2011"), comparable("Song"));
        assert_ne!(comparable("Song"), comparable("Other"));
    }

    fn chosen(titles: &[&str]) -> Vec<Chosen> {
        titles
            .iter()
            .enumerate()
            .map(|(i, t)| Chosen {
                number: i as u32 + 1,
                title: (*t).to_owned(),
            })
            .collect()
    }

    #[test]
    fn a_disc_whose_tracks_are_all_the_songs_chosen_agrees() {
        let answers = vec![
            (1, found("Girl's Not Grey", "Sing the Sorrow")),
            (2, found("The Leaving Song", "Sing the Sorrow")),
            (3, Ok(None)),
        ];
        let check = check_disc(
            "Sing the Sorrow",
            &chosen(&["Girl's Not Grey", "The Leaving Song", "Bleed Black"]),
            &answers,
        );
        assert_eq!(check.state, DiscState::Agrees);
        assert_eq!(check.tracks[2].state, TrackState::Unknown);
        assert!(check.album_hint.is_none());
        assert!(check.headline.contains("recognised 2 of 3"));
    }

    #[test]
    fn a_track_that_is_another_song_is_reported_and_its_real_place_found() {
        let answers = vec![
            (1, found("The Leaving Song", "Sing the Sorrow")),
            (2, found("Girl's Not Grey", "Sing the Sorrow")),
            (3, found("Bleed Black", "Sing the Sorrow")),
        ];
        let check = check_disc(
            "Sing the Sorrow",
            &chosen(&["Girl's Not Grey", "The Leaving Song", "Bleed Black"]),
            &answers,
        );
        assert_eq!(check.state, DiscState::Mixed);
        assert_eq!(check.tracks[0].state, TrackState::Other);
        assert_eq!(
            check.tracks[0].sounds_like,
            Some(2),
            "track 1 carries track 2's title"
        );
        assert_eq!(check.tracks[2].state, TrackState::Agrees);
    }

    #[test]
    fn a_disc_that_is_another_album_suggests_the_album_most_tracks_are_on() {
        let answers = vec![
            (1, found("One", "Real Album")),
            (2, found("Two", "Real Album")),
            (3, Ok(None)),
        ];
        let check = check_disc("Wrong Album", &chosen(&["A", "B", "C"]), &answers);
        assert_eq!(check.state, DiscState::Different);
        let hint = check.album_hint.expect("a hint");
        assert_eq!(
            (hint.title.as_str(), hint.tracks, hint.of),
            ("Real Album", 2, 2)
        );
        assert!(check.headline.contains("different album"));
    }

    #[test]
    fn nothing_to_compare_with_is_not_a_disagreement() {
        let answers = vec![
            (1, found("One", "Real Album")),
            (2, found("Two", "Real Album")),
        ];
        let check = check_disc("", &chosen(&["Track 1", ""]), &answers);
        assert_eq!(
            check.state,
            DiscState::Named,
            "placeholder titles are not compared"
        );
        assert_eq!(
            check.album_hint.as_ref().map(|h| h.title.as_str()),
            Some("Real Album")
        );
        let unknown = check_disc("X", &chosen(&["A"]), &[(1, Ok(None))]);
        assert_eq!(unknown.state, DiscState::Unknown);
        let failed = check_disc("X", &chosen(&["A"]), &[(1, Err("down".to_owned()))]);
        assert_eq!(failed.state, DiscState::Failed);
    }

    #[test]
    fn a_compilation_does_not_beat_the_studio_album_on_a_tie() {
        let comp = group("Greatest Hits", "Album", r#""Compilation""#);
        let studio = group("Studio", "Album", "");
        let two = |t: &str| {
            parse_lookup(&reply(0.9, &recording("r", t, &format!("{comp},{studio}")))).unwrap()
        };
        let answers = vec![(1, Ok(two("One"))), (2, Ok(two("Two")))];
        let hint = album_hint("Elsewhere", &answers).unwrap();
        assert_eq!(hint.title, "Studio");
    }

    #[test]
    fn only_sure_matches_are_tagged_and_only_unambiguous_names_are_used() {
        let sure = |title: &str, score: f64| {
            parse_lookup(&reply(
                score,
                &recording("r", title, &group("A", "Album", "")),
            ))
            .unwrap()
        };
        // Agrees and sure: its ids may be tagged. Agrees but only 0.7: not.
        let check = check_disc(
            "A",
            &chosen(&["One", "Two"]),
            &[(1, Ok(sure("One", 0.97))), (2, Ok(sure("Two", 0.7)))],
        );
        assert!(check.tracks[0].tag_ids && !check.tracks[0].name_it);
        assert!(
            !check.tracks[1].tag_ids,
            "0.7 is not sure enough to write into a file"
        );
        assert_eq!(check.tracks[0].acoustid_id.as_deref(), Some("a"));
        assert_eq!(check.tracks[0].recording_id.as_deref(), Some("r"));
        // Nobody titled it: a sure single name is used and tagged; a different song is neither.
        let named = check_disc(
            "",
            &chosen(&["Track 1", "Track 2", "Track 3"]),
            &[
                (1, Ok(sure("Real Title", 0.95))),
                (2, Ok(sure("Maybe", 0.8))),
                (3, Ok(None)),
            ],
        );
        assert!(named.tracks[0].name_it && named.tracks[0].tag_ids);
        assert!(
            !named.tracks[1].name_it && !named.tracks[1].tag_ids,
            "0.8 is too unsure to name a song"
        );
        let other = check_disc(
            "A",
            &chosen(&["Wanted"]),
            &[(1, Ok(sure("Different", 0.99)))],
        );
        assert!(
            !other.tracks[0].tag_ids && !other.tracks[0].name_it,
            "a song that is not the one chosen is never tagged"
        );
        // Two recordings with different titles: ambiguous, so not named.
        let two = parse_lookup(&reply(
            0.98,
            &format!(
                "{},{}",
                recording("r1", "Song", ""),
                recording("r2", "Song (Live)", "")
            ),
        ))
        .unwrap();
        assert!(
            check_disc("", &chosen(&["Track 1"]), &[(1, Ok(two))]).tracks[0].name_it,
            "decorations alone do not make it ambiguous"
        );
        let different = parse_lookup(&reply(
            0.98,
            &format!(
                "{},{}",
                recording("r1", "Song", ""),
                recording("r2", "Other Tune", "")
            ),
        ))
        .unwrap();
        assert!(!check_disc("", &chosen(&["Track 1"]), &[(1, Ok(different))]).tracks[0].name_it);
    }
}
