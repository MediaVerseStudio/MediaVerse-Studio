//! End-to-end tests of ripping, the folder rules and the FLAC archive.
#![allow(unused_imports)]

mod common;
use common::*;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[test]
fn ripping_requires_a_calibrated_drive() {
    let data = temp_dir("rip-uncalibrated");
    seed_accuraterip(&data, "found");
    let mut client = Client::start(&data, false);
    client.request(1, "rip_disc", json!({ "device": "Z:", "output_dir": "out", "archive": false, "metadata": { "album": "A", "artist": "B" } }));
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], false);
    assert_eq!(finished["payload"]["error"]["code"], "drive_not_calibrated");
}

#[test]
fn ripping_applies_the_measured_offset_and_reports_progress() {
    let data = temp_dir("rip-measured");
    seed_accuraterip(&data, "found");
    let mut client = Client::start(&data, false);
    client.request(1, "calibrate_drive", json!({ "device": "Z:" }));
    client.wait_for_event("job-finished"); // saves a profile with a measured offset of 6
    client.events.clear(); // drop the calibration job's leftover progress events

    let started = client.request(
        2,
        "rip_disc",
        json!({ "device": "Z:", "output_dir": rip_dir("measured").to_string_lossy(), "tracks": [2, 3], "secure": true, "archive": false, "mp3": false }),
    );
    let job = started["result"]["job_id"].as_str().unwrap().to_owned();

    let progress = client.wait_for_event("job-progress");
    assert_eq!(progress["payload"]["kind"], "rip");
    assert_eq!(progress["payload"]["job_id"], job.as_str());
    assert_eq!(progress["payload"]["total"], 1500);

    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], true, "{finished}");
    let result = &finished["payload"]["result"];
    assert_eq!(result["echo"]["offset"], 6);
    assert_eq!(
        result["echo"]["output_dir"],
        rip_dir("measured").to_string_lossy().as_ref()
    );
    assert_eq!(result["echo"]["tracks"], json!([2, 3]));
    assert_eq!(result["echo"]["secure"], true);
    assert_eq!(result["echo"]["pressings_hex_len"], 6);
    assert_eq!(result["offset_verified"], true);
    // The fake helper deliberately makes track 3 fail the AccurateRip comparison: a warning, not a failure.
    let warnings = result["warnings"].as_array().unwrap();
    assert_eq!(warnings.len(), 1, "{warnings:?}");
    assert!(
        warnings[0]
            .as_str()
            .unwrap()
            .starts_with("Track 3 did not match AccurateRip")
    );
    // Read again once, it came out the same with no read problems: not damage, but a copy AccurateRip's entry does
    // not confirm (another pressing, perhaps), and the page says exactly that.
    assert_eq!(result["disc_health"]["state"], "good");
    assert_eq!(result["disc_health"]["damaged"], json!([]));
    assert_eq!(result["disc_health"]["unmatched"], json!([3]));
    assert_eq!(result["disc_health"]["tracks"][0]["passes"], 2);
    assert_eq!(
        result["tracks"][1]["read_agreement"],
        json!({ "reads": 2, "identical": true })
    );

    // The finished rip is in the drive's track record, and the record can be cleared.
    let history = client.request(3, "drive_history", Value::Null);
    let record = &history["result"][0];
    assert_eq!(record["name"], "FAKE Fake Drive", "{history}");
    assert_eq!(
        (
            record["discs"].as_u64(),
            record["tracks"].as_u64(),
            record["differing"].as_u64()
        ),
        (Some(1), Some(2), Some(1)),
        "{history}"
    );
    assert_eq!(
        client.request(4, "clear_drive_history", Value::Null)["result"]["cleared"],
        true
    );
    assert_eq!(
        client.request(5, "drive_history", Value::Null)["result"],
        json!([])
    );
    assert_eq!(result["disc"], "0013232b-00b35ece-860a510c");
}

#[test]
fn an_offset_that_was_never_measured_is_flagged_on_the_rip() {
    use mediaverse_ripper::profile::{DriveProfile, Field, Provenance};
    let data = temp_dir("rip-manual");
    seed_accuraterip(&data, "found");
    let mut profile = DriveProfile::new(fake_identity(), "test");
    profile.read_offset = Some(Field {
        value: 30,
        provenance: Provenance::Manual,
    });
    mediaverse_sidecar::profiles::ProfileStore::new(&data)
        .save(&profile)
        .unwrap();

    let mut client = Client::start(&data, false);
    client.request(1, "rip_disc", json!({ "device": "Z:", "output_dir": rip_dir("manual").to_string_lossy(), "archive": false, "metadata": { "album": "A", "artist": "B" } }));
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], true, "{finished}");
    let result = &finished["payload"]["result"];
    assert_eq!(result["echo"]["offset"], 30);
    assert_eq!(result["offset_verified"], false);
    let warnings = result["warnings"].as_array().unwrap();
    assert!(warnings.iter().any(|w| {
        w.as_str()
            .unwrap()
            .contains("not verified against AccurateRip")
    }));
}

#[test]
fn a_rip_that_would_be_tagged_needs_an_album_and_an_artist_first() {
    let data = temp_dir("rip-tags");
    seed_accuraterip(&data, "found");
    let mut client = Client::start(&data, false);
    for details in [
        json!({}),
        json!({ "metadata": { "album": "  ", "artist": "X" } }),
        json!({ "metadata": { "album": "Y" } }),
    ] {
        let mut args = json!({ "device": "Z:", "output_dir": rip_dir("tags").to_string_lossy(), "archive": false, "mp3": true });
        args.as_object_mut()
            .unwrap()
            .extend(details.as_object().unwrap().clone());
        let refused = client.request(1, "rip_disc", args);
        assert_eq!(refused["error"]["code"], "tags_required", "{refused}");
    }
    // Typed details are accepted, and so is a rip that writes no tagged files at all.
    let typed = client.request(2, "rip_disc", json!({ "device": "Z:", "output_dir": rip_dir("tags").to_string_lossy(), "archive": false, "mp3": false, "tracks": [2] }));
    assert_eq!(typed["ok"], true, "{typed}");
}

#[test]
fn a_running_rip_can_be_cancelled() {
    use mediaverse_ripper::profile::{DriveProfile, Field};
    let data = temp_dir("rip-cancel");
    seed_accuraterip(&data, "found");
    let mut profile = DriveProfile::new(fake_identity(), "test");
    profile.read_offset = Some(Field::measured(6));
    mediaverse_sidecar::profiles::ProfileStore::new(&data)
        .save(&profile)
        .unwrap();

    let mut client = Client::start(&data, true);
    let job = client.request(1, "rip_disc", json!({ "device": "Z:", "output_dir": "out", "archive": false, "metadata": { "album": "A", "artist": "B" } }))["result"]["job_id"]
        .as_str()
        .unwrap()
        .to_owned();
    client.wait_for_event("job-progress");
    assert_eq!(
        client.request(2, "cancel_job", json!({ "job_id": job }))["ok"],
        true
    );
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["error"]["code"], "cancelled");
}

#[test]
fn rip_arguments_are_checked() {
    let data = temp_dir("rip-args");
    let mut client = Client::start(&data, false);
    // The working folder is optional (the program picks one), but must be text when given.
    assert_eq!(
        client.request(1, "rip_disc", json!({ "device": "Z:", "output_dir": 5 }))["error"]["code"],
        "invalid_arguments"
    );
    assert_eq!(
        client.request(2, "rip_disc", json!({ "output_dir": "x" }))["error"]["code"],
        "invalid_arguments"
    );
}
#[test]
fn the_archive_folder_must_be_separate_from_the_library() {
    let data = temp_dir("archive-settings");
    let library = temp_dir("archive-library");
    let mut client = Client::start(&data, false);

    // With no library chosen yet, any full path is accepted; relative ones are not.
    assert_eq!(
        client.request(1, "set_archive_dir", json!({ "path": "relative" }))["error"]["code"],
        "invalid_archive_location"
    );
    let outside = temp_dir("archive-elsewhere");
    assert_eq!(
        client.request(
            2,
            "set_archive_dir",
            json!({ "path": outside.to_string_lossy() })
        )["ok"],
        true
    );

    assert_eq!(
        client.request(
            3,
            "import_collection",
            json!({ "root": library.to_string_lossy() })
        )["ok"],
        true
    );
    let settings = client.request(4, "get_archive_settings", Value::Null);
    assert_eq!(
        settings["result"]["archive_dir"],
        outside.to_string_lossy().as_ref()
    );
    assert_eq!(
        settings["result"]["library_dir"],
        library.to_string_lossy().as_ref()
    );

    let inside = library.join("archive");
    for bad in [library.clone(), inside, library.join("a").join("..")] {
        let response = client.request(
            5,
            "set_archive_dir",
            json!({ "path": bad.to_string_lossy() }),
        );
        assert_eq!(
            response["error"]["code"], "invalid_archive_location",
            "{bad:?}: {response}"
        );
    }
    let parent = library.parent().unwrap().to_path_buf();
    assert_eq!(
        client.request(
            6,
            "set_archive_dir",
            json!({ "path": parent.to_string_lossy() })
        )["error"]["code"],
        "invalid_archive_location"
    );

    // The rejected attempts left the earlier setting alone; null clears it.
    assert_eq!(
        client.request(7, "get_archive_settings", Value::Null)["result"]["archive_dir"],
        outside.to_string_lossy().as_ref()
    );
    assert_eq!(
        client.request(8, "set_archive_dir", json!({ "path": null }))["result"]["archive_dir"],
        Value::Null
    );
    assert_eq!(
        client.request(9, "set_archive_dir", json!({ "path": 5 }))["error"]["code"],
        "invalid_arguments"
    );
}

#[test]
fn a_rip_saves_verified_tagged_flac_masters_to_the_archive() {
    use mediaverse_metadata_tags::read_track_metadata;
    let (_data, mut client) = ready_to_rip("archive-rip");
    let archive = temp_dir("archive-dest");
    client.request(
        1,
        "set_archive_dir",
        json!({ "path": archive.to_string_lossy() }),
    );

    let work = rip_dir("archive-work");
    client.request(
        2,
        "rip_disc",
        json!({
            "device": "Z:", "output_dir": work.to_string_lossy(), "tracks": [2, 3], "mp3": false, "keep_wav": true,
            "metadata": {
                "album_artist": "Operation Ivy", "album": "Energy", "genre": "Punk", "release_year": 1989,
                "tracks": { "2": { "title": "Sound System" }, "3": { "title": "Bad/Town?" } },
            },
        }),
    );
    let archive_progress = client.wait_for_event("job-progress");
    assert_eq!(archive_progress["payload"]["kind"], "rip"); // the fake helper's own progress comes first
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], true, "{finished}");
    let result = &finished["payload"]["result"];

    let tracks = result["archive"]["tracks"].as_array().unwrap();
    assert_eq!(tracks.len(), 2);
    assert!(tracks.iter().all(|t| t["ok"] == true), "{tracks:?}");

    let album = archive.join("Operation Ivy").join("Energy");
    let first = album.join("02 - Sound System.flac");
    let second = album.join("03 - Bad_Town_.flac"); // characters Windows forbids are replaced
    for (path, number) in [(&first, 2u8), (&second, 3u8)] {
        let bytes = std::fs::read(path).unwrap_or_else(|e| panic!("{}: {e}", path.display()));
        mediaverse_ripper::flac::verify(&bytes, &fake_samples(number))
            .expect("archived audio is exactly the ripped audio");
    }

    let tags = read_track_metadata(&first).unwrap();
    assert_eq!(tags.title.as_deref(), Some("Sound System"));
    assert_eq!(tags.album.as_deref(), Some("Energy"));
    assert_eq!(tags.album_artist.as_deref(), Some("Operation Ivy"));
    assert_eq!(tags.artist.as_deref(), Some("Operation Ivy"));
    assert_eq!(tags.genre.as_deref(), Some("Punk"));
    assert_eq!(tags.release_year, Some(1989));
    assert_eq!(tags.track_number, Some(2));

    assert!(
        album.join("rip-log.json").is_file(),
        "the rip log is kept with the masters"
    );
    assert!(
        work.join("02.wav").is_file(),
        "the WAV intermediates stay until the MP3 step has used them"
    );

    // Track 3 did not match AccurateRip: it is saved, but flagged.
    let warnings: Vec<_> = result["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_str().unwrap())
        .collect();
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("Track 3") && w.contains("not verified against AccurateRip")),
        "{warnings:?}"
    );
    assert!(
        !warnings.iter().any(|w| w.contains("Track 2")),
        "{warnings:?}"
    );
}

#[test]
fn archived_files_are_never_overwritten_and_failures_are_reported_per_track() {
    let (_data, mut client) = ready_to_rip("archive-twice");
    let archive = temp_dir("archive-twice-dest");
    client.request(
        1,
        "set_archive_dir",
        json!({ "path": archive.to_string_lossy() }),
    );
    let args = json!({
        "device": "Z:", "output_dir": rip_dir("twice").to_string_lossy(), "tracks": [2],
        "metadata": { "album_artist": "A", "album": "B", "tracks": { "2": { "title": "T" } } },
    });

    client.request(2, "rip_disc", args.clone());
    assert_eq!(
        client.wait_for_event("job-finished")["payload"]["result"]["archive"]["tracks"][0]["ok"],
        true
    );
    let path = archive.join("A").join("B").join("02 - T.flac");
    let original = std::fs::read(&path).unwrap();

    client.events.clear();
    client.request(3, "rip_disc", args);
    let second = client.wait_for_event("job-finished");
    assert_eq!(
        second["payload"]["ok"], true,
        "the job still finishes: {second}"
    );
    let entry = &second["payload"]["result"]["archive"]["tracks"][0];
    assert_eq!(entry["ok"], false);
    assert!(
        entry["error"].as_str().unwrap().contains("already exists"),
        "{entry}"
    );
    assert_eq!(
        std::fs::read(&path).unwrap(),
        original,
        "the first master is untouched"
    );
    let warnings = second["payload"]["result"]["warnings"].as_array().unwrap();
    assert!(
        warnings
            .iter()
            .any(|w| w.as_str().unwrap().contains("was not saved to the archive"))
    );
}

#[test]
fn ripping_without_an_archive_folder_says_so_and_can_skip_archiving() {
    let (_data, mut client) = ready_to_rip("archive-none");
    // Archiving is on by default: with no archive folder the rip is refused before the disc is touched.
    client.request(1, "rip_disc", json!({ "device": "Z:", "output_dir": rip_dir("none").to_string_lossy(), "metadata": { "album": "A", "artist": "B" } }));
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], false);
    assert_eq!(
        finished["payload"]["error"]["code"],
        "archive_folder_required"
    );
    assert!(
        finished["payload"]["error"]["message"]
            .as_str()
            .unwrap()
            .contains("turn archiving off")
    );
    assert!(!rip_dir("none").exists(), "nothing was ripped");

    client.events.clear();
    client.request(2, "rip_disc", json!({ "device": "Z:", "output_dir": rip_dir("none2").to_string_lossy(), "archive": false, "mp3": false }));
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["result"]["warnings"], json!([]));
}

#[test]
fn an_archive_that_ends_up_inside_the_library_is_not_written_to() {
    let (data, mut client) = ready_to_rip("archive-nested");
    // The library is chosen later, and it contains the archive. (Its own folder: the shared temp folder holds
    // whatever else is lying around, which made importing it fail on some machines and on CI.)
    let library = temp_dir("archive-nested-lib");
    let archive = library.join("archive");
    std::fs::create_dir_all(&archive).unwrap();
    client.request(
        1,
        "set_archive_dir",
        json!({ "path": archive.to_string_lossy() }),
    );
    assert_eq!(
        client.request(
            2,
            "import_collection",
            json!({ "root": library.to_string_lossy() })
        )["ok"],
        true
    );

    // Refused up front, before the disc is read.
    client.request(3, "rip_disc", json!({ "device": "Z:", "output_dir": rip_dir("nested").to_string_lossy(), "metadata": { "album": "A", "artist": "B" } }));
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], false);
    assert_eq!(
        finished["payload"]["error"]["code"],
        "invalid_archive_location"
    );
    assert!(!archive.join("Unknown Artist").exists());
    let _ = data;
}
