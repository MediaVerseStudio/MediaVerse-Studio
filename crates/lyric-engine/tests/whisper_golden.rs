//! Whisper's log-mel front end against transformers' own `WhisperFeatureExtractor` (fixtures made by the lab's Python: a 4 s synthetic signal, its first 450 frames
//! and last 10 frames, and the 128 mel filters).

use mediaverse_lyric_engine::whisper::{FRAMES, MELS, Mel, mel_filters};

fn floats(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

#[test]
fn the_mel_filters_are_whispers() {
    let expected = floats(include_bytes!("fixtures/whisper-mel-filters.f32"));
    let ours = mel_filters();
    assert_eq!(ours.len(), expected.len());
    let worst = ours
        .iter()
        .zip(&expected)
        .map(|(a, b)| (a - b).abs())
        .fold(0.0f32, f32::max);
    assert!(worst < 1e-5, "largest filter difference {worst}");
}

#[test]
fn the_features_match_transformers() {
    let signal = floats(include_bytes!("fixtures/whisper-signal.f32"));
    let head = floats(include_bytes!("fixtures/whisper-features-450.f32")); // 450 frames x 128, frame-major
    let tail = floats(include_bytes!("fixtures/whisper-features-tail.f32")); // 10 frames x 128, frame-major
    let features = Mel::new().log_mel(&signal); // mel-major: mel * FRAMES + frame
    assert_eq!(features.len(), MELS * FRAMES);
    let mut worst = 0.0f32;
    for frame in 0..450 {
        for mel in 0..MELS {
            worst = worst.max((features[mel * FRAMES + frame] - head[frame * MELS + mel]).abs());
        }
    }
    for frame in 0..10 {
        for mel in 0..MELS {
            worst =
                worst.max((features[mel * FRAMES + 2990 + frame] - tail[frame * MELS + mel]).abs());
        }
    }
    println!("largest difference {worst}");
    assert!(
        worst < 2e-3,
        "the largest difference from transformers' features is {worst}"
    );
}
