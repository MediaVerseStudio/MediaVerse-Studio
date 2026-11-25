//! The sound itself for the exclusive (WASAPI) output: songs decoded to whole-number samples, and the step that turns
//! them into the bytes the sound card is opened with. Nothing here talks to Windows, so it is tested on its own.
//!
//! Every sample is kept as a 32-bit whole number scaled to the full range (a 16-bit sample is shifted up 16 places, a
//! 24-bit one 8), so any source depth is held without loss and the card's own depth decides how many bits are written.
//! At full volume nothing else touches the samples: what comes out is exactly what the file holds (bit-perfect).
//! Decoders: FLAC (claxon, also used by the ripper), MP3 (nanomp3, which trims the encoder delay and padding, so gapless
//! albums join exactly) and PCM WAV.

use std::path::Path;
use std::sync::atomic::{AtomicBool, AtomicU64, Ordering};
use std::sync::{Arc, Mutex};

/// A song longer than this (about 40 minutes of 24-bit 192 kHz stereo) is played the ordinary way instead.
const MAX_FILE_BYTES: u64 = 1 << 30;

/// How the sound card is opened: sample rate, channels, and the size of each sample in the buffer.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct Format {
    pub rate: u32,
    pub channels: u16,
    /// Bits in each sample slot of the buffer: 16, 24 (packed in three bytes) or 32.
    pub container_bits: u16,
    /// Bits of that slot that carry sound (a 24-bit song in a 32-bit slot has 24; the low byte is zero).
    pub valid_bits: u16,
}

impl Format {
    pub fn frame_bytes(&self) -> usize {
        usize::from(self.channels) * usize::from(self.container_bits) / 8
    }
}

/// The depth class of a source: 16, 24 or 32 bits.
pub fn depth_class(bits: u32) -> u16 {
    match bits {
        0..=16 => 16,
        17..=24 => 24,
        _ => 32,
    }
}

/// The ways to open the card for a song, best first: the song's own depth where the card allows it, then larger slots
/// that still hold it exactly, and last a smaller one (which rounds the sound and is no longer bit-perfect).
pub fn candidate_formats(rate: u32, channels: u16, source_bits: u16) -> Vec<Format> {
    let make = |container_bits, valid_bits| Format {
        rate,
        channels,
        container_bits,
        valid_bits,
    };
    match depth_class(u32::from(source_bits)) {
        16 => vec![make(16, 16), make(24, 24), make(32, 24), make(32, 32)],
        24 => vec![make(24, 24), make(32, 24), make(32, 32), make(16, 16)],
        _ => vec![make(32, 32), make(24, 24), make(32, 24), make(16, 16)],
    }
}

/// A song held in memory, filled in by a decoder thread while it plays (a song starts after its first moments).
pub struct Track {
    pub rate: u32,
    pub channels: u16,
    /// Depth of the source: 16, 24 or 32 bits.
    pub bits: u16,
    samples: Mutex<Vec<i32>>,
    ready_frames: AtomicU64,
    /// Length in frames once known (from the file's header, or when decoding has finished).
    total_frames: AtomicU64,
    done: AtomicBool,
    failed: Mutex<Option<String>>,
}

impl Track {
    fn new(rate: u32, channels: u16, bits: u16, expected_frames: u64) -> Arc<Self> {
        let reserve = usize::try_from(expected_frames.saturating_mul(u64::from(channels)))
            .unwrap_or(0)
            .min(1 << 28);
        Arc::new(Self {
            rate,
            channels,
            bits,
            samples: Mutex::new(Vec::with_capacity(reserve)),
            ready_frames: AtomicU64::new(0),
            total_frames: AtomicU64::new(expected_frames),
            done: AtomicBool::new(false),
            failed: Mutex::new(None),
        })
    }

    /// A finished song from samples already in memory (the whole-number scale described above).
    pub fn from_samples(rate: u32, channels: u16, bits: u16, samples: Vec<i32>) -> Arc<Self> {
        let frames = (samples.len() / usize::from(channels)) as u64;
        let track = Self::new(rate, channels, bits, 0);
        track.push(&samples);
        track.finish();
        debug_assert_eq!(track.ready_frames(), frames);
        track
    }

    fn push(&self, chunk: &[i32]) {
        let Ok(mut samples) = self.samples.lock() else {
            return;
        };
        samples.extend_from_slice(chunk);
        let frames = (samples.len() / usize::from(self.channels)) as u64;
        self.ready_frames.store(frames, Ordering::Release);
    }

    fn finish(&self) {
        self.total_frames
            .store(self.ready_frames(), Ordering::Release);
        self.done.store(true, Ordering::Release);
    }

    fn fail(&self, message: String) {
        if let Ok(mut failed) = self.failed.lock() {
            *failed = Some(message);
        }
        self.finish();
    }

    pub fn ready_frames(&self) -> u64 {
        self.ready_frames.load(Ordering::Acquire)
    }

    pub fn is_done(&self) -> bool {
        self.done.load(Ordering::Acquire)
    }

    /// The length in frames when known, else 0.
    pub fn total_frames(&self) -> u64 {
        self.total_frames.load(Ordering::Acquire)
    }

    pub fn error(&self) -> Option<String> {
        self.failed.lock().ok().and_then(|f| f.clone())
    }

    pub fn duration_ms(&self) -> Option<u64> {
        let total = self.total_frames();
        (total > 0).then(|| total * 1000 / u64::from(self.rate))
    }

    /// Whether a song of this kind can follow this one in the same open sound card without reopening it.
    pub fn joins(&self, format: &Format) -> bool {
        self.rate == format.rate
            && self.channels == format.channels
            && depth_class(u32::from(self.bits)) <= format.valid_bits
    }
}

/// Opens a song: the header is read now (so the format is known), the sound is decoded on a background thread.
pub fn open(path: &Path) -> Result<Arc<Track>, String> {
    let size = std::fs::metadata(path)
        .map_err(|e| format!("The song could not be read: {e}"))?
        .len();
    if size > MAX_FILE_BYTES {
        return Err("The file is too large for exclusive output.".to_owned());
    }
    match path
        .extension()
        .and_then(|e| e.to_str())
        .map(str::to_ascii_lowercase)
        .as_deref()
    {
        Some("flac") => open_flac(path),
        Some("mp3") => open_mp3(path),
        Some("wav") => open_wav(path),
        _ => Err("Exclusive output plays FLAC, MP3 and WAV files.".to_owned()),
    }
}

/// Mono is played to both sides: the card is opened as stereo, as nearly every card only accepts.
fn widen(channels: u16) -> u16 {
    if channels == 1 { 2 } else { channels }
}

fn open_flac(path: &Path) -> Result<Arc<Track>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("The song could not be read: {e}"))?;
    let mut reader = claxon::FlacReader::new(std::io::Cursor::new(bytes))
        .map_err(|e| format!("This FLAC file could not be read: {e}"))?;
    let info = reader.streaminfo();
    let channels = u16::try_from(info.channels).unwrap_or(0);
    if !(1..=8).contains(&channels)
        || info.sample_rate == 0
        || !(8..=32).contains(&info.bits_per_sample)
    {
        return Err("This FLAC file has a format exclusive output cannot play.".to_owned());
    }
    let out_channels = widen(channels);
    let bits = depth_class(info.bits_per_sample);
    let shift = 32 - info.bits_per_sample;
    let track = Track::new(
        info.sample_rate,
        out_channels,
        bits,
        info.samples.unwrap_or(0),
    );
    let worker = Arc::clone(&track);
    std::thread::spawn(move || {
        let mut frames = reader.blocks();
        let mut buffer = Vec::new();
        let mut chunk: Vec<i32> = Vec::new();
        loop {
            match frames.read_next_or_eof(std::mem::take(&mut buffer)) {
                Ok(Some(block)) => {
                    chunk.clear();
                    let length = block.duration() as usize;
                    for i in 0..length {
                        for c in 0..channels {
                            let sample = block.channel(u32::from(c))[i] << shift;
                            chunk.push(sample);
                            if channels == 1 {
                                chunk.push(sample);
                            }
                        }
                    }
                    worker.push(&chunk);
                    buffer = block.into_buffer();
                }
                Ok(None) => break,
                Err(error) => {
                    worker.fail(format!("The FLAC file broke off: {error}"));
                    return;
                }
            }
        }
        worker.finish();
    });
    Ok(track)
}

fn open_mp3(path: &Path) -> Result<Arc<Track>, String> {
    let file = std::fs::File::open(path).map_err(|e| format!("The song could not be read: {e}"))?;
    let mut reader = nanomp3::Reader::<_, i16>::new(std::io::BufReader::new(file))
        .map_err(|e| format!("This MP3 could not be read: {e}"))?;
    let rate = reader.sample_rate();
    let channels: u16 = match reader.channels() {
        Some(nanomp3::Channels::Mono) => 1,
        Some(nanomp3::Channels::Stereo) => 2,
        None => 0,
    };
    if rate == 0 || channels == 0 {
        return Err("This MP3 has a format exclusive output cannot play.".to_owned());
    }
    // the encoder's delay and padding are already trimmed (when the file says how much), so albums join exactly
    let track = Track::new(
        rate,
        widen(channels),
        16,
        reader.total_samples().unwrap_or(0),
    );
    let worker = Arc::clone(&track);
    std::thread::spawn(move || {
        let mut raw = vec![0i16; 1152 * 2 * 16];
        let mut chunk: Vec<i32> = Vec::with_capacity(raw.len() * 2);
        loop {
            match reader.read(&mut raw) {
                Ok(0) => break,
                Ok(count) => {
                    chunk.clear();
                    for &s in &raw[..count] {
                        chunk.push(i32::from(s) << 16);
                        if channels == 1 {
                            chunk.push(i32::from(s) << 16);
                        }
                    }
                    worker.push(&chunk);
                }
                Err(error) => {
                    worker.fail(format!("The MP3 broke off: {error}"));
                    return;
                }
            }
        }
        worker.finish();
    });
    Ok(track)
}

/// The format of a PCM WAV file and where its sound lies: (rate, channels, bits, data start, data length).
fn parse_wav(bytes: &[u8]) -> Result<(u32, u16, u16, usize, usize), String> {
    let bad = || "This WAV file has a format exclusive output cannot play.".to_owned();
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        return Err(bad());
    }
    let le16 = |at: usize| u16::from_le_bytes([bytes[at], bytes[at + 1]]);
    let le32 =
        |at: usize| u32::from_le_bytes([bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]]);
    let mut at = 12;
    let mut format: Option<(u32, u16, u16)> = None;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let size = le32(at + 4) as usize;
        let body = at + 8;
        if id == b"fmt " && body + 16 <= bytes.len() {
            let mut tag = le16(body);
            if tag == 0xFFFE && size >= 26 && body + 26 <= bytes.len() {
                tag = le16(body + 24); // the first two bytes of the sub-format say which kind it is
            }
            if tag != 1 {
                return Err(bad());
            }
            format = Some((le32(body + 4), le16(body + 2), le16(body + 14)));
        } else if id == b"data" {
            let (rate, channels, bits) = format.ok_or_else(bad)?;
            let length = size.min(bytes.len() - body);
            if !(1..=8).contains(&channels) || rate == 0 || ![16, 24, 32].contains(&bits) {
                return Err(bad());
            }
            return Ok((rate, channels, bits, body, length));
        }
        at = body + size + (size & 1);
    }
    Err(bad())
}

fn open_wav(path: &Path) -> Result<Arc<Track>, String> {
    let bytes = std::fs::read(path).map_err(|e| format!("The song could not be read: {e}"))?;
    let (rate, channels, bits, start, length) = parse_wav(&bytes)?;
    let width = usize::from(bits / 8);
    let frames = (length / (width * usize::from(channels))) as u64;
    let track = Track::new(rate, widen(channels), bits, frames);
    let worker = Arc::clone(&track);
    std::thread::spawn(move || {
        let data = &bytes[start..start + length];
        let mut chunk: Vec<i32> = Vec::with_capacity(1 << 16);
        let frame_size = width * usize::from(channels);
        for frame in data.chunks_exact(frame_size) {
            for sample in frame.chunks_exact(width) {
                let value = match width {
                    2 => i32::from(i16::from_le_bytes([sample[0], sample[1]])) << 16,
                    3 => i32::from_le_bytes([0, sample[0], sample[1], sample[2]]),
                    _ => i32::from_le_bytes([sample[0], sample[1], sample[2], sample[3]]),
                };
                chunk.push(value);
                if channels == 1 {
                    chunk.push(value);
                }
            }
            if chunk.len() >= 1 << 16 {
                worker.push(&chunk);
                chunk.clear();
            }
        }
        worker.push(&chunk);
        worker.finish();
    });
    Ok(track)
}

/// One song being played: where in it the next sample comes from.
struct Playing {
    token: u64,
    track: Arc<Track>,
    cursor: u64,
}

/// What a call to `render` found.
#[derive(Debug, Default, PartialEq, Eq)]
pub struct Report {
    /// The next song took over inside this block, and its token.
    pub advanced_to: Option<u64>,
    /// The last song ran out (and the following one, if any, cannot share this open card).
    pub finished: bool,
    /// The sound was not decoded fast enough and silence was written for the rest.
    pub underrun: bool,
}

/// Turns the songs into the card's buffer: the current song, the next one joined to it exactly, and the volume.
pub struct Renderer {
    pub format: Format,
    current: Option<Playing>,
    next: Option<(u64, Arc<Track>)>,
    gain: f64,
    target: f64,
    step: f64,
}

impl Renderer {
    pub fn new(format: Format) -> Self {
        Self {
            format,
            current: None,
            next: None,
            gain: 0.0,
            target: 0.0,
            // a change of volume takes about 10 ms, which is too quick to hear as a sweep and too slow to click
            step: 1.0 / (0.010 * f64::from(format.rate)).max(1.0),
        }
    }

    pub fn set_current(&mut self, token: u64, track: Arc<Track>, start_frame: u64) {
        self.current = Some(Playing {
            token,
            track,
            cursor: start_frame,
        });
        self.next = None;
    }

    pub fn set_next(&mut self, next: Option<(u64, Arc<Track>)>) {
        self.next = next;
    }

    pub fn take_next(&mut self) -> Option<(u64, Arc<Track>)> {
        self.next.take()
    }

    pub fn has_current(&self) -> bool {
        self.current.is_some()
    }

    pub fn current_token(&self) -> Option<u64> {
        self.current.as_ref().map(|p| p.token)
    }

    pub fn current_track(&self) -> Option<Arc<Track>> {
        self.current.as_ref().map(|p| Arc::clone(&p.track))
    }

    pub fn cursor(&self) -> u64 {
        self.current.as_ref().map_or(0, |p| p.cursor)
    }

    pub fn seek(&mut self, frame: u64) {
        if let Some(p) = self.current.as_mut() {
            p.cursor = frame;
            self.gain = 0.0; // the new place is faded in, not cut in
        }
    }

    /// The volume to reach (0 to 1); `immediate` jumps there instead of fading.
    pub fn set_target(&mut self, target: f64, immediate: bool) {
        self.target = target.clamp(0.0, 1.0);
        if immediate {
            self.gain = self.target;
        }
    }

    pub fn gain(&self) -> f64 {
        self.gain
    }

    /// Writes `frames` frames into `out` (which holds exactly that many).
    pub fn render(&mut self, out: &mut [u8], frames: usize) -> Report {
        let mut report = Report::default();
        let frame_bytes = self.format.frame_bytes();
        debug_assert!(out.len() >= frames * frame_bytes);
        let channels = usize::from(self.format.channels);
        let mut written = 0usize;
        while written < frames {
            let Some(playing) = self.current.as_mut() else {
                out[written * frame_bytes..frames * frame_bytes].fill(0);
                break;
            };
            let ready = playing.track.ready_frames();
            let available = ready.saturating_sub(playing.cursor);
            if available == 0 {
                if playing.track.is_done() {
                    // the song is over: the next one follows on the very next sample if the open card can carry it
                    if let Some((token, track)) = self.next.take() {
                        if track.joins(&self.format) {
                            self.current = Some(Playing {
                                token,
                                track,
                                cursor: 0,
                            });
                            report.advanced_to = Some(token);
                            continue;
                        }
                        self.next = Some((token, track));
                    }
                    self.current = None;
                    report.finished = true;
                    continue;
                }
                report.underrun = true;
                out[written * frame_bytes..frames * frame_bytes].fill(0);
                break;
            }
            let count = (available as usize).min(frames - written);
            let from = playing.cursor as usize * channels;
            let Ok(samples) = playing.track.samples.lock() else {
                out[written * frame_bytes..frames * frame_bytes].fill(0);
                break;
            };
            let source = &samples[from..from + count * channels];
            let target = &mut out[written * frame_bytes..(written + count) * frame_bytes];
            if self.gain == 1.0 && self.target == 1.0 {
                write_samples(target, source, &self.format);
            } else {
                // fading or below full volume: the only case where the samples are changed
                let mut faded: Vec<i32> = Vec::with_capacity(source.len());
                for frame in source.chunks_exact(channels) {
                    if self.gain < self.target {
                        self.gain = (self.gain + self.step).min(self.target);
                    } else if self.gain > self.target {
                        self.gain = (self.gain - self.step).max(self.target);
                    }
                    for &s in frame {
                        faded.push((f64::from(s) * self.gain).round() as i32);
                    }
                }
                write_samples(target, &faded, &self.format);
            }
            drop(samples);
            playing.cursor += count as u64;
            written += count;
        }
        report
    }
}

/// Writes whole-number samples into the card's slots, rounding when the slot is smaller than the sample.
fn write_samples(out: &mut [u8], samples: &[i32], format: &Format) {
    match (format.container_bits, format.valid_bits) {
        (16, _) => {
            for (slot, &s) in out.chunks_exact_mut(2).zip(samples) {
                let v = ((i64::from(s) + 0x8000) >> 16).clamp(-0x8000, 0x7FFF) as i16;
                slot.copy_from_slice(&v.to_le_bytes());
            }
        }
        (24, _) => {
            for (slot, &s) in out.chunks_exact_mut(3).zip(samples) {
                let v = ((i64::from(s) + 0x80) >> 8).clamp(-0x80_0000, 0x7F_FFFF) as i32;
                slot.copy_from_slice(&v.to_le_bytes()[0..3]);
            }
        }
        (_, 24) => {
            for (slot, &s) in out.chunks_exact_mut(4).zip(samples) {
                let v = ((i64::from(s) + 0x80) >> 8).clamp(-0x80_0000, 0x7F_FFFF) as i32;
                slot.copy_from_slice(&(v << 8).to_le_bytes());
            }
        }
        _ => {
            for (slot, &s) in out.chunks_exact_mut(4).zip(samples) {
                slot.copy_from_slice(&s.to_le_bytes());
            }
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn stereo16(rate: u32, values: &[i16]) -> Arc<Track> {
        Track::from_samples(
            rate,
            2,
            16,
            values.iter().map(|&v| i32::from(v) << 16).collect(),
        )
    }

    fn format(container: u16, valid: u16) -> Format {
        Format {
            rate: 44_100,
            channels: 2,
            container_bits: container,
            valid_bits: valid,
        }
    }

    #[test]
    fn sixteen_bit_song_is_written_unchanged() {
        let values: Vec<i16> = vec![0, 1, -1, 32767, -32768, 1234, -4321, 7];
        let mut renderer = Renderer::new(format(16, 16));
        renderer.set_current(1, stereo16(44_100, &values), 0);
        renderer.set_target(1.0, true);
        let mut out = vec![0u8; values.len() * 2];
        let report = renderer.render(&mut out, values.len() / 2);
        let expected: Vec<u8> = values.iter().flat_map(|v| v.to_le_bytes()).collect();
        assert_eq!(out, expected, "full volume must not change a single bit");
        assert_eq!(report, Report::default());
    }

    #[test]
    fn a_larger_slot_holds_the_same_sound_exactly() {
        let values: Vec<i16> = vec![5, -5, 32767, -32768];
        let mut renderer = Renderer::new(format(24, 24));
        renderer.set_current(1, stereo16(44_100, &values), 0);
        renderer.set_target(1.0, true);
        let mut out = vec![0u8; 2 * 6];
        renderer.render(&mut out, 2);
        // 24-bit little endian of the 16-bit value shifted up eight places
        let expected: Vec<u8> = values
            .iter()
            .flat_map(|&v| (i32::from(v) << 8).to_le_bytes()[0..3].to_vec())
            .collect();
        assert_eq!(out, expected);

        let mut renderer = Renderer::new(format(32, 24));
        renderer.set_current(1, stereo16(44_100, &values), 0);
        renderer.set_target(1.0, true);
        let mut out = vec![0u8; 2 * 8];
        renderer.render(&mut out, 2);
        let expected: Vec<u8> = values
            .iter()
            .flat_map(|&v| (i32::from(v) << 16).to_le_bytes())
            .collect();
        assert_eq!(out, expected);
    }

    #[test]
    fn twenty_four_bit_song_keeps_every_bit_in_a_24_bit_slot() {
        let source: Vec<i32> = vec![0x123456 << 8, -(0x654321 << 8), 1 << 8, -(1 << 8)];
        let mut renderer = Renderer::new(format(24, 24));
        renderer.set_current(1, Track::from_samples(44_100, 2, 24, source.clone()), 0);
        renderer.set_target(1.0, true);
        let mut out = vec![0u8; 2 * 6];
        renderer.render(&mut out, 2);
        let expected: Vec<u8> = source
            .iter()
            .flat_map(|&s| (s >> 8).to_le_bytes()[0..3].to_vec())
            .collect();
        assert_eq!(out, expected);
    }

    #[test]
    fn the_next_song_follows_on_the_very_next_sample() {
        let first = stereo16(44_100, &[1, 1, 2, 2, 3, 3]);
        let second = stereo16(44_100, &[10, 10, 20, 20, 30, 30]);
        let mut renderer = Renderer::new(format(16, 16));
        renderer.set_current(1, first, 0);
        renderer.set_next(Some((2, second)));
        renderer.set_target(1.0, true);
        let mut out = vec![0u8; 5 * 4];
        let report = renderer.render(&mut out, 5);
        let left: Vec<i16> = out
            .chunks_exact(4)
            .map(|f| i16::from_le_bytes([f[0], f[1]]))
            .collect();
        assert_eq!(
            left,
            vec![1, 2, 3, 10, 20],
            "no gap and no repeat across the join"
        );
        assert_eq!(report.advanced_to, Some(2));
        assert!(!report.finished);
        assert_eq!(renderer.current_token(), Some(2));
    }

    #[test]
    fn a_song_that_cannot_share_the_card_ends_the_stream() {
        let first = stereo16(44_100, &[1, 1]);
        let other_rate = stereo16(48_000, &[9, 9]);
        let mut renderer = Renderer::new(format(16, 16));
        renderer.set_current(1, first, 0);
        renderer.set_next(Some((2, other_rate)));
        renderer.set_target(1.0, true);
        let mut out = vec![0xAAu8; 4 * 4];
        let report = renderer.render(&mut out, 4);
        assert!(report.finished);
        assert_eq!(report.advanced_to, None);
        assert_eq!(&out[4..], &[0u8; 12], "silence after the end");
        assert!(
            renderer.take_next().is_some(),
            "the next song stays queued for the caller to open"
        );
    }

    #[test]
    fn a_sixteen_bit_card_cannot_carry_a_24_bit_song() {
        let song = Track::from_samples(44_100, 2, 24, vec![0; 4]);
        assert!(!song.joins(&format(16, 16)));
        assert!(song.joins(&format(24, 24)));
        assert!(song.joins(&format(32, 24)));
        assert!(stereo16(44_100, &[0, 0]).joins(&format(16, 16)));
        assert!(stereo16(44_100, &[0, 0]).joins(&format(32, 32)));
    }

    #[test]
    fn silence_and_a_flag_when_the_decoder_is_behind() {
        let track = Track::new(44_100, 2, 16, 100);
        track.push(&[1 << 16, 1 << 16]); // one frame so far
        let mut renderer = Renderer::new(format(16, 16));
        renderer.set_current(1, Arc::clone(&track), 0);
        renderer.set_target(1.0, true);
        let mut out = vec![0xFFu8; 3 * 4];
        let report = renderer.render(&mut out, 3);
        assert!(report.underrun);
        assert_eq!(i16::from_le_bytes([out[0], out[1]]), 1);
        assert_eq!(&out[4..], &[0u8; 8]);
        assert_eq!(
            renderer.cursor(),
            1,
            "the place is kept, so the sound resumes where it stopped"
        );
    }

    #[test]
    fn volume_fades_rather_than_jumps() {
        let ones: Vec<i32> = vec![1 << 30; 2 * 1000];
        let mut renderer = Renderer::new(format(32, 32));
        renderer.set_current(1, Track::from_samples(44_100, 2, 32, ones), 0);
        renderer.set_target(1.0, true);
        renderer.set_target(0.0, false);
        let mut out = vec![0u8; 1000 * 8];
        renderer.render(&mut out, 1000);
        let left: Vec<i32> = out
            .chunks_exact(8)
            .map(|f| i32::from_le_bytes([f[0], f[1], f[2], f[3]]))
            .collect();
        assert!(
            left[0] < 1 << 30 && left[0] > 0,
            "starts to fall at once, not at a stroke"
        );
        assert!(left.windows(2).all(|w| w[1] <= w[0]), "falls steadily");
        assert_eq!(*left.last().unwrap(), 0, "silent within about 10 ms");
        assert_eq!(renderer.gain(), 0.0);
    }

    #[test]
    fn seeking_fades_the_new_place_in() {
        let ones: Vec<i32> = vec![1 << 30; 2 * 1000];
        let mut renderer = Renderer::new(format(32, 32));
        renderer.set_current(1, Track::from_samples(44_100, 2, 32, ones), 0);
        renderer.set_target(1.0, true);
        renderer.seek(500);
        let mut out = vec![0u8; 8 * 8];
        renderer.render(&mut out, 8);
        let first = i32::from_le_bytes([out[0], out[1], out[2], out[3]]);
        assert!(first < 1 << 28, "starts near silence");
        assert_eq!(renderer.cursor(), 508);
    }

    #[test]
    fn card_formats_are_offered_best_first() {
        let sixteen = candidate_formats(44_100, 2, 16);
        assert_eq!((sixteen[0].container_bits, sixteen[0].valid_bits), (16, 16));
        let twenty_four = candidate_formats(96_000, 2, 24);
        assert_eq!(
            (twenty_four[0].container_bits, twenty_four[0].valid_bits),
            (24, 24)
        );
        assert_eq!(
            (twenty_four[1].container_bits, twenty_four[1].valid_bits),
            (32, 24)
        );
        assert_eq!(
            twenty_four.last().unwrap().container_bits,
            16,
            "rounding down is the last resort"
        );
    }

    fn wav(bits: u16, channels: u16, data: &[u8]) -> Vec<u8> {
        let mut file = Vec::new();
        file.extend_from_slice(b"RIFF");
        file.extend_from_slice(&((36 + data.len()) as u32).to_le_bytes());
        file.extend_from_slice(b"WAVEfmt ");
        file.extend_from_slice(&16u32.to_le_bytes());
        file.extend_from_slice(&1u16.to_le_bytes());
        file.extend_from_slice(&channels.to_le_bytes());
        file.extend_from_slice(&96_000u32.to_le_bytes());
        file.extend_from_slice(&(96_000 * u32::from(channels) * u32::from(bits / 8)).to_le_bytes());
        file.extend_from_slice(&(channels * (bits / 8)).to_le_bytes());
        file.extend_from_slice(&bits.to_le_bytes());
        file.extend_from_slice(b"data");
        file.extend_from_slice(&(data.len() as u32).to_le_bytes());
        file.extend_from_slice(data);
        file
    }

    #[test]
    fn wav_header_is_read() {
        let file = wav(24, 2, &[0u8; 12]);
        let (rate, channels, bits, start, length) = parse_wav(&file).unwrap();
        assert_eq!((rate, channels, bits, length), (96_000, 2, 24, 12));
        assert_eq!(start, 44);
        assert!(parse_wav(b"not a wav file at all").is_err());
    }

    #[test]
    fn a_wav_file_plays_back_the_samples_it_holds() {
        let dir = std::env::temp_dir().join(format!("mv-native-pcm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("a.wav");
        // two frames of 24-bit stereo: (1, -1) and (0x7FFFFF, -0x800000)
        let data: Vec<u8> = [1i32, -1, 0x7FFFFF, -0x800000]
            .iter()
            .flat_map(|v| v.to_le_bytes()[0..3].to_vec())
            .collect();
        std::fs::write(&path, wav(24, 2, &data)).unwrap();
        let track = open(&path).unwrap();
        while !track.is_done() {
            std::thread::yield_now();
        }
        assert_eq!(
            (track.rate, track.channels, track.bits, track.total_frames()),
            (96_000, 2, 24, 2)
        );
        let mut renderer = Renderer::new(Format {
            rate: 96_000,
            channels: 2,
            container_bits: 24,
            valid_bits: 24,
        });
        renderer.set_current(1, track, 0);
        renderer.set_target(1.0, true);
        let mut out = vec![0u8; 2 * 6];
        renderer.render(&mut out, 2);
        assert_eq!(out, data, "the file's own bytes come back out");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn mono_is_played_to_both_sides() {
        let dir = std::env::temp_dir().join(format!("mv-native-pcm-mono-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("m.wav");
        let data: Vec<u8> = [100i16, -200]
            .iter()
            .flat_map(|v| v.to_le_bytes())
            .collect();
        std::fs::write(&path, wav(16, 1, &data)).unwrap();
        let track = open(&path).unwrap();
        while !track.is_done() {
            std::thread::yield_now();
        }
        assert_eq!(track.channels, 2);
        assert_eq!(track.total_frames(), 2);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
