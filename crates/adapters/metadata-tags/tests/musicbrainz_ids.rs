//! The MusicBrainz recording id and AcoustID this program writes into a new MP3 must be where other software looks for
//! them (the UFID frame owned by http://musicbrainz.org, and the TXXX frame "Acoustid Id", as Picard writes them), and
//! editing the song's other tags afterwards must not lose them.

use lofty::file::TaggedFileExt;
use lofty::tag::ItemKey;
use mediaverse_metadata_tags::{TrackMetadata, write_track_metadata};
use mediaverse_ripper::id3::{self, TagSet};

/// The value of a TXXX frame, read through lofty's own ID3v2 reader.
fn id3_user_text(path: &std::path::Path, description: &str) -> Option<String> {
    use lofty::file::AudioFile;
    let mut file = std::fs::File::open(path).unwrap();
    let mpeg =
        lofty::mpeg::MpegFile::read_from(&mut file, lofty::config::ParseOptions::new()).unwrap();
    mpeg.id3v2()
        .and_then(|tag| tag.get_user_text(description))
        .map(str::to_owned)
}

const RECORDING: &str = "b9ad642e-b012-41c7-b72a-42cf4911f9ff";
const ACOUSTID: &str = "7c8f5a4e-8f3b-4b0e-9f77-3c0e1f2a9b11";

fn audio() -> Vec<u8> {
    let mut data = Vec::new();
    for _ in 0..3 {
        data.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
        data.extend(std::iter::repeat(0u8).take(413));
    }
    data
}

#[test]
fn another_tagger_reads_the_ids_and_an_edit_keeps_them() {
    let dir = std::env::temp_dir().join(format!("mv-mbids-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();
    let path = dir.join("01.mp3");
    let tags = TagSet {
        title: "Song".into(),
        artist: "Band".into(),
        album: "LP".into(),
        recording_id: Some(RECORDING.into()),
        acoustid_id: Some(ACOUSTID.into()),
        ..TagSet::default()
    };
    let mut bytes = id3::write_tag(&tags).unwrap();
    bytes.extend_from_slice(&audio());
    std::fs::write(&path, bytes).unwrap();

    let read = |path: &std::path::Path| {
        let tagged = lofty::read_from_path(path).unwrap();
        let tag = tagged.primary_tag().expect("a tag").clone();
        (
            tag.get_string(&ItemKey::MusicBrainzRecordingId)
                .map(str::to_owned),
            id3_user_text(path, "Acoustid Id"),
        )
    };
    assert_eq!(
        read(&path),
        (Some(RECORDING.to_owned()), Some(ACOUSTID.to_owned())),
        "lofty (as Picard-compatible readers do) finds both ids"
    );

    write_track_metadata(
        &path,
        &TrackMetadata {
            title: Some("Renamed".into()),
            ..TrackMetadata::default()
        },
    )
    .unwrap();
    assert_eq!(
        read(&path),
        (Some(RECORDING.to_owned()), Some(ACOUSTID.to_owned())),
        "an edit of another tag keeps the ids"
    );
    let frames = id3::read_frames(&std::fs::read(&path).unwrap()).unwrap();
    assert!(
        frames.iter().any(|f| f.id == "UFID"),
        "still a UFID frame, not some other form"
    );
    let _ = std::fs::remove_dir_all(&dir);
}
