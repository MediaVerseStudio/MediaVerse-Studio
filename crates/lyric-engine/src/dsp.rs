//! Signal processing around the models: a band-limited resampler (the same method and settings as torchaudio's default) and the spectrogram
//! transforms that Demucs does outside its neural network (STFT before it, mask and inverse STFT after it).

use rustfft::{FftPlanner, num_complex::Complex32};
use std::f32::consts::PI;
use std::sync::Arc;

fn gcd(a: u64, b: u64) -> u64 {
    if b == 0 { a } else { gcd(b, a % b) }
}

/// Resamples `input` from `from` to `to` Hz (windowed sinc, Hann window, filter width 6, roll-off 0.99: torchaudio's `resample` defaults).
pub fn resample(input: &[f32], from: u32, to: u32) -> Vec<f32> {
    if from == to || input.is_empty() {
        return input.to_vec();
    }
    let g = gcd(u64::from(from), u64::from(to));
    let (orig, new) = ((u64::from(from) / g) as usize, (u64::from(to) / g) as usize);
    let (lowpass_width, rolloff) = (6.0f64, 0.99f64);
    let base = orig.min(new) as f64 * rolloff;
    let width = (lowpass_width * orig as f64 / base).ceil() as usize;
    let taps = 2 * width + orig;
    // kernels[phase][tap]
    let mut kernels = vec![0f32; new * taps];
    for phase in 0..new {
        for tap in 0..taps {
            let idx = (tap as f64 - width as f64) / orig as f64;
            let mut t = (-(phase as f64) / new as f64 + idx) * base;
            t = t.clamp(-lowpass_width, lowpass_width);
            let window = (t * std::f64::consts::PI / lowpass_width / 2.0)
                .cos()
                .powi(2);
            let x = t * std::f64::consts::PI;
            let sinc = if x == 0.0 { 1.0 } else { x.sin() / x };
            kernels[phase * taps + tap] = (sinc * window * base / orig as f64) as f32;
        }
    }
    let out_len = (new * input.len()).div_ceil(orig);
    let mut out = vec![0f32; out_len];
    for (m, slot) in out.iter_mut().enumerate() {
        let (block, phase) = (m / new, m % new);
        let start = (block * orig) as isize - width as isize; // index into the input of tap 0
        let kernel = &kernels[phase * taps..(phase + 1) * taps];
        let mut sum = 0f32;
        for (tap, k) in kernel.iter().enumerate() {
            let at = start + tap as isize;
            if at >= 0 && (at as usize) < input.len() {
                sum += k * input[at as usize];
            }
        }
        *slot = sum;
    }
    out
}

/// Demucs's transform: window 4096, hop 1024.
pub const N_FFT: usize = 4096;
pub const HOP: usize = N_FFT / 4;

fn hann(n: usize) -> Vec<f32> {
    // periodic, like torch.hann_window
    (0..n)
        .map(|i| 0.5 - 0.5 * (2.0 * PI * i as f32 / n as f32).cos())
        .collect()
}

fn reflect_pad(x: &[f32], left: usize, right: usize) -> Vec<f32> {
    let n = x.len() as isize;
    let at = |i: isize| -> f32 {
        let mut j = i;
        while j < 0 || j >= n {
            if j < 0 {
                j = -j;
            }
            if j >= n {
                j = 2 * (n - 1) - j;
            }
        }
        x[j as usize]
    };
    (-(left as isize)..n + right as isize).map(at).collect()
}

/// The shape of a spectrogram in the form the Demucs network takes ("complex as channels"): `channels * 2` planes of `freqs x frames`.
pub struct Spectrogram {
    pub channels: usize,
    pub freqs: usize,
    pub frames: usize,
    /// `[channel][freq][frame]` real and imaginary parts, as complex numbers.
    pub data: Vec<Complex32>,
}

pub struct Transforms {
    forward: Arc<dyn rustfft::Fft<f32>>,
    inverse: Arc<dyn rustfft::Fft<f32>>,
    window: Vec<f32>,
}

impl Default for Transforms {
    fn default() -> Self {
        let mut planner = FftPlanner::new();
        Transforms {
            forward: planner.plan_fft_forward(N_FFT),
            inverse: planner.plan_fft_inverse(N_FFT),
            window: hann(N_FFT),
        }
    }
}

impl Transforms {
    /// `HTDemucs._spec` for each channel: the spectrogram of `length` samples, `2048` frequencies and `ceil(length / 1024)` frames.
    pub fn spec(&self, channels: &[&[f32]]) -> Spectrogram {
        let length = channels[0].len();
        let le = length.div_ceil(HOP);
        let pad = HOP / 2 * 3;
        let freqs = N_FFT / 2; // the top bin is dropped
        let mut data = vec![Complex32::new(0.0, 0.0); channels.len() * freqs * le];
        let scale = 1.0 / (N_FFT as f32).sqrt(); // normalized=True
        let mut buffer = vec![Complex32::new(0.0, 0.0); N_FFT];
        for (c, x) in channels.iter().enumerate() {
            let padded = reflect_pad(x, pad, pad + le * HOP - length);
            let centred = reflect_pad(&padded, N_FFT / 2, N_FFT / 2);
            // torch.stft frames: 1 + len / hop; the network wants frames 2 .. 2 + le
            for frame in 0..le {
                let at = (frame + 2) * HOP;
                for i in 0..N_FFT {
                    buffer[i] = Complex32::new(centred[at + i] * self.window[i], 0.0);
                }
                self.forward.process(&mut buffer);
                for f in 0..freqs {
                    data[(c * freqs + f) * le + frame] = buffer[f] * scale;
                }
            }
        }
        Spectrogram {
            channels: channels.len(),
            freqs,
            frames: le,
            data,
        }
    }

    /// `HTDemucs._magnitude` with complex-as-channels: planes in the order channel 0 real, channel 0 imaginary, channel 1 real, ...; `freqs x frames` each.
    pub fn cac(spec: &Spectrogram) -> Vec<f32> {
        let plane = spec.freqs * spec.frames;
        let mut out = vec![0f32; spec.channels * 2 * plane];
        for c in 0..spec.channels {
            for i in 0..plane {
                let z = spec.data[c * plane + i];
                out[(2 * c) * plane + i] = z.re;
                out[(2 * c + 1) * plane + i] = z.im;
            }
        }
        out
    }

    /// `HTDemucs._ispec` of one source: the network's output planes (`channels * 2` planes of `freqs x frames`) back to `length` samples per channel.
    pub fn ispec(
        &self,
        planes: &[f32],
        channels: usize,
        freqs: usize,
        frames: usize,
        length: usize,
    ) -> Vec<Vec<f32>> {
        let plane = freqs * frames;
        let hl = HOP;
        let pad = hl / 2 * 3;
        let total = hl * length.div_ceil(hl) + 2 * pad;
        let scale = (N_FFT as f32).sqrt(); // normalized=True, inverse
        let full_frames = frames + 4; // two empty frames on each side
        let mut result = Vec::with_capacity(channels);
        let mut buffer = vec![Complex32::new(0.0, 0.0); N_FFT];
        for c in 0..channels {
            let mut output = vec![0f32; hl * (full_frames - 1) + N_FFT];
            let mut envelope = vec![0f32; output.len()];
            for frame in 0..full_frames {
                let source = frame as isize - 2;
                buffer.fill(Complex32::new(0.0, 0.0));
                if (0..frames as isize).contains(&source) {
                    let source = source as usize;
                    for f in 0..freqs {
                        let (re, im) = (
                            planes[(2 * c) * plane + f * frames + source],
                            planes[(2 * c + 1) * plane + f * frames + source],
                        );
                        buffer[f] = Complex32::new(re, im);
                    }
                    // the top bin (2048) was dropped and put back as zero; bins above mirror the lower ones
                    buffer[0].im = 0.0;
                    for f in 1..N_FFT / 2 {
                        buffer[N_FFT - f] = buffer[f].conj();
                    }
                    buffer[N_FFT / 2] = Complex32::new(0.0, 0.0);
                    self.inverse.process(&mut buffer);
                }
                let at = frame * hl;
                for i in 0..N_FFT {
                    let w = self.window[i];
                    output[at + i] += buffer[i].re / N_FFT as f32 * scale * w;
                    envelope[at + i] += w * w;
                }
            }
            // torch.istft: divide by the window envelope, drop the centring pad, cut to the wanted length
            let trimmed: Vec<f32> = (N_FFT / 2..N_FFT / 2 + total)
                .map(|i| {
                    if envelope[i] > 1e-11 {
                        output[i] / envelope[i]
                    } else {
                        output[i]
                    }
                })
                .collect();
            result.push(trimmed[pad..pad + length].to_vec());
        }
        result
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tone(length: usize, rate: f32, hz: f32) -> Vec<f32> {
        (0..length)
            .map(|i| (2.0 * PI * hz * i as f32 / rate).sin() * 0.5)
            .collect()
    }

    #[test]
    fn resampling_keeps_a_tone_and_the_right_length() {
        let x = tone(44_100, 44_100.0, 440.0);
        let y = resample(&x, 44_100, 16_000);
        assert_eq!(y.len(), 16_000);
        let z = tone(16_000, 16_000.0, 440.0);
        let error: f32 = y[200..15_800]
            .iter()
            .zip(&z[200..15_800])
            .map(|(a, b)| (a - b).abs())
            .fold(0.0, f32::max);
        assert!(error < 0.01, "{error}");
        assert_eq!(resample(&x, 44_100, 44_100), x);
        assert_eq!(
            resample(&x, 48_000, 44_100).len(),
            (147 * 44_100usize).div_ceil(160)
        );
    }

    #[test]
    fn spectrogram_and_back_gives_the_signal_again() {
        let t = Transforms::default();
        let length = 20_000;
        let left = tone(length, 44_100.0, 330.0);
        // a second channel of several tones (noise would put energy into the top bin that the transform drops)
        let (a, b, c) = (
            tone(length, 44_100.0, 1000.0),
            tone(length, 44_100.0, 5000.0),
            tone(length, 44_100.0, 12_000.0),
        );
        let right: Vec<f32> = (0..length).map(|i| (a[i] + b[i] + c[i]) / 2.0).collect();
        let spec = t.spec(&[&left, &right]);
        assert_eq!((spec.freqs, spec.frames), (2048, length.div_ceil(1024)));
        let planes = Transforms::cac(&spec);
        let back = t.ispec(&planes, 2, spec.freqs, spec.frames, length);
        // the top frequency bin is dropped by the model's transform, so the match is close, not perfect
        for (original, again) in [(&left, &back[0]), (&right, &back[1])] {
            // The edges are not exact (the transform drops the top bin and reflects the ends; Demucs's own does the same, see
            // tests/dsp_golden.rs for the exact comparison): the middle of the signal must come back.
            let err: f32 = original[3000..length - 3000]
                .iter()
                .zip(&again[3000..length - 3000])
                .map(|(a, b)| (a - b).abs())
                .fold(0.0, f32::max);
            assert!(err < 0.02, "{err}");
        }
    }
}
