//! Development aid: recomputes AccurateRip checksums from WAV files on disk and compares them with
//! a database file, independently of the ripper that wrote them.
//! usage: wavcheck <dBAR.bin> <track-count> <file.wav>:<track-number>...
use mediaverse_accuraterip::*;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let pressings = parse_response(&std::fs::read(&args[0]).unwrap()).unwrap();
    let count: usize = args[1].parse().unwrap();
    for spec in &args[2..] {
        let (path, number) = spec.rsplit_once(':').unwrap();
        let number: usize = number.parse().unwrap();
        let bytes = std::fs::read(path).unwrap();
        assert_eq!(&bytes[0..4], b"RIFF", "{path} is not a WAV file");
        let samples = pack_samples(&bytes[44..]);
        let position = match (number, count) {
            (1, _) => TrackPosition::First,
            (n, c) if n == c => TrackPosition::Last,
            _ => TrackPosition::Middle,
        };
        let sums = checksums(&samples, position);
        let hit = pressings.iter().enumerate().find_map(|(i, p)| {
            let e = p.tracks.get(number - 1)?;
            (e.checksum == sums.v1 || e.checksum == sums.v2).then_some((i, e.confidence))
        });
        println!(
            "{path}: v1={:08X} v2={:08X} -> {}",
            sums.v1,
            sums.v2,
            hit.map_or("NO MATCH".to_owned(), |(i, c)| format!(
                "matches pressing {i}, confidence {c}"
            ))
        );
    }
}
