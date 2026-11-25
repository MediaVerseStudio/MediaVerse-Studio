//! End-to-end tests of chosen albums becoming tags, and of cover art.
#![allow(unused_imports)]

mod common;
use common::*;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[test]
fn a_chosen_album_becomes_exactly_the_expected_flac_tags() {
    let (_data, mut client) = ready_to_rip("candidate-tags");
    let archive = temp_dir("candidate-archive");
    client.request(
        1,
        "set_archive_dir",
        json!({ "path": archive.to_string_lossy() }),
    );
    let mut album = candidate(
        12,
        json!({ "disc_number": 2, "disc_count": 3, "compilation": true, "album": "Hits\nOf  The Day", "album_artist": "Various Artists" }),
    );
    album["tracks"][1]["artist"] = json!("Guest Band");

    client.request(2, "rip_disc", json!({ "device": "Z:", "output_dir": rip_dir("candidate").to_string_lossy(), "tracks": [2, 3], "candidate": album }));
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], true, "{finished}");
    assert_eq!(
        finished["payload"]["result"]["archive"]["tracks"]
            .as_array()
            .unwrap()
            .iter()
            .filter(|t| t["ok"] == true)
            .count(),
        2
    );

    let folder = archive.join("Various Artists").join("Hits Of The Day");
    let two = std::fs::read(folder.join("02 - Song 2.flac")).unwrap();
    let three = std::fs::read(folder.join("03 - Song 3.flac")).unwrap();
    let common = |title: &'static str, artist: &'static str, number: &'static str| {
        vec![
            ("TITLE", title),
            ("ARTIST", artist),
            ("ALBUM", "Hits Of The Day"),
            ("ALBUMARTIST", "Various Artists"),
            ("TRACKNUMBER", number),
            ("TRACKTOTAL", "12"),
            ("DISCNUMBER", "2"),
            ("DISCTOTAL", "3"),
            ("COMPILATION", "1"),
            ("GENRE", "Rock"),
            ("DATE", "1996"),
        ]
    };
    // Exactly these tags, in this order: nothing missing, nothing extra.
    mediaverse_ripper::flac::check_tags(&two, &common("Song 2", "Guest Band", "2")).unwrap();
    mediaverse_ripper::flac::check_tags(&three, &common("Song 3", "Various Artists", "3")).unwrap();
}

#[test]
fn a_single_disc_album_gets_no_disc_tags_and_a_blank_title_is_flagged() {
    let (_data, mut client) = ready_to_rip("candidate-plain");
    let archive = temp_dir("candidate-plain-archive");
    client.request(
        1,
        "set_archive_dir",
        json!({ "path": archive.to_string_lossy() }),
    );
    let mut album = candidate(12, json!({}));
    album["tracks"][1]["title"] = json!("  ");
    client.request(2, "rip_disc", json!({ "device": "Z:", "output_dir": rip_dir("candidate2").to_string_lossy(), "tracks": [2], "candidate": album }));
    let finished = client.wait_for_event("job-finished");
    let result = &finished["payload"]["result"];
    let file = archive
        .join("The Watchmen")
        .join("Brand New Day")
        .join("02 - Track 02.flac");
    let bytes = std::fs::read(&file).unwrap();
    mediaverse_ripper::flac::check_tags(
        &bytes,
        &[
            ("TITLE", "Track 02"),
            ("ARTIST", "The Watchmen"),
            ("ALBUM", "Brand New Day"),
            ("ALBUMARTIST", "The Watchmen"),
            ("TRACKNUMBER", "2"),
            ("TRACKTOTAL", "12"),
            ("GENRE", "Rock"),
            ("DATE", "1996"),
        ],
    )
    .unwrap();
    let warnings = result["warnings"].as_array().unwrap();
    assert!(
        warnings
            .iter()
            .any(|w| w.as_str().unwrap().contains("has no title")),
        "{warnings:?}"
    );
}

#[test]
fn a_candidate_for_a_different_disc_or_with_missing_details_is_refused() {
    let (_data, mut client) = ready_to_rip("candidate-bad");
    // Ten tracks listed, twelve on the disc: refused before anything is ripped.
    client.request(1, "rip_disc", json!({ "device": "Z:", "output_dir": rip_dir("bad1").to_string_lossy(), "archive": false, "candidate": candidate(10, json!({})) }));
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], false);
    assert_eq!(finished["payload"]["error"]["code"], "metadata_mismatch");
    assert!(
        finished["payload"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("lists 10 tracks")
    );
    assert!(!rip_dir("bad1").exists(), "nothing was ripped");

    for (broken, expected) in [
        (json!({ "album": "" }), "no title"),
        (json!({ "album_artist": null }), "no artist"),
        (json!({ "tracks": [] }), "lists no tracks"),
    ] {
        let response = client.request(
            2,
            "rip_disc",
            json!({ "device": "Z:", "output_dir": "x", "candidate": candidate(12, broken) }),
        );
        assert_eq!(response["error"]["code"], "invalid_candidate", "{response}");
        assert!(
            response["error"]["message"]
                .as_str()
                .unwrap()
                .contains(expected),
            "{response}"
        );
    }
}

#[test]
fn the_front_cover_is_saved_beside_the_masters_exactly_as_received() {
    let image = jpeg(1200, 1180, false);
    let served = image.clone();
    let (mut client, server, archive) = with_cover_server("cover-ok", move |target| {
        if target.ends_with("/front-1200") {
            fakes::ok(served.clone())
        } else {
            fakes::Reply {
                status: 404,
                headers: vec![],
                body: vec![],
            }
        }
    });
    let result = rip_with_cover(&mut client, 3, "cover-ok");
    let folder = archive.join("The Watchmen").join("Brand New Day");
    assert_eq!(
        std::fs::read(folder.join("cover.jpg")).unwrap(),
        image,
        "written byte for byte"
    );
    assert_eq!(result["archive"]["cover"]["ok"], true);
    assert_eq!(result["archive"]["cover"]["width"], 1200);
    assert!(folder.join("02 - Song 2.flac").is_file());
    assert_eq!(
        server.seen.lock().unwrap()[0].target,
        format!("/release/{RELEASE}/front-1200")
    );
    assert!(
        server.seen.lock().unwrap()[0]
            .user_agent
            .starts_with("MediaVerseStudio/")
    );
    assert!(
        warnings_of(&result).is_empty(),
        "{:?}",
        warnings_of(&result)
    );

    // A second rip leaves the existing cover alone.
    let second = rip_with_cover(&mut client, 4, "cover-ok2");
    assert_eq!(second["archive"]["cover"]["skipped"], true);
    assert_eq!(std::fs::read(folder.join("cover.jpg")).unwrap(), image);
}

#[test]
fn a_smaller_size_is_used_when_the_large_one_is_missing() {
    let image = jpeg(500, 500, false);
    let served = image.clone();
    let (mut client, server, archive) = with_cover_server("cover-small", move |target| {
        if target.ends_with("/front-500") {
            fakes::ok(served.clone())
        } else {
            fakes::Reply {
                status: 404,
                headers: vec![],
                body: vec![],
            }
        }
    });
    rip_with_cover(&mut client, 3, "cover-small");
    assert_eq!(
        std::fs::read(
            archive
                .join("The Watchmen")
                .join("Brand New Day")
                .join("cover.jpg")
        )
        .unwrap(),
        image
    );
    let targets: Vec<String> = server
        .seen
        .lock()
        .unwrap()
        .iter()
        .map(|s| s.target.clone())
        .collect();
    assert_eq!(
        targets,
        [
            format!("/release/{RELEASE}/front-1200"),
            format!("/release/{RELEASE}/front-500")
        ]
    );
}

#[test]
fn missing_bad_or_hostile_cover_downloads_never_stop_the_masters_being_saved() {
    for (label, reply_body, expected) in [
        ("none", None, "No front cover is available"),
        (
            "html",
            Some(b"<html>Not Found</html>".to_vec()),
            "not a JPEG or PNG",
        ),
        ("tiny", Some(jpeg(60, 60, false)), "outside the accepted"),
        ("wide", Some(jpeg(2000, 300, false)), "not cover-shaped"),
    ] {
        let body = reply_body.clone();
        let (mut client, _server, archive) =
            with_cover_server(&format!("cover-{label}"), move |_| match &body {
                Some(bytes) => fakes::ok(bytes.clone()),
                None => fakes::Reply {
                    status: 404,
                    headers: vec![],
                    body: vec![],
                },
            });
        let result = rip_with_cover(&mut client, 3, &format!("cover-{label}"));
        let folder = archive.join("The Watchmen").join("Brand New Day");
        assert!(
            folder.join("02 - Song 2.flac").is_file(),
            "{label}: the master must still be saved"
        );
        assert!(
            !folder.join("cover.jpg").exists() && !folder.join("cover.png").exists(),
            "{label}: nothing bad is written"
        );
        assert!(
            warnings_of(&result).iter().any(|w| w.contains(expected)),
            "{label}: {:?}",
            warnings_of(&result)
        );
    }
}

#[test]
fn a_progressive_jpeg_is_saved_with_a_warning_and_cover_art_can_be_switched_off() {
    let progressive = jpeg(800, 800, true);
    let served = progressive.clone();
    let (mut client, _server, archive) =
        with_cover_server("cover-prog", move |_| fakes::ok(served.clone()));
    let result = rip_with_cover(&mut client, 3, "cover-prog");
    assert!(
        archive
            .join("The Watchmen")
            .join("Brand New Day")
            .join("cover.jpg")
            .is_file()
    );
    assert!(
        warnings_of(&result)
            .iter()
            .any(|w| w.contains("progressive JPEG"))
    );

    // Switched off: no request at all.
    let (mut client, server, archive) =
        with_cover_server("cover-off", move |_| fakes::ok(jpeg(800, 800, false)));
    client.request(
        9,
        "set_metadata_settings",
        json!({ "settings": { "cover_art": { "enabled": false } } }),
    );
    let result = rip_with_cover(&mut client, 10, "cover-off");
    assert!(server.seen.lock().unwrap().is_empty());
    assert!(
        !archive
            .join("The Watchmen")
            .join("Brand New Day")
            .join("cover.jpg")
            .exists()
    );
    assert!(
        warnings_of(&result).is_empty(),
        "{:?}",
        warnings_of(&result)
    );
}

#[test]
fn an_invalid_release_id_is_never_put_into_a_request() {
    let (mut client, server, _archive) =
        with_cover_server("cover-badid", |_| fakes::ok(jpeg(800, 800, false)));
    client.events.clear();
    client.request(3, "rip_disc", json!({
        "device": "Z:", "output_dir": rip_dir("cover-badid").to_string_lossy(), "tracks": [2], "mp3": false,
        "candidate": candidate(12, json!({ "cover_art_release": "../../secret?x=1" })),
    }));
    let finished = client.wait_for_event("job-finished");
    assert!(
        warnings_of(&finished["payload"]["result"])
            .iter()
            .any(|w| w.contains("not a valid release id"))
    );
    assert!(server.seen.lock().unwrap().is_empty());
}
