//! The lyric AI end to end through the sidecar's protocol, with real models and a real song. Ignored unless the environment names them:
//!
//!   LYRIC_E2E_RUNTIME   onnxruntime.dll          LYRIC_E2E_MODELS   folder with htdemucs-core.onnx, w2v.onnx, w2v.json
//!   LYRIC_E2E_CUDA      folder with the CUDA libraries (optional; then the models run on the graphics card)
//!   LYRIC_E2E_MP3       a song WITHOUT lyrics in its tags     LYRIC_E2E_CANDIDATES   JSON array of LRCLIB search answers for it
//!
//!   cargo test -p mediaverse_sidecar --test lyric_ai_e2e -- --ignored --nocapture
#![allow(unused_imports)]

mod common;
use common::*;
use serde_json::{Value, json};

#[test]
#[ignore = "needs the models and a song (see the file's first lines)"]
fn a_song_with_no_lyrics_gets_the_right_found_lyrics_timed() {
    let env = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} is not set"));
    let candidates = std::fs::read_to_string(env("LYRIC_E2E_CANDIDATES")).unwrap();
    let server = fakes::Http::start(move |target| {
        if target.starts_with("/api/search?") {
            fakes::ok(candidates.clone())
        } else {
            fakes::Reply {
                status: 404,
                headers: vec![],
                body: b"{}".to_vec(),
            }
        }
    });
    let (_data, mut client) = ready_to_rip("lyric-ai-e2e");
    let library = temp_dir("lyric-ai-e2e-library");
    let song = library.join("Band").join("LP").join("01 Song.mp3");
    std::fs::create_dir_all(song.parent().unwrap()).unwrap();
    std::fs::copy(env("LYRIC_E2E_MP3"), &song).unwrap();
    assert_eq!(
        client.request(
            1,
            "import_collection",
            json!({ "root": library.to_string_lossy() })
        )["ok"],
        true
    );
    assert_eq!(
        client.request(
            2,
            "set_lyrics_settings",
            json!({ "base_url": format!("http://127.0.0.1:{}", server.port) })
        )["ok"],
        true
    );
    let cuda = std::env::var("LYRIC_E2E_CUDA").ok();
    let processor = if cuda.is_some() { "cuda" } else { "cpu" };
    let configured = client.request(
        3,
        "lyric_ai_configure",
        json!({ "runtime": env("LYRIC_E2E_RUNTIME"), "models": env("LYRIC_E2E_MODELS"), "library_folders": cuda.iter().collect::<Vec<_>>(), "separator": processor, "reader": processor }),
    );
    assert_eq!(configured["result"]["ready"], true, "{configured}");

    client.events.clear();
    let started = client.request(
        4,
        "lyric_ai_analyse",
        json!({ "paths": [song.to_string_lossy()] }),
    );
    assert_eq!(started["ok"], true, "{started}");
    let done = client.wait_for_event("job-finished")["payload"].clone();
    assert_eq!(done["ok"], true, "{done}");
    println!("job: {}", done["result"]);

    let results = client.request(5, "lyric_ai_results", json!({}));
    let item = &results["result"]["items"][0];
    println!("result: {}", serde_json::to_string_pretty(item).unwrap());
    assert_eq!(item["task"], "find");
    assert_eq!(item["verdict"], "timed", "{item}");
    assert!(
        item["identity"]["candidate"]["same_artist"] == true,
        "the artist's own record should win: {item}"
    );
    assert!(item["lines"].as_u64().unwrap() >= 8);
}
