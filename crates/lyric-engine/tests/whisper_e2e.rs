//! Whisper end to end on a 70 s excerpt of a real song (ignored: needs ONNX Runtime, the Whisper files and the excerpt).
//!   LYRIC_E2E_RUNTIME=<onnxruntime.dll>  LYRIC_E2E_CUDA=<folder with the CUDA libraries, optional>  WHISPER_DIR=<folder with onnx/ and vocab.json>
//!   LYRIC_WHISPER_AUDIO=<16 kHz mono f32 file>  LYRIC_WHISPER_LYRICS=<text file with the true lyrics>
//!   cargo test --release -p mediaverse_lyric_engine --test whisper_e2e -- --ignored --nocapture

use mediaverse_lyric_engine::models::{Provider, init};
use mediaverse_lyric_engine::whisper::{Whisper, WhisperFiles};
use std::path::PathBuf;

fn words(text: &str) -> Vec<String> {
    text.to_lowercase()
        .replace('\u{2019}', "'")
        .split(|c: char| !(c.is_alphabetic() || c == '\''))
        .filter(|w| !w.is_empty())
        .map(str::to_owned)
        .collect()
}

fn word_error_rate(reference: &[String], heard: &[String]) -> f64 {
    let mut row: Vec<usize> = (0..=heard.len()).collect();
    for (i, r) in reference.iter().enumerate() {
        let mut diagonal = row[0];
        row[0] = i + 1;
        for (j, h) in heard.iter().enumerate() {
            let above = row[j + 1];
            row[j + 1] = (row[j + 1] + 1)
                .min(row[j] + 1)
                .min(diagonal + usize::from(r != h));
            diagonal = above;
        }
    }
    row[heard.len()] as f64 / reference.len().max(1) as f64
}

#[test]
#[ignore = "needs the models and an excerpt (see the file's first lines)"]
fn whisper_transcribes_a_song_excerpt() {
    let env = |k: &str| std::env::var(k).unwrap_or_else(|_| panic!("{k} is not set"));
    if let Ok(cuda) = std::env::var("LYRIC_E2E_CUDA") {
        let path = std::env::var("PATH").unwrap_or_default();
        unsafe { std::env::set_var("PATH", format!("{cuda};{path}")) };
    }
    init(&PathBuf::from(env("LYRIC_E2E_RUNTIME"))).unwrap();
    let dir = PathBuf::from(env("WHISPER_DIR"));
    let files = WhisperFiles {
        encoder: dir.join("onnx").join("encoder_model_fp16.onnx"),
        decoder: dir.join("onnx").join("decoder_model_merged_fp16.onnx"),
        vocab: dir.join("vocab.json"),
        generation_config: dir.join("generation_config.json"),
    };
    let provider = if std::env::var("LYRIC_E2E_CUDA").is_ok() {
        Provider::Cuda
    } else {
        Provider::Cpu
    };
    let started = std::time::Instant::now();
    let mut whisper = Whisper::load(&files, provider).unwrap();
    println!("loaded in {:.1} s", started.elapsed().as_secs_f64());
    let bytes = std::fs::read(env("LYRIC_WHISPER_AUDIO")).unwrap();
    let audio: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    let started = std::time::Instant::now();
    let text = whisper.transcribe(&audio, |_| {}).unwrap();
    let seconds = started.elapsed().as_secs_f64();
    println!(
        "heard ({:.1} s for {:.0} s of audio): {text}",
        seconds,
        audio.len() as f64 / 16000.0
    );
    let reference = words(&std::fs::read_to_string(env("LYRIC_WHISPER_LYRICS")).unwrap());
    let wer = word_error_rate(&reference, &words(&text));
    println!(
        "word error rate {wer:.2} against {} lyric words",
        reference.len()
    );
    assert!(wer < 0.6, "the draft is far from the lyrics: {wer}");
}
