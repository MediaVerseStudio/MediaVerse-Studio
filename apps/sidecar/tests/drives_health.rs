//! A track that reads badly is read again and the good read is kept (D102).
#![allow(unused_imports)]

mod common;
use common::*;
use serde_json::{Value, json};

#[test]
fn a_track_that_matches_on_the_second_read_is_recovered_and_the_disc_is_not_called_damaged() {
    let data = temp_dir("health-recovered");
    seed_accuraterip(&data, "found");
    let mut client = Client::start_with(&data, false, true);
    client.request(1, "calibrate_drive", json!({ "device": "Z:" }));
    client.wait_for_event("job-finished");
    client.events.clear();

    client.request(2, "rip_disc", json!({ "device": "Z:", "output_dir": rip_dir("health-recovered").to_string_lossy(), "tracks": [2, 3], "secure": true, "archive": false, "mp3": false }));
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], true, "{finished}");
    let result = &finished["payload"]["result"];
    // Track 3 first failed AccurateRip, matched when read again: both tracks verify now.
    assert!(
        result["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .all(|t| t["verification"]["kind"] == "matched"),
        "{result}"
    );
    let health = &result["disc_health"];
    assert_eq!(health["state"], "good", "{health}");
    assert_eq!(health["recovered"], json!([3]));
    assert_eq!(health["tracks"][0]["state"], "recovered");
    assert_eq!(
        health["tracks"][0]["passes"], 2,
        "it stopped as soon as the second read matched"
    );
    assert_eq!(
        result["warnings"],
        json!([]),
        "a recovered track is good news, not a warning"
    );
}
