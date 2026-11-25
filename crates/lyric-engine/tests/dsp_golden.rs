//! The spectrogram transforms against Demucs's own (tools/lyric-sync/make_golden_dsp.py writes the fixtures).

use mediaverse_lyric_engine::dsp::Transforms;

fn floats(bytes: &[u8]) -> Vec<f32> {
    bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect()
}

fn worst(a: &[f32], b: &[f32]) -> f32 {
    assert_eq!(a.len(), b.len());
    a.iter()
        .zip(b)
        .map(|(x, y)| (x - y).abs())
        .fold(0.0, f32::max)
}

#[test]
fn spec_and_ispec_agree_with_demucs() {
    let signal = floats(include_bytes!("fixtures/signal.f32"));
    let want_cac = floats(include_bytes!("fixtures/cac.f32"));
    let want_back = floats(include_bytes!("fixtures/back.f32"));
    let length = signal.len() / 2;
    let transforms = Transforms::default();
    let spec = transforms.spec(&[&signal[..length], &signal[length..]]);
    assert_eq!((spec.freqs, spec.frames), (2048, length.div_ceil(1024)));
    let cac = Transforms::cac(&spec);
    let spec_error = worst(&cac, &want_cac);
    assert!(
        spec_error < 1e-4,
        "spectrogram differs from Demucs's by {spec_error}"
    );
    let back = transforms.ispec(&want_cac, 2, spec.freqs, spec.frames, length);
    let flat: Vec<f32> = back.into_iter().flatten().collect();
    let back_error = worst(&flat, &want_back);
    assert!(
        back_error < 1e-4,
        "inverse differs from Demucs's by {back_error}"
    );
}
