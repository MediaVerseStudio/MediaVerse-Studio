//! Run by hand against COPIES of real songs: `MV_PATCH_DIR=<folder of copies> cargo test -p mediaverse_metadata_tags
//! --test real_files -- --ignored --nocapture`. Fills two fields in every file, checks the audio stream and every
//! other value are unchanged, then undoes it and checks the file reads as before.

use mediaverse_metadata_tags::{
    TagField, TrackMetadata, patch_track_metadata, read_track_metadata,
};

/// The bytes after the ID3v2 tag (and before an ID3v1 tag) of an MP3, or the whole file otherwise.
fn audio_of(bytes: &[u8], mp3: bool) -> &[u8] {
    if !mp3 {
        return bytes;
    }
    let start = if bytes.len() > 10 && &bytes[..3] == b"ID3" {
        let size = bytes[6..10]
            .iter()
            .fold(0usize, |acc, b| (acc << 7) | usize::from(b & 0x7F));
        10 + size + if bytes[5] & 0x10 != 0 { 10 } else { 0 }
    } else {
        0
    };
    let end = if bytes.len() >= 128 && &bytes[bytes.len() - 128..bytes.len() - 125] == b"TAG" {
        bytes.len() - 128
    } else {
        bytes.len()
    };
    let mut s = start;
    // Skip padding between the tag and the first frame.
    while s < end && bytes[s] == 0 {
        s += 1;
    }
    &bytes[s..end]
}

#[test]
#[ignore]
fn real_files_fill_and_undo() {
    let Ok(dir) = std::env::var("MV_PATCH_DIR") else {
        return;
    };
    let mut checked = 0;
    let mut refused = 0;
    for entry in std::fs::read_dir(&dir).unwrap() {
        let path = entry.unwrap().path();
        let ext = path
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("")
            .to_ascii_lowercase();
        if !["mp3", "m4a"].contains(&ext.as_str()) {
            continue;
        }
        let mp3 = ext == "mp3";
        let original = std::fs::read(&path).unwrap();
        // A file that cannot be read is listed as unreadable by the scan and never offered for writing.
        let Ok(before) = read_track_metadata(&path) else {
            println!("UNREADABLE {}", path.file_name().unwrap().to_string_lossy());
            continue;
        };
        // Fill (or overwrite, for the test) the album artist and the genre.
        let old = match patch_track_metadata(
            &path,
            &[
                (TagField::AlbumArtist, Some("Test Album Artist".into())),
                (TagField::Genre, Some("Test Genre".into())),
            ],
        ) {
            Ok(old) => old,
            Err(e) => {
                assert_eq!(
                    std::fs::read(&path).unwrap(),
                    original,
                    "a refused write leaves the file exactly as it was"
                );
                println!(
                    "REFUSED {}: {e}",
                    path.file_name().unwrap().to_string_lossy()
                );
                refused += 1;
                continue;
            }
        };
        let mid = read_track_metadata(&path).unwrap();
        assert_eq!(
            mid.album_artist.as_deref(),
            Some("Test Album Artist"),
            "{}",
            path.display()
        );
        assert_eq!(
            (
                mid.title.clone(),
                mid.artist.clone(),
                mid.album.clone(),
                mid.release_year,
                mid.track_number
            ),
            (
                before.title.clone(),
                before.artist.clone(),
                before.album.clone(),
                before.release_year,
                before.track_number
            ),
            "other values kept: {}",
            path.display()
        );
        let written = std::fs::read(&path).unwrap();
        if mp3 {
            assert_eq!(
                audio_of(&written, true),
                audio_of(&original, true),
                "audio unchanged: {}",
                path.display()
            );
        }
        patch_track_metadata(&path, &old)
            .unwrap_or_else(|e| panic!("undo {}: {e}", path.display()));
        let after = read_track_metadata(&path).unwrap();
        // An empty ID3v2 tag beside an old ID3v1 one is not written back, so the ID3v1 values show again: allowed.
        if before != TrackMetadata::default() {
            assert_eq!(
                after,
                before,
                "undo restores the values: {}",
                path.display()
            );
        }
        println!(
            "ok  {}  ({} -> {} -> {} bytes)",
            path.file_name().unwrap().to_string_lossy(),
            original.len(),
            written.len(),
            std::fs::metadata(&path).unwrap().len()
        );
        checked += 1;
    }
    println!("{checked} files checked, {refused} refused");
}
