//! End-to-end tests of the online lyrics lookup (LRCLIB), against a fake server on this computer.
#![allow(unused_imports)]

mod common;
use common::*;
use serde_json::{Value, json};

fn setup(name: &str, server: &fakes::Http) -> (Client, String) {
    let (_data, mut client) = ready_to_rip(name);
    let library = temp_dir(&format!("{name}-library"));
    let song = library.join("Band").join("LP").join("01.mp3");
    std::fs::create_dir_all(song.parent().unwrap()).unwrap();
    std::fs::write(&song, b"x").unwrap();
    assert_eq!(
        client.request(
            1,
            "import_collection",
            json!({ "root": library.to_string_lossy() })
        )["ok"],
        true
    );
    let set = client.request(
        2,
        "set_lyrics_settings",
        json!({ "base_url": format!("http://127.0.0.1:{}", server.port) }),
    );
    assert_eq!(set["ok"], true, "{set}");
    std::mem::forget(_data);
    (client, song.to_string_lossy().into_owned())
}

fn lookup(client: &mut Client, id: u64, song: &str, title: &str, artist: &str) -> Value {
    client.events.clear();
    client.request(
        id,
        "lookup_lyrics",
        json!({ "path": song, "title": title, "artist": artist, "album": "LP" }),
    );
    client.wait_for_event("job-finished")["payload"].clone()
}

const SONG: &str = r#"{"id":7,"trackName":"Song","artistName":"Band","albumName":"LP","duration":201.4,"instrumental":false,"plainLyrics":"First\nSecond","syncedLyrics":"[00:01.00]First\n[00:04.00]Second"}"#;

#[test]
fn an_exact_match_is_found_with_the_right_request_and_an_identifying_user_agent() {
    let server = fakes::Http::start(|target| {
        if target.starts_with("/api/get?") {
            fakes::ok(SONG)
        } else {
            fakes::Reply {
                status: 404,
                headers: vec![],
                body: b"{}".to_vec(),
            }
        }
    });
    let (mut client, song) = setup("lrc-exact", &server);
    let done = lookup(&mut client, 3, &song, "Song & Dance", "AC/DC");
    assert_eq!(done["ok"], true, "{done}");
    assert_eq!(done["result"]["via"], "exact");
    assert_eq!(
        done["result"]["results"][0]["synced"],
        "[00:01.00]First\n[00:04.00]Second"
    );
    let seen = server.seen.lock().unwrap();
    assert_eq!(seen.len(), 1);
    assert!(
        seen[0].target.contains("track_name=Song%20%26%20Dance")
            && seen[0].target.contains("artist_name=AC%2FDC")
            && seen[0].target.contains("album_name=LP"),
        "{}",
        seen[0].target
    );
    assert!(
        seen[0].user_agent.starts_with("MediaVerseStudio/"),
        "{}",
        seen[0].user_agent
    );
}

#[test]
fn when_there_is_no_exact_match_a_search_offers_candidates_with_synced_lyrics_first() {
    let search = format!(
        "[{{\"id\":1,\"trackName\":\"Song\",\"artistName\":\"Band\",\"duration\":200,\"plainLyrics\":\"plain only\",\"syncedLyrics\":null}},{},{{\"id\":3,\"trackName\":\"Song\",\"artistName\":\"Band\",\"duration\":200,\"plainLyrics\":null,\"syncedLyrics\":null,\"instrumental\":false}}]",
        SONG
    );
    let server = fakes::Http::start(move |target| {
        if target.starts_with("/api/search?") {
            fakes::ok(search.clone())
        } else {
            fakes::Reply {
                status: 404,
                headers: vec![],
                body: b"{}".to_vec(),
            }
        }
    });
    let (mut client, song) = setup("lrc-search", &server);
    let done = lookup(&mut client, 3, &song, "Song", "Band");
    assert_eq!(done["ok"], true, "{done}");
    assert_eq!(done["result"]["via"], "search");
    let results = done["result"]["results"].as_array().unwrap();
    assert_eq!(
        results.len(),
        2,
        "the entry with no lyrics at all is dropped"
    );
    assert!(results[0]["synced"].is_string(), "synced lyrics come first");
    assert_eq!(
        server.seen.lock().unwrap().len(),
        2,
        "the exact request, then the search"
    );
}

#[test]
fn a_title_with_its_track_number_in_front_is_asked_again_without_the_number() {
    let server = fakes::Http::start(|target| {
        if target.starts_with("/api/get?") && target.contains("track_name=Song&") {
            fakes::ok(SONG)
        } else if target.starts_with("/api/search?") {
            fakes::ok("[]")
        } else {
            fakes::Reply {
                status: 404,
                headers: vec![],
                body: b"{}".to_vec(),
            }
        }
    });
    let (mut client, song) = setup("lrc-number", &server);
    let done = lookup(&mut client, 3, &song, "14 Song", "Band");
    assert_eq!(done["ok"], true, "{done}");
    assert_eq!(done["result"]["via"], "exact");
    assert_eq!(done["result"]["title_used"], "Song");
    let seen = server.seen.lock().unwrap();
    assert!(
        seen[0].target.contains("track_name=14%20Song"),
        "asked as written first: {}",
        seen[0].target
    );
    assert!(
        seen.last().unwrap().target.contains("track_name=Song&"),
        "then without the number: {}",
        seen.last().unwrap().target
    );
}

#[test]
fn the_librarys_length_is_sent_and_makes_a_search_answer_of_the_same_length_a_sure_one() {
    let search = format!("[{SONG}]");
    let server = fakes::Http::start(move |target| {
        if target.starts_with("/api/search?") {
            fakes::ok(search.clone())
        } else {
            fakes::Reply {
                status: 404,
                headers: vec![],
                body: b"{}".to_vec(),
            }
        }
    });
    let (mut client, song) = setup("lrc-length", &server);
    client.events.clear();
    client.request(
        3,
        "lookup_lyrics",
        json!({ "path": song, "title": "Song", "artist": "Band", "album": "LP", "length_ms": 201_000 }),
    );
    let done = client.wait_for_event("job-finished")["payload"].clone();
    assert_eq!(done["ok"], true, "{done}");
    let best = &done["result"]["results"][0];
    assert!(best.get("length_unknown").is_none(), "{best}");
    assert!(best.get("other_version").is_none(), "{best}");
    assert!(best["confidence"].as_u64().unwrap() >= 92, "{best}");
    assert_eq!(done["result"]["song_duration"], 201.0);
    assert!(
        server.seen.lock().unwrap()[0]
            .target
            .contains("duration=201"),
        "the exact request carries the length"
    );
}

#[test]
fn an_artist_written_differently_is_found_by_a_free_text_search() {
    let listed = r#"[{"id":9,"trackName":"Song","artistName":"The Band","albumName":"LP","duration":200,"plainLyrics":"words","syncedLyrics":"[00:01.00]words"},{"id":10,"trackName":"Song","artistName":"Somebody Else","duration":200,"plainLyrics":"other","syncedLyrics":null}]"#;
    let server = fakes::Http::start(move |target| {
        if target.starts_with("/api/search?q=") {
            fakes::ok(listed)
        } else if target.starts_with("/api/search?") {
            fakes::ok("[]")
        } else {
            fakes::Reply {
                status: 404,
                headers: vec![],
                body: b"{}".to_vec(),
            }
        }
    });
    let (mut client, song) = setup("lrc-freetext", &server);
    let done = lookup(&mut client, 3, &song, "Song", "Band feat. Guest");
    assert_eq!(done["ok"], true, "{done}");
    assert_eq!(done["result"]["via"], "search");
    let results = done["result"]["results"].as_array().unwrap();
    assert_eq!(
        results.len(),
        1,
        "only the answer by this artist: {results:?}"
    );
    assert_eq!(results[0]["id"], 9);
}

#[test]
fn a_title_that_is_found_as_written_is_not_asked_about_twice() {
    let server = fakes::Http::start(|target| {
        if target.starts_with("/api/get?") {
            fakes::ok(SONG)
        } else {
            fakes::Reply {
                status: 404,
                headers: vec![],
                body: b"{}".to_vec(),
            }
        }
    });
    let (mut client, song) = setup("lrc-number-kept", &server);
    let done = lookup(&mut client, 3, &song, "99 Red Balloons", "Band");
    assert_eq!(done["result"]["via"], "exact");
    assert!(done["result"].get("title_used").is_none());
    assert_eq!(server.seen.lock().unwrap().len(), 1);
}

#[test]
fn a_busy_server_a_missing_artist_a_switched_off_lookup_and_unsafe_addresses_are_explained() {
    let server = fakes::Http::start(|_| fakes::Reply {
        status: 429,
        headers: vec![("Retry-After", "3".to_owned())],
        body: b"{}".to_vec(),
    });
    let (mut client, song) = setup("lrc-errors", &server);
    let busy = lookup(&mut client, 3, &song, "Song", "Band");
    assert_eq!(busy["ok"], false);
    assert_eq!(busy["error"]["code"], "rate_limited");
    assert!(
        busy["error"]["message"]
            .as_str()
            .unwrap()
            .contains("3 seconds")
    );

    let blank = lookup(&mut client, 4, &song, "Song", "  ");
    assert_eq!(blank["error"]["code"], "missing_details");

    let outside = temp_dir("lrc-outside").join("x.mp3");
    std::fs::write(&outside, b"x").unwrap();
    assert_eq!(
        client.request(
            5,
            "lookup_lyrics",
            json!({ "path": outside.to_string_lossy(), "title": "S", "artist": "B" })
        )["error"]["code"],
        "invalid_arguments"
    );

    assert_eq!(
        client.request(
            6,
            "set_lyrics_settings",
            json!({ "base_url": "http://lrclib.example" })
        )["error"]["code"],
        "invalid_arguments"
    );
    assert_eq!(
        client.request(7, "set_lyrics_settings", json!({ "enabled": false }))["result"]["enabled"],
        false
    );
    assert_eq!(
        client.request(
            8,
            "lookup_lyrics",
            json!({ "path": song, "title": "S", "artist": "B" })
        )["error"]["code"],
        "lookup_disabled"
    );
    assert_eq!(
        server.seen.lock().unwrap().len(),
        1,
        "only the one real request reached the server"
    );
}
