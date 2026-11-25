//! The whole chain for one song: separate the vocals, read the letters, decode what was heard, and measure whether anyone is singing.

use crate::dsp::resample;
use crate::models::{BertReader, Letters, Provider, Reader, Separator, init, to_reader_audio};
use mediaverse_lyric_ai::align::{Alphabet, FRAME_SECONDS, LineTime, align_anchored, align_lines};
use mediaverse_lyric_ai::identity::FitLimits;
use std::path::{Path, PathBuf};

/// Which model reads the letters.
#[derive(Debug, Clone, PartialEq, Eq)]
pub enum ReaderModel {
    /// wav2vec2 (English, trained on speech) on the separated vocals: `htdemucs-core.onnx`, `w2v.onnx` and `w2v.json` in the models folder.
    Wav2Vec2,
    /// A w2v-BERT music-lyrics CTC model (`mrfakename/w2v-bert-2.0-music-lyrics-ctc`, `radiant-lyrics/sylla-600m-v1`) on the full mix, no separation: its ONNX file
    /// and its `vocab.json` (`{"character": id}`, id 0 the CTC blank, `|` the word break), by file name in the models folder.
    MusicBert { onnx: String, vocab: String },
}

impl ReaderModel {
    /// The cut-offs for deciding which lyrics belong to a song, calibrated for this model (every model has its own scale: right lyrics fit at about -1.4 with
    /// the wav2vec2 reader and about -0.4 with the music-lyrics reader).
    pub fn limits(&self) -> FitLimits {
        match self {
            ReaderModel::Wav2Vec2 => FitLimits::default(),
            ReaderModel::MusicBert { .. } => MUSIC_BERT_LIMITS,
        }
    }
}

/// Calibrated on 160 songs of the To review list (`judge-lab/calib-music.jsonl`, 2026-11-19): the 40 whose own time stamps agree with the singing (so their words are
/// right) fit between -1.68 and 0 (median -0.56); 79 other songs' lyrics put on a song fit between -5.6 and -2.05 (median -4.1). Floor -2.0: every right text passes,
/// no wrong one. Certain at -1.4: 97% of right texts, no wrong one, 0.65 clear of the best wrong one. (The speech reader: right -3.3 to -0.6, wrong up to -2.8.)
pub const MUSIC_BERT_LIMITS: FitLimits = FitLimits {
    floor: -2.0,
    margin: 0.3,
    sure: -1.4,
    sure_margin: 1.0,
};

/// Where the models are and where they run.
#[derive(Debug, Clone)]
pub struct EngineConfig {
    /// `onnxruntime.dll` of the downloaded ONNX Runtime.
    pub runtime: PathBuf,
    /// Folders to add to the library search path before ONNX Runtime loads (the CUDA libraries, when they are not beside it).
    pub library_folders: Vec<PathBuf>,
    /// Holds `htdemucs-core.onnx`, `w2v.onnx` and `w2v.json` (the letters of the reader model).
    pub models: PathBuf,
    pub separator_provider: Provider,
    pub reader_provider: Provider,
    pub reader_model: ReaderModel,
}

/// What listens: the speech reader behind the vocal separator, or the music reader on the mix.
enum Hearing {
    Vocals {
        separator: Separator,
        reader: Reader,
    },
    Mix(BertReader),
}

pub struct Engine {
    hearing: Hearing,
    labels: Vec<String>,
    alphabet: Alphabet,
    limits: FitLimits,
}

/// What the engine heard in one song.
pub struct Listening {
    pub letters: Letters,
    /// The letters of the greedy reading, lower case, words separated by spaces: noisy, but enough to tell lyrics apart.
    pub reading: String,
    pub voice: Voice,
    pub seconds: f64,
    /// The song as 16 kHz mono (what the readers and Whisper take), kept so Whisper can transcribe it without decoding again.
    pub mix16: Vec<f32>,
}

/// Is anybody singing? `present`: the share of the song in which the separated vocals are clearly above the rest (voice-like energy against the mix);
/// `letters`: the share of 20 ms frames in which the reader hears a letter. A song with lyrics scores high on both; an instrumental low on the second
/// (measured on 120 songs: letters <= 0.08 and present <= 0.35 caught 48 of 60 instrumentals and wrongly flagged 1 of 60 songs with lyrics).
#[derive(Debug, Clone, Copy, PartialEq)]
pub struct Voice {
    pub present: f64,
    pub letters: f64,
    /// Read from the full mix (no separation, so `present` is not measured and mirrors `letters`).
    pub from_mix: bool,
}

/// With the music reader on the mix, a song in which the reader hears letters in at most this share of the frames is probably instrumental. Measured on 60
/// instrumentals and 60 songs with lyrics from the library (`judge-lab/inst_music.py`): 59 of 60 instrumentals caught and no song with lyrics flagged (the speech
/// reader behind the separator caught 48 of 60 and flagged 1); songs with lyrics hear letters in 6% to 17% of the frames (median 12%), instrumentals in under 0.5%.
pub const MIX_INSTRUMENTAL_LETTERS: f64 = 0.03;

impl Voice {
    pub fn probably_instrumental(&self) -> bool {
        if self.from_mix {
            return self.letters <= MIX_INSTRUMENTAL_LETTERS;
        }
        self.letters <= 0.08 && self.present <= 0.35
    }
}

impl Engine {
    pub fn load(config: &EngineConfig) -> Result<Engine, String> {
        if !config.library_folders.is_empty() {
            let mut path = std::env::var_os("PATH").unwrap_or_default();
            for folder in &config.library_folders {
                let mut joined = std::ffi::OsString::from(folder.as_os_str());
                joined.push(";");
                joined.push(&path);
                path = joined;
            }
            // SAFETY: set before any model is loaded and before this engine starts its work; nothing else here reads the environment concurrently.
            unsafe { std::env::set_var("PATH", path) };
        }
        init(&config.runtime)?;
        let (hearing, labels) = match &config.reader_model {
            ReaderModel::Wav2Vec2 => {
                let json: serde_json::Value = serde_json::from_str(
                    &std::fs::read_to_string(config.models.join("w2v.json"))
                        .map_err(|e| format!("w2v.json: {e}"))?,
                )
                .map_err(|e| e.to_string())?;
                let labels: Vec<String> = json["labels"]
                    .as_array()
                    .ok_or("w2v.json has no letters")?
                    .iter()
                    .map(|v| v.as_str().unwrap_or("").to_owned())
                    .collect();
                let hearing = Hearing::Vocals {
                    separator: Separator::load(
                        &config.models.join("htdemucs-core.onnx"),
                        config.separator_provider,
                    )?,
                    reader: Reader::load(&config.models.join("w2v.onnx"), config.reader_provider)?,
                };
                (hearing, labels)
            }
            ReaderModel::MusicBert { onnx, vocab } => {
                let json: serde_json::Value = serde_json::from_str(
                    &std::fs::read_to_string(config.models.join(vocab))
                        .map_err(|e| format!("{vocab}: {e}"))?,
                )
                .map_err(|e| e.to_string())?;
                (
                    Hearing::Mix(BertReader::load(
                        &config.models.join(onnx),
                        config.reader_provider,
                    )?),
                    labels_from_vocab(&json)?,
                )
            }
        };
        Ok(Engine {
            hearing,
            alphabet: Alphabet::new(&labels),
            labels,
            limits: config.reader_model.limits(),
        })
    }

    /// The cut-offs for choosing lyrics, calibrated for the reader this engine uses.
    pub fn limits(&self) -> FitLimits {
        self.limits
    }

    /// Listens to a stereo 44.1 kHz song. `progress`: 0 to 1 over the whole job.
    pub fn listen(
        &mut self,
        left: &[f32],
        right: &[f32],
        mut progress: impl FnMut(f32),
    ) -> Result<Listening, String> {
        let seconds = left.len() as f64 / 44_100.0;
        let mix: Vec<f32> = left.iter().zip(right).map(|(a, b)| (a + b) / 2.0).collect();
        let mix16 = resample(&mix, 44_100, 16_000);
        let (letters, present, from_mix) = match &mut self.hearing {
            Hearing::Vocals { separator, reader } => {
                let vocals = separator.vocals(left, right, |p| progress(p * 0.8))?;
                let reader_audio = to_reader_audio(&vocals);
                let letters = reader.letters(&reader_audio)?;
                let present = presence(&reader_audio, &mix16);
                (letters, present, false)
            }
            Hearing::Mix(reader) => {
                let letters = reader.letters(&mix16)?;
                let share = letters_share(&letters);
                (letters, share, true)
            }
        };
        progress(1.0);
        let reading = greedy_reading(&letters, &self.labels);
        let voice = Voice {
            present,
            letters: letters_share(&letters),
            from_mix,
        };
        Ok(Listening {
            letters,
            reading,
            voice,
            seconds,
            mix16,
        })
    }
    /// How well some words fit what was heard (0 is perfect, more negative is worse); see `Alphabet::fit`. `None` for too few words.
    pub fn fit(&self, listening: &Listening, text: &str) -> Option<f64> {
        self.alphabet.fit(
            &listening.letters.data,
            listening.letters.frames,
            listening.letters.classes,
            text,
        )
    }

    /// How well each run of `size` consecutive placed lines fits the sound of just its own stretch (a quarter second either side), per `fit`: a run sung
    /// differently from the page (a live version, an ad-lib) fits worse than the song as a whole. `None` for a run that cannot be scored (no placed line, too
    /// few words, too short a stretch). Entry `i` is the run that starts at line `i`.
    pub fn window_fits(
        &self,
        listening: &Listening,
        lines: &[LineTime],
        size: usize,
    ) -> Vec<Option<f64>> {
        let (frames, classes) = (listening.letters.frames, listening.letters.classes);
        (0..lines.len())
            .map(|i| {
                let run = &lines[i..(i + size).min(lines.len())];
                let start = run.iter().find_map(|l| l.start)?;
                let end = run.iter().rev().find_map(|l| l.end)?;
                let from = ((start - 0.25) / FRAME_SECONDS).max(0.0) as usize;
                let to = (((end + 0.25) / FRAME_SECONDS) as usize + 1).min(frames);
                if to < from + 25 {
                    return None;
                }
                let text = run
                    .iter()
                    .map(|l| l.text.as_str())
                    .collect::<Vec<_>>()
                    .join("\n");
                self.alphabet.fit(
                    &listening.letters.data[from * classes..to * classes],
                    to - from,
                    classes,
                    &text,
                )
            })
            .collect()
    }

    /// Times lyric lines against what was heard, keeping the lines a person has timed where they put them (`anchors`: line number and start in seconds as the
    /// aligner reports it) and placing the others between them.
    pub fn time_anchored(
        &self,
        listening: &Listening,
        lines: &[String],
        anchors: &[(usize, f64)],
    ) -> Vec<LineTime> {
        align_anchored(
            &listening.letters.data,
            listening.letters.frames,
            listening.letters.classes,
            &self.alphabet,
            lines,
            anchors,
        )
    }

    /// Times lyric lines against what was heard.
    pub fn time(&self, listening: &Listening, lines: &[String]) -> Vec<LineTime> {
        align_lines(
            &listening.letters.data,
            listening.letters.frames,
            listening.letters.classes,
            &self.alphabet,
            lines,
        )
    }
}

/// The letters of the most likely path, repeats and "nothing" removed, "|" as a space.
pub fn greedy_reading(letters: &Letters, labels: &[String]) -> String {
    let mut out = String::new();
    let mut previous = 0usize;
    for frame in 0..letters.frames {
        let row = &letters.data[frame * letters.classes..(frame + 1) * letters.classes];
        let best = row
            .iter()
            .enumerate()
            .max_by(|a, b| a.1.total_cmp(b.1))
            .map_or(0, |(i, _)| i);
        if best != previous && best != 0 {
            match labels.get(best).map(String::as_str) {
                Some("|") => out.push(' '),
                Some(l) => out.push_str(&l.to_lowercase()),
                None => {}
            }
        }
        previous = best;
    }
    out
}

/// Share of 20 ms frames in which the reader hears something other than "nothing" with more than even odds.
fn letters_share(letters: &Letters) -> f64 {
    if letters.frames == 0 {
        return 0.0;
    }
    let heard = (0..letters.frames)
        .filter(|&f| 1.0 - letters.data[f * letters.classes].exp() > 0.5)
        .count();
    heard as f64 / letters.frames as f64
}

/// Share of whole seconds in which the vocals' loudness is more than a quarter of the mix's (and not tiny).
fn presence(vocals: &[f32], mix: &[f32]) -> f64 {
    const RATE: usize = 16_000;
    let seconds = vocals.len().min(mix.len()) / RATE;
    if seconds == 0 {
        return 0.0;
    }
    let rms = |x: &[f32]| (x.iter().map(|v| v * v).sum::<f32>() / x.len() as f32).sqrt();
    let present = (0..seconds)
        .filter(|&s| {
            let (v, m) = (
                rms(&vocals[s * RATE..(s + 1) * RATE]),
                rms(&mix[s * RATE..(s + 1) * RATE]) + 1e-6,
            );
            v / m > 0.25 && v > 0.005
        })
        .count();
    present as f64 / seconds as f64
}

/// The letters of a `vocab.json` (`{"character": id}`) in class order.
pub fn labels_from_vocab(json: &serde_json::Value) -> Result<Vec<String>, String> {
    let object = json
        .as_object()
        .ok_or("the vocabulary is not a list of characters and numbers")?;
    let size = object
        .values()
        .filter_map(serde_json::Value::as_u64)
        .max()
        .ok_or("the vocabulary is empty")? as usize
        + 1;
    let mut labels = vec![String::new(); size];
    for (character, id) in object {
        let id = id.as_u64().ok_or("a vocabulary number is not a number")? as usize;
        labels[id] = character.clone();
    }
    Ok(labels)
}

/// The files the engine needs for `reader`, and which of them are present in `models` (for the status page).
pub fn model_files(models: &Path, reader: &ReaderModel) -> Vec<(String, bool)> {
    let names: Vec<String> = match reader {
        ReaderModel::Wav2Vec2 => ["htdemucs-core.onnx", "w2v.onnx", "w2v.json"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect(),
        ReaderModel::MusicBert { onnx, vocab } => vec![onnx.clone(), vocab.clone()],
    };
    names
        .into_iter()
        .map(|f| (f.clone(), models.join(&f).is_file()))
        .collect()
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_vocabulary_file_becomes_the_letters_in_class_order() {
        let json: serde_json::Value =
            serde_json::from_str(r#"{"<blank>": 0, "|": 1, "<unk>": 2, "'": 3, "a": 4, "b": 5}"#)
                .unwrap();
        let labels = labels_from_vocab(&json).unwrap();
        assert_eq!(labels, ["<blank>", "|", "<unk>", "'", "a", "b"]);
        let alphabet = Alphabet::new(&labels);
        assert!(!alphabet.upper, "this model reads lower case");
        assert!(labels_from_vocab(&serde_json::json!([1, 2])).is_err());
        assert!(labels_from_vocab(&serde_json::json!({})).is_err());
    }

    #[test]
    fn a_song_read_from_the_mix_is_instrumental_by_the_letters_alone() {
        let quiet = Voice {
            present: 0.01,
            letters: 0.01,
            from_mix: true,
        };
        let singing = Voice {
            present: 0.06,
            letters: 0.06,
            from_mix: true,
        };
        assert!(quiet.probably_instrumental());
        assert!(!singing.probably_instrumental());
        // separated vocals: both measures must be low
        assert!(
            !Voice {
                present: 0.9,
                letters: 0.05,
                from_mix: false
            }
            .probably_instrumental()
        );
        assert!(
            Voice {
                present: 0.2,
                letters: 0.05,
                from_mix: false
            }
            .probably_instrumental()
        );
    }

    #[test]
    fn the_music_reader_has_its_own_cut_offs() {
        let music = ReaderModel::MusicBert {
            onnx: "m.onnx".into(),
            vocab: "v.json".into(),
        }
        .limits();
        let speech = ReaderModel::Wav2Vec2.limits();
        assert!(
            music.floor > speech.floor && music.sure > speech.sure,
            "the music reader fits tighter, so its cut-offs sit closer to 0"
        );
        let files = model_files(
            std::path::Path::new("nowhere"),
            &ReaderModel::MusicBert {
                onnx: "m.onnx".into(),
                vocab: "v.json".into(),
            },
        );
        assert_eq!(
            files.iter().map(|f| f.0.as_str()).collect::<Vec<_>>(),
            ["m.onnx", "v.json"]
        );
        assert_eq!(
            model_files(std::path::Path::new("nowhere"), &ReaderModel::Wav2Vec2).len(),
            3
        );
    }
    #[test]
    fn the_reading_collapses_repeats_and_drops_nothing() {
        let labels: Vec<String> = ["-", "|", "A", "B"]
            .iter()
            .map(|s| (*s).to_owned())
            .collect();
        // frames: A A - A B B | -
        let plan = [2usize, 2, 0, 2, 3, 3, 1, 0];
        let mut data = Vec::new();
        for c in plan {
            for k in 0..4 {
                data.push(if k == c { 0.0f32 } else { -10.0 });
            }
        }
        let letters = Letters {
            data,
            frames: plan.len(),
            classes: 4,
        };
        assert_eq!(greedy_reading(&letters, &labels), "aab ");
        assert!(
            (letters_share(&letters) - 0.75).abs() < 1e-9,
            "{}",
            letters_share(&letters)
        );
    }

    #[test]
    fn a_song_with_no_voice_is_probably_instrumental() {
        assert!(
            Voice {
                present: 0.05,
                letters: 0.03,
                from_mix: false
            }
            .probably_instrumental()
        );
        assert!(
            !Voice {
                present: 0.62,
                letters: 0.15,
                from_mix: false
            }
            .probably_instrumental()
        );
        assert!(
            !Voice {
                present: 0.50,
                letters: 0.04,
                from_mix: false
            }
            .probably_instrumental(),
            "a voice with few words is not called instrumental"
        );
    }

    #[test]
    fn presence_counts_the_seconds_with_a_voice() {
        let loud: Vec<f32> = (0..32_000)
            .map(|i| if i < 16_000 { 0.2 } else { 0.0 })
            .collect();
        let mix: Vec<f32> = vec![0.3; 32_000];
        assert!((presence(&loud, &mix) - 0.5).abs() < 1e-9);
    }
}
