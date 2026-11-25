//! The w2v-BERT audio front end against the exporter's golden file (a 2 s synthetic signal and the features transformers' own extractor makes of it).
//! The file is from https://huggingface.co/redbaty/ytm-lyrics-aligner (MIT); `frontend-golden.json`.

use mediaverse_lyric_engine::seamless::{FEATURES, Frontend};

#[test]
fn the_front_end_gives_the_same_features_as_transformers() {
    let golden: serde_json::Value =
        serde_json::from_slice(include_bytes!("fixtures/frontend-golden.json")).unwrap();
    let signal: Vec<f32> = golden["input"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_f64().unwrap() as f32)
        .collect();
    let expected: Vec<Vec<f32>> = golden["features"]
        .as_array()
        .unwrap()
        .iter()
        .map(|row| {
            row.as_array()
                .unwrap()
                .iter()
                .map(|v| v.as_f64().unwrap() as f32)
                .collect()
        })
        .collect();
    let (features, rows) = Frontend::new().features(&signal);
    assert_eq!(rows, expected.len(), "the same number of frames");
    assert_eq!(features.len(), rows * FEATURES);
    let worst = features
        .chunks(FEATURES)
        .zip(&expected)
        .flat_map(|(a, b)| a.iter().zip(b).map(|(x, y)| (x - y).abs()))
        .fold(0.0f32, f32::max);
    println!("largest difference {worst}");
    assert!(
        worst < 2e-3,
        "the largest difference from the golden features is {worst}"
    );
}

#[test]
fn audio_shorter_than_one_frame_gives_nothing() {
    let (features, rows) = Frontend::new().features(&[0.0; 100]);
    assert!(features.is_empty());
    assert_eq!(rows, 0);
}
