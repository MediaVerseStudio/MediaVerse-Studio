//! End-to-end tests of listening history and the "New" shelf.
#![allow(unused_imports)]

mod common;
use common::*;
use serde_json::{Value, json};

#[test]
fn plays_are_recorded_only_while_history_is_on_and_only_for_library_files() {
    let (_data, mut client) = ready_to_rip("history");
    let library = temp_dir("history-library");
    std::fs::create_dir_all(library.join("Band").join("LP")).unwrap();
    let song = library.join("Band").join("LP").join("01.mp3");
    std::fs::write(&song, b"x").unwrap();
    let outside = temp_dir("history-outside").join("x.mp3");
    std::fs::write(&outside, b"x").unwrap();
    assert_eq!(
        client.request(
            1,
            "import_collection",
            json!({ "root": library.to_string_lossy() })
        )["ok"],
        true
    );

    let listed = client.request(2, "list_history", Value::Null);
    assert_eq!(listed["result"]["enabled"], true, "on unless switched off");
    assert_eq!(listed["result"]["entries"], json!([]));

    let play = |client: &mut Client, id: u64, path: &std::path::Path| {
        client.request(id, "record_play", json!({ "path": path.to_string_lossy(), "title": "Song", "artist": "Band", "album": "LP" }))
    };
    assert_eq!(play(&mut client, 3, &song)["result"]["recorded"], true);
    assert_eq!(play(&mut client, 4, &song)["result"]["recorded"], true);
    assert_eq!(
        play(&mut client, 5, &outside)["error"]["code"],
        "invalid_arguments",
        "a file outside the library is refused"
    );
    let entries = client.request(6, "list_history", Value::Null)["result"]["entries"].clone();
    assert_eq!(entries.as_array().unwrap().len(), 1);
    assert_eq!(entries[0]["count"], 2);
    assert_eq!(entries[0]["album"], "LP");

    // Switched off: nothing is recorded, what exists is kept, and it can be cleared.
    assert_eq!(
        client.request(7, "set_history_enabled", json!({ "enabled": false }))["result"]["enabled"],
        false
    );
    assert_eq!(play(&mut client, 8, &song)["result"]["recorded"], false);
    assert_eq!(
        client.request(9, "list_history", Value::Null)["result"]["entries"][0]["count"],
        2
    );
    assert_eq!(
        client.request(10, "set_history_enabled", json!({ "enabled": "yes" }))["error"]["code"],
        "invalid_arguments"
    );
    let cleared = client.request(11, "clear_history", Value::Null);
    assert_eq!(cleared["result"]["entries"], json!([]));
    assert_eq!(cleared["result"]["enabled"], false);
}

#[test]
fn the_new_shelf_lists_audio_files_newest_first() {
    let (_data, mut client) = ready_to_rip("recent");
    let library = temp_dir("recent-library");
    std::fs::write(library.join("a.mp3"), b"x").unwrap();
    std::fs::write(library.join("notes.txt"), b"x").unwrap();
    assert_eq!(
        client.request(
            1,
            "import_collection",
            json!({ "root": library.to_string_lossy() })
        )["ok"],
        true
    );
    let reply = client.request(2, "recent_files", json!({ "limit": 10 }));
    assert_eq!(
        reply["result"]["files"].as_array().unwrap().len(),
        1,
        "{reply}"
    );
    assert!(
        reply["result"]["files"][0]["path"]
            .as_str()
            .unwrap()
            .ends_with("a.mp3")
    );
}

#[test]
fn albums_can_be_pinned_only_inside_the_library() {
    let (_data, mut client) = ready_to_rip("pins");
    let library = temp_dir("pins-library");
    let album = library.join("Band").join("LP");
    std::fs::create_dir_all(&album).unwrap();
    std::fs::write(album.join("01.mp3"), b"x").unwrap();
    let outside = temp_dir("pins-outside");
    assert_eq!(
        client.request(
            1,
            "import_collection",
            json!({ "root": library.to_string_lossy() })
        )["ok"],
        true
    );
    let pinned = client.request(
        2,
        "set_pin",
        json!({ "folder": album.to_string_lossy(), "album": "LP", "artist": "Band" }),
    );
    assert_eq!(
        pinned["result"]["pins"].as_array().unwrap().len(),
        1,
        "{pinned}"
    );
    assert_eq!(
        client.request(3, "list_pins", Value::Null)["result"]["pins"][0]["album"],
        "LP"
    );
    assert_eq!(
        client.request(4, "set_pin", json!({ "folder": outside.to_string_lossy() }))["error"]["code"],
        "invalid_arguments"
    );
    assert_eq!(
        client.request(
            5,
            "set_pin",
            json!({ "folder": album.join("01.mp3").to_string_lossy() })
        )["error"]["code"],
        "invalid_arguments",
        "a file is not an album folder"
    );
    assert_eq!(
        client.request(
            6,
            "set_pin",
            json!({ "folder": album.to_string_lossy(), "pinned": false })
        )["result"]["pins"],
        json!([])
    );
}

#[test]
fn a_new_folder_can_be_made_inside_a_chosen_folder_with_a_safe_name() {
    let (_data, mut client) = ready_to_rip("create-folder");
    let parent = temp_dir("create-folder-parent");
    let made = client.request(
        1,
        "create_folder",
        json!({ "parent": parent.to_string_lossy(), "name": "My Music: Library?" }),
    );
    assert_eq!(made["ok"], true, "{made}");
    let path = std::path::PathBuf::from(made["result"]["path"].as_str().unwrap());
    assert!(path.is_dir() && path.starts_with(&parent), "{path:?}");
    assert!(
        !made["result"]["created_name"]
            .as_str()
            .unwrap()
            .contains(['?', ':']),
        "{made}"
    );
    // Asking again for the same name is fine (it is simply used); a name that tries to leave the folder is made safe.
    assert_eq!(
        client.request(
            2,
            "create_folder",
            json!({ "parent": parent.to_string_lossy(), "name": "My Music: Library?" })
        )["ok"],
        true
    );
    let sneaky = client.request(
        3,
        "create_folder",
        json!({ "parent": parent.to_string_lossy(), "name": "..\\..\\evil" }),
    );
    let p = std::path::PathBuf::from(sneaky["result"]["path"].as_str().unwrap());
    assert!(p.starts_with(&parent) && p != parent, "{p:?}");
    assert_eq!(
        client.request(
            4,
            "create_folder",
            json!({ "parent": "relative", "name": "x" })
        )["error"]["code"],
        "invalid_arguments"
    );
    assert_eq!(
        client.request(
            5,
            "create_folder",
            json!({ "parent": parent.to_string_lossy(), "name": "  " })
        )["error"]["code"],
        "invalid_arguments"
    );
    // The archive decision starts undecided and is recorded by choosing a folder or switching it off.
    assert_eq!(
        client.request(6, "get_archive_settings", Value::Null)["result"]["archive_decided"],
        false
    );
    client.request(7, "set_archive_enabled", json!({ "enabled": false }));
    assert_eq!(
        client.request(8, "get_archive_settings", Value::Null)["result"]["archive_decided"],
        true
    );
}

#[test]
fn the_listen_length_defaults_to_eight_seconds_and_is_kept_within_limits() {
    let (_data, mut client) = ready_to_rip("listen");
    let got = client.request(1, "get_listen_settings", Value::Null);
    assert_eq!(got["result"]["seconds"], 8);
    assert_eq!(
        (
            got["result"]["recommended_min"].clone(),
            got["result"]["recommended_max"].clone()
        ),
        (json!(5), json!(12))
    );
    assert_eq!(
        client.request(2, "set_listen_settings", json!({ "seconds": 10 }))["result"]["seconds"],
        10
    );
    assert_eq!(
        client.request(3, "get_listen_settings", Value::Null)["result"]["seconds"],
        10
    );
    for bad in [
        json!({ "seconds": 1 }),
        json!({ "seconds": 99 }),
        json!({ "seconds": "ten" }),
        json!({}),
    ] {
        assert_eq!(
            client.request(4, "set_listen_settings", bad)["error"]["code"],
            "invalid_arguments"
        );
    }
}

#[test]
fn a_gaps_scan_reports_missing_covers_and_lyrics_as_a_job() {
    let (_data, mut client) = ready_to_rip("gaps");
    let library = temp_dir("gaps-library");
    let album = library.join("Band").join("LP");
    std::fs::create_dir_all(&album).unwrap();
    std::fs::write(album.join("01.mp3"), b"x").unwrap();
    assert_eq!(
        client.request(
            1,
            "import_collection",
            json!({ "root": library.to_string_lossy() })
        )["ok"],
        true
    );
    client.events.clear();
    client.request(2, "library_gaps", Value::Null);
    let done = client.wait_for_event("job-finished");
    assert_eq!(done["payload"]["ok"], true, "{done}");
    let files = done["payload"]["result"]["files"].as_array().unwrap();
    assert_eq!(files.len(), 1);
    assert_eq!(
        (files[0]["cover"].clone(), files[0]["lyrics"].clone()),
        (json!(false), json!(false))
    );
}
