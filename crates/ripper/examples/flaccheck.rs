//! Development aid: decodes archived FLAC files and checks the audio against an AccurateRip
//! database file, independently of the ripper that made them. Also prints the tags.
//! usage: flaccheck <dBAR.bin> <track-count> <file.flac>:<track-number>...
use mediaverse_accuraterip::*;

fn main() {
    let args: Vec<String> = std::env::args().skip(1).collect();
    let pressings = parse_response(&std::fs::read(&args[0]).unwrap()).unwrap();
    let count: usize = args[1].parse().unwrap();
    for spec in &args[2..] {
        let (path, number) = spec.rsplit_once(':').unwrap();
        let number: usize = number.parse().unwrap();
        let mut reader = claxon::FlacReader::open(path).unwrap();
        let tags: Vec<String> = reader.tags().map(|(k, v)| format!("{k}={v}")).collect();
        let mut interleaved = reader.samples().map(|s| s.unwrap());
        let mut samples = Vec::new();
        while let (Some(l), Some(r)) = (interleaved.next(), interleaved.next()) {
            samples.push(u32::from(l as i16 as u16) | (u32::from(r as i16 as u16) << 16));
        }
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
            "{path}\n  tags: {}\n  {} samples -> {}",
            tags.join(", "),
            samples.len(),
            hit.map_or("NO MATCH".to_owned(), |(i, c)| format!(
                "matches AccurateRip pressing {i}, confidence {c}"
            ))
        );
    }
}
