//! Runs the real LAME (the build in `third_party/build/lame-4.0`, made by `tools/build-lame-4.0.ps1`)
//! on music-like audio and applies the MP3 checks to what it produces, including damaged copies.
//! If that LAME has not been built, the test says so and passes.

use mediaverse_ripper::id3::{self, Picture, PictureKind, TagSet};
use mediaverse_ripper::mp3::{self, Quality};
use mediaverse_ripper::wav::write_wav;
use std::path::PathBuf;
use std::process::Command;

fn lame() -> Option<PathBuf> {
    let path = PathBuf::from(env!("CARGO_MANIFEST_DIR"))
        .join("../../third_party/build/lame-4.0/x64/Release/lame.exe");
    path.is_file().then_some(path)
}

/// Eight seconds of two overlapping tones with a little noise, different in each channel.
fn music_like(seconds: u32) -> Vec<u32> {
    let mut state = 12345u32;
    (0..44_100 * seconds)
        .map(|i| {
            let t = f64::from(i) / 44_100.0;
            state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
            let noise = f64::from((state >> 20) as i32 - 2048) * 0.5;
            let tone = |f: f64, a: f64| a * (t * f * std::f64::consts::TAU).sin();
            let left = tone(220.0, 9_000.0) + tone(1_760.0, 3_000.0) + noise;
            let right = tone(330.0, 8_000.0) + tone(2_640.0, 2_500.0) + noise;
            u32::from(left as i16 as u16) | (u32::from(right as i16 as u16) << 16)
        })
        .collect()
}

fn jpeg() -> Vec<u8> {
    let mut data = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 16];
    data.extend(std::iter::repeat_n(0x5A, 30_000));
    data.extend_from_slice(&[0xFF, 0xD9]);
    data
}

#[test]
fn real_lame_output_passes_every_check_and_damage_is_caught() {
    let Some(lame) = lame() else {
        eprintln!("SKIPPED: LAME has not been built (run tools/build-lame-4.0.ps1)");
        return;
    };
    let dir = std::env::temp_dir().join(format!("mv-lame-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    for (name, quality, expect_vbr) in [
        ("v0", Quality::V0, true),
        ("cbr320", Quality::Cbr320, false),
    ] {
        let samples = music_like(8);
        let wav = dir.join(format!("{name}.wav"));
        let mp3 = dir.join(format!("{name}.mp3"));
        write_wav(std::fs::File::create(&wav).unwrap(), &samples).unwrap();

        let status = Command::new(&lame)
            .args(mp3::lame_arguments(quality, &wav, &mp3))
            .status()
            .unwrap();
        assert!(status.success(), "{name}: LAME failed");
        let bytes = std::fs::read(&mp3).unwrap();

        // The raw encoder output.
        let info =
            mp3::check_structure(&bytes, samples.len()).unwrap_or_else(|e| panic!("{name}: {e}"));
        assert_eq!(info.variable_bitrate, expect_vbr, "{name}");
        assert_eq!(info.tag_bytes, 0);
        eprintln!(
            "{name}: {} bytes, {} frames, delay {}, padding {}",
            bytes.len(),
            info.audio_frames,
            info.encoder_delay,
            info.encoder_padding
        );

        // With the full tag in front: text, three kinds of picture, plain and synced lyrics.
        let tags = TagSet {
            title: "Song".into(),
            artist: "Band".into(),
            album: "Album".into(),
            album_artist: "Band".into(),
            track: Some((3, Some(12))),
            year: Some(2007),
            genre: Some("Punk".into()),
            pictures: vec![
                Picture {
                    kind: PictureKind::FrontCover,
                    data: jpeg(),
                },
                Picture {
                    kind: PictureKind::BackCover,
                    data: jpeg(),
                },
                Picture {
                    kind: PictureKind::ArtistPhoto,
                    data: jpeg(),
                },
            ],
            lyrics: Some("Words\nMore words".into()),
            synced_lyrics: vec![
                id3::SyncedLine {
                    milliseconds: 1_000,
                    text: "Words".into(),
                },
                id3::SyncedLine {
                    milliseconds: 3_000,
                    text: "More words".into(),
                },
            ],
            ..TagSet::default()
        };
        let tag = id3::write_tag(&tags).unwrap();
        let tagged = mp3::with_tag(&bytes, &tag).unwrap();
        let tagged_info = mp3::check_structure(&tagged, samples.len()).unwrap();
        assert_eq!(tagged_info.tag_bytes, tag.len());
        id3::check_tag(&tagged, &tags).unwrap();
        assert_eq!(
            &tagged[tag.len()..],
            &bytes[..],
            "the audio is untouched by tagging"
        );

        // Decode with an independent decoder and compare with the source.
        let snr = mp3::decode_check(&tagged, &samples).unwrap_or_else(|e| panic!("{name}: {e}"));
        eprintln!("{name}: signal-to-noise {snr:.1} dB");
        assert!(snr > 15.0);
        let mut other = samples.clone();
        other.rotate_left(5_000);
        assert!(
            mp3::decode_check(&tagged, &other).is_err(),
            "{name}: different audio must fail"
        );
        assert!(
            mp3::decode_check(&tagged, &samples[..samples.len() - 1]).is_err(),
            "{name}: wrong length must fail"
        );

        // Damage must be caught.
        let n = tagged.len();
        assert!(
            mp3::check_structure(&tagged[..n - 100], samples.len()).is_err(),
            "{name}: truncated file"
        );
        assert!(
            mp3::check_structure(&tagged[..n - 1], samples.len()).is_err(),
            "{name}: one byte missing"
        );
        assert!(
            mp3::check_structure(&tagged, samples.len() + 1).is_err(),
            "{name}: wrong expected length"
        );
        let mut cut_frame = tagged.clone();
        cut_frame.drain(tag.len() + 4000..tag.len() + 4100);
        assert!(
            mp3::check_structure(&cut_frame, samples.len()).is_err(),
            "{name}: bytes removed from the middle"
        );
        let mut bad_sync = tagged.clone();
        bad_sync[tag.len() + 2_500] = 0;
        let _ = mp3::check_structure(&bad_sync, samples.len()); // may or may not land on a header; must not panic
        let mut shifted_tag = tagged.clone();
        shifted_tag[9] ^= 1; // the tag's size field: audio no longer starts where the tag ends
        assert!(
            mp3::check_structure(&shifted_tag, samples.len()).is_err(),
            "{name}: tag size changed"
        );
        let mut junk_tail = tagged.clone();
        junk_tail.extend_from_slice(&[0u8; 20]);
        assert!(
            mp3::check_structure(&junk_tail, samples.len()).is_err(),
            "{name}: trailing junk"
        );
    }
    let _ = std::fs::remove_dir_all(&dir);
}
