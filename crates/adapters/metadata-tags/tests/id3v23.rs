//! Editing the tags of an MP3 made by this program must keep it a well-formed ID3v2.3 file with its picture and
//! lyrics, and the compilation flag must be written as the TCMP frame.

use mediaverse_metadata_tags::{TrackMetadata, write_track_metadata};
use mediaverse_ripper::id3::{self, Picture, PictureKind, SyncedLine, TagSet};

/// Three silent MPEG-1 Layer III frames (128 kbps, 44.1 kHz, 417 bytes each): small but a real MP3 stream.
fn audio() -> Vec<u8> {
    let mut data = Vec::new();
    for _ in 0..3 {
        data.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
        data.extend(std::iter::repeat(0u8).take(413));
    }
    data
}

fn song(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("mv-tags-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let mut cover = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 16];
    cover.extend(std::iter::repeat(0x44).take(200));
    cover.extend_from_slice(&[0xFF, 0xD9]);
    let tags = TagSet {
        title: "Old title".into(),
        artist: "Band".into(),
        album: "LP".into(),
        album_artist: "Band".into(),
        track: Some((3, Some(12))),
        year: Some(2007),
        pictures: vec![Picture {
            kind: PictureKind::FrontCover,
            data: cover,
        }],
        lyrics: Some("Some words".into()),
        synced_lyrics: vec![SyncedLine {
            milliseconds: 1000,
            text: "Some words".into(),
        }],
        ..TagSet::default()
    };
    let mut bytes = id3::write_tag(&tags).unwrap();
    bytes.extend_from_slice(&audio());
    let path = dir.join("01.mp3");
    std::fs::write(&path, bytes).unwrap();
    path
}

#[test]
fn an_edit_keeps_the_file_id3v23_with_its_picture_and_lyrics_and_sets_tcmp() {
    let path = song("edit");
    let edit = TrackMetadata {
        title: Some("New title".into()),
        artist: Some("Various".into()),
        album: Some("LP".into()),
        album_artist: Some("Various Artists".into()),
        compilation: Some(true),
        track_number: Some(3),
        release_year: Some(2007),
        ..TrackMetadata::default()
    };
    write_track_metadata(&path, &edit).unwrap();
    let bytes = std::fs::read(&path).unwrap();
    assert_eq!(&bytes[..3], b"ID3");
    assert_eq!(bytes[3], 3, "still ID3v2.3, not upgraded to 2.4");
    let frames = id3::read_frames(&bytes).expect("our own reader still accepts the edited tag");
    let text = |id: &str| {
        frames
            .iter()
            .find(|f| f.id == id)
            .map(|f| id3::frame_text(f).unwrap())
    };
    assert_eq!(text("TIT2").as_deref(), Some("New title"));
    assert_eq!(text("TPE2").as_deref(), Some("Various Artists"));
    assert_eq!(text("TCMP").as_deref(), Some("1"), "the compilation flag");
    assert_eq!(
        text("TYER").as_deref(),
        Some("2007"),
        "the year is really written (it used to be dropped): {:?}",
        frames.iter().map(|f| f.id.clone()).collect::<Vec<_>>()
    );
    assert!(
        frames.iter().any(|f| f.id == "APIC"),
        "the picture survived"
    );
    assert!(frames.iter().any(|f| f.id == "USLT"), "the lyrics survived");
    assert!(
        frames.iter().any(|f| f.id == "SYLT"),
        "the synced lyrics survived"
    );
    assert!(bytes.ends_with(&audio()), "the audio is untouched");

    // Unticking the box removes the flag; leaving it out keeps whatever is there.
    write_track_metadata(
        &path,
        &TrackMetadata {
            compilation: None,
            title: Some("Again".into()),
            ..edit.clone()
        },
    )
    .unwrap();
    let kept = id3::read_frames(&std::fs::read(&path).unwrap()).unwrap();
    assert!(
        kept.iter().any(|f| f.id == "TCMP"),
        "None leaves the flag alone"
    );
    write_track_metadata(
        &path,
        &TrackMetadata {
            compilation: Some(false),
            ..edit
        },
    )
    .unwrap();
    let cleared = id3::read_frames(&std::fs::read(&path).unwrap()).unwrap();
    assert!(
        !cleared.iter().any(|f| f.id == "TCMP"),
        "Some(false) removes it"
    );
}
