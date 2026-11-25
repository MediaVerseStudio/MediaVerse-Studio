//! End-to-end tests of disc lookup and the metadata settings, against fake services.
#![allow(unused_imports)]

mod common;
use common::*;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[test]
fn metadata_settings_are_validated_masked_and_remembered() {
    let data = temp_dir("meta-settings");
    let mut client = Client::start(&data, false);

    let defaults = client.request(1, "get_metadata_settings", Value::Null);
    assert_eq!(
        defaults["result"]["cddb_servers"][0]["host"],
        "gnudb.gnudb.org"
    );
    assert_eq!(defaults["result"]["cddb_servers"][1]["port"], 8880);

    // MusicBrainz is on by default but needs contact details. That is flagged, not refused, so
    // anything else can still be saved; malformed values are refused.
    let bare = client.request(
        2,
        "set_metadata_settings",
        json!({ "settings": { "cover_art": { "enabled": true } } }),
    );
    assert_eq!(bare["ok"], true, "{bare}");
    assert_eq!(bare["result"]["setup_needed"][0]["source"], "musicbrainz");
    let refused = client.request(
        2,
        "set_metadata_settings",
        json!({ "settings": { "cddb_servers": [{ "name": "x", "host": "h", "port": 0 }] } }),
    );
    assert_eq!(refused["error"]["code"], "invalid_settings");
    assert!(
        refused["error"]["message"]
            .as_str()
            .unwrap()
            .contains("between 1 and 65535")
    );

    let saved = client.request(
        3,
        "set_metadata_settings",
        json!({ "settings": {
            "identity": { "contact": "alex@example.com" },
            "gracenote": { "enabled": true, "base_url": "https://gn.example.org", "client_id": "SUPER-SECRET-ID" },
        } }),
    );
    assert_eq!(saved["ok"], true, "{saved}");
    assert!(
        !saved.to_string().contains("SUPER-SECRET-ID"),
        "credentials never come back to the interface"
    );
    assert_eq!(
        saved["result"]["gracenote"]["client_id"],
        json!({ "set": true })
    );
    assert_eq!(
        saved["result"]["gracenote"]["user_id"],
        json!({ "set": false })
    );

    // Sending the masked view back changes nothing; the stored credential survives a restart.
    let again = client.request(
        4,
        "set_metadata_settings",
        json!({ "settings": saved["result"].clone() }),
    );
    assert_eq!(again["ok"], true, "{again}");
    let _ = client.child.kill();
    let mut restarted = Client::start(&data, false);
    let view = restarted.request(5, "get_metadata_settings", Value::Null);
    assert_eq!(view["result"]["identity"]["contact"], "alex@example.com");
    assert_eq!(
        view["result"]["gracenote"]["client_id"],
        json!({ "set": true })
    );
    assert!(!view.to_string().contains("SUPER-SECRET-ID"));
    let stored = std::fs::read_to_string(data.join("metadata-settings.json")).unwrap();
    assert!(
        stored.contains("SUPER-SECRET-ID"),
        "the real value is kept in the settings file"
    );
}

#[test]
fn a_lookup_merges_musicbrainz_gnudb_and_a_cddbp_mirror_using_the_users_own_servers() {
    let mb = fakes::Http::start(|_| fakes::ok(MB_WATCHMEN));
    let gnudb = fakes::Http::start(|target| {
        if target.contains("cddb+query") {
            fakes::ok("200 rock 860a510c The Watchmen / Brand New Day\n")
        } else {
            fakes::ok(watchmen_record(12))
        }
    });
    let mirror = fakes::Cddbp::start(
        "200 rock 860a510c The Watchmen / Brand New Day".to_owned(),
        watchmen_record(12),
    );

    let data = temp_dir("meta-merge");
    let mut client = Client::start(&data, false);
    let servers = vec![
        http_server_entry("gnudb", gnudb.port),
        json!({ "name": "my mirror", "transport": "cddbp", "host": "127.0.0.1", "port": mirror.port,
                "client_name": "MyRegisteredApp", "client_version": "9.9", "min_interval_ms": 0 }),
    ];
    let saved = client.request(
        1,
        "set_metadata_settings",
        json!({ "settings": metadata_settings(&mb.url(), servers) }),
    );
    assert_eq!(saved["ok"], true, "{saved}");

    let result = lookup(&mut client, 2);
    assert_eq!(result["errors"], json!([]));
    assert_eq!(result["disc_ids"]["cddb"], "860a510c");
    assert_eq!(
        result["disc_ids"]["musicbrainz"],
        "C9Ixgq666BRi1vBlyVjf1Bwd1e8-"
    );
    let candidates = result["candidates"].as_array().unwrap();
    assert_eq!(
        candidates.len(),
        1,
        "three sources agree on one album: {candidates:?}"
    );
    assert_eq!(
        candidates[0]["sources"],
        json!(["musicbrainz", "gnudb", "my mirror"])
    );
    assert_eq!(candidates[0]["album"]["album"], "Brand New Day");
    assert_eq!(
        candidates[0]["album"]["tracks"][0]["title"], "Zoom",
        "MusicBrainz's wording is preferred"
    );
    assert_eq!(
        candidates[0]["album"]["genre"], "Rock",
        "genre is filled in from the CDDB record"
    );
    assert_eq!(result["automatic_choice"], 0);

    // What each server was actually sent.
    let mb_request = mb.seen.lock().unwrap()[0].clone();
    assert!(
        mb_request
            .target
            .contains("/ws/2/discid/C9Ixgq666BRi1vBlyVjf1Bwd1e8-"),
        "{mb_request:?}"
    );
    assert!(
        mb_request.user_agent.starts_with("MediaVerseStudio/"),
        "{mb_request:?}"
    );
    assert!(
        mb_request.user_agent.contains("( alex@myhost.example )"),
        "{mb_request:?}"
    );
    let cddb_request = gnudb.seen.lock().unwrap()[0].target.clone();
    assert!(
        cddb_request.starts_with("/~cddb/cddb.cgi?cmd=cddb+query+860a510c+12+150+15920"),
        "{cddb_request}"
    );
    assert!(
        cddb_request.contains("hello=alex+myhost.example+MyRegisteredApp+9.9"),
        "the email is split into user and host, with the user's own client name: {cddb_request}"
    );
    assert!(cddb_request.contains("proto=6"));
    let commands = mirror.commands.lock().unwrap().clone();
    assert_eq!(
        commands[0],
        "cddb hello alex myhost.example MyRegisteredApp 9.9"
    );
    assert_eq!(commands[1], "proto 6");
    assert!(commands[2].starts_with("cddb query 860a510c 12 150 15920"));
    assert_eq!(commands[3], "cddb read rock 860a510c");
    assert_eq!(commands.last().unwrap(), "quit");
}

#[test]
fn one_failing_source_is_reported_by_name_and_does_not_hide_the_others() {
    let mb = fakes::Http::start(|_| fakes::ok(MB_WATCHMEN));
    let gnudb = fakes::Http::start(|_| {
        fakes::ok("500 Unknown application, developer email for MyRegisteredApp 9.9\n")
    });
    let data = temp_dir("meta-partial");
    let mut client = Client::start(&data, false);
    client.request(1, "set_metadata_settings", json!({ "settings": metadata_settings(&mb.url(), vec![http_server_entry("gnudb", gnudb.port)]) }));

    let result = lookup(&mut client, 2);
    let errors = result["errors"].as_array().unwrap();
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert_eq!(errors[0]["source"], "gnudb");
    assert_eq!(errors[0]["code"], "cddb_500");
    assert!(
        errors[0]["message"]
            .as_str()
            .unwrap()
            .contains("Unknown application")
    );
    assert_eq!(
        result["candidates"].as_array().unwrap().len(),
        1,
        "MusicBrainz still answered"
    );
    assert_eq!(result["sources_tried"], json!(["musicbrainz", "gnudb"]));
}

#[test]
fn rate_limit_replies_back_off_and_the_minimum_interval_is_kept() {
    let mb = fakes::Http::start(|_| fakes::Reply {
        status: 503,
        headers: vec![("Retry-After", "1".to_owned())],
        body: b"busy".to_vec(),
    });
    let data = temp_dir("meta-rate");
    let mut client = Client::start(&data, false);
    client.request(
        1,
        "set_metadata_settings",
        json!({ "settings": metadata_settings(&mb.url(), vec![]) }),
    );

    let first = lookup(&mut client, 2);
    assert_eq!(first["errors"][0]["code"], "rate_limited");
    assert_eq!(first["errors"][0]["source"], "musicbrainz");
    let second = lookup(&mut client, 3);
    assert_eq!(second["errors"][0]["code"], "rate_limited");

    let seen = mb.seen.lock().unwrap().clone();
    assert_eq!(seen.len(), 2);
    let gap = seen[1].at.duration_since(seen[0].at);
    assert!(
        gap >= std::time::Duration::from_millis(950),
        "the server said Retry-After: 1, but the next request came after {gap:?}"
    );
}

#[test]
fn no_matches_anywhere_is_an_empty_answer_not_an_error() {
    let mb = fakes::Http::start(|_| fakes::Reply {
        status: 404,
        headers: vec![],
        body: br#"{"error":"Not found"}"#.to_vec(),
    });
    let gnudb = fakes::Http::start(|_| fakes::ok("202 No match found\n"));
    let data = temp_dir("meta-none");
    let mut client = Client::start(&data, false);
    client.request(1, "set_metadata_settings", json!({ "settings": metadata_settings(&mb.url(), vec![http_server_entry("gnudb", gnudb.port)]) }));
    let result = lookup(&mut client, 2);
    assert_eq!(result["candidates"], json!([]));
    assert_eq!(result["errors"], json!([]));
    assert_eq!(result["automatic_choice"], Value::Null);
}

#[test]
fn unreachable_insecure_and_unavailable_services_are_explained() {
    let gnudb = fakes::Http::start(|target| {
        if target.contains("cddb+query") {
            fakes::ok("200 rock 860a510c The Watchmen / Brand New Day\n")
        } else {
            fakes::ok(watchmen_record(7))
        }
    });
    let dead_port = std::net::TcpListener::bind("127.0.0.1:0")
        .unwrap()
        .local_addr()
        .unwrap()
        .port(); // closed again at once
    let data = temp_dir("meta-errors");
    let mut client = Client::start(&data, false);
    // An https address on a port that is listening but only speaks plain http: the secure handshake fails.
    let mut settings = metadata_settings(
        &format!("https://127.0.0.1:{}", gnudb.port),
        vec![
            http_server_entry("gnudb", gnudb.port),
            http_server_entry("gone", dead_port),
        ],
    );
    settings["gracenote"] =
        json!({ "enabled": true, "base_url": "https://gn.example.org", "client_id": "x" });
    let saved = client.request(1, "set_metadata_settings", json!({ "settings": settings }));
    assert_eq!(saved["ok"], true, "{saved}");

    let result = lookup(&mut client, 2);
    let code_of = |source: &str| {
        result["errors"]
            .as_array()
            .unwrap()
            .iter()
            .find(|e| e["source"] == source)
            .map(|e| e["code"].clone())
    };
    assert_eq!(
        code_of("musicbrainz"),
        Some(json!("tls_failed")),
        "https to a server that only speaks plain http"
    );
    assert_eq!(code_of("gone"), Some(json!("connection_failed")));
    assert_eq!(code_of("gracenote"), Some(json!("not_available")));
    assert_eq!(
        code_of("gnudb"),
        None,
        "gnudb answered, but its record had the wrong number of tracks, so it is not used"
    );
    assert_eq!(result["candidates"], json!([]));
}

#[test]
fn gnudb_needs_an_email_address_but_a_web_address_still_satisfies_musicbrainz() {
    let mb = fakes::Http::start(|_| fakes::ok(MB_WATCHMEN));
    let gnudb =
        fakes::Http::start(|_| fakes::ok("200 rock 860a510c The Watchmen / Brand New Day\n"));
    let data = temp_dir("meta-email");
    let mut client = Client::start(&data, false);
    let mut settings = metadata_settings(&mb.url(), vec![http_server_entry("gnudb", gnudb.port)]);
    settings["identity"] = json!({ "contact": "https://example.org/about-me" });
    client.request(1, "set_metadata_settings", json!({ "settings": settings }));

    let result = lookup(&mut client, 2);
    let errors = result["errors"].as_array().unwrap();
    assert_eq!(errors.len(), 1, "{errors:?}");
    assert_eq!(errors[0]["source"], "gnudb");
    assert_eq!(errors[0]["code"], "needs_setup");
    assert!(
        errors[0]["message"]
            .as_str()
            .unwrap()
            .contains("valid email address")
    );
    assert_eq!(
        result["candidates"].as_array().unwrap().len(),
        1,
        "MusicBrainz accepted the web address"
    );
    assert!(
        gnudb.seen.lock().unwrap().is_empty(),
        "nothing was sent to gnudb without a usable email address"
    );
    let ua = mb.seen.lock().unwrap()[0].user_agent.clone();
    assert!(ua.contains("( https://example.org/about-me )"), "{ua}");
}

#[test]
fn a_cddb_429_reply_is_reported_as_rate_limiting() {
    let gnudb = fakes::Http::start(|_| fakes::ok("429 Too Many Requests\n"));
    let data = temp_dir("meta-429");
    let mut client = Client::start(&data, false);
    let mut settings = metadata_settings(
        "http://127.0.0.1:9",
        vec![http_server_entry("gnudb", gnudb.port)],
    );
    settings["musicbrainz"]["enabled"] = json!(false);
    client.request(1, "set_metadata_settings", json!({ "settings": settings }));
    let result = lookup(&mut client, 2);
    assert_eq!(result["errors"][0]["source"], "gnudb");
    assert_eq!(result["errors"][0]["code"], "rate_limited");
}
