//! End-to-end tests of MP3 copies (real LAME; skipped if it has not been built).
#![allow(unused_imports)]

mod common;
use common::*;
use serde_json::{Value, json};
use std::io::{BufRead, BufReader, Write};
use std::path::PathBuf;
use std::process::{Command, Stdio};

#[test]
fn mp3_copies_are_made_in_the_library_tagged_checked_and_the_wavs_are_cleaned_up() {
    use lofty::file::TaggedFileExt;
    use lofty::tag::{Accessor, ItemKey};
    if !lame_or_skip() {
        return;
    }
    let (mut client, archive, library) = mp3_setup("mp3-basic");
    let result = rip_all(&mut client, 4, "mp3-basic", json!({}));

    let tracks = result["mp3"]["tracks"].as_array().unwrap();
    assert_eq!(tracks.len(), 2);
    assert!(
        tracks
            .iter()
            .all(|t| t["ok"] == true && t["quality"] == "v0" && t["variable_bitrate"] == true),
        "{tracks:?}"
    );
    // Only the fake helper's deliberate "track 3 did not match AccurateRip" note. Track 3 read the same when read again
    // and had no read problems, so it is unconfirmed (another pressing, perhaps), not a damaged disc.
    assert_eq!(
        result["warnings"],
        json!([
            "Track 3 did not match AccurateRip. The disc may be a different pressing or the copy may contain read errors; check it by ear or re-rip.",
            "Track 3 was saved to the archive but is not verified against AccurateRip."
        ])
    );

    let folder = library.join("The Watchmen").join("Brand New Day");
    let file = folder.join("02 - Song 2.mp3");
    let bytes = std::fs::read(&file).unwrap();
    // Our own checks, with the exact length of the source (20,000 samples).
    mediaverse_ripper::mp3::check_structure(&bytes, 20_000).unwrap();
    // An independent reader sees the tags we meant.
    let tagged = lofty::read_from_path(&file).unwrap();
    assert_eq!(tagged.file_type(), lofty::file::FileType::Mpeg);
    let tag = tagged.primary_tag().expect("an ID3 tag");
    assert_eq!(tag.title().as_deref(), Some("Song 2"));
    assert_eq!(tag.artist().as_deref(), Some("The Watchmen"));
    assert_eq!(tag.album().as_deref(), Some("Brand New Day"));
    assert_eq!(tag.get_string(&ItemKey::AlbumArtist), Some("The Watchmen"));
    assert_eq!(tag.track(), Some(2));
    assert_eq!(tag.track_total(), Some(12));
    assert_eq!(tag.disk(), Some(1));
    assert_eq!(tag.disk_total(), Some(2));
    assert_eq!(tag.genre().as_deref(), Some("Rock"));
    assert_eq!(tag.year(), Some(1996));
    assert!(matches!(tag.tag_type(), lofty::tag::TagType::Id3v2));
    assert_eq!(&bytes[3..5], &[3, 0], "ID3v2.3");

    // The FLAC masters and the cleanup: both outputs succeeded, so the WAVs are gone.
    assert!(
        archive
            .join("The Watchmen")
            .join("Brand New Day")
            .join("02 - Song 2.flac")
            .is_file()
    );
    assert_eq!(result["wav_removed"], 2);
    assert!(!rip_dir("mp3-basic").join("02.wav").exists());

    // A repeat rip never replaces the existing MP3.
    let again = rip_all(&mut client, 5, "mp3-basic2", json!({}));
    assert!(
        again["mp3"]["tracks"][0]["error"]
            .as_str()
            .unwrap()
            .contains("already exists")
    );
    assert_eq!(std::fs::read(&file).unwrap(), bytes);
    assert_eq!(
        again["wav_removed"], 0,
        "nothing was deleted because not everything succeeded"
    );
    assert!(rip_dir("mp3-basic2").join("02.wav").is_file());
}

#[test]
fn constant_320_is_available_and_the_wavs_can_be_kept() {
    if !lame_or_skip() {
        return;
    }
    let (mut client, _archive, library) = mp3_setup("mp3-cbr");
    let result = rip_all(
        &mut client,
        4,
        "mp3-cbr",
        json!({ "mp3_quality": "cbr320", "keep_wav": true, "archive": false }),
    );
    let entry = &result["mp3"]["tracks"][0];
    assert_eq!(
        (
            entry["ok"].clone(),
            entry["quality"].clone(),
            entry["variable_bitrate"].clone()
        ),
        (json!(true), json!("cbr320"), json!(false)),
        "{entry}"
    );
    assert!(
        library
            .join("The Watchmen")
            .join("Brand New Day")
            .join("02 - Song 2.mp3")
            .is_file()
    );
    assert_eq!(result["wav_removed"], 0);
    assert!(
        rip_dir("mp3-cbr").join("02.wav").is_file(),
        "kept on request"
    );
    let refused = client.request(
        9,
        "rip_disc",
        json!({ "device": "Z:", "output_dir": "x", "mp3_quality": "v7" }),
    );
    assert_eq!(refused["error"]["code"], "invalid_arguments");
}

#[test]
fn ripping_needs_a_separate_archive_folder_when_archiving_is_on_and_never_writes_into_the_library()
{
    let (_data, mut client) = ready_to_rip("folders-check");
    let library = temp_dir("folders-library");
    assert_eq!(
        client.request(
            1,
            "import_collection",
            json!({ "root": library.to_string_lossy() })
        )["ok"],
        true
    );
    let refused = |client: &mut Client, id: u64, args: Value, code: &str| {
        client.events.clear();
        client.request(id, "rip_disc", args);
        let finished = client.wait_for_event("job-finished");
        assert_eq!(finished["payload"]["ok"], false, "{finished}");
        assert_eq!(finished["payload"]["error"]["code"], code, "{finished}");
    };
    let out = rip_dir("folders-out");
    let base = json!({ "device": "Z:", "output_dir": out.to_string_lossy(), "mp3": false, "metadata": { "album": "A", "artist": "B" } });

    // Archiving is on by default but no archive folder is chosen: refused before anything is ripped.
    refused(&mut client, 2, base.clone(), "archive_folder_required");
    assert!(!out.exists(), "nothing was ripped");

    // A folder inside the library is refused when it is chosen; one that sneaks in later is caught at rip time.
    let inside = library.join("archive");
    assert_eq!(
        client.request(
            3,
            "set_archive_dir",
            json!({ "path": inside.to_string_lossy() })
        )["error"]["code"],
        "invalid_archive_location"
    );

    // The temporary WAV folder may not be inside the library either (that would duplicate songs there).
    let archive = temp_dir("folders-archive");
    assert_eq!(
        client.request(
            4,
            "set_archive_dir",
            json!({ "path": archive.to_string_lossy() })
        )["ok"],
        true
    );
    let mut in_library = base.clone();
    in_library["output_dir"] = json!(library.join("wavs").to_string_lossy());
    refused(&mut client, 5, in_library, "output_in_library");
    assert!(!library.join("wavs").exists());

    // With archiving switched off, no archive folder is needed.
    assert_eq!(
        client.request(6, "set_archive_dir", json!({ "path": null }))["ok"],
        true
    );
    let mut off = base.clone();
    off["archive"] = json!(false);
    client.events.clear();
    client.request(7, "rip_disc", off);
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], true, "{finished}");
}

#[test]
fn without_a_working_folder_the_wavs_go_to_the_programs_own_data_folder() {
    let (data, mut client) = ready_to_rip("default-work");
    client.request(
        1,
        "rip_disc",
        json!({ "device": "Z:", "archive": false, "mp3": false, "tracks": [2] }),
    );
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], true, "{finished}");
    let files = finished["payload"]["result"]["files"].as_array().unwrap();
    let path = std::path::PathBuf::from(files[0].as_str().unwrap());
    assert!(path.starts_with(data.join("rip-work")), "{path:?}");
    // With nothing to wait for (no archive, no MP3) the WAV is the only output and is kept.
    assert!(path.exists());
}

#[test]
fn the_archive_switch_decides_whether_flac_masters_are_kept() {
    if !lame_or_skip() {
        return;
    }
    let (mut client, archive, library) = mp3_setup("switch");
    let off = client.request(2, "set_archive_enabled", json!({ "enabled": false }));
    assert_eq!(off["result"]["archive_enabled"], false);
    assert_eq!(
        off["result"]["archive_dir"],
        archive.to_string_lossy().as_ref(),
        "the folder is remembered"
    );
    assert_eq!(
        client.request(3, "set_archive_enabled", json!({ "enabled": "yes" }))["error"]["code"],
        "invalid_arguments"
    );
    client.events.clear();
    client.request(4, "rip_disc", json!({ "device": "Z:", "output_dir": rip_dir("switch").to_string_lossy(), "tracks": [2], "candidate": candidate(12, json!({})) }));
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], true, "{finished}");
    assert!(
        finished["payload"]["result"].get("archive").is_none(),
        "no archive result when the switch is off"
    );
    assert!(
        library
            .join("The Watchmen")
            .join("Brand New Day")
            .join("02 - Song 2.mp3")
            .is_file()
    );
    let flacs = std::fs::read_dir(&archive).map(|d| d.count()).unwrap_or(0);
    assert_eq!(flacs, 0, "nothing was written to the archive");
    assert_eq!(
        client.request(5, "get_archive_settings", Value::Null)["result"]["archive_enabled"],
        false
    );
}

#[test]
fn manual_pictures_and_lyrics_become_the_right_kinds_of_tag() {
    use lofty::file::TaggedFileExt;
    use lofty::picture::PictureType;

    if !lame_or_skip() {
        return;
    }
    let (mut client, _archive, library) = mp3_setup("mp3-manual");
    let pictures = temp_dir("mp3-manual-images");
    let (front, back, artist) = (
        pictures.join("front.jpg"),
        pictures.join("back.jpg"),
        pictures.join("artist.jpg"),
    );
    std::fs::write(&front, jpeg(900, 900, false)).unwrap();
    std::fs::write(&back, jpeg(800, 810, false)).unwrap();
    std::fs::write(&artist, jpeg(700, 700, false)).unwrap();
    let not_an_image = pictures.join("notes.txt");
    std::fs::write(&not_an_image, "hello").unwrap();

    let mut album = candidate(12, json!({}));
    album["tracks"][1]["lyrics"] =
        json!("[ti:Song 2]\n[00:01.50]First line\n[00:04.00]Second line é\n");
    album["tracks"][2]["lyrics"] = json!("Plain words\nsecond line");
    client.events.clear();
    let mut args = json!({ "device": "Z:", "output_dir": rip_dir("mp3-manual").to_string_lossy(), "tracks": [2, 3], "archive": false, "candidate": album });
    args["candidate"]["pictures"] = json!([]); // album-level pictures travel in the candidate or beside it
    args["pictures"] = json!([
        { "kind": "front_cover", "path": front.to_string_lossy() },
        { "kind": "back_cover", "path": back.to_string_lossy() },
        { "kind": "artist_photo", "path": artist.to_string_lossy() },
        { "kind": "back_cover", "path": not_an_image.to_string_lossy() },
        { "kind": "poster", "path": front.to_string_lossy() },
    ]);
    client.request(4, "rip_disc", args);
    let finished = client.wait_for_event("job-finished");
    assert_eq!(finished["payload"]["ok"], true, "{finished}");
    let result = &finished["payload"]["result"];
    let warnings: Vec<&str> = result["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_str().unwrap())
        .collect();
    assert_eq!(
        warnings
            .iter()
            .filter(|w| w.starts_with("A picture was not embedded"))
            .count(),
        2,
        "{warnings:?}"
    );
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("notes.txt") && w.contains("not a JPEG or PNG"))
    );
    assert!(
        warnings
            .iter()
            .any(|w| w.contains("'poster' is not a picture kind"))
    );

    let folder = library.join("The Watchmen").join("Brand New Day");
    let two = lofty::read_from_path(folder.join("02 - Song 2.mp3")).unwrap();
    let tag = two.primary_tag().unwrap();
    let mut kinds: Vec<_> = tag
        .pictures()
        .iter()
        .map(|p| (p.pic_type(), p.data().len()))
        .collect();
    kinds.sort_by_key(|(kind, _)| format!("{kind:?}"));
    assert_eq!(
        kinds.iter().map(|(k, _)| *k).collect::<Vec<_>>(),
        [
            PictureType::Artist,
            PictureType::CoverBack,
            PictureType::CoverFront
        ]
    );
    assert_eq!(
        tag.pictures()
            .iter()
            .find(|p| p.pic_type() == PictureType::CoverFront)
            .unwrap()
            .data(),
        jpeg(900, 900, false).as_slice(),
        "stored byte for byte"
    );
    // Lyrics through lofty's ID3v2-specific view of the file (its generic view does not expose USLT).
    {
        use lofty::config::ParseOptions;
        use lofty::file::AudioFile;
        let mut handle = std::fs::File::open(folder.join("02 - Song 2.mp3")).unwrap();
        let mpeg = lofty::mpeg::MpegFile::read_from(&mut handle, ParseOptions::new()).unwrap();
        let _id3v2 = mpeg.id3v2().unwrap();
        let lyrics: Vec<String> = mpeg
            .id3v2()
            .unwrap()
            .unsync_text()
            .map(|f| f.content.to_string())
            .collect();
        assert_eq!(
            lyrics,
            ["First line\nSecond line é"],
            "plain lyrics from the LRC text, time stamps removed"
        );
    }

    // The synced lyrics are in the file too (read with our own frame parser).
    let bytes = std::fs::read(folder.join("02 - Song 2.mp3")).unwrap();
    let frames = mediaverse_ripper::id3::read_frames(&bytes).unwrap();
    let synced =
        mediaverse_ripper::id3::frame_synced(frames.iter().find(|f| f.id == "SYLT").unwrap())
            .unwrap();
    assert_eq!(
        synced
            .iter()
            .map(|l| (l.milliseconds, l.text.as_str()))
            .collect::<Vec<_>>(),
        [(1_500, "First line"), (4_000, "Second line é")]
    );

    // Track 3 had plain lyrics only.
    let bytes3 = std::fs::read(folder.join("03 - Song 3.mp3")).unwrap();
    let frames3 = mediaverse_ripper::id3::read_frames(&bytes3).unwrap();
    assert!(frames3.iter().any(|f| f.id == "USLT") && !frames3.iter().any(|f| f.id == "SYLT"));
}

#[test]
fn a_progressive_or_oversized_cover_is_replaced_by_the_small_one_for_embedding() {
    use lofty::file::TaggedFileExt;
    if !lame_or_skip() {
        return;
    }
    let small = jpeg(500, 500, false);
    let big_progressive = jpeg(1200, 1200, true);
    let (small_served, big_served) = (small.clone(), big_progressive.clone());
    let server = fakes::Http::start(move |target| {
        if target.ends_with("/front-1200") {
            fakes::ok(big_served.clone())
        } else if target.ends_with("/front-500") {
            fakes::ok(small_served.clone())
        } else {
            fakes::Reply {
                status: 404,
                headers: vec![],
                body: vec![],
            }
        }
    });
    let (mut client, archive, library) = mp3_setup("mp3-cover");
    client.request(
        6,
        "set_metadata_settings",
        json!({ "settings": { "cover_art": { "enabled": true, "base_url": server.url() } } }),
    );
    let mut album = candidate(12, json!({ "cover_art_release": RELEASE }));
    album["tracks"] = json!(album["tracks"].as_array().unwrap().clone());
    client.events.clear();
    client.request(7, "rip_disc", json!({ "device": "Z:", "output_dir": rip_dir("mp3-cover").to_string_lossy(), "tracks": [2], "candidate": album }));
    let finished = client.wait_for_event("job-finished");
    let result = &finished["payload"]["result"];
    assert_eq!(result["mp3"]["tracks"][0]["ok"], true, "{result}");
    // The file beside the FLACs is the full-size download; the MP3 embeds the small baseline one.
    assert_eq!(
        std::fs::read(
            archive
                .join("The Watchmen")
                .join("Brand New Day")
                .join("cover.jpg")
        )
        .unwrap(),
        big_progressive
    );
    let mp3 = lofty::read_from_path(
        library
            .join("The Watchmen")
            .join("Brand New Day")
            .join("02 - Song 2.mp3"),
    )
    .unwrap();
    let pictures = mp3.primary_tag().unwrap().pictures().to_vec();
    assert_eq!(pictures.len(), 1);
    assert_eq!(pictures[0].data(), small.as_slice());
    let warnings: Vec<&str> = result["warnings"]
        .as_array()
        .unwrap()
        .iter()
        .map(|w| w.as_str().unwrap())
        .collect();
    assert!(
        warnings.iter().any(|w| w.contains("progressive JPEG")),
        "{warnings:?}"
    ); // the existing note about the saved file
}

#[test]
fn without_a_library_or_with_the_archive_inside_it_no_mp3_is_made() {
    if !lame_or_skip() {
        return;
    }
    // No library chosen.
    let (_d, mut client) = ready_to_rip("mp3-nolib");
    let result = rip_all(&mut client, 4, "mp3-nolib", json!({ "archive": false }));
    assert!(result["warnings"].as_array().unwrap().iter().any(|w| {
        w.as_str()
            .unwrap()
            .contains("No music library folder is chosen")
    }));
    assert_eq!(result["mp3"], Value::Null);
    assert_eq!(
        result["wav_removed"], 0,
        "the WAV files stay when nothing could be produced"
    );

    // The archive inside the library.
    let (_d2, mut client2) = ready_to_rip("mp3-nested");
    let library = temp_dir("mp3-nested-library");
    let archive = library.join("archive");
    client2.request(
        1,
        "set_archive_dir",
        json!({ "path": archive.to_string_lossy() }),
    );
    client2.request(
        2,
        "import_collection",
        json!({ "root": library.to_string_lossy() }),
    );
    client2.events.clear();
    client2.request(4, "rip_disc", json!({ "device": "Z:", "output_dir": rip_dir("mp3-nested").to_string_lossy(), "candidate": candidate(12, json!({})) }));
    let finished = client2.wait_for_event("job-finished");
    assert_eq!(
        finished["payload"]["error"]["code"], "invalid_archive_location",
        "{finished}"
    );
    assert!(!library.join("The Watchmen").exists());
}
