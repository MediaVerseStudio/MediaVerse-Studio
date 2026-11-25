//! The wrong-lyrics check's commands (D152) through the real sidecar protocol: what they answer before anything is set up.
#![allow(unused_imports)]

mod common;
use common::*;
use serde_json::{Value, json};

#[test]
fn the_wrong_lyrics_commands_answer_before_the_lyric_ai_is_set_up() {
    let data = temp_dir("wrong-lyrics-protocol");
    let mut client = Client::start(&data, false);

    let results = client.request(1, "lyric_ai_wrong_results", json!({}));
    assert_eq!(results["ok"], true, "{results}");
    assert_eq!(results["result"]["items"], json!([]));
    assert_eq!(results["result"]["checked"], 0);

    // No models are in place, so the check refuses to start and says why (and starts no job).
    let start = client.request(
        2,
        "lyric_ai_wrong_check",
        json!({ "paths": ["C:\\Music\\a.mp3"], "include_instrumental": true }),
    );
    assert_eq!(start["ok"], false, "{start}");
    assert_eq!(start["error"]["code"], "not_configured", "{start}");

    let none = client.request(3, "lyric_ai_wrong_check", json!({ "paths": [] }));
    assert_eq!(none["ok"], false);
    assert_eq!(none["error"]["code"], "invalid_arguments", "{none}");

    let unknown = client.request(
        4,
        "lyric_ai_wrong_dismiss",
        json!({ "path": "C:\\Music\\never-checked.mp3" }),
    );
    assert_eq!(unknown["ok"], false);
    assert_eq!(unknown["error"]["code"], "not_found", "{unknown}");
}
