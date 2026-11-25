//! Whisper (OpenAI, MIT licence) run through ONNX Runtime: a rough draft of the words of a song nobody has lyrics for (docs/lyric-models.md). The model is the
//! `onnx-community/whisper-large-v3-turbo` export (fp16 encoder and merged decoder with a key/value cache); nothing of it is part of the program, it is a separate
//! download. Greedy decoding in 30 s windows, English, no timestamps; the words are timed afterwards by the music reader's aligner.
//!
//! Measured on 40 library songs against their true lyrics (`judge-lab/whisper_onnx.py`): median word error 32% on the plain mix, about 110 times real time on an
//! RTX 4090, and how well the draft fits the singing (the same fit score the matching uses) predicts its errors (correlation -0.88): at -0.5 or better about 20%
//! of the words are wrong, below -1.5 most are.

use ort::session::Session;
use ort::value::{DynValue, Tensor};
use rustfft::num_complex::Complex;
use rustfft::{Fft, FftPlanner};
use std::path::{Path, PathBuf};
use std::sync::Arc;

pub const SAMPLE_RATE: usize = 16_000;
const N_FFT: usize = 400;
const HOP: usize = 160;
const WINDOW_SAMPLES: usize = 30 * SAMPLE_RATE;
pub const MELS: usize = 128;
pub const FRAMES: usize = 3000;
const BINS: usize = N_FFT / 2 + 1;
const HEADS: usize = 20;
const HEAD_DIM: usize = 64;
const MAX_TOKENS: usize = 224;

/// Slaney's mel scale (what librosa and Whisper use): linear below 1 kHz, logarithmic above.
fn hertz_to_mel(hertz: f64) -> f64 {
    let (f_sp, min_log_hz) = (200.0 / 3.0, 1000.0);
    let min_log_mel = min_log_hz / f_sp;
    let log_step = (6.4f64).ln() / 27.0;
    if hertz >= min_log_hz {
        min_log_mel + (hertz / min_log_hz).ln() / log_step
    } else {
        hertz / f_sp
    }
}

fn mel_to_hertz(mel: f64) -> f64 {
    let (f_sp, min_log_hz) = (200.0 / 3.0, 1000.0);
    let min_log_mel = min_log_hz / f_sp;
    let log_step = (6.4f64).ln() / 27.0;
    if mel >= min_log_mel {
        min_log_hz * (log_step * (mel - min_log_mel)).exp()
    } else {
        f_sp * mel
    }
}

/// The triangular mel filters of Whisper: `MELS` x `BINS`, Slaney-normalised.
pub fn mel_filters() -> Vec<f32> {
    let freqs: Vec<f64> = (0..BINS)
        .map(|i| i as f64 * (SAMPLE_RATE as f64 / 2.0) / (BINS as f64 - 1.0))
        .collect();
    let (low, high) = (hertz_to_mel(0.0), hertz_to_mel(SAMPLE_RATE as f64 / 2.0));
    let points: Vec<f64> = (0..MELS + 2)
        .map(|i| mel_to_hertz(low + (high - low) * i as f64 / (MELS as f64 + 1.0)))
        .collect();
    let mut bank = vec![0.0f32; MELS * BINS];
    for m in 0..MELS {
        let (left, centre, right) = (points[m], points[m + 1], points[m + 2]);
        let norm = 2.0 / (right - left);
        for (i, f) in freqs.iter().enumerate() {
            let (up, down) = ((f - left) / (centre - left), (right - f) / (right - centre));
            bank[m * BINS + i] = (up.min(down).max(0.0) * norm) as f32;
        }
    }
    bank
}

/// The log-mel front end: `MELS x FRAMES` numbers (mel-major) for one window of audio of at most 30 s (padded with silence).
pub struct Mel {
    fft: Arc<dyn Fft<f32>>,
    window: Vec<f32>,
    bank: Vec<f32>,
}

impl Default for Mel {
    fn default() -> Self {
        Self::new()
    }
}

impl Mel {
    pub fn new() -> Self {
        let fft = FftPlanner::<f32>::new().plan_fft_forward(N_FFT);
        // A periodic Hann window.
        let window = (0..N_FFT)
            .map(|n| {
                (0.5 - 0.5 * (2.0 * std::f64::consts::PI * n as f64 / N_FFT as f64).cos()) as f32
            })
            .collect();
        Mel {
            fft,
            window,
            bank: mel_filters(),
        }
    }

    pub fn log_mel(&self, audio: &[f32]) -> Vec<f32> {
        // To exactly 30 s, then reflected by half a frame at both ends (a centred transform).
        let mut samples = audio[..audio.len().min(WINDOW_SAMPLES)].to_vec();
        samples.resize(WINDOW_SAMPLES, 0.0);
        let pad = N_FFT / 2;
        let mut padded = Vec::with_capacity(WINDOW_SAMPLES + 2 * pad);
        padded.extend((1..=pad).rev().map(|i| samples[i]));
        padded.extend_from_slice(&samples);
        padded.extend((0..pad).map(|i| samples[WINDOW_SAMPLES - 2 - i]));
        let mut log = vec![0.0f32; MELS * FRAMES];
        let mut buffer = vec![Complex::new(0.0f32, 0.0); N_FFT];
        let mut power = [0.0f32; BINS];
        for t in 0..FRAMES {
            for (n, slot) in buffer.iter_mut().enumerate() {
                *slot = Complex::new(padded[t * HOP + n] * self.window[n], 0.0);
            }
            self.fft.process(&mut buffer);
            for (b, p) in power.iter_mut().enumerate() {
                *p = buffer[b].norm_sqr();
            }
            for m in 0..MELS {
                let filter = &self.bank[m * BINS..(m + 1) * BINS];
                let energy: f64 = filter
                    .iter()
                    .zip(power.iter())
                    .map(|(w, p)| f64::from(*w) * f64::from(*p))
                    .sum();
                log[m * FRAMES + t] = energy.max(1e-10).log10() as f32;
            }
        }
        // Nothing lower than 8 below the loudest, then into about -1 to 1.
        let loudest = log.iter().cloned().fold(f32::NEG_INFINITY, f32::max);
        for v in &mut log {
            *v = (v.max(loudest - 8.0) + 4.0) / 4.0;
        }
        log
    }
}

/// What Whisper's tokens are in bytes (GPT-2's byte-level BPE), to turn ids back into text. Only decoding is needed: the prompt is given as ids.
struct Vocabulary {
    bytes: Vec<Vec<u8>>,
}

impl Vocabulary {
    fn load(vocab: &Path) -> Result<Self, String> {
        let json: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(vocab).map_err(|e| format!("{}: {e}", vocab.display()))?,
        )
        .map_err(|e| e.to_string())?;
        let object = json
            .as_object()
            .ok_or("the vocabulary is not a list of tokens")?;
        // GPT-2's printable stand-ins for the 256 byte values.
        let mut printable: Vec<u32> = (b'!'..=b'~')
            .map(u32::from)
            .chain(0xA1..=0xAC)
            .chain(0xAE..=0xFF)
            .collect();
        let mut stand_in: std::collections::HashMap<char, u8> = printable
            .iter()
            .map(|&c| (char::from_u32(c).unwrap(), c as u8))
            .collect();
        let mut next = 0u32;
        for byte in 0..=255u32 {
            if !printable.contains(&byte) {
                printable.push(byte);
                stand_in.insert(char::from_u32(256 + next).unwrap(), byte as u8);
                next += 1;
            }
        }
        let size = object
            .values()
            .filter_map(serde_json::Value::as_u64)
            .max()
            .ok_or("the vocabulary is empty")? as usize
            + 1;
        let mut bytes = vec![Vec::new(); size];
        for (token, id) in object {
            let id = id.as_u64().ok_or("a token number is not a number")? as usize;
            bytes[id] = token
                .chars()
                .filter_map(|c| stand_in.get(&c).copied())
                .collect();
        }
        Ok(Vocabulary { bytes })
    }

    /// The text of ordinary tokens (ids below the special ones).
    fn text(&self, ids: &[i64], first_special: usize) -> String {
        let mut raw = Vec::new();
        for &id in ids {
            let id = id as usize;
            if id < first_special && id < self.bytes.len() {
                raw.extend_from_slice(&self.bytes[id]);
            }
        }
        String::from_utf8_lossy(&raw).trim().to_owned()
    }
}

/// Where the Whisper files are (all in one folder).
#[derive(Debug, Clone)]
pub struct WhisperFiles {
    pub encoder: PathBuf,
    pub decoder: PathBuf,
    pub vocab: PathBuf,
    pub generation_config: PathBuf,
}

pub struct Whisper {
    encoder: Session,
    decoder: Session,
    mel: Mel,
    vocab: Vocabulary,
    layers: usize,
    prompt: Vec<i64>,
    eos: i64,
    first_special: usize,
    /// Tokens that may never be chosen (the model's own list, and every timestamp and special token past the end of the text tokens).
    suppress: Vec<usize>,
    begin_suppress: Vec<usize>,
}

fn session(path: &Path, provider: crate::models::Provider) -> Result<Session, String> {
    crate::models::session_for(path, provider)
}

impl Whisper {
    pub fn load(files: &WhisperFiles, provider: crate::models::Provider) -> Result<Self, String> {
        let config: serde_json::Value = serde_json::from_str(
            &std::fs::read_to_string(&files.generation_config)
                .map_err(|e| format!("{}: {e}", files.generation_config.display()))?,
        )
        .map_err(|e| e.to_string())?;
        let id = |value: &serde_json::Value, what: &str| {
            value
                .as_i64()
                .ok_or_else(|| format!("generation_config.json has no {what}"))
        };
        let (start, english, transcribe, no_timestamps, eos) = (
            id(&config["decoder_start_token_id"], "the start token")?,
            id(&config["lang_to_id"]["<|en|>"], "English")?,
            id(&config["task_to_id"]["transcribe"], "the transcribe task")?,
            id(&config["no_timestamps_token_id"], "the no-timestamps token")?,
            id(&config["eos_token_id"], "the end token")?,
        );
        let list = |key: &str| -> Vec<usize> {
            config[key]
                .as_array()
                .map(|a| {
                    a.iter()
                        .filter_map(serde_json::Value::as_u64)
                        .map(|v| v as usize)
                        .collect()
                })
                .unwrap_or_default()
        };
        let decoder = session(&files.decoder, provider)?;
        let layers = decoder
            .inputs
            .iter()
            .filter(|i| i.name.ends_with(".decoder.key"))
            .count();
        if layers == 0 {
            return Err(
                "the Whisper decoder has no key/value cache inputs (use the merged decoder)"
                    .to_owned(),
            );
        }
        Ok(Whisper {
            encoder: session(&files.encoder, provider)?,
            decoder,
            mel: Mel::new(),
            vocab: Vocabulary::load(&files.vocab)?,
            layers,
            prompt: vec![start, english, transcribe, no_timestamps],
            eos,
            first_special: eos as usize,
            suppress: list("suppress_tokens"),
            begin_suppress: list("begin_suppress_tokens"),
        })
    }

    /// The words of a whole song (16 kHz mono): 30 s windows one after the other, each decoded on its own. A window of under a second is left out.
    pub fn transcribe(
        &mut self,
        audio: &[f32],
        mut progress: impl FnMut(f32),
    ) -> Result<String, String> {
        let mut parts = Vec::new();
        let windows = audio.len().div_ceil(WINDOW_SAMPLES).max(1);
        for w in 0..windows {
            let piece = &audio[w * WINDOW_SAMPLES..audio.len().min((w + 1) * WINDOW_SAMPLES)];
            if piece.len() > SAMPLE_RATE {
                let text = self.window(piece)?;
                if !text.is_empty() {
                    parts.push(text);
                }
            }
            progress((w + 1) as f32 / windows as f32);
        }
        Ok(parts.join(" "))
    }

    fn window(&mut self, audio: &[f32]) -> Result<String, String> {
        let features = self.mel.log_mel(audio);
        let input =
            Tensor::from_array(([1usize, MELS, FRAMES], features)).map_err(|e| e.to_string())?;
        let encoded = self
            .encoder
            .run(ort::inputs!["input_features" => input])
            .map_err(|e| e.to_string())?;
        let (shape, hidden) = encoded["last_hidden_state"]
            .try_extract_tensor::<f32>()
            .map_err(|e| e.to_string())?;
        let hidden_shape: Vec<usize> = shape.iter().map(|&d| d as usize).collect();
        let hidden: Vec<f32> = hidden.to_vec();
        drop(encoded);

        // The key/value cache: per layer decoder key, decoder value, encoder key, encoder value.
        let names: Vec<String> = (0..self.layers)
            .flat_map(|l| {
                [
                    "decoder.key",
                    "decoder.value",
                    "encoder.key",
                    "encoder.value",
                ]
                .map(|n| format!("{l}.{n}"))
            })
            .collect();
        // The first step does not use the cache (its branch of the model ignores these), but the inputs must exist and ONNX Runtime does not build empty
        // tensors: one placeholder position each.
        let mut past: Vec<(Vec<usize>, Vec<f32>)> = names
            .iter()
            .map(|_| (vec![1, HEADS, 1, HEAD_DIM], vec![0.0f32; HEADS * HEAD_DIM]))
            .collect();
        let mut out: Vec<i64> = Vec::new();
        let mut step_ids = self.prompt.clone();
        let mut cached = false;
        for step in 0..MAX_TOKENS {
            let mut feed: Vec<(String, DynValue)> = Vec::with_capacity(3 + past.len());
            feed.push((
                "input_ids".to_owned(),
                Tensor::from_array(([1usize, step_ids.len()], step_ids.clone()))
                    .map_err(|e| e.to_string())?
                    .into_dyn(),
            ));
            feed.push((
                "encoder_hidden_states".to_owned(),
                Tensor::from_array((hidden_shape.clone(), hidden.clone()))
                    .map_err(|e| e.to_string())?
                    .into_dyn(),
            ));
            feed.push((
                "use_cache_branch".to_owned(),
                Tensor::from_array(([1usize], vec![cached]))
                    .map_err(|e| e.to_string())?
                    .into_dyn(),
            ));
            for (name, (shape, data)) in names.iter().zip(&past) {
                feed.push((
                    format!("past_key_values.{name}"),
                    Tensor::from_array((shape.clone(), data.clone()))
                        .map_err(|e| e.to_string())?
                        .into_dyn(),
                ));
            }
            let outputs = self.decoder.run(feed).map_err(|e| e.to_string())?;
            let (logit_shape, logits) = outputs["logits"]
                .try_extract_tensor::<f32>()
                .map_err(|e| e.to_string())?;
            let classes = *logit_shape.last().unwrap_or(&0) as usize;
            let mut last = logits[logits.len() - classes..].to_vec();
            for &s in &self.suppress {
                if s < classes {
                    last[s] = f32::NEG_INFINITY;
                }
            }
            // No timestamps and no special tokens: only the end token and the text tokens.
            for (i, v) in last.iter_mut().enumerate() {
                if i >= self.first_special && i as i64 != self.eos {
                    *v = f32::NEG_INFINITY;
                }
            }
            if step == 0 {
                for &s in &self.begin_suppress {
                    if s < classes {
                        last[s] = f32::NEG_INFINITY;
                    }
                }
            }
            let next = last
                .iter()
                .enumerate()
                .max_by(|a, b| a.1.total_cmp(b.1))
                .map_or(self.eos, |(i, _)| i as i64);
            if next == self.eos {
                break;
            }
            out.push(next);
            // A loop (the same six tokens twice): this window is done.
            if out.len() > 14 && out[out.len() - 7..] == out[out.len() - 14..out.len() - 7] {
                break;
            }
            for (name, slot) in names.iter().zip(past.iter_mut()) {
                // The encoder part of the cache is made at the first step and stays.
                if cached && name.contains("encoder") {
                    continue;
                }
                let (shape, data) = outputs[format!("present.{name}")]
                    .try_extract_tensor::<f32>()
                    .map_err(|e| e.to_string())?;
                *slot = (shape.iter().map(|&d| d as usize).collect(), data.to_vec());
            }
            step_ids = vec![next];
            cached = true;
        }
        Ok(self.vocab.text(&out, self.first_special))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn token_bytes_become_text_the_way_gpt2_writes_them() {
        let dir = std::env::temp_dir().join(format!("whisper-vocab-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let file = dir.join("vocab.json");
        // "Ġ" stands for a space; "Ã©" for the two bytes of "é"; ids at or above the first special id are not text.
        std::fs::write(
            &file,
            r#"{"Hello": 0, "Ġworld": 1, "Ã©": 2, "!": 3, "<|endoftext|>": 4}"#,
        )
        .unwrap();
        let vocab = Vocabulary::load(&file).unwrap();
        assert_eq!(vocab.text(&[0, 1, 3], 4), "Hello world!");
        assert_eq!(
            vocab.text(&[1, 2], 4),
            "world\u{e9}".replace("world", "world"),
            "leading space trimmed, bytes joined into é"
        );
        assert_eq!(
            vocab.text(&[0, 4, 1], 4),
            "Hello world",
            "a special token is left out"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
