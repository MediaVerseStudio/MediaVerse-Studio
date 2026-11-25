//! Runs one song through the whole chain and prints each line's start: the stand-alone test of the engine (no program around it).
//!
//!   cargo run --release -p mediaverse_lyric_engine --example analyse -- <onnxruntime.dll> <models-folder> <song.f32> <lyrics.txt> [cuda|directml|cpu] [reader-provider]
//!
//! `song.f32`: raw little-endian float32, the left channel then the right, 44.1 kHz (tools/lyric-sync/dump_song.py writes one);
//! `lyrics.txt`: one lyric line per line. `models-folder` holds `htdemucs-core.onnx`, `w2v.onnx` and `w2v.json` (tools/lyric-sync/export_*.py).

use mediaverse_lyric_ai::align::{Alphabet, align_lines};
use mediaverse_lyric_engine::models::{Provider, Reader, Separator, init, to_reader_audio};
use std::path::PathBuf;
use std::time::Instant;

fn provider(name: &str) -> Provider {
    match name {
        "cuda" => Provider::Cuda,
        "directml" => Provider::DirectMl,
        _ => Provider::Cpu,
    }
}

fn main() -> Result<(), String> {
    let args: Vec<String> = std::env::args().collect();
    if args.len() < 5 {
        return Err("usage: analyse <onnxruntime.dll> <models-folder> <song.f32> <lyrics.txt> [cuda|directml|cpu] [reader provider]".to_owned());
    }
    let models = PathBuf::from(&args[2]);
    let sep_provider = provider(args.get(5).map_or("cpu", String::as_str));
    let read_provider = provider(
        args.get(6)
            .map_or(args.get(5).map_or("cpu", String::as_str), String::as_str),
    );
    init(&PathBuf::from(&args[1]))?;
    let bytes = std::fs::read(&args[3]).map_err(|e| e.to_string())?;
    let samples: Vec<f32> = bytes
        .chunks_exact(4)
        .map(|b| f32::from_le_bytes([b[0], b[1], b[2], b[3]]))
        .collect();
    let (left, right) = samples.split_at(samples.len() / 2);
    println!("{:.0} s of music", left.len() as f64 / 44_100.0);
    let lyrics: Vec<String> = std::fs::read_to_string(&args[4])
        .map_err(|e| e.to_string())?
        .lines()
        .filter(|l| !l.trim().is_empty())
        .map(str::to_owned)
        .collect();
    let labels: Vec<String> = {
        let json: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(models.join("w2v.json")).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        json["labels"]
            .as_array()
            .ok_or("no labels")?
            .iter()
            .map(|v| v.as_str().unwrap_or("").to_owned())
            .collect()
    };

    let t = Instant::now();
    let mut separator = Separator::load(&models.join("htdemucs-core.onnx"), sep_provider)?;
    let mut reader = Reader::load(&models.join("w2v.onnx"), read_provider)?;
    println!("models loaded in {:.1} s", t.elapsed().as_secs_f64());
    let t = Instant::now();
    let vocals = separator.vocals(left, right, |_| {})?;
    println!(
        "vocals separated in {:.1} s ({:?})",
        t.elapsed().as_secs_f64(),
        sep_provider
    );
    let t = Instant::now();
    let audio = to_reader_audio(&vocals);
    let letters = reader.letters(&audio)?;
    println!(
        "letters read in {:.1} s ({:?}): {} frames",
        t.elapsed().as_secs_f64(),
        read_provider,
        letters.frames
    );
    let t = Instant::now();
    let timed = align_lines(
        &letters.data,
        letters.frames,
        letters.classes,
        &Alphabet::new(&labels),
        &lyrics,
    );
    println!("aligned in {:.2} s", t.elapsed().as_secs_f64());
    for line in &timed {
        println!(
            "{:>8.2}  {}{}",
            line.start.unwrap_or(-1.0),
            line.text.chars().take(40).collect::<String>(),
            if line.flags.is_empty() {
                String::new()
            } else {
                format!("   [{}]", line.flags.join(", "))
            }
        );
    }
    Ok(())
}
