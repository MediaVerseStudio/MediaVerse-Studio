//! Lyrics by photo through the real sidecar protocol: what the commands answer before the models are on the computer, and (ignored,
//! needs the models) a run over real photos.
#![allow(unused_imports)]

mod common;
use common::*;
use serde_json::{Value, json};

#[test]
fn the_photo_commands_answer_before_the_models_are_downloaded() {
    let data = temp_dir("lyric-photos-protocol");
    let mut client = Client::start(&data, false);

    let status = client.request(1, "lyric_photos_status", json!({}));
    assert_eq!(status["ok"], true, "{status}");
    assert_eq!(status["result"]["installed"], false);
    assert_eq!(status["result"]["licence"], "Apache-2.0");
    assert_eq!(
        status["result"]["missing"].as_array().map(Vec::len),
        Some(3)
    );
    // the vision reader: not installed, nothing there to update, the whole download is about 3 GB, Apache-2.0 licence
    let vision = &status["result"]["vision"];
    assert_eq!(vision["installed"], false, "{vision}");
    assert_eq!(vision["update"], false, "{vision}");
    assert_eq!(vision["licence"], "Apache-2.0");
    let mb = vision["download_mb"].as_u64().unwrap();
    assert!((2900..3100).contains(&mb), "{vision}");

    let none = client.request(2, "lyric_photos_read", json!({ "photos": [] }));
    assert_eq!(none["error"]["code"], "invalid_arguments", "{none}");

    let not_a_picture = client.request(
        3,
        "lyric_photos_read",
        json!({ "photos": ["C:\\x\\notes.txt"] }),
    );
    assert_eq!(
        not_a_picture["error"]["code"], "invalid_arguments",
        "{not_a_picture}"
    );

    // A picture that exists but no models: told to download them first (and no job starts).
    let picture = data.join("page.jpg");
    std::fs::write(&picture, [0xFF, 0xD8, 0xFF, 0xD9]).unwrap();
    let no_models = client.request(
        4,
        "lyric_photos_read",
        json!({ "photos": [picture.display().to_string()] }),
    );
    assert_eq!(no_models["error"]["code"], "not_configured", "{no_models}");

    // The preview of a photo: a missing one is refused, and a turn must be a quarter turn.
    let missing = client.request(
        5,
        "lyric_photos_preview",
        json!({ "path": "C:\\x\\none.jpg", "turn": 90 }),
    );
    assert_eq!(missing["error"]["code"], "invalid_arguments", "{missing}");
    let odd_turn = client.request(
        6,
        "lyric_photos_preview",
        json!({ "path": picture.display().to_string(), "turn": 45 }),
    );
    assert_eq!(odd_turn["error"]["code"], "invalid_arguments", "{odd_turn}");
}

/// Downloads the vision reader into a fresh data folder (`MV_VISION_DATA`, which must not hold it yet), reads the photos `MV_PHOTOS` (`;`
/// between, `MV_ROT` the turns, `MV_TITLES` the track titles) and writes the answer to `MV_OUT`.
#[test]
#[ignore = "downloads about 3 GB and needs real photos"]
fn a_real_download_and_read_with_the_vision_reader() {
    let data = std::path::PathBuf::from(std::env::var("MV_VISION_DATA").expect("MV_VISION_DATA"));
    let mut client = Client::start(&data, false);
    let status = client.request(1, "lyric_photos_status", json!({}));
    if status["result"]["vision"]["installed"] != true {
        let started = client.request(2, "lyric_photos_download", json!({}));
        assert_eq!(started["ok"], true, "{started}");
        let finished = client.wait_for_event("job-finished");
        assert_eq!(finished["payload"]["ok"], true, "{finished}");
    }
    let status = client.request(3, "lyric_photos_status", json!({}));
    assert_eq!(status["result"]["vision"]["installed"], true, "{status}");
    let photos: Vec<String> = std::env::var("MV_PHOTOS")
        .expect("MV_PHOTOS")
        .split(';')
        .map(str::to_owned)
        .collect();
    let rotations: Vec<u64> = std::env::var("MV_ROT")
        .unwrap_or_default()
        .split(';')
        .filter_map(|r| r.parse().ok())
        .collect();
    let tracks: Vec<Value> = std::env::var("MV_TITLES")
        .unwrap_or_default()
        .split(';')
        .filter(|t| !t.is_empty())
        .enumerate()
        .map(|(i, t)| json!({ "path": format!("C:\\none\\{i}.mp3"), "title": t }))
        .collect();
    let started = client.request(
        4,
        "lyric_photos_read",
        json!({ "photos": photos, "rotations": rotations, "tracks": tracks }),
    );
    assert_eq!(started["ok"], true, "{started}");
    let finished = client.wait_for_event("job-finished");
    let payload = &finished["payload"];
    assert_eq!(payload["ok"], true, "{payload}");
    assert_eq!(payload["result"]["reader"], "vision");
    if let Ok(out) = std::env::var("MV_OUT") {
        std::fs::write(
            out,
            serde_json::to_string_pretty(&payload["result"]).unwrap(),
        )
        .unwrap();
    }
}

/// `MV_PHOTO_DATA` is a data folder whose lyric-ai.json points at an ONNX Runtime and a models folder holding `page-reader`;
/// `MV_PHOTOS` the pictures (`;` between), `MV_TITLES` the album's track titles (`;` between), `MV_OUT` where the answer is written.
#[test]
#[ignore = "needs the photo reader models, ONNX Runtime and real photos"]
fn a_real_run_over_booklet_photos() {
    let data = std::path::PathBuf::from(std::env::var("MV_PHOTO_DATA").expect("MV_PHOTO_DATA"));
    let photos: Vec<String> = std::env::var("MV_PHOTOS")
        .expect("MV_PHOTOS")
        .split(';')
        .map(str::to_owned)
        .collect();
    let tracks: Vec<Value> = std::env::var("MV_TITLES")
        .unwrap_or_default()
        .split(';')
        .filter(|t| !t.is_empty())
        .enumerate()
        .map(|(i, t)| json!({ "path": format!("C:\\none\\{i}.mp3"), "title": t }))
        .collect();
    let mut client = Client::start(&data, false);
    let started = client.request(
        1,
        "lyric_photos_read",
        json!({ "photos": photos, "tracks": tracks }),
    );
    assert_eq!(started["ok"], true, "{started}");
    let finished = client.wait_for_event("job-finished");
    let payload = &finished["payload"];
    assert_eq!(payload["ok"], true, "{payload}");
    if let Ok(out) = std::env::var("MV_OUT") {
        std::fs::write(
            out,
            serde_json::to_string_pretty(&payload["result"]).unwrap(),
        )
        .unwrap();
    }
}

#[test]
fn saved_work_on_an_album_survives_the_program_being_closed() {
    let data = temp_dir("lyric-photos-session");
    let album = "C:\\Music\\MxPx\\Living In The Chaos";
    {
        let mut client = Client::start(&data, false);
        let none = client.request(1, "lyric_photos_session_load", json!({ "album": album }));
        assert_eq!(none["ok"], true, "{none}");
        assert_eq!(none["result"], Value::Null);
        let state = json!({ "photos": ["a.jpg"], "assignment": [0, null], "edited": { "0": "Let it burn out, we don't have forever" }, "done": ["C:\\Music\\a.mp3"] });
        let saved = client.request(
            2,
            "lyric_photos_session_save",
            json!({ "album": album, "state": state }),
        );
        assert_eq!(saved["ok"], true, "{saved}");
        let bad = client.request(
            3,
            "lyric_photos_session_save",
            json!({ "album": "", "state": {} }),
        );
        assert_eq!(bad["error"]["code"], "invalid_arguments", "{bad}");
    }
    // a new run of the program, the same data folder
    let mut client = Client::start(&data, false);
    let loaded = client.request(1, "lyric_photos_session_load", json!({ "album": album }));
    assert_eq!(
        loaded["result"]["state"]["edited"]["0"], "Let it burn out, we don't have forever",
        "{loaded}"
    );
    let other = client.request(
        2,
        "lyric_photos_session_load",
        json!({ "album": "C:\\Music\\Other" }),
    );
    assert_eq!(other["result"], Value::Null);
    let forgotten = client.request(3, "lyric_photos_session_forget", json!({ "album": album }));
    assert_eq!(forgotten["ok"], true);
    let gone = client.request(4, "lyric_photos_session_load", json!({ "album": album }));
    assert_eq!(gone["result"], Value::Null);
}
