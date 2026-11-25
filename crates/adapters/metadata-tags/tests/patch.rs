//! Fix tags (ADR 0009) writes only the fields it fills, through `patch_track_metadata`: everything else in the file
//! stays, a file without any tag gets one, and the returned old values put the file back exactly.

use mediaverse_metadata_tags::{TagField, patch_track_metadata, read_track_metadata};
use mediaverse_ripper::id3::{self, Picture, PictureKind, TagSet};

/// A few silent MPEG-1 Layer III frames (128 kbps, 44.1 kHz, 417 bytes each): small but a real MP3 stream.
fn audio() -> Vec<u8> {
    let mut data = Vec::new();
    for _ in 0..40 {
        data.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
        data.extend(std::iter::repeat(0u8).take(413));
    }
    data
}

fn folder(name: &str) -> std::path::PathBuf {
    let dir = std::env::temp_dir().join(format!("mv-patch-{name}-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    dir
}

#[test]
fn filling_gaps_keeps_every_other_value_the_picture_and_the_audio() {
    let path = folder("fill").join("01.mp3");
    let tags = TagSet {
        title: "Song".into(),
        artist: "Band".into(),
        pictures: vec![Picture {
            kind: PictureKind::FrontCover,
            data: vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 16, 1, 2, 3, 0xFF, 0xD9],
        }],
        lyrics: Some("Words".into()),
        ..TagSet::default()
    };
    let mut bytes = id3::write_tag(&tags).unwrap();
    bytes.extend_from_slice(&audio());
    std::fs::write(&path, bytes).unwrap();

    let before = patch_track_metadata(
        &path,
        &[
            (TagField::Album, Some("Record".into())),
            (TagField::Year, Some("1999".into())),
            (TagField::Track, Some("4".into())),
        ],
    )
    .unwrap();
    assert_eq!(
        before,
        vec![
            (TagField::Album, None),
            (TagField::Year, None),
            (TagField::Track, None)
        ]
    );

    let now = read_track_metadata(&path).unwrap();
    assert_eq!(now.title.as_deref(), Some("Song"), "untouched fields stay");
    assert_eq!(now.artist.as_deref(), Some("Band"));
    assert_eq!(now.album.as_deref(), Some("Record"));
    assert_eq!(now.release_year, Some(1999));
    assert_eq!(now.track_number, Some(4));
    let written = std::fs::read(&path).unwrap();
    assert_eq!(written[3], 3, "still ID3v2.3");
    let frames = id3::read_frames(&written).unwrap();
    assert!(
        frames.iter().any(|f| f.id == "APIC"),
        "the picture survived"
    );
    assert!(frames.iter().any(|f| f.id == "USLT"), "the lyrics survived");
    assert!(written.ends_with(&audio()), "the audio is untouched");
    let leftovers: Vec<_> = std::fs::read_dir(path.parent().unwrap())
        .unwrap()
        .map(|e| e.unwrap().file_name())
        .collect();
    assert_eq!(
        leftovers.len(),
        1,
        "no temporary copy is left behind: {leftovers:?}"
    );

    // Undo: writing the old values back removes what was added.
    patch_track_metadata(&path, &before).unwrap();
    let undone = read_track_metadata(&path).unwrap();
    assert_eq!(
        (undone.album, undone.release_year, undone.track_number),
        (None, None, None)
    );
    assert_eq!(undone.title.as_deref(), Some("Song"));
}

#[test]
fn a_file_with_no_tag_at_all_gets_one() {
    let path = folder("bare").join("02.mp3");
    std::fs::write(&path, audio()).unwrap();
    let before = patch_track_metadata(
        &path,
        &[
            (TagField::Title, Some("Named".into())),
            (TagField::AlbumArtist, Some("Band".into())),
        ],
    )
    .unwrap();
    assert_eq!(
        before,
        vec![(TagField::Title, None), (TagField::AlbumArtist, None)]
    );
    let now = read_track_metadata(&path).unwrap();
    assert_eq!(now.title.as_deref(), Some("Named"));
    assert_eq!(now.album_artist.as_deref(), Some("Band"));
    assert!(std::fs::read(&path).unwrap().ends_with(&audio()));

    // Undoing it removes every value again, which leaves no tag at all: that must count as success.
    patch_track_metadata(&path, &before).unwrap();
    let undone = read_track_metadata(&path).unwrap();
    assert_eq!((undone.title, undone.album_artist), (None, None));
}

#[test]
fn an_empty_id3_tag_is_filled() {
    let path = folder("empty").join("04.mp3");
    let mut bytes = id3::write_tag(&TagSet::default()).unwrap();
    bytes.extend_from_slice(&audio());
    std::fs::write(&path, bytes).unwrap();
    patch_track_metadata(
        &path,
        &[
            (TagField::Title, Some("Named".into())),
            (TagField::Album, Some("Record".into())),
        ],
    )
    .unwrap();
    let now = read_track_metadata(&path).unwrap();
    assert_eq!(now.title.as_deref(), Some("Named"));
    assert_eq!(now.album.as_deref(), Some("Record"));
}

#[test]
fn a_bad_value_changes_nothing() {
    let path = folder("bad").join("03.mp3");
    std::fs::write(&path, audio()).unwrap();
    let error =
        patch_track_metadata(&path, &[(TagField::Year, Some("nineteen".into()))]).unwrap_err();
    assert!(error.to_string().contains("not a number"), "{error}");
    assert_eq!(
        std::fs::read(&path).unwrap(),
        audio(),
        "the file is exactly as it was"
    );
}

/// An ID3v2.3 tag built by hand from (frame id, Latin-1 text) pairs.
fn v23_tag(frames: &[(&str, &str)]) -> Vec<u8> {
    let mut body = Vec::new();
    for (id, text) in frames {
        let size = (text.len() + 1) as u32;
        body.extend_from_slice(id.as_bytes());
        body.extend_from_slice(&size.to_be_bytes());
        body.extend_from_slice(&[0, 0, 0]);
        body.extend_from_slice(text.as_bytes());
    }
    let n = body.len() as u32;
    let mut tag = vec![
        b'I',
        b'D',
        b'3',
        3,
        0,
        0,
        ((n >> 21) & 0x7F) as u8,
        ((n >> 14) & 0x7F) as u8,
        ((n >> 7) & 0x7F) as u8,
        (n & 0x7F) as u8,
    ];
    tag.extend(body);
    tag
}

#[test]
fn a_full_date_from_a_reissue_is_replaced_by_the_year() {
    // The owner's Bad Religion "Stranger Than Fiction": tagged from a 2010 reissue with year and day (TYER 2010,
    // TDAT 3011, read as "2010-11-30"); writing 1994 left the old date beside it and the write was refused.
    let path = folder("fulldate").join("10.mp3");
    let mut bytes = v23_tag(&[
        ("TIT2", "Hooray for Me..."),
        ("TYER", "2010"),
        ("TDAT", "3011"),
        ("TORY", "2010"),
    ]);
    bytes.extend_from_slice(&audio());
    std::fs::write(&path, bytes).unwrap();
    assert_eq!(read_track_metadata(&path).unwrap().release_year, Some(2010));
    let before = patch_track_metadata(&path, &[(TagField::Year, Some("1994".into()))]).unwrap();
    assert_eq!(before, vec![(TagField::Year, Some("2010".into()))]);
    let now = read_track_metadata(&path).unwrap();
    assert_eq!(now.release_year, Some(1994));
    assert_eq!(now.title.as_deref(), Some("Hooray for Me..."));
    // Undo puts the year back (the day is not kept: the journal holds the year only).
    patch_track_metadata(&path, &before).unwrap();
    assert_eq!(read_track_metadata(&path).unwrap().release_year, Some(2010));
}

#[test]
fn an_instrumental_marker_sets_only_the_language_and_undoes_cleanly() {
    use mediaverse_metadata_tags::read_tag_fields;
    let path = folder("language").join("03.mp3");
    std::fs::write(&path, audio()).unwrap();
    patch_track_metadata(
        &path,
        &[
            (TagField::Title, Some("Wordless".into())),
            (TagField::Genre, Some("Industrial".into())),
        ],
    )
    .unwrap();
    // "zxx" is the ISO 639-2 code for no linguistic content; the genre stays whatever the music is.
    let before = patch_track_metadata(&path, &[(TagField::Language, Some("zxx".into()))]).unwrap();
    assert_eq!(before, vec![(TagField::Language, None)]);
    let now = read_tag_fields(
        &path,
        &[TagField::Language, TagField::Genre, TagField::Title],
    )
    .unwrap();
    assert_eq!(now[0].1.as_deref(), Some("zxx"));
    assert_eq!(now[1].1.as_deref(), Some("Industrial"));
    assert_eq!(now[2].1.as_deref(), Some("Wordless"));
    assert!(std::fs::read(&path).unwrap().ends_with(&audio()));
    patch_track_metadata(&path, &before).unwrap();
    let undone = read_tag_fields(&path, &[TagField::Language, TagField::Genre]).unwrap();
    assert_eq!(
        (undone[0].1.clone(), undone[1].1.as_deref()),
        (None, Some("Industrial"))
    );
}
