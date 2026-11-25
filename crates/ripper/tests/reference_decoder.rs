//! Cross-checks our FLAC files with Xiph's reference decoder (`flac --test --warnings-as-errors`),
//! which is stricter than the decoder inside the program and found a fault the program's own checks
//! missed (the STREAMINFO minimum block size, ADR 0005).
//!
//! The reference tools are a test-only download (`pwsh tools/fetch-flac-reference.ps1`). If they are
//! absent this test says so and passes, so it never blocks a machine without them; set
//! `MEDIAVERSE_FLAC_REFERENCE` to a `flac.exe` to use another copy.

use mediaverse_ripper::flac::{encode_verified, with_vorbis_comments};
use mediaverse_ripper::wav::write_wav;
use std::path::PathBuf;
use std::process::Command;

fn reference_decoder() -> Option<PathBuf> {
    if let Some(path) = std::env::var_os("MEDIAVERSE_FLAC_REFERENCE") {
        return Some(PathBuf::from(path));
    }
    let root =
        PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("../../third_party/build/flac-reference");
    let mut pending = vec![root];
    while let Some(dir) = pending.pop() {
        for entry in std::fs::read_dir(&dir).ok()?.flatten() {
            let path = entry.path();
            if path.is_dir() {
                pending.push(path);
            } else if path.file_name().is_some_and(|n| n == "flac.exe")
                && path.to_string_lossy().contains("Win64")
            {
                return Some(path);
            }
        }
    }
    None
}

fn audio(length: usize, seed: u32) -> Vec<u32> {
    (0..length as u32)
        .map(|i| {
            i.wrapping_mul(2_654_435_761)
                .wrapping_add(seed)
                .rotate_left(7)
        })
        .collect()
}

#[test]
fn the_reference_decoder_accepts_our_files_and_hears_the_same_audio() {
    let Some(flac) = reference_decoder() else {
        eprintln!(
            "SKIPPED: the reference FLAC tools are not installed (run tools/fetch-flac-reference.ps1)"
        );
        return;
    };
    let dir = std::env::temp_dir().join(format!("mv-reference-{}", std::process::id()));
    let _ = std::fs::remove_dir_all(&dir);
    std::fs::create_dir_all(&dir).unwrap();

    // Lengths around block boundaries, CD-sized tracks (multiples of 588 samples), odd sizes, and 10 s.
    let lengths = [
        16usize,
        17,
        588,
        4095,
        4096,
        4097,
        8193,
        12_345,
        588 * 100,
        588 * 1_333 + 17,
        441_000,
    ];
    for (n, &length) in lengths.iter().enumerate() {
        let samples = audio(length, n as u32);
        let plain = encode_verified(&samples).unwrap();
        let tagged = with_vorbis_comments(
            &plain,
            &[
                ("TITLE", "Zürich – 東京"),
                ("ARTIST", "Band"),
                ("TRACKNUMBER", "7"),
            ],
        )
        .unwrap();
        for (label, bytes) in [("plain", plain), ("tagged", tagged)] {
            let file = dir.join(format!("len{length}-{label}.flac"));
            std::fs::write(&file, bytes).unwrap();

            let test = Command::new(&flac)
                .args(["--test", "--warnings-as-errors", "--silent"])
                .arg(&file)
                .output()
                .unwrap();
            assert!(
                test.status.success(),
                "the reference decoder rejected {} ({} samples): {}",
                file.display(),
                length,
                String::from_utf8_lossy(&test.stderr)
            );

            // Decode with the reference decoder and compare with the audio we encoded, byte for byte.
            let decoded = dir.join(format!("len{length}-{label}.wav"));
            let status = Command::new(&flac)
                .args(["-d", "--silent", "-o"])
                .arg(&decoded)
                .arg(&file)
                .status()
                .unwrap();
            assert!(status.success());
            let mut expected = Vec::new();
            write_wav(&mut expected, &samples).unwrap();
            assert_eq!(
                std::fs::read(&decoded).unwrap(),
                expected,
                "{label} {length}: the reference decoder heard different audio"
            );
        }
    }
    let _ = std::fs::remove_dir_all(&dir);
}
