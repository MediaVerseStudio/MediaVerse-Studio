//! A trial of the lyric AI on real songs with the real LRCLIB: finds out how many songs are settled by themselves. Ignored unless the environment names the models:
//!
//!   LYRIC_E2E_RUNTIME, LYRIC_E2E_MODELS, LYRIC_E2E_CUDA (as in lyric_ai_e2e.rs)    LYRIC_TRIAL_LIST   a text file, one song path per line
//!
//!   cargo test -p mediaverse_sidecar --test lyric_ai_trial -- --ignored --nocapture
#![allow(unused_imports)]

mod common;
use common::*;
use serde_json::{Value, json};

#[test]
#[ignore = "needs the models, songs and the internet (see the file's first lines)"]
fn a_trial_on_real_songs() {
    let env = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} is not set"));
    let songs: Vec<String> = std::fs::read_to_string(env("LYRIC_TRIAL_LIST"))
        .unwrap()
        .lines()
        .map(|l| l.trim().trim_start_matches('\u{feff}').to_owned())
        .filter(|l| !l.is_empty())
        .collect();
    let (_data, mut client) = ready_to_rip("lyric-ai-trial");
    let library = temp_dir("lyric-ai-trial-library");
    let mut copied = Vec::new();
    for (n, source) in songs.iter().enumerate() {
        let target = library
            .join(format!("Album {}", n / 10))
            .join(format!("{n:02}.mp3"));
        std::fs::create_dir_all(target.parent().unwrap()).unwrap();
        std::fs::copy(source, &target).unwrap();
        copied.push(target.to_string_lossy().into_owned());
    }
    assert_eq!(
        client.request(
            1,
            "import_collection",
            json!({ "root": library.to_string_lossy() })
        )["ok"],
        true
    );
    client.request(2, "set_lyrics_settings", json!({ "enabled": true }));
    let cuda = std::env::var("LYRIC_E2E_CUDA").ok();
    let processor = if cuda.is_some() { "cuda" } else { "cpu" };
    let configured = client.request(3, "lyric_ai_configure", json!({ "runtime": env("LYRIC_E2E_RUNTIME"), "models": env("LYRIC_E2E_MODELS"), "library_folders": cuda.iter().collect::<Vec<_>>(), "separator": processor, "reader": processor }));
    assert_eq!(configured["result"]["ready"], true, "{configured}");
    client.events.clear();
    let started = std::time::Instant::now();
    assert_eq!(
        client.request(4, "lyric_ai_analyse", json!({ "paths": copied }))["ok"],
        true
    );
    let done = client.wait_for_event("job-finished")["payload"].clone();
    println!(
        "job: {} in {:.0} s",
        done["result"],
        started.elapsed().as_secs_f64()
    );
    let results = client.request(5, "lyric_ai_results", json!({}));
    let mut counts = std::collections::BTreeMap::<String, usize>::new();
    for item in results["result"]["items"].as_array().unwrap() {
        let key = format!(
            "{} / {} / {}",
            item["task"].as_str().unwrap_or("?"),
            item["verdict"].as_str().unwrap_or("?"),
            item["need"].as_str().unwrap_or("?")
        );
        *counts.entry(key).or_default() += 1;
        let top = &item["ranking"][0];
        println!(
            "{:34} {:44} fit {:>6} flagged {:>2}/{:<2} | {}",
            item["artist"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(33)
                .collect::<String>(),
            item["title"]
                .as_str()
                .unwrap_or("")
                .chars()
                .take(43)
                .collect::<String>(),
            item["identity"]["fit"]
                .as_f64()
                .map_or("-".to_owned(), |f| format!("{f:.2}")),
            item["flagged"].as_u64().unwrap_or(0),
            item["lines"].as_u64().unwrap_or(0),
            if item["need"] == "sure" {
                "SURE".to_owned()
            } else {
                format!(
                    "{} {} ({} candidates, best {} {})",
                    item["verdict"].as_str().unwrap_or(""),
                    item["need"].as_str().unwrap_or(""),
                    item["candidates"],
                    top["artist"].as_str().unwrap_or("-"),
                    top["fit"]
                )
            }
        );
    }
    println!("\nsummary:");
    for (key, n) in counts {
        println!("{n:4}  {key}");
    }
}
