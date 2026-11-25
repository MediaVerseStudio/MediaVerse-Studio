//! The audio check after a rip (ADR 0006, D113): each ripped track is fingerprinted and AcoustID is asked what recording
//! it is, so the details chosen for the disc are confirmed (or doubted) by the audio itself rather than by names alone.
//! It is a report only. Nothing is written or changed because of it, and any failure here (no key, the service down) leaves
//! the rip exactly as it was.
//!
//! The fingerprints are made from the verified WAV files, before they are encoded and removed.

use crate::drives::Drives;
use crate::fingerprint;
use crate::lookup::{http_post_text, source_label};
use mediaverse_disc_metadata::acoustid::{self, Chosen, Found};
use mediaverse_host::EventSink;
use serde_json::{Value, json};
use std::path::Path;
use std::time::Duration;

const APP_NAME: &str = "MediaVerseStudio";
/// Give up on the rest of the disc after this many failures in a row (the service is down, or refusing us).
const GIVE_UP_AFTER: usize = 3;

/// The titles chosen for the disc, by track number.
fn chosen_titles(metadata: &Value, numbers: &[u32]) -> Vec<Chosen> {
    numbers
        .iter()
        .map(|&number| Chosen {
            number,
            title: metadata["tracks"][number.to_string()]["title"]
                .as_str()
                .unwrap_or("")
                .to_owned(),
        })
        .collect()
}

/// A MusicBrainz or AcoustID id from a track's chosen details, only when it is a well-formed UUID (lower case, as taggers write them).
pub(crate) fn tag_id(per_track: &Value, key: &str) -> Option<String> {
    per_track[key]
        .as_str()
        .filter(|id| mediaverse_ripper::id3::is_uuid(id))
        .map(str::to_ascii_lowercase)
}

/// What the check found out is put into the details the files are made from: a title for a track nobody titled (when AcoustID is
/// very sure and has one name for it), and the ids of tracks it is sure of. Returns the numbers of the tracks it named.
pub(crate) fn apply_to_details(check: &mut Value, metadata: &mut Value) -> Vec<u64> {
    let mut named = Vec::new();
    let Some(tracks) = check["tracks"].as_array_mut() else {
        return named;
    };
    for track in tracks {
        let Some(number) = track["number"].as_u64() else {
            continue;
        };
        let key = number.to_string();
        if track["name_it"] == true
            && let Some(title) = track["title"].as_str().map(str::to_owned)
        {
            metadata["tracks"][&key]["title"] = json!(title);
            track["named"] = json!(true);
            named.push(number);
        }
        if track["tag_ids"] == true {
            if let Some(id) = track["recording_id"].as_str() {
                metadata["tracks"][&key]["recording_id"] = json!(id);
            }
            if let Some(id) = track["acoustid_id"].as_str() {
                metadata["tracks"][&key]["acoustid_id"] = json!(id);
            }
        }
    }
    named
}

/// Takes the key out of any message (a network error may quote the address or body it was sending).
fn without_key(message: String, key: &str) -> String {
    if key.is_empty() {
        message
    } else {
        message.replace(key, "(key)")
    }
}

#[cfg(test)]
pub(crate) mod tests {
    use super::*;

    pub(crate) fn reply(title: &str) -> String {
        format!(
            r#"{{"status":"ok","results":[{{"id":"a","score":0.95,"recordings":[{{"id":"r-{title}","title":"{title}","artists":[{{"name":"AFI"}}],"releasegroups":[{{"title":"Sing the Sorrow","type":"Album","secondarytypes":[],"artists":[{{"name":"AFI"}}]}}]}}]}}]}}"#
        )
    }

    /// A stand-in AcoustID on this PC that gives the answers in turn and returns the requests it got.
    pub(crate) fn serve(answers: Vec<String>) -> (u16, std::thread::JoinHandle<Vec<String>>) {
        use std::io::{Read, Write};
        let listener = std::net::TcpListener::bind("127.0.0.1:0").unwrap();
        let port = listener.local_addr().unwrap().port();
        let handle = std::thread::spawn(move || {
            let mut requests = Vec::new();
            for answer in answers {
                let (mut stream, _) = listener.accept().unwrap();
                let mut buffer = vec![0u8; 65536];
                let mut got = 0;
                loop {
                    let n = stream.read(&mut buffer[got..]).unwrap();
                    got += n;
                    let text = String::from_utf8_lossy(&buffer[..got]).into_owned();
                    if let Some((head, body)) = text.split_once("\r\n\r\n") {
                        let length = head
                            .lines()
                            .find_map(|l| {
                                l.to_lowercase()
                                    .strip_prefix("content-length:")
                                    .map(|v| v.trim().parse::<usize>().unwrap())
                            })
                            .unwrap_or(0);
                        if body.len() >= length || n == 0 {
                            break;
                        }
                    } else if n == 0 {
                        break;
                    }
                }
                let _ = write!(
                    stream,
                    "HTTP/1.0 200 OK\r\nContent-Type: application/json\r\nContent-Length: {}\r\n\r\n{answer}",
                    answer.len()
                );
                requests.push(String::from_utf8_lossy(&buffer[..got]).into_owned());
            }
            requests
        });
        (port, handle)
    }
    #[test]
    fn what_the_check_found_goes_into_the_details_the_files_are_made_from() {
        let mut check = json!({ "tracks": [
            { "number": 1, "state": "agrees", "tag_ids": true, "name_it": false, "title": "One", "recording_id": "B9AD642E-B012-41C7-B72A-42CF4911F9FF", "acoustid_id": "7c8f5a4e-8f3b-4b0e-9f77-3c0e1f2a9b11" },
            { "number": 2, "state": "named", "tag_ids": true, "name_it": true, "title": "Real Title", "recording_id": "11111111-2222-3333-4444-555555555555", "acoustid_id": null },
            { "number": 3, "state": "other", "tag_ids": false, "name_it": false, "title": "Different", "recording_id": "99999999-2222-3333-4444-555555555555" },
        ] });
        let mut metadata = json!({ "album": "A", "tracks": { "1": { "title": "One" }, "2": { "title": "Track 2" }, "3": { "title": "Three" } } });
        let named = apply_to_details(&mut check, &mut metadata);
        assert_eq!(named, vec![2]);
        assert_eq!(
            metadata["tracks"]["2"]["title"], "Real Title",
            "a track nobody titled takes the name"
        );
        assert_eq!(
            metadata["tracks"]["1"]["title"], "One",
            "a chosen title is never replaced"
        );
        assert_eq!(metadata["tracks"]["3"]["title"], "Three");
        assert_eq!(check["tracks"][1]["named"], true);
        // Ids only for tracks it is sure of, and only well-formed ones are used by the writers.
        assert_eq!(
            tag_id(&metadata["tracks"]["1"], "recording_id").as_deref(),
            Some("b9ad642e-b012-41c7-b72a-42cf4911f9ff"),
            "written in lower case"
        );
        assert_eq!(
            tag_id(&metadata["tracks"]["1"], "acoustid_id").as_deref(),
            Some("7c8f5a4e-8f3b-4b0e-9f77-3c0e1f2a9b11")
        );
        assert!(
            metadata["tracks"]["3"]["recording_id"].is_null(),
            "a different song gets no ids"
        );
        assert_eq!(
            tag_id(&json!({ "recording_id": "nonsense" }), "recording_id"),
            None
        );
        // With no details at all, they are created.
        let mut bare = Value::Null;
        apply_to_details(&mut check, &mut bare);
        assert_eq!(bare["tracks"]["2"]["title"], "Real Title");
    }

    /// The whole check, against a stand-in AcoustID on this PC: three tracks, the second of which is another song.
    #[test]
    fn the_check_asks_for_each_track_keeps_the_key_in_the_body_and_reports_a_different_song() {
        let (port, server) = serve(vec![
            reply("One"),
            reply("Not Two"),
            r#"{"status":"ok","results":[]}"#.to_owned(),
        ]);

        let dir = std::env::temp_dir().join(format!("mv-audio-check-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let drives = Drives::new(
            &dir.join("data"),
            crate::Output::new(std::io::sink()),
            std::sync::Arc::new(|| None),
        );
        drives
            .metadata
            .update(&json!({ "acoustid": { "enabled": true, "api_key": "SECRETKEY123", "base_url": format!("http://127.0.0.1:{port}"), "min_interval_ms": 1 } }))
            .unwrap();
        let mut files = Vec::new();
        for n in 1..=3 {
            let path = dir.join(format!("{n:02}.wav"));
            fingerprint::tests::write_wav(&path, &fingerprint::tests::tone(10 + n, 11_025), 11_025);
            files.push(path.to_string_lossy().into_owned());
        }
        let rip = json!({ "tracks": [{ "number": 1 }, { "number": 2 }, { "number": 3 }], "files": files });
        let metadata = json!({ "album": "Sing the Sorrow", "tracks": { "1": { "title": "One" }, "2": { "title": "Two" }, "3": { "title": "Three" } } });
        let check = drives
            .audio_check(&rip, &metadata, "job-1")
            .expect("a check");

        assert_eq!(check["state"], "mixed");
        assert_eq!(check["tracks"][0]["state"], "agrees");
        assert_eq!(check["tracks"][1]["state"], "other");
        assert_eq!(check["tracks"][1]["title"], "Not Two");
        assert_eq!(check["tracks"][2]["state"], "unknown");
        assert!(check["checked_at"].as_u64().unwrap() > 0);
        assert!(
            !check.to_string().contains("SECRETKEY123"),
            "the key never appears in the result"
        );
        let requests = server.join().unwrap();
        assert_eq!(requests.len(), 3, "one question per track");
        assert!(
            requests[0].starts_with("POST /v2/lookup"),
            "{}",
            &requests[0][..40]
        );
        let (head, body) = requests[0].split_once("\r\n\r\n").unwrap();
        assert!(body.starts_with("client=SECRETKEY123&format=json&meta=recordings+releasegroups&duration=11&fingerprint="), "{body}");
        assert!(
            !head.contains("SECRETKEY123"),
            "the key is not in the address or headers"
        );

        // Off means nothing is asked.
        drives
            .metadata
            .update(&json!({ "acoustid": { "enabled": false } }))
            .unwrap();
        assert!(drives.audio_check(&rip, &metadata, "job-2").is_none());
        let _ = std::fs::remove_dir_all(&dir);
    }

    /// Live check that our fingerprints are ones AcoustID understands (D35). Run by hand:
    /// `MV_TEST_WAV=song.wav MV_ACOUSTID_KEY=... cargo test -p mediaverse_sidecar --lib live_fingerprint -- --ignored --nocapture`
    #[test]
    #[ignore = "needs the network, an AcoustID key and a WAV file"]
    fn live_fingerprint_is_recognised_by_acoustid() {
        let (Ok(wav), Ok(key)) = (
            std::env::var("MV_TEST_WAV"),
            std::env::var("MV_ACOUSTID_KEY"),
        ) else {
            panic!("set MV_TEST_WAV and MV_ACOUSTID_KEY")
        };
        let print = fingerprint::from_file(Path::new(&wav)).unwrap();
        println!(
            "fingerprint of {} s, {} characters",
            print.duration_seconds,
            print.encoded.len()
        );
        let body = acoustid::lookup_body(&key, print.duration_seconds, &print.encoded);
        let reply = http_post_text(
            "https://api.acoustid.org/v2/lookup",
            "MediaVerseStudio/0.1.0 test",
            Duration::from_secs(30),
            &[("Content-Type", "application/x-www-form-urlencoded")],
            &body,
        )
        .unwrap();
        let text = String::from_utf8_lossy(&reply.body).replace(&key, "(key)");
        println!("HTTP {}", reply.status);
        match acoustid::parse_lookup(&text) {
            Ok(Some(found)) => {
                println!("score {:.2}", found.score);
                for r in found.recordings.iter().take(5) {
                    println!(
                        "  {} - {} ({} albums, e.g. {:?})",
                        r.artist,
                        r.title,
                        r.groups.len(),
                        r.groups.first().map(|g| &g.title)
                    );
                }
            }
            other => println!("{other:?}\n{}", &text[..text.len().min(400)]),
        }
    }
}

/// How to ask AcoustID, from the Settings: where, with which key, as whom, and how often.
pub(crate) struct Asker {
    url: String,
    key: String,
    user_agent: String,
    gap: Duration,
}

impl Drives {
    /// `None` when AcoustID is not switched on and keyed in Settings (nothing is asked then).
    pub(crate) fn acoustid_asker(&self) -> Option<Asker> {
        let settings = self.metadata.current();
        let acoustid_settings = &settings.acoustid;
        if !acoustid_settings.enabled || !acoustid_settings.api_key.is_set() {
            return None;
        }
        Some(Asker {
            key: acoustid_settings.api_key.expose().to_owned(),
            url: format!(
                "{}/v2/lookup",
                acoustid_settings.base_url.trim_end_matches('/')
            ),
            user_agent: mediaverse_disc_metadata::musicbrainz::user_agent(
                APP_NAME,
                env!("CARGO_PKG_VERSION"),
                settings.identity.contact.trim(),
            ),
            gap: Duration::from_millis(acoustid_settings.min_interval_ms),
        })
    }

    /// Fingerprints every ripped track and asks AcoustID about it. `None` when AcoustID is not switched on and keyed in
    /// Settings (nothing is asked then), otherwise the verdict as JSON (`DiscCheck`) with a `checked_at` time.
    pub(crate) fn audio_check(
        &self,
        result: &Value,
        metadata: &Value,
        job_id: &str,
    ) -> Option<Value> {
        let asker = self.acoustid_asker()?;
        let tracks: Vec<(u32, String)> = result["tracks"]
            .as_array()
            .into_iter()
            .flatten()
            .enumerate()
            .filter_map(|(i, t)| {
                Some((
                    t["number"].as_u64()? as u32,
                    result["files"][i].as_str()?.to_owned(),
                ))
            })
            .filter(|(_, file)| file.to_ascii_lowercase().ends_with(".wav"))
            .collect();
        if tracks.is_empty() {
            return None;
        }
        let numbers: Vec<u32> = tracks.iter().map(|(n, _)| *n).collect();
        let total = tracks.len();

        let mut answers: Vec<(u32, Result<Option<Found>, String>)> = Vec::new();
        let mut failures_in_a_row = 0;
        for (done, (number, file)) in tracks.iter().enumerate() {
            self.output.emit("job-progress", json!({ "job_id": job_id, "kind": "audio_check", "track": number, "tracks_done": done, "tracks_total": total }));
            if failures_in_a_row >= GIVE_UP_AFTER {
                answers.push((
                    *number,
                    Err("skipped after AcoustID failed to answer".to_owned()),
                ));
                continue;
            }
            let answer = self.ask_acoustid(&asker, Path::new(file));
            failures_in_a_row = if answer.is_err() {
                failures_in_a_row + 1
            } else {
                0
            };
            answers.push((*number, answer));
        }
        let album = metadata["album"].as_str().unwrap_or("");
        let check = acoustid::check_disc(album, &chosen_titles(metadata, &numbers), &answers);
        let mut value = serde_json::to_value(check).ok()?;
        value["checked_at"] = json!(
            std::time::SystemTime::now()
                .duration_since(std::time::UNIX_EPOCH)
                .map_or(0, |d| d.as_secs())
        );
        Some(value)
    }

    /// Fingerprints one song (WAV, MP3 or FLAC) and asks AcoustID what it is. The key never appears in an error message.
    pub(crate) fn ask_acoustid(&self, asker: &Asker, file: &Path) -> Result<Option<Found>, String> {
        self.ask_unscrubbed(asker, file)
            .map_err(|message| without_key(message, &asker.key))
    }

    fn ask_unscrubbed(&self, asker: &Asker, file: &Path) -> Result<Option<Found>, String> {
        let print = fingerprint::from_file(file)?;
        self.metadata.wait_turn("acoustid", asker.gap);
        let body = acoustid::lookup_body(&asker.key, print.duration_seconds, &print.encoded);
        let reply = http_post_text(
            &asker.url,
            &asker.user_agent,
            Duration::from_secs(30),
            &[("Content-Type", "application/x-www-form-urlencoded")],
            &body,
        )
        .map_err(|(_, message)| message)?;
        let text = String::from_utf8_lossy(&reply.body).into_owned();
        match reply.status {
            200 => {
                self.metadata.outcome("acoustid", false, None);
                acoustid::parse_lookup(&text)
            }
            403 | 429 | 503 => {
                self.metadata.outcome("acoustid", true, reply.retry_after);
                Err(format!(
                    "{} is limiting requests from this address.",
                    source_label("acoustid")
                ))
            }
            // AcoustID explains its errors in the body (a bad key is a 400 with a message).
            other => acoustid::parse_lookup(&text)
                .map_err(|m| format!("{m} (HTTP {other})"))
                .and_then(|_| {
                    Err(format!(
                        "{} answered HTTP {other}.",
                        source_label("acoustid")
                    ))
                }),
        }
    }
}
