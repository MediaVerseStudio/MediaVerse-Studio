//! The two models: vocal separation (Demucs's neural core, ONNX) and the letter reader (the aligner network, ONNX), run through ONNX Runtime.
//! ONNX Runtime is loaded from a file at run time (`init`); which processor runs a model is a choice of `Provider`.

use crate::dsp::{Transforms, resample};
use crate::seamless::{FEATURES, Frontend};
use ort::session::Session;
use ort::value::Tensor;
use std::path::Path;

/// Where a model runs.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Provider {
    /// The processor: works everywhere, slower.
    Cpu,
    /// An NVIDIA graphics card through CUDA (needs the CUDA libraries beside ONNX Runtime): the fastest.
    Cuda,
    /// Any graphics card through DirectML (right for the letter reader; wrong output for the separator, so not offered for it).
    DirectMl,
}

/// Loads ONNX Runtime from `library` (the `onnxruntime.dll` of the download). Call once, before any model is loaded.
pub fn init(library: &Path) -> Result<(), String> {
    ort::init_from(library.to_string_lossy().to_string())
        .commit()
        .map_err(|e| {
            format!(
                "ONNX Runtime could not be loaded from {}: {e}",
                library.display()
            )
        })?;
    Ok(())
}

/// A session for `model` on `provider` (shared by the readers and Whisper).
pub(crate) fn session_for(model: &Path, provider: Provider) -> Result<Session, String> {
    session(model, provider)
}

fn session(model: &Path, provider: Provider) -> Result<Session, String> {
    use ort::execution_providers::{CUDAExecutionProvider, DirectMLExecutionProvider};
    let mut builder = Session::builder().map_err(|e| e.to_string())?;
    builder = match provider {
        Provider::Cpu => builder,
        Provider::Cuda => builder
            .with_execution_providers([CUDAExecutionProvider::default().build().error_on_failure()])
            .map_err(|e| e.to_string())?,
        Provider::DirectMl => builder
            .with_execution_providers([DirectMLExecutionProvider::default()
                .build()
                .error_on_failure()])
            .and_then(|b| b.with_memory_pattern(false))
            .map_err(|e| e.to_string())?,
    };
    builder
        .commit_from_file(model)
        .map_err(|e| format!("{}: {e}", model.display()))
}

/// Mean and standard deviation (N-1, like PyTorch's) of a signal.
fn mean_std(x: &[f32]) -> (f32, f32) {
    let n = x.len().max(1) as f64;
    let mean = x.iter().map(|&v| f64::from(v)).sum::<f64>() / n;
    let var = x
        .iter()
        .map(|&v| (f64::from(v) - mean).powi(2))
        .sum::<f64>()
        / (n - 1.0).max(1.0);
    (mean as f32, var.sqrt() as f32)
}

pub struct Separator {
    session: Session,
    transforms: Transforms,
}

impl Separator {
    /// Samples in one window of the exported network (7.8 s at 44.1 kHz).
    pub const SEGMENT: usize = 343_980;
    const OVERLAP: f64 = 0.25;
    /// The vocals are the fourth source of htdemucs (drums, bass, other, vocals).
    const VOCALS: usize = 3;

    pub fn load(model: &Path, provider: Provider) -> Result<Self, String> {
        Ok(Separator {
            session: session(model, provider)?,
            transforms: Transforms::default(),
        })
    }

    /// The vocals of a stereo 44.1 kHz song, as the same two channels. `progress` is called with the share done (0 to 1).
    pub fn vocals(
        &mut self,
        left: &[f32],
        right: &[f32],
        mut progress: impl FnMut(f32),
    ) -> Result<[Vec<f32>; 2], String> {
        let length = left.len();
        if right.len() != length || length == 0 {
            return Err("the two channels differ in length".to_owned());
        }
        // like the demucs command: the song is normalised by the mean and spread of its mono mix
        let mono: Vec<f32> = left.iter().zip(right).map(|(a, b)| (a + b) / 2.0).collect();
        let (mean, std) = mean_std(&mono);
        let norm =
            |x: &[f32]| -> Vec<f32> { x.iter().map(|v| (v - mean) / (std + 1e-8)).collect() };
        let (l, r) = (norm(left), norm(right));
        let seg = Self::SEGMENT;
        let stride = ((1.0 - Self::OVERLAP) * seg as f64) as usize;
        let weight: Vec<f32> = {
            let mut w: Vec<f32> = (1..=seg / 2).map(|i| i as f32).collect();
            w.extend((1..=seg - seg / 2).rev().map(|i| i as f32));
            let top = w.iter().cloned().fold(0.0, f32::max);
            w.into_iter().map(|v| v / top).collect()
        };
        let mut out = [vec![0f32; length], vec![0f32; length]];
        let mut sum_weight = vec![0f32; length];
        let offsets: Vec<usize> = (0..length).step_by(stride).collect();
        for (n, &offset) in offsets.iter().enumerate() {
            let take = seg.min(length - offset);
            let mut chunk = [vec![0f32; seg], vec![0f32; seg]];
            chunk[0][..take].copy_from_slice(&l[offset..offset + take]);
            chunk[1][..take].copy_from_slice(&r[offset..offset + take]);
            let vocals = self.run_window(&chunk)?;
            for c in 0..2 {
                for i in 0..take {
                    out[c][offset + i] += weight[i] * vocals[c][i];
                }
            }
            for i in 0..take {
                sum_weight[offset + i] += weight[i];
            }
            progress((n + 1) as f32 / offsets.len() as f32);
        }
        for c in 0..2 {
            for i in 0..length {
                out[c][i] = out[c][i] / sum_weight[i] * (std + 1e-8) + mean;
            }
        }
        Ok(out)
    }

    /// One window through the network: the vocals of `SEGMENT` samples per channel.
    fn run_window(&mut self, chunk: &[Vec<f32>; 2]) -> Result<[Vec<f32>; 2], String> {
        let seg = Self::SEGMENT;
        let spec = self.transforms.spec(&[&chunk[0], &chunk[1]]);
        let cac = Transforms::cac(&spec);
        let mut mix = Vec::with_capacity(2 * seg);
        mix.extend_from_slice(&chunk[0]);
        mix.extend_from_slice(&chunk[1]);
        let mix = Tensor::from_array(([1usize, 2, seg], mix)).map_err(|e| e.to_string())?;
        let cac = Tensor::from_array(([1usize, 4, spec.freqs, spec.frames], cac))
            .map_err(|e| e.to_string())?;
        let outputs = self
            .session
            .run(ort::inputs!["mix" => mix, "cac" => cac])
            .map_err(|e| e.to_string())?;
        let (_, freq) = outputs["freq"]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;
        let (_, time) = outputs["time"]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;
        // the frequency branch of the vocals: planes 4 * freqs * frames, starting at source 3
        let plane = 4 * spec.freqs * spec.frames;
        let planes = &freq[Self::VOCALS * plane..(Self::VOCALS + 1) * plane];
        let mut audio = self
            .transforms
            .ispec(planes, 2, spec.freqs, spec.frames, seg);
        let time_branch = &time[Self::VOCALS * 2 * seg..(Self::VOCALS + 1) * 2 * seg];
        for (c, channel) in audio.iter_mut().enumerate() {
            for (i, v) in channel.iter_mut().enumerate() {
                *v += time_branch[c * seg + i];
            }
        }
        let [a, b]: [Vec<f32>; 2] = audio
            .try_into()
            .map_err(|_| "the separator gave the wrong number of channels".to_owned())?;
        Ok([a, b])
    }
}

/// The letter odds for a song: `frames x classes` log-probabilities, one frame per 20 ms.
pub struct Letters {
    pub data: Vec<f32>,
    pub frames: usize,
    pub classes: usize,
}

pub struct Reader {
    session: Session,
}

impl Reader {
    pub fn load(model: &Path, provider: Provider) -> Result<Self, String> {
        Ok(Reader {
            session: session(model, provider)?,
        })
    }

    /// Reads 16 kHz mono audio in 24 s windows that overlap by 2 s on each side (their middles are joined), so memory stays small.
    pub fn letters(&mut self, audio: &[f32]) -> Result<Letters, String> {
        const RATE: usize = 16_000;
        let (window, hop) = (24 * RATE, 20 * RATE);
        let margin = (window - hop) / 2;
        let total = audio.len();
        let mut data: Vec<f32> = Vec::new();
        let mut classes;
        let mut start: usize = 0;
        loop {
            let lo = start.saturating_sub(margin);
            let hi = total.min(start + hop + margin);
            let (mean, std) = mean_std(&audio[lo..hi]);
            let chunk: Vec<f32> = audio[lo..hi]
                .iter()
                .map(|v| (v - mean) / (std + 1e-7))
                .collect();
            let input =
                Tensor::from_array(([1usize, chunk.len()], chunk)).map_err(|e| e.to_string())?;
            let outputs = self
                .session
                .run(ort::inputs!["audio" => input])
                .map_err(|e| e.to_string())?;
            let (shape, out) = outputs["letters"]
                .try_extract_tensor::<f32>()
                .map_err(|e| e.to_string())?;
            let frames = shape[1] as usize;
            classes = shape[2] as usize;
            let first = if start > 0 {
                (((start - lo) as f64 / RATE as f64 / 0.02).round() as usize).min(frames)
            } else {
                0
            };
            let keep = (hop as f64 / RATE as f64 / 0.02).round() as usize;
            let end = if hi < total {
                (first + keep).min(frames)
            } else {
                frames
            };
            data.extend_from_slice(&out[first * classes..end * classes]);
            start += hop;
            if start >= total {
                break;
            }
        }
        Ok(Letters {
            frames: data.len() / classes.max(1),
            data,
            classes,
        })
    }
}

/// The music-lyrics reader (a w2v-BERT 2.0 CTC model in ONNX, e.g. `mrfakename/w2v-bert-2.0-music-lyrics-ctc`): it reads the full mix, no vocal separation. Its
/// input is the Seamless-style filter-bank features of `crate::seamless`; its output is the same `Letters` as the other reader, one frame per 20 ms.
pub struct BertReader {
    session: Session,
    frontend: Frontend,
}

impl BertReader {
    pub fn load(model: &Path, provider: Provider) -> Result<Self, String> {
        Ok(BertReader {
            session: session(model, provider)?,
            frontend: Frontend::new(),
        })
    }

    /// Reads a whole song (16 kHz mono) in 30 s windows with 2 s of context on each side (the model was trained on windows up to 30 s): features per window,
    /// the middle 26 s of each kept and joined.
    pub fn letters(&mut self, audio: &[f32]) -> Result<Letters, String> {
        const RATE: usize = 16_000;
        const CONTEXT: usize = 2 * RATE;
        const KEEP: usize = 26 * RATE;
        let mut data: Vec<f32> = Vec::new();
        let mut classes = 0usize;
        let mut start = 0usize;
        while start < audio.len() {
            let lo = start.saturating_sub(CONTEXT);
            let hi = audio.len().min(start + KEEP + CONTEXT);
            let (features, rows) = self.frontend.features(&audio[lo..hi]);
            if rows == 0 {
                break;
            }
            let input = Tensor::from_array(([1usize, rows, FEATURES], features))
                .map_err(|e| e.to_string())?;
            let mask = Tensor::from_array(([1usize, rows], vec![1i64; rows]))
                .map_err(|e| e.to_string())?;
            let outputs = self
                .session
                .run(ort::inputs!["features" => input, "attention_mask" => mask])
                .map_err(|e| e.to_string())?;
            let (shape, out) = outputs["log_probs"]
                .try_extract_tensor::<f32>()
                .map_err(|e| e.to_string())?;
            let frames = shape[1] as usize;
            classes = shape[2] as usize;
            // The last window can be only a little longer than its context, so the model may return fewer frames than the context alone would give: clamp, or the
            // slice below starts past the end (found 2026-11-20 on a song whose length left under 20 ms after the last full window).
            let first = (((start - lo) as f64 / RATE as f64 / 0.02).round() as usize).min(frames);
            let want = (KEEP.min(audio.len() - start) as f64 / RATE as f64 / 0.02).round() as usize;
            let end = (first + want).min(frames);
            data.extend_from_slice(&out[first * classes..end * classes]);
            start += KEEP;
        }
        Ok(Letters {
            frames: data.len() / classes.max(1),
            data,
            classes,
        })
    }
}

/// A song's vocals as the letter reader wants them: the two channels averaged and brought to 16 kHz.
pub fn to_reader_audio(vocals: &[Vec<f32>; 2]) -> Vec<f32> {
    let mono: Vec<f32> = vocals[0]
        .iter()
        .zip(&vocals[1])
        .map(|(a, b)| (a + b) / 2.0)
        .collect();
    resample(&mono, 44_100, 16_000)
}
