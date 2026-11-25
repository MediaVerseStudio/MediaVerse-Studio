//! The audio front end of the w2v-BERT 2.0 music-lyrics models (`mrfakename/w2v-bert-2.0-music-lyrics-ctc`, `radiant-lyrics/sylla-600m-v1`): the same
//! features as `SeamlessM4TFeatureExtractor` in transformers (which uses Kaldi-style filter banks), written in Rust so the program needs no Python.
//!
//! For 16 kHz mono audio in the range -1 to 1: scale by 2^15; frames of 400 samples every 160 (a frame is dropped when it would run past the end);
//! per frame remove the mean, pre-emphasise (0.97), multiply by the Povey window (a Hann window to the power 0.85), zero-pad to 512 and take the power
//! spectrum; 80 triangular mel filters from 20 Hz to 8 kHz (Kaldi's mel scale, 1127 ln(1 + f/700)); the natural log with a floor; each mel bin then
//! normalised over the whole window to mean 0 and variance 1 (sample variance + 1e-7); finally two consecutive frames are joined, giving 160 numbers
//! every 20 ms (an odd last frame is dropped).
//! Tested against the exporter's golden file (`tests/fixtures/frontend-golden.json`, MIT, from redbaty/ytm-lyrics-aligner).

use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::sync::Arc;

pub const SAMPLE_RATE: usize = 16_000;
const FRAME: usize = 400;
const HOP: usize = 160;
const FFT_SIZE: usize = 512;
pub const MEL_BINS: usize = 80;
/// Numbers per output frame: two mel frames joined.
pub const FEATURES: usize = 2 * MEL_BINS;
const LOG_FLOOR: f64 = 1.192_092_9e-7;

fn mel_scale(hertz: f64) -> f64 {
    1127.0 * (1.0 + hertz / 700.0).ln()
}

pub struct Frontend {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    /// `MEL_BINS` filters over the `FFT_SIZE / 2 + 1` bins of the power spectrum.
    bank: Vec<Vec<f32>>,
}

impl Default for Frontend {
    fn default() -> Self {
        Self::new()
    }
}

impl Frontend {
    pub fn new() -> Self {
        let fft = FftPlanner::<f32>::new().plan_fft_forward(FFT_SIZE);
        // Povey window: Hann (not periodic) to the power 0.85.
        let window = (0..FRAME)
            .map(|n| {
                let hann = 0.5
                    - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / (FRAME as f64 - 1.0)).cos();
                hann.powf(0.85) as f32
            })
            .collect();
        let (low, high) = (mel_scale(20.0), mel_scale(SAMPLE_RATE as f64 / 2.0));
        let delta = (high - low) / (MEL_BINS as f64 + 1.0);
        let bin_width = SAMPLE_RATE as f64 / FFT_SIZE as f64;
        let bank = (0..MEL_BINS)
            .map(|b| {
                let (left, centre, right) = (
                    low + b as f64 * delta,
                    low + (b as f64 + 1.0) * delta,
                    low + (b as f64 + 2.0) * delta,
                );
                // 256 bins; the Nyquist bin gets weight 0 (Kaldi pads a zero column).
                (0..=FFT_SIZE / 2)
                    .map(|i| {
                        if i == FFT_SIZE / 2 {
                            return 0.0;
                        }
                        let mel = mel_scale(bin_width * i as f64);
                        let (up, down) = (
                            (mel - left) / (centre - left),
                            (right - mel) / (right - centre),
                        );
                        up.min(down).max(0.0) as f32
                    })
                    .collect()
            })
            .collect();
        Frontend { fft, window, bank }
    }

    /// The log mel frames of `audio`: `frames x MEL_BINS`, not yet normalised. `None` when the audio is shorter than one frame.
    fn log_mel(&self, audio: &[f32]) -> Option<Vec<f64>> {
        if audio.len() < FRAME {
            return None;
        }
        let frames = 1 + (audio.len() - FRAME) / HOP;
        let mut out = Vec::with_capacity(frames * MEL_BINS);
        let mut buffer = vec![Complex::new(0.0f32, 0.0); FFT_SIZE];
        let mut frame = [0.0f32; FRAME];
        for f in 0..frames {
            let start = f * HOP;
            let mut mean = 0.0f64;
            for (n, sample) in frame.iter_mut().enumerate() {
                *sample = audio[start + n] * 32_768.0;
                mean += f64::from(*sample);
            }
            let mean = (mean / FRAME as f64) as f32;
            for sample in &mut frame {
                *sample -= mean;
            }
            // Pre-emphasis; the sample before the first is the first itself.
            let mut previous = frame[0];
            for (n, sample) in frame.iter_mut().enumerate() {
                let current = *sample;
                *sample = current - 0.97 * previous;
                previous = current;
                let _ = n;
            }
            for (n, slot) in buffer.iter_mut().enumerate() {
                *slot = Complex::new(
                    if n < FRAME {
                        frame[n] * self.window[n]
                    } else {
                        0.0
                    },
                    0.0,
                );
            }
            self.fft.process(&mut buffer);
            let power: Vec<f32> = buffer[..=FFT_SIZE / 2]
                .iter()
                .map(Complex::norm_sqr)
                .collect();
            for filter in &self.bank {
                let energy: f64 = filter
                    .iter()
                    .zip(&power)
                    .map(|(w, p)| f64::from(*w) * f64::from(*p))
                    .sum();
                out.push(energy.max(LOG_FLOOR).ln());
            }
        }
        Some(out)
    }

    /// The model's input for one window of audio: `(rows x FEATURES numbers, rows)`; at most about 30 s of audio is meant to be given at a time.
    /// Empty when the audio is too short.
    pub fn features(&self, audio: &[f32]) -> (Vec<f32>, usize) {
        let Some(mel) = self.log_mel(audio) else {
            return (Vec::new(), 0);
        };
        let frames = mel.len() / MEL_BINS;
        // Each mel bin to mean 0 and sample variance 1 over the window.
        let mut normalised = mel;
        if frames > 1 {
            for bin in 0..MEL_BINS {
                let mean = (0..frames)
                    .map(|f| normalised[f * MEL_BINS + bin])
                    .sum::<f64>()
                    / frames as f64;
                let variance = (0..frames)
                    .map(|f| (normalised[f * MEL_BINS + bin] - mean).powi(2))
                    .sum::<f64>()
                    / (frames as f64 - 1.0);
                let scale = 1.0 / (variance + 1e-7).sqrt();
                for f in 0..frames {
                    let at = f * MEL_BINS + bin;
                    normalised[at] = (normalised[at] - mean) * scale;
                }
            }
        }
        let rows = frames / 2;
        let features: Vec<f32> = normalised[..rows * FEATURES]
            .iter()
            .map(|v| *v as f32)
            .collect();
        (features, rows)
    }
}
