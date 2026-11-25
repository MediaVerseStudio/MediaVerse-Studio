//! Loudness analysis for volume levelling (owner's list 2026-11-23, issue #6): how loud a song is, measured the way ITU-R BS.1770-4 and EBU R128 define
//! it (the K-weighting filter, 400 ms blocks overlapping by 75 %, an absolute gate at -70 LUFS and a relative gate 10 LU below the average), and from it the
//! ReplayGain 2.0 gain that brings the song to the reference level of -18 LUFS. Written from the published standards, with no new dependency: the file is
//! decoded by `library_defects::decode_file` (MP3, FLAC and WAV, 44.1 kHz stereo, the same decoders as the defect scan) and nothing is written to the file.

/// The level ReplayGain 2.0 plays everything at, in LUFS.
pub const REFERENCE_LUFS: f64 = -18.0;
const SAMPLE_RATE: f64 = 44_100.0;
const ABSOLUTE_GATE_LUFS: f64 = -70.0;
const RELATIVE_GATE_LU: f64 = -10.0;

#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Loudness {
    /// Integrated loudness of the whole song in LUFS.
    pub lufs: f64,
    /// The highest sample, as a fraction of full scale (1.0 is the loudest a 16-bit file can hold).
    pub peak: f64,
    /// The gain in dB that brings the song to `REFERENCE_LUFS` (negative for a loud song).
    pub gain_db: f64,
    /// How much the song's loudness moves, in LU (EBU R128 loudness range: the spread of its 3-second readings, quiet passages to loud ones).
    pub range_lu: f64,
    /// The loudness of its loud passages: the 95th percentile of its 3-second readings, in LUFS. A song that is mostly soft with a few intense sections
    /// reads far above its integrated loudness here.
    pub loud_end_lufs: f64,
    /// Its length in samples at 44.1 kHz (the weight of the song in an album's measurement).
    pub samples: usize,
}

/// A second-order filter section (direct form I, the coefficients as in the standard, with a0 divided out).
#[derive(Clone, Copy)]
struct Biquad {
    b: [f64; 3],
    a: [f64; 2],
    x: [f64; 2],
    y: [f64; 2],
}

impl Biquad {
    fn run(&mut self, input: f64) -> f64 {
        let out = self.b[0] * input + self.b[1] * self.x[0] + self.b[2] * self.x[1]
            - self.a[0] * self.y[0]
            - self.a[1] * self.y[1];
        self.x = [input, self.x[0]];
        self.y = [out, self.y[0]];
        out
    }
}

/// The two stages of the K-weighting filter for `rate`: a high shelf (the head's acoustics) and a high-pass at about 38 Hz. The standard gives the
/// coefficients for 48 kHz; these are the same filters worked out for any rate from their frequency, gain and Q.
fn k_weighting(rate: f64) -> [Biquad; 2] {
    let (f0, gain_db, q) = (
        1_681.974_450_955_533,
        3.999_843_853_973_347,
        0.707_175_236_955_419_6,
    );
    let k = (std::f64::consts::PI * f0 / rate).tan();
    let vh = 10f64.powf(gain_db / 20.0);
    let vb = vh.powf(0.499_666_774_154_541_6);
    let a0 = 1.0 + k / q + k * k;
    let shelf = Biquad {
        b: [
            (vh + vb * k / q + k * k) / a0,
            2.0 * (k * k - vh) / a0,
            (vh - vb * k / q + k * k) / a0,
        ],
        a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q + k * k) / a0],
        x: [0.0; 2],
        y: [0.0; 2],
    };
    let (f1, q1) = (38.135_470_876_024_44, 0.500_327_037_323_877_3);
    let k = (std::f64::consts::PI * f1 / rate).tan();
    let a0 = 1.0 + k / q1 + k * k;
    let high_pass = Biquad {
        b: [1.0, -2.0, 1.0],
        a: [2.0 * (k * k - 1.0) / a0, (1.0 - k / q1 + k * k) / a0],
        x: [0.0; 2],
        y: [0.0; 2],
    };
    [shelf, high_pass]
}

fn lufs_of(mean_square_sum: f64) -> f64 {
    -0.691 + 10.0 * mean_square_sum.log10()
}

/// Measures packed stereo 44.1 kHz samples (left in the low 16 bits, right in the high 16, as `decode_file` gives them). `None` when the song holds
/// nothing above the absolute gate (silence), or is shorter than one 400 ms block.
pub fn analyze(samples: &[u32]) -> Option<Loudness> {
    let block = (SAMPLE_RATE * 0.4) as usize;
    let step = (SAMPLE_RATE * 0.1) as usize;
    if samples.len() < block {
        return None;
    }
    let mut filters = [k_weighting(SAMPLE_RATE), k_weighting(SAMPLE_RATE)];
    // The weighted energy of every sample (left and right added), so a block's loudness is a sum over a window.
    let mut energy = Vec::with_capacity(samples.len());
    let mut peak = 0f64;
    for &packed in samples {
        let channels = [
            f64::from(packed as u16 as i16) / 32768.0,
            f64::from((packed >> 16) as u16 as i16) / 32768.0,
        ];
        let mut sum = 0.0;
        for (c, &sample) in channels.iter().enumerate() {
            peak = peak.max(sample.abs());
            let weighted = filters[c]
                .iter_mut()
                .fold(sample, |value, stage| stage.run(value));
            sum += weighted * weighted;
        }
        energy.push(sum);
    }
    // Prefix sums make each overlapping block a subtraction.
    let mut prefix = Vec::with_capacity(energy.len() + 1);
    prefix.push(0.0);
    let mut running = 0.0;
    for e in &energy {
        running += e;
        prefix.push(running);
    }
    let blocks: Vec<f64> = (0..=samples.len() - block)
        .step_by(step)
        .map(|start| (prefix[start + block] - prefix[start]) / block as f64)
        .collect();
    let above_absolute: Vec<f64> = blocks
        .iter()
        .copied()
        .filter(|&b| b > 0.0 && lufs_of(b) > ABSOLUTE_GATE_LUFS)
        .collect();
    if above_absolute.is_empty() {
        return None;
    }
    let relative_gate = lufs_of(above_absolute.iter().sum::<f64>() / above_absolute.len() as f64)
        + RELATIVE_GATE_LU;
    let kept: Vec<f64> = above_absolute
        .into_iter()
        .filter(|&b| lufs_of(b) > relative_gate)
        .collect();
    if kept.is_empty() {
        return None;
    }
    let lufs = lufs_of(kept.iter().sum::<f64>() / kept.len() as f64);
    let (range_lu, loud_end_lufs) = short_term_stats(&prefix, lufs);
    Some(Loudness {
        lufs,
        peak,
        gain_db: REFERENCE_LUFS - lufs,
        range_lu,
        loud_end_lufs,
        samples: samples.len(),
    })
}

/// The loudness range and the loud end from 3-second readings taken every second (EBU Tech 3342: readings below -70 LUFS and below 20 LU under the
/// average of the rest are left out; the range is the 95th minus the 10th percentile).
fn short_term_stats(prefix: &[f64], integrated: f64) -> (f64, f64) {
    let window = (SAMPLE_RATE * 3.0) as usize;
    let hop = SAMPLE_RATE as usize;
    let total = prefix.len() - 1;
    if total < window {
        return (0.0, integrated);
    }
    let mut readings: Vec<f64> = (0..=total - window)
        .step_by(hop)
        .map(|s| (prefix[s + window] - prefix[s]) / window as f64)
        .filter(|&e| e > 0.0)
        .map(lufs_of)
        .filter(|&l| l > ABSOLUTE_GATE_LUFS)
        .collect();
    if readings.is_empty() {
        return (0.0, integrated);
    }
    let average = lufs_of(
        readings
            .iter()
            .map(|&l| 10f64.powf((l + 0.691) / 10.0))
            .sum::<f64>()
            / readings.len() as f64,
    );
    readings.retain(|&l| l > average - 20.0);
    readings.sort_by(|a, b| a.partial_cmp(b).unwrap_or(std::cmp::Ordering::Equal));
    let at = |q: f64| readings[((readings.len() - 1) as f64 * q).round() as usize];
    (at(0.95) - at(0.10), at(0.95))
}

/// The gain to play with (dB): the song's own, or its album's when `album_gain` is wanted, never so high that the loudest sample would clip.
pub fn safe_gain_db(loudness: &Loudness) -> f64 {
    if loudness.peak <= 0.0 {
        return loudness.gain_db;
    }
    loudness.gain_db.min(-20.0 * loudness.peak.log10())
}

/// The gain for a whole album: the loudness of all its songs together, so quiet songs stay quieter than loud ones as the artist intended. `parts` are
/// each song's integrated loudness and length in samples.
pub fn album_gain_db(parts: &[(f64, usize)]) -> Option<f64> {
    let total: usize = parts.iter().map(|p| p.1).sum();
    if total == 0 {
        return None;
    }
    // Energy-weighted by length (each song's mean energy is 10^((LUFS + 0.691) / 10)).
    let energy: f64 = parts
        .iter()
        .map(|&(lufs, len)| 10f64.powf((lufs + 0.691) / 10.0) * len as f64)
        .sum::<f64>()
        / total as f64;
    Some(REFERENCE_LUFS - lufs_of(energy))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// `seconds` of a 997 Hz sine with the given peak amplitude (fraction of full scale) in the left and right channels.
    fn sine(seconds: f64, left: f64, right: f64) -> Vec<u32> {
        (0..(seconds * SAMPLE_RATE) as usize)
            .map(|n| {
                let s = (2.0 * std::f64::consts::PI * 997.0 * n as f64 / SAMPLE_RATE).sin();
                let l = (s * left * 32767.0).round() as i16;
                let r = (s * right * 32767.0).round() as i16;
                u32::from(l as u16) | (u32::from(r as u16) << 16)
            })
            .collect()
    }

    fn close(a: f64, b: f64, tolerance: f64) {
        assert!(
            (a - b).abs() <= tolerance,
            "{a} is not within {tolerance} of {b}"
        );
    }

    #[test]
    fn a_full_scale_sine_in_both_channels_reads_about_zero_lufs() {
        // BS.1770: the -0.691 offset is chosen so that a 997 Hz tone gives its level back.
        close(analyze(&sine(6.0, 1.0, 1.0)).unwrap().lufs, 0.0, 0.1);
    }

    #[test]
    fn one_channel_alone_is_three_decibels_quieter() {
        close(analyze(&sine(6.0, 1.0, 0.0)).unwrap().lufs, -3.01, 0.1);
    }

    #[test]
    fn a_quieter_song_reads_lower_by_the_same_amount() {
        let loud = analyze(&sine(6.0, 0.5, 0.5)).unwrap();
        let quiet = analyze(&sine(6.0, 0.05, 0.05)).unwrap();
        close(loud.lufs - quiet.lufs, 20.0, 0.05);
        close(loud.gain_db, REFERENCE_LUFS - loud.lufs, 1e-9);
    }

    #[test]
    fn silence_and_very_short_songs_have_no_loudness() {
        assert_eq!(analyze(&vec![0u32; 44_100 * 5]), None);
        assert_eq!(analyze(&sine(0.2, 0.5, 0.5)), None);
    }

    #[test]
    fn quiet_passages_below_the_gate_do_not_pull_the_average_down() {
        let mut song = sine(8.0, 0.5, 0.5);
        let alone = analyze(&song).unwrap().lufs;
        song.extend(sine(8.0, 0.0005, 0.0005)); // a fade-out far below the relative gate
        close(analyze(&song).unwrap().lufs, alone, 0.2);
    }

    #[test]
    fn a_louder_song_is_turned_down_but_never_into_clipping() {
        let loud = analyze(&sine(6.0, 0.9, 0.9)).unwrap();
        assert!(loud.gain_db < 0.0);
        let quiet = analyze(&sine(6.0, 0.02, 0.02)).unwrap();
        assert!(quiet.gain_db > 10.0);
        // Raising a quiet song with a high peak must stop at full scale.
        let peaky = Loudness {
            lufs: -30.0,
            peak: 0.9,
            gain_db: 12.0,
            range_lu: 3.0,
            loud_end_lufs: -27.0,
            samples: 1,
        };
        close(safe_gain_db(&peaky), -20.0 * 0.9f64.log10(), 1e-9);
        close(safe_gain_db(&loud), loud.gain_db, 1e-9);
    }

    #[test]
    fn an_album_is_measured_together() {
        // Two equally long songs, 10 LU apart: the album sits between them, nearer the loud one.
        let gain = album_gain_db(&[(-14.0, 1_000_000), (-24.0, 1_000_000)]).unwrap();
        assert!(gain < REFERENCE_LUFS - (-24.0) && gain > REFERENCE_LUFS - (-14.0));
        close(gain, REFERENCE_LUFS - (-16.6), 0.05);
        assert_eq!(album_gain_db(&[]), None);
    }
}
