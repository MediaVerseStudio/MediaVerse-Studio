//! The Rust aligner against the Python prototype's answers on 20 seconds of real singing (tools/lyric-sync/make_golden.py writes the fixture).

use mediaverse_lyric_ai::align::{Alphabet, align_lines};
use serde_json::Value;

#[test]
fn the_rust_alignment_agrees_with_the_python_prototype() {
    let fixture: Value = serde_json::from_str(include_str!("fixtures/golden_align.json")).unwrap();
    let labels: Vec<String> = fixture["labels"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    let frames = fixture["frames"].as_u64().unwrap() as usize;
    let classes = fixture["classes"].as_u64().unwrap() as usize;
    let emission: Vec<f32> = fixture["thousandths"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| (v.as_i64().unwrap() as f64 / 1000.0) as f32)
        .collect();
    let lines: Vec<String> = fixture["lines"]
        .as_array()
        .unwrap()
        .iter()
        .map(|v| v.as_str().unwrap().to_owned())
        .collect();
    let expected = fixture["expected"].as_array().unwrap();
    assert_eq!(emission.len(), frames * classes);

    // identity by fit: the numbers are the Python prototype's (these lines run past the 20 seconds, so only the numbers are compared)
    let alphabet = Alphabet::new(&labels);
    let (right, other) = (
        alphabet
            .fit(&emission, frames, classes, &lines.join("\n"))
            .unwrap(),
        alphabet
            .fit(
                &emission,
                frames,
                classes,
                fixture["fits"]["other_text"].as_str().unwrap(),
            )
            .unwrap(),
    );
    let (want_right, want_other) = (
        fixture["fits"]["right"].as_f64().unwrap(),
        fixture["fits"]["other"].as_f64().unwrap(),
    );
    assert!(
        (right - want_right).abs() < 0.01,
        "fit of the right words {right} against {want_right}"
    );
    assert!(
        (other - want_other).abs() < 0.01,
        "fit of other words {other} against {want_other}"
    );

    let got = align_lines(&emission, frames, classes, &Alphabet::new(&labels), &lines);
    assert_eq!(got.len(), expected.len());
    for (line, want) in got.iter().zip(expected) {
        let name = &line.text;
        assert_eq!(line.start, want["start"].as_f64(), "start of {name}");
        assert_eq!(line.end, want["end"].as_f64(), "end of {name}");
        let (a, b) = (line.score.unwrap(), want["score"].as_f64().unwrap());
        assert!((a - b).abs() < 0.002, "score of {name}: {a} against {b}");
        let want_words = want["words"].as_array().unwrap();
        assert_eq!(line.words.len(), want_words.len(), "words of {name}");
        for (w, x) in line.words.iter().zip(want_words) {
            assert_eq!(w.word, x["word"].as_str().unwrap());
            assert!(
                (w.start - x["start"].as_f64().unwrap()).abs() < 0.011
                    && (w.end - x["end"].as_f64().unwrap()).abs() < 0.011,
                "{} in {name}",
                w.word
            );
            assert!(
                (w.score - x["score"].as_f64().unwrap()).abs() < 0.011,
                "score of {} in {name}",
                w.word
            );
        }
        // The flags are not compared: the prototype's rules were the first guess and the rule in `flag_lines` was calibrated again (D150); it has its own tests.
    }
}
