//! Try the photo reader on real photos: `read_photos <onnxruntime.dll> <models folder> <photo>...`
//! Prints every panel found (title, how sure, the words). The models folder holds det-inference.onnx, rec-inference.onnx and rec-inference.yml.

use mediaverse_page_reader::{PageReader, panels_from_lines};
use std::path::PathBuf;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() < 3 {
        eprintln!("usage: read_photos <onnxruntime.dll> <models folder> <photo>...");
        std::process::exit(2);
    }
    ort::init_from(&args[0])
        .commit()
        .expect("load ONNX Runtime");
    let mut reader = PageReader::open(&PathBuf::from(&args[1])).expect("open the models");
    // VOCAB_DIR=<folder of .lrc/.txt lyrics>: the word list used to repair the reading (the app counts it from the library's lyrics).
    let mut vocab = mediaverse_page_reader::Vocabulary::default();
    if let Some(dir) = std::env::var_os("VOCAB_DIR") {
        let mut stack = vec![PathBuf::from(dir)];
        while let Some(folder) = stack.pop() {
            for entry in std::fs::read_dir(&folder).into_iter().flatten().flatten() {
                let path = entry.path();
                if path.is_dir() {
                    if path.file_name().is_some_and(|n| n != ".venv") {
                        stack.push(path);
                    }
                } else if matches!(
                    path.extension().and_then(|e| e.to_str()),
                    Some("lrc" | "txt")
                ) {
                    if let Ok(text) = std::fs::read_to_string(&path) {
                        let stripped: String = text
                            .lines()
                            .map(|l| l.rsplit(']').next().unwrap_or(l))
                            .collect::<Vec<_>>()
                            .join("\n");
                        vocab.add(&stripped);
                    }
                }
            }
        }
        println!("word list: {} words", vocab.len());
    }
    for photo in &args[2..] {
        let started = std::time::Instant::now();
        let lines = reader.read(&PathBuf::from(photo)).expect("read the photo");
        println!(
            "== {photo}: {} lines in {:.1}s",
            lines.len(),
            started.elapsed().as_secs_f32()
        );
        for panel in panels_from_lines(&lines) {
            println!(
                "--- [{}] (words {:.2}, {} lines, left {:.0})",
                panel.title,
                panel.score,
                panel.lines.len(),
                panel.left
            );
            if std::env::var_os("SHOW_WORDS").is_some() {
                for line in &panel.lines {
                    println!("{}", vocab.correct_line(line));
                }
            }
        }
    }
}
