//! Development aid: searches for the drive read offset by matching a ripped track against an
//! AccurateRip response.
//! usage: calibrate <track.raw> <margin-sectors> <track-sectors> <dBAR.bin> <track-number> <track-count>
use mediaverse_accuraterip::*;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    if args.len() != 6 {
        eprintln!(
            "usage: calibrate <track.raw> <margin-sectors> <track-sectors> <dBAR.bin> <track-number> <track-count>"
        );
        std::process::exit(2);
    }
    let pcm = std::fs::read(&args[0]).expect("read raw PCM");
    let margin_sectors: usize = args[1].parse().unwrap();
    let track_sectors: usize = args[2].parse().unwrap();
    let response = std::fs::read(&args[3]).expect("read database file");
    let number: usize = args[4].parse().unwrap();
    let count: usize = args[5].parse().unwrap();

    let samples = pack_samples(&pcm);
    let margin = margin_sectors * SAMPLES_PER_SECTOR;
    let track_len = track_sectors * SAMPLES_PER_SECTOR;
    let position = match (number, count) {
        (1, 1) => TrackPosition::Only,
        (1, _) => TrackPosition::First,
        (n, c) if n == c => TrackPosition::Last,
        _ => TrackPosition::Middle,
    };
    let pressings = parse_response(&response).expect("parse database file");
    let expected: Vec<(usize, TrackEntry)> = pressings
        .iter()
        .enumerate()
        .filter_map(|(index, p)| p.tracks.get(number - 1).map(|entry| (index, *entry)))
        .collect();

    let limit = margin as i32;
    let found = find_offsets(
        &samples,
        margin,
        track_len,
        position,
        &expected,
        -limit..=limit,
    );
    println!(
        "{} samples read, searched offsets {}..={}",
        samples.len(),
        -limit,
        limit
    );
    if found.is_empty() {
        println!("NO MATCH for track {number} at any searched offset");
    }
    for m in found {
        println!(
            "MATCH offset {:+} samples  checksum v{}  pressing {}  confidence {}",
            m.offset, m.version, m.pressing, m.confidence
        );
    }
    let zero = checksums(&samples[margin..margin + track_len], position);
    println!(
        "(checksums at offset 0: v1={:08X} v2={:08X})",
        zero.v1, zero.v2
    );
}
