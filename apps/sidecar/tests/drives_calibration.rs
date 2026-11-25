//! End-to-end tests of drive listing and calibration: the real sidecar binary talking to a fake helper.
#![allow(unused_imports)]

mod common;
use common::*;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[test]
fn advertises_the_drive_commands() {
    let data = temp_dir("ready");
    let mut command = Command::new(env!("CARGO_BIN_EXE_mediaverse_sidecar"));
    let mut child = command
        .arg("--data-dir")
        .arg(&data)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .spawn()
        .unwrap();
    let mut ready = String::new();
    BufReader::new(child.stdout.take().unwrap())
        .read_line(&mut ready)
        .unwrap();
    let ready: Value = serde_json::from_str(&ready).unwrap();
    for name in [
        "calibrate_drive",
        "cancel_job",
        "list_drives",
        "library_snapshot",
    ] {
        assert!(
            ready["commands"].as_array().unwrap().contains(&json!(name)),
            "{name}"
        );
    }
    let _ = child.kill();
}

#[test]
fn lists_drives_from_the_helper_with_no_profile_yet() {
    let data = temp_dir("list");
    let mut client = Client::start(&data, false);
    let response = client.request(1, "list_drives", Value::Null);
    assert_eq!(response["ok"], true, "{response}");
    assert_eq!(response["result"][0]["model"], "Fake Drive");
    assert_eq!(response["result"][0]["profile"], Value::Null);
    assert_eq!(
        client.request(2, "list_drive_profiles", Value::Null)["result"],
        json!([])
    );
}

#[test]
fn calibration_is_a_job_that_reports_progress_and_saves_the_profile() {
    let data = temp_dir("job");
    seed_accuraterip(&data, "found");
    let mut client = Client::start(&data, false);

    let started = client.request(1, "calibrate_drive", json!({ "device": "Z:" }));
    let job = started["result"]["job_id"]
        .as_str()
        .expect("job id")
        .to_owned();

    let progress = client.wait_for_event("job-progress");
    assert_eq!(progress["payload"]["job_id"], job.as_str());
    assert_eq!(progress["payload"]["kind"], "calibration");
    assert_eq!(progress["payload"]["step"], "read_test");

    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], true, "{finished}");
    let report = &finished["payload"]["result"];
    assert_eq!(report["offset"]["offset"], 6);
    assert_eq!(report["disc"], "0013232b-00b35ece-860a510c");
    // The cached AccurateRip bytes [1,2,3] were passed to the helper as six hex characters.
    assert_eq!(report["echo"]["pressings_hex_len"], 6);
    assert_eq!(report["echo"]["date_len"], 10);
    assert_eq!(report["echo"]["existing_offset"], Value::Null);

    // The profile was saved and now shows up in both listings.
    let profiles = client.request(2, "list_drive_profiles", Value::Null);
    assert_eq!(profiles["result"].as_array().unwrap().len(), 1);
    assert_eq!(profiles["result"][0]["read_offset"]["value"], 6);
    let drives = client.request(3, "list_drives", Value::Null);
    assert_eq!(
        drives["result"][0]["profile"]["read_offset"]["provenance"],
        "measured"
    );

    // A second run hands the stored profile to the helper as `existing`.
    client.request(4, "calibrate_drive", json!({ "device": "Z:" }));
    let second = client.wait_for_event("job-finished");
    assert_eq!(second["payload"]["result"]["echo"]["existing_offset"], 6);
}

#[test]
fn a_disc_missing_from_accuraterip_is_noted_not_fatal() {
    let data = temp_dir("missing");
    seed_accuraterip(&data, "missing");
    let mut client = Client::start(&data, false);
    client.request(1, "calibrate_drive", json!({ "device": "Z:" }));
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], true, "{finished}");
    let report = &finished["payload"]["result"];
    assert_eq!(report["echo"]["pressings_hex_len"], 0);
    let warnings = report["warnings"].as_array().unwrap();
    assert!(warnings.iter().any(|w| {
        w.as_str()
            .unwrap()
            .contains("not in the AccurateRip database")
    }));
}

#[test]
fn an_unknown_device_fails_the_job_with_a_clear_error() {
    let data = temp_dir("nodrive");
    let mut client = Client::start(&data, false);
    client.request(1, "calibrate_drive", json!({ "device": "Q:" }));
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], false);
    assert_eq!(finished["payload"]["error"]["code"], "drive_not_found");
}

#[test]
fn a_running_calibration_can_be_cancelled() {
    let data = temp_dir("cancel");
    seed_accuraterip(&data, "found");
    let mut client = Client::start(&data, true);

    let job = client.request(1, "calibrate_drive", json!({ "device": "Z:" }))["result"]["job_id"]
        .as_str()
        .unwrap()
        .to_owned();
    client.wait_for_event("job-progress"); // the helper is now waiting inside calibrate

    let cancel = client.request(2, "cancel_job", json!({ "job_id": job }));
    assert_eq!(cancel["ok"], true, "{cancel}");
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], false);
    assert_eq!(finished["payload"]["error"]["code"], "cancelled");
    assert!(
        client.request(3, "list_drive_profiles", Value::Null)["result"]
            .as_array()
            .unwrap()
            .is_empty()
    );

    let again = client.request(4, "cancel_job", json!({ "job_id": job }));
    assert_eq!(again["error"]["code"], "unknown_job");
}

#[test]
fn bad_arguments_are_rejected() {
    let data = temp_dir("badargs");
    let mut client = Client::start(&data, false);
    assert_eq!(
        client.request(1, "calibrate_drive", json!({}))["error"]["code"],
        "invalid_arguments"
    );
    assert_eq!(
        client.request(2, "cancel_job", json!({}))["error"]["code"],
        "invalid_arguments"
    );
}
