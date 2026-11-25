//! Defect scan: looks for audible faults in decoded CD-quality audio (clicks and pops, dropouts,
//! stuck samples, clipping). It is an aid, not a verdict: it reports where something looks wrong so a
//! person can listen, and says so plainly. Useful above all for rips with no AccurateRip reference.
//!
//! Pure logic over packed stereo samples (left in the low 16 bits, as everywhere in this crate); it
//! never touches files. Thresholds are deliberately conservative, because a false alarm on every
//! drum hit would make the scan useless.

pub const SAMPLE_RATE: u64 = 44_100;

const BLOCK: usize = 2048;
/// A click must be at least this many times the typical high-frequency activity around it...
const CLICK_RATIO: f64 = 6.0;
/// ...and at least this large in absolute terms (second difference of 16-bit samples).
const CLICK_MIN: f64 = 2500.0;
const EDGE_IGNORE: usize = 1000;
const MIN_ZERO_RUN: usize = 32;
const MAX_DROPOUT_RUN: usize = SAMPLE_RATE as usize / 2;
const SURROUND: usize = 2048;
const SURROUND_RMS: f64 = 1500.0;
const MIN_STUCK_RUN: usize = 64;
/// A held value must last this long (about 6 ms) to be heard as a fault.
const MIN_AUDIBLE_STUCK_RUN: usize = 256;
/// Bump when the scanner's rules change: results stored by an older version are scanned again.
pub const ENGINE_VERSION: i64 = 3;
/// A song whose loudest sample is no louder than this (about -72 dB below full scale) has no sound in it: a rip that came out empty. Real quiet music is far above it.
const SILENT_PEAK: i32 = 8;
/// ...and it must last this long (one second), so a short click or a hidden second of nothing is not a "silent song".
const MIN_SILENT_SAMPLES: usize = SAMPLE_RATE as usize;
const CLIP_LEVEL: i32 = 32_760;
const MIN_CLIP_RUN: usize = 6;
const MAX_FINDINGS: usize = 200;

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum DefectKind {
    /// A very short, sharp spike: a pop or tick.
    Click,
    /// A stretch of digital silence in the middle of loud music: a skip or lost data.
    Dropout,
    /// The signal stuck at one non-zero value: a stalled read.
    Stuck,
    /// The signal flat against the maximum level: clipping (often just loud mastering).
    Clipping,
    /// No sound at all from the first sample to the last (D175): an empty rip, or a track made silent on purpose.
    Silent,
}

impl DefectKind {
    pub fn name(self) -> &'static str {
        match self {
            Self::Click => "click",
            Self::Dropout => "dropout",
            Self::Stuck => "stuck",
            Self::Clipping => "clipping",
            Self::Silent => "silent",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Defect {
    pub kind: DefectKind,
    pub start_sample: u64,
    pub length_samples: u64,
    /// 0.0 (barely) to 1.0 (very obvious).
    pub strength: f64,
}

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum Verdict {
    /// Nothing worth listening for.
    Clean,
    /// A few things that may or may not be audible.
    Minor,
    /// Likely audible faults: listen to the marked places.
    Suspect,
}

impl Verdict {
    pub fn name(self) -> &'static str {
        match self {
            Self::Clean => "clean",
            Self::Minor => "minor",
            Self::Suspect => "suspect",
        }
    }
}

#[derive(Clone, Debug, PartialEq)]
pub struct Report {
    pub samples: u64,
    pub defects: Vec<Defect>,
    pub verdict: Verdict,
    /// True when more findings were found than are listed.
    pub truncated: bool,
}

impl Report {
    pub fn count(&self, kind: DefectKind) -> usize {
        self.defects.iter().filter(|d| d.kind == kind).count()
    }
}

fn channel(samples: &[u32], right: bool) -> Vec<i32> {
    samples
        .iter()
        .map(|&s| i32::from(if right { (s >> 16) as u16 } else { s as u16 } as i16))
        .collect()
}

fn median(values: &mut [f64]) -> f64 {
    if values.is_empty() {
        return 0.0;
    }
    let middle = values.len() / 2;
    *values
        .select_nth_unstable_by(middle, |a, b| a.total_cmp(b))
        .1
}

/// Clicks in one channel: isolated spikes far above the local high-frequency activity.
fn clicks(x: &[i32]) -> Vec<(usize, f64)> {
    if x.len() < 2 * EDGE_IGNORE + 8 {
        return Vec::new();
    }
    let d2: Vec<f64> = (1..x.len() - 1)
        .map(|n| f64::from(x[n - 1] - 2 * x[n] + x[n + 1]))
        .collect(); // d2[i] is at sample i+1
    let blocks = d2.len().div_ceil(BLOCK);
    let scales: Vec<f64> = (0..blocks)
        .map(|b| {
            let mut slice: Vec<f64> = d2[b * BLOCK..((b + 1) * BLOCK).min(d2.len())]
                .iter()
                .map(|v| v.abs())
                .collect();
            median(&mut slice)
        })
        .collect();
    let mut found: Vec<(usize, f64)> = Vec::new();
    for (i, &value) in d2.iter().enumerate() {
        let sample = i + 1;
        if sample < EDGE_IGNORE || sample + EDGE_IGNORE > x.len() {
            continue;
        }
        let a = value.abs();
        if a < CLICK_MIN {
            continue;
        }
        let b = i / BLOCK;
        let scale = scales[b]
            .max(scales[b.saturating_sub(1)])
            .max(scales[(b + 1).min(blocks - 1)])
            .max(4.0);
        if a < CLICK_RATIO * scale {
            continue;
        }
        // The signature of one bad sample s: the second difference is -2s there and +s on each side,
        // and nothing else nearby is anywhere near as large. A loud musical transient (a snare hit, a
        // distorted guitar edge) keeps moving for several samples, so it fails the second condition.
        if i == 0 || i + 1 >= d2.len() {
            continue;
        }
        let shaped = |neighbour: f64| {
            neighbour * value < 0.0 && (0.25 * a..=0.75 * a).contains(&neighbour.abs())
        };
        if !shaped(d2[i - 1]) || !shaped(d2[i + 1]) {
            continue;
        }
        let lo = i.saturating_sub(12);
        let hi = (i + 13).min(d2.len());
        let around: f64 = (lo..hi)
            .filter(|&j| j.abs_diff(i) > 1)
            .map(|j| d2[j].abs())
            .fold(0.0, f64::max);
        if around > 0.25 * a {
            continue;
        }
        found.push((sample, (a / 20_000.0).min(1.0)));
    }
    // One click makes a small cluster of large values; keep the strongest of each cluster.
    let mut merged: Vec<(usize, f64)> = Vec::new();
    for (sample, strength) in found {
        match merged.last_mut() {
            Some(last) if sample - last.0 <= 8 => {
                if strength > last.1 {
                    *last = (sample, strength);
                }
            }
            _ => merged.push((sample, strength)),
        }
    }
    merged
}

fn rms(both: &[(i32, i32)]) -> f64 {
    if both.is_empty() {
        return 0.0;
    }
    let sum: f64 = both
        .iter()
        .map(|&(l, r)| f64::from(l) * f64::from(l) + f64::from(r) * f64::from(r))
        .sum();
    (sum / (2.0 * both.len() as f64)).sqrt()
}

/// Runs of identical frames: digital silence in loud music (dropout) or a stuck non-zero value.
fn runs(left: &[i32], right: &[i32]) -> Vec<Defect> {
    let n = left.len();
    let frames: Vec<(i32, i32)> = left.iter().copied().zip(right.iter().copied()).collect();
    let mut out = Vec::new();
    let mut start = 0;
    while start < n {
        let mut end = start + 1;
        while end < n && frames[end] == frames[start] {
            end += 1;
        }
        let length = end - start;
        let value = frames[start];
        if value == (0, 0)
            && length >= MIN_ZERO_RUN
            && length <= MAX_DROPOUT_RUN
            && start >= SURROUND
            && end + SURROUND <= n
        {
            let before = rms(&frames[start - SURROUND..start]);
            let after = rms(&frames[end..end + SURROUND]);
            if before >= SURROUND_RMS && after >= SURROUND_RMS {
                let strength = (length as f64 / 441.0).min(1.0).max(0.3); // 10 ms or more is obvious
                out.push(Defect {
                    kind: DefectKind::Dropout,
                    start_sample: start as u64,
                    length_samples: length as u64,
                    strength,
                });
            }
        } else if value != (0, 0)
            && length >= MIN_STUCK_RUN
            && value.0.abs() < CLIP_LEVEL
            && value.1.abs() < CLIP_LEVEL
            && start >= SURROUND
            && end + SURROUND <= n
        {
            // A stalled read holds one value for a noticeable time in the middle of music. Flat stretches of a few
            // milliseconds at a song's start, in a fade-out or in near-silence (where a decoder settles on one tiny
            // value) are normal and inaudible, so the music has to be loud on both sides and the hold long enough to hear.
            let before = rms(&frames[start - SURROUND..start]);
            let after = rms(&frames[end..end + SURROUND]);
            if length >= MIN_AUDIBLE_STUCK_RUN && before >= SURROUND_RMS && after >= SURROUND_RMS {
                out.push(Defect {
                    kind: DefectKind::Stuck,
                    start_sample: start as u64,
                    length_samples: length as u64,
                    strength: (length as f64 / 882.0).clamp(0.3, 1.0),
                });
            }
        }
        start = end;
    }
    out
}

/// Runs of samples flat against full scale in either channel.
fn clipping(left: &[i32], right: &[i32]) -> Vec<Defect> {
    let mut out = Vec::new();
    for x in [left, right] {
        let mut start = 0;
        while start < x.len() {
            if x[start].abs() >= CLIP_LEVEL {
                let sign = x[start].signum();
                let mut end = start + 1;
                while end < x.len() && x[end].abs() >= CLIP_LEVEL && x[end].signum() == sign {
                    end += 1;
                }
                if end - start >= MIN_CLIP_RUN {
                    out.push(Defect {
                        kind: DefectKind::Clipping,
                        start_sample: start as u64,
                        length_samples: (end - start) as u64,
                        strength: ((end - start) as f64 / 40.0).min(1.0),
                    });
                }
                start = end;
            } else {
                start += 1;
            }
        }
    }
    out
}

/// Whether the whole song is silent: at least a second long, and nothing in it louder than `SILENT_PEAK`.
pub fn is_silent(left: &[i32], right: &[i32]) -> bool {
    left.len() >= MIN_SILENT_SAMPLES
        && left
            .iter()
            .chain(right)
            .all(|&sample| sample.abs() <= SILENT_PEAK)
}

pub fn analyze(samples: &[u32]) -> Report {
    let left = channel(samples, false);
    let right = channel(samples, true);
    // A song with no sound at all is one finding and nothing else to look for (D175).
    if is_silent(&left, &right) {
        return Report {
            samples: samples.len() as u64,
            defects: vec![Defect {
                kind: DefectKind::Silent,
                start_sample: 0,
                length_samples: samples.len() as u64,
                strength: 1.0,
            }],
            verdict: Verdict::Suspect,
            truncated: false,
        };
    }
    let mut defects: Vec<Defect> = Vec::new();
    for x in [&left, &right] {
        defects.extend(clicks(x).into_iter().map(|(sample, strength)| Defect {
            kind: DefectKind::Click,
            start_sample: sample as u64,
            length_samples: 1,
            strength,
        }));
    }
    let run_defects = runs(&left, &right);
    // The hard edges of a dropout or stuck stretch look like clicks; they are part of that defect.
    defects.retain(|d| {
        d.kind != DefectKind::Click
            || !run_defects.iter().any(|r| {
                d.start_sample + 4 >= r.start_sample
                    && d.start_sample <= r.start_sample + r.length_samples + 4
            })
    });
    defects.extend(run_defects);
    defects.extend(clipping(&left, &right));
    defects.sort_by_key(|d| (d.start_sample, d.kind as u8));
    // The same click in both channels is one defect.
    // Likewise a flattened peak in both channels, or two flattened peaks a moment apart, is one finding.
    defects.dedup_by(|b, a| {
        a.kind == b.kind
            && matches!(a.kind, DefectKind::Click | DefectKind::Clipping)
            && b.start_sample - a.start_sample <= 8
    });

    let clicks = defects
        .iter()
        .filter(|d| d.kind == DefectKind::Click)
        .count();
    let dropouts = defects
        .iter()
        .filter(|d| d.kind == DefectKind::Dropout)
        .count();
    let stuck = defects
        .iter()
        .filter(|d| d.kind == DefectKind::Stuck)
        .count();
    // Clipping is counted and shown but never decides the verdict: loud masters (and MP3 decoding of them) clip a lot.
    let verdict = if dropouts > 0 || stuck > 0 || clicks >= 3 {
        Verdict::Suspect
    } else if clicks > 0 {
        Verdict::Minor
    } else {
        Verdict::Clean
    };
    let truncated = defects.len() > MAX_FINDINGS;
    if truncated {
        // Keep the most obvious findings, then put them back in time order.
        defects.sort_by(|a, b| b.strength.total_cmp(&a.strength));
        defects.truncate(MAX_FINDINGS);
        defects.sort_by_key(|d| (d.start_sample, d.kind as u8));
    }
    Report {
        samples: samples.len() as u64,
        defects,
        verdict,
        truncated,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn pack(l: i32, r: i32) -> u32 {
        u32::from(l as i16 as u16) | (u32::from(r as i16 as u16) << 16)
    }

    /// Music-like audio: a few tones plus noise, loud enough to count as music.
    fn music(seconds: f64) -> Vec<u32> {
        let total = (seconds * 44_100.0) as usize;
        let mut state = 99u32;
        (0..total)
            .map(|i| {
                let t = i as f64 / 44_100.0;
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                let noise = f64::from((state >> 20) as i32 - 2048) * 0.4;
                let tone = |f: f64, a: f64| a * (t * f * std::f64::consts::TAU).sin();
                let l = tone(220.0, 7000.0) + tone(1760.0, 2500.0) + tone(5000.0, 800.0) + noise;
                let r = tone(330.0, 6500.0) + tone(2640.0, 2200.0) + tone(7000.0, 700.0) + noise;
                pack(l as i32, r as i32)
            })
            .collect()
    }

    #[test]
    fn a_song_with_no_sound_at_all_is_one_silent_finding() {
        let silent = vec![0u32; 3 * 44_100];
        let report = analyze(&silent);
        assert_eq!(report.verdict, Verdict::Suspect);
        assert_eq!(report.count(DefectKind::Silent), 1);
        assert_eq!(report.defects.len(), 1);
        assert_eq!(report.defects[0].length_samples, 3 * 44_100);
        // A whisper of dither (peak of a few steps) is still no sound; a quiet song is not.
        let dither: Vec<u32> = (0..3 * 44_100)
            .map(|i| pack((i % 5) as i32 - 2, 3 - (i % 7) as i32))
            .collect();
        assert_eq!(analyze(&dither).count(DefectKind::Silent), 1);
        let quiet: Vec<u32> = (0..3 * 44_100)
            .map(|i| pack(if i % 100 < 50 { 40 } else { -40 }, 0))
            .collect();
        assert_eq!(analyze(&quiet).count(DefectKind::Silent), 0);
    }

    #[test]
    fn silence_that_is_only_part_of_a_song_or_too_short_is_not_a_silent_song() {
        let mut mostly = vec![0u32; 5 * 44_100];
        mostly.extend(music(1.0)); // a hidden track after a long silence
        assert_eq!(analyze(&mostly).count(DefectKind::Silent), 0);
        assert_eq!(
            analyze(&vec![0u32; 20_000]).count(DefectKind::Silent),
            0,
            "under a second"
        );
        assert_eq!(analyze(&[]).verdict, Verdict::Clean);
    }

    #[test]
    fn clean_music_has_no_findings() {
        let report = analyze(&music(3.0));
        assert_eq!(report.defects, vec![], "{report:?}");
        assert_eq!(report.verdict, Verdict::Clean);
    }

    #[test]
    fn full_scale_noise_and_silence_are_not_mistaken_for_defects() {
        let mut state = 5u32;
        let noise: Vec<u32> = (0..88_200)
            .map(|_| {
                state = state.wrapping_mul(1_664_525).wrapping_add(1_013_904_223);
                pack(
                    ((state >> 16) as i32 & 0xFFFF) - 32768,
                    ((state >> 4) as i32 & 0xFFFF) - 32768,
                )
            })
            .collect();
        assert_eq!(
            analyze(&noise).count(DefectKind::Click),
            0,
            "noise has no isolated spikes"
        );
        let silence = analyze(&vec![0u32; 88_200]);
        assert_eq!(
            silence.count(DefectKind::Dropout),
            0,
            "silence is not a dropout (it is a silent song, D175)"
        );
        assert_eq!(silence.count(DefectKind::Silent), 1);
    }

    #[test]
    fn a_single_pop_is_found_where_it_is() {
        let mut audio = music(3.0);
        let at = 70_000;
        audio[at] = pack(
            (audio[at] as u16 as i16 as i32) + 16_000,
            audio[at] as i32 >> 16,
        );
        let report = analyze(&audio);
        let clicks: Vec<_> = report
            .defects
            .iter()
            .filter(|d| d.kind == DefectKind::Click)
            .collect();
        assert_eq!(clicks.len(), 1, "{report:?}");
        assert!(clicks[0].start_sample.abs_diff(at as u64) <= 2);
        assert_eq!(report.verdict, Verdict::Minor);
        // Three of them make it suspect.
        for place in [30_000usize, 50_000, 100_000] {
            audio[place] = pack(20_000, 20_000);
        }
        assert_eq!(analyze(&audio).verdict, Verdict::Suspect);
    }

    #[test]
    fn a_hole_of_silence_in_loud_music_is_a_dropout_but_edges_and_long_gaps_are_not() {
        let mut audio = music(3.0);
        for sample in &mut audio[60_000..60_300] {
            *sample = 0;
        }
        let report = analyze(&audio);
        let dropouts: Vec<_> = report
            .defects
            .iter()
            .filter(|d| d.kind == DefectKind::Dropout)
            .collect();
        assert_eq!(dropouts.len(), 1, "{report:?}");
        assert_eq!(dropouts[0].start_sample, 60_000);
        assert_eq!(dropouts[0].length_samples, 300);
        assert_eq!(
            report.count(DefectKind::Click),
            0,
            "the edges of the hole are not separate clicks: {report:?}"
        );
        assert_eq!(report.verdict, Verdict::Suspect);

        // Silence at the start and a long (more than half a second) gap are normal.
        let mut quiet = music(4.0);
        for sample in &mut quiet[..5_000] {
            *sample = 0;
        }
        for sample in &mut quiet[80_000..120_000] {
            *sample = 0;
        }
        assert_eq!(analyze(&quiet).count(DefectKind::Dropout), 0);
    }

    #[test]
    fn a_stalled_value_and_clipping_are_reported() {
        let mut audio = music(3.0);
        for sample in &mut audio[40_000..40_600] {
            *sample = pack(1234, -777);
        }
        let report = analyze(&audio);
        assert_eq!(report.count(DefectKind::Stuck), 1, "{report:?}");
        assert_eq!(report.count(DefectKind::Click), 0, "{report:?}");
        assert_eq!(report.verdict, Verdict::Suspect);

        // Short flat spots, flat spots at the very start or end, and a tiny held value in a quiet fade are not stalls.
        let mut calm = music(4.0);
        for sample in &mut calm[40_000..40_150] {
            *sample = pack(1234, -777);
        }
        for sample in &mut calm[..3_000] {
            *sample = pack(3, 3);
        }
        let last = calm.len();
        for sample in &mut calm[last - 3_000..] {
            *sample = pack(-2, -2);
        }
        // A quiet fade where the decoder settles on one tiny value, then another, 900 samples at a time.
        for (i, sample) in calm[96_000..106_000].iter_mut().enumerate() {
            let level = (i / 900 % 2 + 1) as i32;
            *sample = pack(level, level);
        }
        let report = analyze(&calm);
        assert_eq!(report.count(DefectKind::Stuck), 0, "{report:?}");

        // The whole signal pushed past full scale, so every peak is flattened at the limit (a hot master).
        let mut loud = music(2.0);
        for sample in &mut loud {
            let l = ((*sample as u16 as i16 as i32) * 4).clamp(-32_768, 32_767);
            *sample = pack(l, (*sample >> 16) as u16 as i16 as i32);
        }
        let report = analyze(&loud);
        assert!(report.count(DefectKind::Clipping) >= 1, "{report:?}");
        assert_eq!(
            report.count(DefectKind::Click),
            0,
            "flattened peaks are not clicks: {report:?}"
        );
        assert_ne!(
            report.verdict,
            Verdict::Suspect,
            "clipping alone is information, not a fault"
        );
    }

    #[test]
    fn short_or_empty_input_does_not_panic() {
        for length in [0usize, 1, 5, 500, 2_100] {
            let _ = analyze(&vec![pack(100, 100); length]);
        }
        assert_eq!(analyze(&[]).verdict, Verdict::Clean);
    }
}
