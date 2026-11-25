//! Lyric AI in the sidecar (docs/lyric-ai-plan.md, D127): which models are installed and where they run, and the job that listens to songs, finds or checks their
//! lyrics and times them. Nothing is written into a song unless the person asked for it ("apply what is sure") or confirms a result in Review.

use crate::drives::Drives;
use crate::helper::Canceller;
use crate::library_cover::resolve_in_library;
use mediaverse_host::EventSink;
use mediaverse_lyric_ai::align::LineTime;
use mediaverse_lyric_ai::check::{Fit, to_lrc, verdict};
use mediaverse_lyric_ai::identity::{FitLimits, Verdict, choose_by_fit};
use mediaverse_lyric_engine::models::Provider;
use mediaverse_lyric_engine::pipeline::{
    Engine, EngineConfig, Listening, ReaderModel, model_files,
};
use mediaverse_lyric_engine::whisper::{Whisper, WhisperFiles};
use serde_json::{Value, json};
use std::path::{Path, PathBuf};
use std::sync::Mutex;

mod draft;
mod judge;
mod timing;
pub(crate) mod trust;
pub(crate) mod wrongcheck;

/// A song whose timing has more than this share of flagged lines goes to a person even when the words are certain.
pub const MAX_FLAGGED_SHARE: f64 = 0.10;

fn provider(name: &str) -> Provider {
    match name {
        "cuda" => Provider::Cuda,
        "directml" => Provider::DirectMl,
        _ => Provider::Cpu,
    }
}

/// What the person (or a first-time detection) set: where ONNX Runtime and the models are, and where each model runs.
#[derive(Debug, Clone, PartialEq)]
pub struct Config {
    pub runtime: PathBuf,
    pub models: PathBuf,
    pub library_folders: Vec<PathBuf>,
    pub separator: String,
    pub reader: String,
    /// Which model reads the letters: "wav2vec2" (the speech model on separated vocals, the default) or "music" (a w2v-BERT music-lyrics model on the full mix).
    pub reader_model: String,
    /// The music reader's ONNX file and vocabulary file (names inside `models`).
    pub music_onnx: String,
    pub music_vocab: String,
    /// The folder with the Whisper files (drafting words for songs nobody has lyrics for); empty means a `whisper` folder inside `models`.
    pub whisper_folder: String,
}

/// The four Whisper files in `folder` (the encoder and decoder may sit in an `onnx` folder inside it, as the download has them): the files found, or the names
/// of those missing.
pub fn whisper_files(folder: &Path) -> Result<WhisperFiles, Vec<String>> {
    let find = |name: &str, inside_onnx: bool| -> Option<PathBuf> {
        let candidates = if inside_onnx {
            vec![folder.join(name), folder.join("onnx").join(name)]
        } else {
            vec![folder.join(name)]
        };
        candidates.into_iter().find(|p| p.is_file())
    };
    let encoder = find("encoder_model_fp16.onnx", true);
    let decoder = find("decoder_model_merged_fp16.onnx", true);
    let vocab = find("vocab.json", false);
    let generation_config = find("generation_config.json", false);
    match (encoder, decoder, vocab, generation_config) {
        (Some(encoder), Some(decoder), Some(vocab), Some(generation_config)) => Ok(WhisperFiles {
            encoder,
            decoder,
            vocab,
            generation_config,
        }),
        (e, d, v, g) => Err([
            (e.is_none(), "encoder_model_fp16.onnx"),
            (d.is_none(), "decoder_model_merged_fp16.onnx"),
            (v.is_none(), "vocab.json"),
            (g.is_none(), "generation_config.json"),
        ]
        .iter()
        .filter(|(missing, _)| *missing)
        .map(|(_, name)| format!("{name} (in {})", folder.display()))
        .collect()),
    }
}

/// A bare file name (no folders), for the model files named in the settings.
fn plain_file_name(name: &str) -> bool {
    !name.is_empty()
        && name.len() <= 120
        && !name.contains(['/', '\\', ':'])
        && name != "."
        && name != ".."
}

fn config_file(data_dir: &Path) -> PathBuf {
    data_dir.join("lyric-ai.json")
}

pub fn load_config(data_dir: &Path) -> Config {
    let saved: Value = std::fs::read(config_file(data_dir))
        .ok()
        .and_then(|b| serde_json::from_slice(&b).ok())
        .unwrap_or(Value::Null);
    let folder = |key: &str, default: PathBuf| {
        saved[key]
            .as_str()
            .filter(|s| !s.is_empty())
            .map_or(default, PathBuf::from)
    };
    let home = data_dir.join("lyric-ai");
    Config {
        runtime: folder("runtime", home.join("runtime").join("onnxruntime.dll")),
        models: folder("models", home.join("models")),
        library_folders: saved["library_folders"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(PathBuf::from)
            .collect(),
        separator: saved["separator"].as_str().unwrap_or("cpu").to_owned(),
        reader: saved["reader"].as_str().unwrap_or("cpu").to_owned(),
        // The music-lyrics reader is the default (D151); the speech reader stays selectable and is kept when it was chosen.
        reader_model: saved["reader_model"]
            .as_str()
            .filter(|m| *m == "wav2vec2")
            .unwrap_or("music")
            .to_owned(),
        music_onnx: saved["music_onnx"]
            .as_str()
            .filter(|n| plain_file_name(n))
            .unwrap_or("aligner-fp16.onnx")
            .to_owned(),
        music_vocab: saved["music_vocab"]
            .as_str()
            .filter(|n| plain_file_name(n))
            .unwrap_or("vocab.json")
            .to_owned(),
        whisper_folder: saved["whisper_folder"].as_str().unwrap_or("").to_owned(),
    }
}

impl Config {
    /// Where the Whisper files are looked for.
    pub fn whisper_dir(&self) -> PathBuf {
        if self.whisper_folder.is_empty() {
            self.models.join("whisper")
        } else {
            PathBuf::from(&self.whisper_folder)
        }
    }

    pub fn reader_model(&self) -> ReaderModel {
        if self.reader_model == "music" {
            ReaderModel::MusicBert {
                onnx: self.music_onnx.clone(),
                vocab: self.music_vocab.clone(),
            }
        } else {
            ReaderModel::Wav2Vec2
        }
    }

    fn engine_config(&self) -> EngineConfig {
        EngineConfig {
            runtime: self.runtime.clone(),
            library_folders: self.library_folders.clone(),
            models: self.models.clone(),
            separator_provider: provider(&self.separator),
            reader_provider: provider(&self.reader),
            reader_model: self.reader_model(),
        }
    }

    /// What is missing, in words, or nothing when everything is there.
    pub fn missing(&self) -> Vec<String> {
        let mut missing = Vec::new();
        if !self.runtime.is_file() {
            missing.push(format!("ONNX Runtime ({})", self.runtime.display()));
        }
        for (file, found) in model_files(&self.models, &self.reader_model()) {
            if !found {
                missing.push(format!("{file} (in {})", self.models.display()));
            }
        }
        missing
    }
}

/// The engine, kept loaded between jobs (loading takes a second or two and some memory); dropped when the settings change.
pub struct LyricAi {
    data_dir: PathBuf,
    engine: Mutex<Option<(Config, Engine)>>,
    /// Whisper, loaded the first time a draft is made (it is large) with the folder and processor it was loaded for.
    whisper: Mutex<Option<((PathBuf, String), Whisper)>>,
    /// The last song listened to for one-song timing in the lyrics editor, so the second and third run on the same song (fix a few lines, run again) skip the
    /// minute of listening. Keyed by the file, its size and its modified time, so a changed file is heard again.
    heard: Mutex<Option<Heard>>,
}

struct Heard {
    file: PathBuf,
    stamp: (u64, Option<std::time::SystemTime>),
    listening: std::sync::Arc<Listening>,
}

impl LyricAi {
    pub fn new(data_dir: &Path) -> Self {
        LyricAi {
            data_dir: data_dir.to_owned(),
            engine: Mutex::new(None),
            whisper: Mutex::new(None),
            heard: Mutex::new(None),
        }
    }

    /// What the AI hears in a song: from the last one-song run when it is the same file, otherwise it listens (about a minute) and remembers.
    pub(crate) fn heard(&self, file: &Path) -> Result<std::sync::Arc<Listening>, String> {
        let meta = std::fs::metadata(file).map_err(|e| format!("could not read the file: {e}"))?;
        let stamp = (meta.len(), meta.modified().ok());
        if let Ok(slot) = self.heard.lock()
            && let Some(h) = slot.as_ref()
            && h.file == file
            && h.stamp == stamp
        {
            return Ok(h.listening.clone());
        }
        let (left, right) = decode_for_listening(file)?;
        let listening =
            std::sync::Arc::new(self.with_engine(|engine| engine.listen(&left, &right, |_| {}))?);
        if let Ok(mut slot) = self.heard.lock() {
            *slot = Some(Heard {
                file: file.to_owned(),
                stamp,
                listening: listening.clone(),
            });
        }
        Ok(listening)
    }

    /// The cut-offs for choosing lyrics, for the reader model that is set.
    pub fn limits(&self) -> FitLimits {
        load_config(&self.data_dir).reader_model().limits()
    }

    pub fn status(&self) -> Value {
        let config = load_config(&self.data_dir);
        let missing = config.missing();
        let loaded = self
            .engine
            .lock()
            .ok()
            .is_some_and(|e| e.as_ref().is_some_and(|(c, _)| *c == config));
        json!({
            "ready": missing.is_empty(),
            "missing": missing,
            "loaded": loaded,
            "runtime": config.runtime.display().to_string(),
            "models": config.models.display().to_string(),
            "separator": config.separator,
            "reader": config.reader,
            "reader_model": config.reader_model,
            "music_onnx": config.music_onnx,
            "music_vocab": config.music_vocab,
            "whisper_folder": config.whisper_dir().display().to_string(),
            "whisper_ready": whisper_files(&config.whisper_dir()).is_ok(),
            "whisper_missing": whisper_files(&config.whisper_dir()).err().unwrap_or_default(),
            "library_folders": config.library_folders.iter().map(|f| f.display().to_string()).collect::<Vec<_>>(),
        })
    }

    /// `lyric_ai_configure {runtime?, models?, library_folders?, separator?, reader?}`: merged into what is saved.
    pub fn configure(&self, args: &Value) -> Result<Value, String> {
        let mut saved: Value = std::fs::read(config_file(&self.data_dir))
            .ok()
            .and_then(|b| serde_json::from_slice(&b).ok())
            .unwrap_or_else(|| json!({}));
        for key in [
            "runtime",
            "models",
            "separator",
            "reader",
            "reader_model",
            "music_onnx",
            "music_vocab",
            "whisper_folder",
        ] {
            if let Some(v) = args.get(key).and_then(Value::as_str) {
                if key == "reader_model" && !["wav2vec2", "music"].contains(&v) {
                    return Err("The reader model must be wav2vec2 or music.".to_owned());
                }
                if matches!(key, "music_onnx" | "music_vocab") && !plain_file_name(v) {
                    return Err("A model file must be named by its file name only.".to_owned());
                }
                if matches!(key, "separator" | "reader")
                    && !["cpu", "cuda", "directml"].contains(&v)
                {
                    return Err("The processor must be cpu, cuda or directml.".to_owned());
                }
                saved[key] = json!(v);
            }
        }
        if let Some(list) = args.get("library_folders").and_then(Value::as_array) {
            saved["library_folders"] =
                json!(list.iter().filter_map(Value::as_str).collect::<Vec<_>>());
        }
        std::fs::write(
            config_file(&self.data_dir),
            serde_json::to_vec_pretty(&saved).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("could not save the settings: {e}"))?;
        if let Ok(mut engine) = self.engine.lock() {
            *engine = None; // loaded again with the new settings at the next job
        }
        if let Ok(mut whisper) = self.whisper.lock() {
            *whisper = None;
        }
        if let Ok(mut heard) = self.heard.lock() {
            *heard = None;
        }
        Ok(self.status())
    }

    /// Runs `work` with the engine, loading it first when needed (or when the settings changed).
    pub fn with_engine<T>(
        &self,
        work: impl FnOnce(&mut Engine) -> Result<T, String>,
    ) -> Result<T, String> {
        let config = load_config(&self.data_dir);
        let missing = config.missing();
        if !missing.is_empty() {
            return Err(format!(
                "The lyric AI is not set up: missing {}.",
                missing.join(", ")
            ));
        }
        let mut slot = self
            .engine
            .lock()
            .map_err(|_| "the lyric AI is busy".to_owned())?;
        if slot.as_ref().is_none_or(|(c, _)| *c != config) {
            *slot = Some((config.clone(), Engine::load(&config.engine_config())?));
        }
        work(&mut slot.as_mut().expect("just loaded").1)
    }

    /// Runs `work` with Whisper, loading it first when needed. ONNX Runtime must be loaded already (by `with_engine`, which a draft always runs inside).
    pub fn with_whisper<T>(
        &self,
        work: impl FnOnce(&mut Whisper) -> Result<T, String>,
    ) -> Result<T, String> {
        let config = load_config(&self.data_dir);
        let dir = config.whisper_dir();
        let files = whisper_files(&dir)
            .map_err(|missing| format!("Whisper is not set up: missing {}.", missing.join(", ")))?;
        let key = (dir, config.reader.clone());
        let mut slot = self
            .whisper
            .lock()
            .map_err(|_| "Whisper is busy".to_owned())?;
        if slot.as_ref().is_none_or(|(k, _)| *k != key) {
            *slot = Some((key, Whisper::load(&files, provider(&config.reader))?));
        }
        work(&mut slot.as_mut().expect("just loaded").1)
    }
}

/// How many songs in a row may fail with the very same message before a run stops: a message that repeats like that is about the setup (no library
/// folder, the engine not loading), not about one song, and racing through a whole list of 2,000 songs to fail each one helps nobody.
pub(crate) const MAX_SAME_FAILURES: usize = 10;

/// Counts consecutive failures with the same message.
#[derive(Default)]
pub(crate) struct FailStreak {
    last: String,
    count: usize,
}

impl FailStreak {
    /// Records a failure; true when the run should stop because of it.
    pub fn failed(&mut self, message: &str) -> bool {
        if self.last == message {
            self.count += 1;
        } else {
            self.last = message.to_owned();
            self.count = 1;
        }
        self.count >= MAX_SAME_FAILURES
    }

    /// A song that worked ends the streak.
    pub fn succeeded(&mut self) {
        self.count = 0;
        self.last.clear();
    }
}

/// The first line was put at the very start of the song (under a second in) while the next line begins eight seconds or more later. Only recorded
/// in the result, it does not decide anything (D149): the owner listened to 47 such songs and none was badly timed. Most open with talking, a
/// count-in or an instrumental part, or the lyrics start with a line that is not sung (a note, "(instrumental)", the title); the next line, the real
/// start, was within 6 s of the real singing in 30 of the 33 songs where a time was given.
pub(crate) fn first_line_stuck(lines: &[LineTime]) -> bool {
    let mut starts = lines.iter().filter_map(|l| l.start);
    match (starts.next(), starts.next()) {
        (Some(first), Some(second)) => first < 1.0 && second - first > 8.0,
        _ => false,
    }
}

/// How sure the AI is about a result: apply without listening, or ask a person.
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum Need {
    /// Nothing to do (the timing fits, or the song is instrumental).
    Nothing,
    /// Safe to apply without anyone listening.
    Sure,
    /// A person should look (play it, check the flagged lines).
    Review,
}

/// The rule of the plan: the words must be certain (`words_sure`) and few lines flagged.
pub fn decide(words_sure: bool, lines: usize, flagged: usize) -> Need {
    if lines == 0 {
        return Need::Review;
    }
    if words_sure && flagged as f64 / lines as f64 <= MAX_FLAGGED_SHARE {
        Need::Sure
    } else {
        Need::Review
    }
}

fn lines_json(lines: &[LineTime]) -> Value {
    json!(lines.iter().map(|l| json!({ "text": l.text, "start": l.start, "end": l.end, "score": l.score, "flags": l.flags })).collect::<Vec<_>>())
}

/// The sung lines of a text: not empty, timestamps (if it is an LRC text) taken off.
pub fn lyric_lines(text: &str) -> Vec<String> {
    text.lines()
        .map(|l| {
            let mut s = l.trim();
            while s.starts_with('[')
                && s.find(']').is_some_and(|i| {
                    s[1..i]
                        .chars()
                        .all(|c| c.is_ascii_digit() || matches!(c, ':' | '.'))
                })
            {
                s = s[s.find(']').unwrap_or(0) + 1..].trim_start();
            }
            s.to_owned()
        })
        .filter(|l| !l.is_empty())
        .collect()
}

/// Everything one song's analysis needs from outside the engine.
pub struct Context<'a> {
    pub root: Option<&'a Path>,
    pub base_url: String,
    pub agent: String,
    pub pause: &'a dyn Fn(),
    pub limits: FitLimits,
}

/// Listens to one song and decides what to do about its lyrics. `existing` is `track_lyrics`'s answer for it.
pub fn analyse_song(
    engine: &mut Engine,
    path: &str,
    existing: &Value,
    listening_of: impl FnOnce(&mut Engine) -> Result<Listening, String>,
    title: &str,
    artist: &str,
    ctx: &Context,
) -> Result<Value, String> {
    let listening = listening_of(engine)?;
    let voice = listening.voice;
    let mut result = json!({
        "path": path, "title": title, "artist": artist, "seconds": listening.seconds.round(),
        "voice": { "present": (voice.present * 1000.0).round() / 1000.0, "letters": (voice.letters * 1000.0).round() / 1000.0 },
    });
    let timed: Vec<(f64, String)> = existing["lines"]
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|l| Some((l["ms"].as_f64()? / 1000.0, l["text"].as_str()?.to_owned())))
        .filter(|(_, t)| !t.trim().is_empty())
        .collect();
    let plain = existing["plain"].as_str().unwrap_or("");

    if !timed.is_empty() {
        // 1. timing the song already has: does it fit the singing?
        let texts: Vec<String> = timed.iter().map(|(_, t)| t.clone()).collect();
        let aligned = engine.time(&listening, &texts);
        let errors: Vec<(f64, f64)> = timed
            .iter()
            .zip(&aligned)
            .filter_map(|((at, _), a)| Some((*at, a.start? * 1000.0 - at * 1000.0)))
            .collect();
        let Some(v) = verdict(&errors) else {
            result["task"] = json!("check");
            result["verdict"] = json!("too few lines placed to tell");
            result["need"] = json!("nothing");
            return Ok(result);
        };
        let flagged = aligned.iter().filter(|l| !l.flags.is_empty()).count();
        result["task"] = json!("check");
        result["verdict"] = json!(v.fit);
        result["offset_ms"] = json!(v.offset_ms);
        result["drift_ms_per_minute"] = json!(v.drift_ms_per_minute);
        result["flagged"] = json!(flagged);
        let fit = engine.fit(&listening, &texts.join("\n"));
        result["identity"] = json!({ "fit": fit.map(|f| (f * 100.0).round() / 100.0) });
        let need = match v.fit {
            Fit::Fits | Fit::DoesNotFit => Need::Nothing, // a timing that fits stays; one that does not fit has the wrong words (listed, not changed)
            Fit::Shifted | Fit::Drifts => decide(
                fit.is_some_and(|f| f >= ctx.limits.floor),
                aligned.len(),
                flagged,
            ),
        };
        if matches!(v.fit, Fit::Shifted | Fit::Drifts) {
            result["lines"] = lines_json(&aligned);
            result["lrc"] = json!(to_lrc(&aligned));
        }
        result["need"] = json!(match need {
            Need::Nothing => "nothing",
            Need::Sure => "sure",
            Need::Review => "review",
        });
        return Ok(result);
    }

    // 2. words and no timing, or 3. no words at all
    let (lines, source, identity_json, words_sure) = if plain.split_whitespace().count() >= 8 {
        let lines = lyric_lines(plain);
        let fit = engine.fit(&listening, plain);
        let shown = fit.map(|f| (f * 100.0).round() / 100.0);
        if fit.is_none_or(|f| f < ctx.limits.floor) {
            result["task"] = json!("sync");
            result["verdict"] = json!("the lyrics in the file do not match this recording");
            result["identity"] = json!({ "fit": shown });
            result["need"] = json!("review");
            return Ok(result);
        }
        (lines, "file", json!({ "fit": shown }), true)
    } else {
        if voice.probably_instrumental() {
            result["task"] = json!("instrumental");
            result["verdict"] = json!("probably instrumental");
            result["need"] = json!("review");
            return Ok(result);
        }
        if title.trim().is_empty() || artist.trim().is_empty() {
            result["task"] = json!("find");
            result["verdict"] = json!("no title or artist to search with");
            result["need"] = json!("review");
            return Ok(result);
        }
        let candidates = crate::lyrics_lookup::loose_candidates(
            &ctx.base_url,
            title,
            artist,
            false,
            &ctx.agent,
            ctx.pause,
        )
        .map_err(|(code, message)| format!("{code}: {message}"))?;
        let texts: Vec<String> = candidates
            .iter()
            .map(|c| {
                c["plain"]
                    .as_str()
                    .or(c["synced"].as_str())
                    .map(|t| lyric_lines(t).join("\n"))
                    .unwrap_or_default()
            })
            .collect();
        let refs: Vec<&str> = texts.iter().map(String::as_str).collect();
        // Each distinct text is tried once (the same lyrics sit on many records), and at most 30 texts: trying one means forcing its words into the song.
        let mut tried: std::collections::HashMap<String, Option<f64>> =
            std::collections::HashMap::new();
        let fits: Vec<Option<f64>> = refs
            .iter()
            .map(|t| {
                let key = mediaverse_lyric_ai::text::words(t, true).join(" ");
                if let Some(known) = tried.get(&key) {
                    return *known;
                }
                let fit = if tried.len() < 30 {
                    engine.fit(&listening, t)
                } else {
                    None
                };
                tried.insert(key, fit);
                fit
            })
            .collect();
        // Records of the same song (same artist and title) are one song when choosing.
        let names: Vec<(String, String)> = candidates
            .iter()
            .map(|c| {
                (
                    c["artist"].as_str().unwrap_or("").to_owned(),
                    c["track"].as_str().unwrap_or("").to_owned(),
                )
            })
            .collect();
        let mut merged = texts.clone();
        merge_same_song(&mut merged, &fits, &names);
        let merged_refs: Vec<&str> = merged.iter().map(String::as_str).collect();
        let choice = choose_by_fit(&fits, &merged_refs, ctx.limits);
        // the best few, for the report (and for finding out why a song was not settled)
        let mut order: Vec<usize> = (0..candidates.len())
            .filter(|&i| fits[i].is_some())
            .collect();
        order.sort_by(|&a, &b| {
            fits[b]
                .partial_cmp(&fits[a])
                .unwrap_or(std::cmp::Ordering::Equal)
        });
        let mut shown_texts = std::collections::HashSet::new();
        order.retain(|&i| {
            shown_texts.insert(mediaverse_lyric_ai::text::words(&texts[i], true).join(" "))
        });
        result["ranking"] = json!(
            order
                .iter()
                .take(6)
                .map(|&i| json!({ "artist": candidates[i]["artist"], "track": candidates[i]["track"], "fit": fits[i].map(|f| (f * 100.0).round() / 100.0), "words": texts[i].split_whitespace().count() }))
                .collect::<Vec<_>>()
        );
        match choice {
            Verdict::None => {
                result["task"] = json!("find");
                result["verdict"] = json!(if candidates.is_empty() {
                    "no lyrics found"
                } else {
                    "no found lyrics match this recording"
                });
                result["candidates"] = json!(candidates.len());
                result["need"] = json!("review");
                return Ok(result);
            }
            Verdict::Likely(i, fit) | Verdict::Sure(i, fit) => {
                let sure = matches!(choice, Verdict::Sure(..));
                let c = &candidates[i];
                (
                    lyric_lines(&texts[i]),
                    "found",
                    json!({ "fit": (fit * 100.0).round() / 100.0, "candidate": { "id": c["id"], "artist": c["artist"], "track": c["track"], "album": c["album"], "duration": c["duration"], "same_artist": c["same_artist"] }, "candidates": candidates.len() }),
                    sure,
                )
            }
        }
    };
    let aligned = engine.time(&listening, &lines);
    let flagged = aligned.iter().filter(|l| !l.flags.is_empty()).count();
    let placed = aligned.iter().filter(|l| l.start.is_some()).count();
    result["task"] = json!(if source == "file" { "sync" } else { "find" });
    result["identity"] = identity_json;
    result["flagged"] = json!(flagged);
    if placed * 10 < aligned.len() * 8 {
        result["verdict"] = json!("too few lines could be placed");
        result["need"] = json!("review");
        return Ok(result);
    }
    result["verdict"] = json!("timed");
    result["lines"] = lines_json(&aligned);
    result["lrc"] = json!(to_lrc(&aligned));
    let stuck = first_line_stuck(&aligned);
    result["first_line_stuck"] = json!(stuck);
    result["need"] = json!(match decide(words_sure, aligned.len(), flagged) {
        Need::Sure => "sure",
        _ => "review",
    });
    Ok(result)
}

fn results_dir(data_dir: &Path) -> PathBuf {
    data_dir.join("lyric-ai").join("results")
}

fn fail(code: &str, message: impl ToString) -> (String, String) {
    (code.to_owned(), message.to_string())
}

/// An artist or title squashed for comparing: without anything in brackets, lower case letters and digits only.
fn squash(name: &str) -> String {
    let mut out = String::new();
    let mut depth = 0usize;
    for c in name.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            c if depth == 0 && c.is_alphanumeric() => out.extend(c.to_lowercase()),
            _ => {}
        }
    }
    out
}

/// The words of one song differ a little between lyric records (spelling, ad-libs). Records with the same artist and title as the best-fitting one count as that
/// song: their text is replaced by the best text, so the choice does not take them for rival songs and refuse both (7 of about 600 refused songs in one pass:
/// Deftones' "Rapture" fitted at -2.21 and -2.25 as two records and was refused for lack of a clear winner).
pub(crate) fn merge_same_song(
    texts: &mut [String],
    fits: &[Option<f64>],
    names: &[(String, String)],
) {
    let Some((best, _)) = fits
        .iter()
        .enumerate()
        .filter_map(|(i, f)| f.map(|f| (i, f)))
        .max_by(|a, b| a.1.total_cmp(&b.1))
    else {
        return;
    };
    let key = |n: &(String, String)| (squash(&n.0), squash(&n.1));
    let best_key = key(&names[best]);
    if best_key.1.is_empty() {
        return;
    }
    let text = texts[best].clone();
    for i in 0..texts.len() {
        if i != best && fits[i].is_some() && key(&names[i]) == best_key {
            texts[i] = text.clone();
        }
    }
}

/// Decodes a song for the Lyric AI: stereo at 44.1 kHz as floats. The defect scanner's decoder refuses anything that is not CD quality; listening does not
/// need that, so an MP3 at another sample rate (48 kHz is common, and 24 songs of one pass were lost to it) is brought to 44.1 kHz here.
pub(crate) fn decode_for_listening(file: &Path) -> Result<(Vec<f32>, Vec<f32>), String> {
    let is_mp3 = file
        .extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| e.eq_ignore_ascii_case("mp3"));
    if !is_mp3 {
        let packed = crate::library_defects::decode_file(file)?;
        return Ok(channels(&packed));
    }
    let size = std::fs::metadata(file)
        .map_err(|e| format!("could not read the file: {e}"))?
        .len();
    if size > 400 * 1024 * 1024 {
        return Err("the file is too large to scan".to_owned());
    }
    let bytes = std::fs::read(file).map_err(|e| format!("could not read the file: {e}"))?;
    let decoded = nanomp3::decode_all::<i16>(&bytes);
    let (left, right): (Vec<f32>, Vec<f32>) = match decoded.channels {
        Some(nanomp3::Channels::Stereo) => (
            decoded
                .samples
                .chunks_exact(2)
                .map(|c| f32::from(c[0]) / 32_768.0)
                .collect(),
            decoded
                .samples
                .chunks_exact(2)
                .map(|c| f32::from(c[1]) / 32_768.0)
                .collect(),
        ),
        Some(nanomp3::Channels::Mono) => {
            let mono: Vec<f32> = decoded
                .samples
                .iter()
                .map(|&s| f32::from(s) / 32_768.0)
                .collect();
            (mono.clone(), mono)
        }
        None => return Err("the MP3 holds no readable audio".to_owned()),
    };
    Ok(to_44100(left, right, decoded.sample_rate as u32))
}

/// Both channels at 44.1 kHz (unchanged when they already are).
fn to_44100(left: Vec<f32>, right: Vec<f32>, rate: u32) -> (Vec<f32>, Vec<f32>) {
    if rate == 44_100 || rate == 0 {
        return (left, right);
    }
    (
        mediaverse_lyric_engine::dsp::resample(&left, rate, 44_100),
        mediaverse_lyric_engine::dsp::resample(&right, rate, 44_100),
    )
}
/// Left and right channels as floats from the sidecar's packed stereo samples (left in the low 16 bits).
fn channels(packed: &[u32]) -> (Vec<f32>, Vec<f32>) {
    let left = packed
        .iter()
        .map(|&s| f32::from(s as u16 as i16) / 32_768.0)
        .collect();
    let right = packed
        .iter()
        .map(|&s| f32::from((s >> 16) as u16 as i16) / 32_768.0)
        .collect();
    (left, right)
}

impl Drives {
    /// `lyric_ai_analyse {paths, apply_sure?, batch?}`: a job that listens to each song and decides what its lyrics need (see `analyse_song`). The result of every
    /// song is kept in `<data>/lyric-ai/results`; those that need a person are also put in Review > Lyrics > To review. With `apply_sure` (and a `batch` id for
    /// Undo) the results that are certain are written into the songs as well.
    pub(crate) fn lyric_ai_analyse(
        self: &std::sync::Arc<Self>,
        args: &Value,
    ) -> Result<Value, (String, String)> {
        let paths: Vec<String> = args["paths"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
            .map(str::to_owned)
            .collect();
        if paths.is_empty() || paths.len() > 20_000 {
            return Err(fail("invalid_arguments", "Give between 1 and 20000 songs."));
        }
        let missing = load_config(&self.data_dir).missing();
        if !missing.is_empty() {
            return Err(fail(
                "not_configured",
                format!(
                    "The lyric AI is not set up: missing {}.",
                    missing.join(", ")
                ),
            ));
        }
        let apply_sure = args["apply_sure"].as_bool().unwrap_or(false);
        let again = args["again"].as_bool().unwrap_or(false);
        let batch = args["batch"]
            .as_str()
            .filter(|b| {
                !b.is_empty()
                    && b.len() <= 64
                    && b.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            })
            .map(str::to_owned);
        if apply_sure && batch.is_none() {
            return Err(fail(
                "invalid_arguments",
                "Applying results needs a batch id (so it can be undone).",
            ));
        }
        let base_url = self.settings.lyrics_base_url();
        Ok(self.start_job(move |this, id| {
            let (canceller, stop) = Canceller::flag();
            if let Ok(mut jobs) = this.jobs.lock() {
                jobs.insert(id.to_owned(), canceller);
            }
            trust::forget(); // what was written or confirmed a moment ago counts now
            let contact = this.metadata.current().identity.contact.trim().to_owned();
            let agent = mediaverse_disc_metadata::musicbrainz::user_agent(
                "MediaVerseStudio",
                env!("CARGO_PKG_VERSION"),
                if contact.is_empty() { "https://github.com/MediaVerseStudio/MediaVerse-Studio" } else { &contact },
            );
            let pause = || this.metadata.wait_turn("lrclib", std::time::Duration::from_millis(500));
            let root = (this.library_root)();
            let ctx = Context { root: root.as_deref(), base_url, agent, pause: &pause, limits: this.lyric_ai.limits() };
            let results = results_dir(&this.data_dir);
            let _ = std::fs::create_dir_all(&results);
            let (mut sure, mut applied, mut review, mut nothing, mut failed, mut skipped) = (0usize, 0usize, 0usize, 0usize, 0usize, 0usize);
            let total = paths.len();
            let mut streak = FailStreak::default();
            let mut aborted: Option<String> = None;
            for (n, path) in paths.iter().enumerate() {
                if aborted.is_some() || stop.load(std::sync::atomic::Ordering::SeqCst) {
                    break;
                }
                this.output.emit("job-progress", json!({ "kind": "lyric_ai", "done": n, "total": total, "skipped": skipped, "current": Path::new(path).file_name().map(|f| f.to_string_lossy().into_owned()) }));
                // Asked about in the last 30 days (a result is kept for every song that was not written): not again, unless asked to (`again`).
                if !again
                    && std::fs::metadata(results.join(format!("{}.json", crate::lyrics_review::key_of(path))))
                        .and_then(|m| m.modified())
                        .ok()
                        .and_then(|t| t.elapsed().ok())
                        .is_some_and(|age| age < std::time::Duration::from_secs(30 * 24 * 3600))
                {
                    skipped += 1;
                    continue;
                }
                // Words the band put into its own file (or a person confirmed) are already matched: timing them is Step 4's work (D169).
                let existing = crate::library_media::track_lyrics(path, ctx.root).unwrap_or(Value::Null);
                if existing.is_object() && trust::untimed(&existing) && trust::current(&this.data_dir).words_settled(path) {
                    skipped += 1;
                    continue;
                }
                let outcome = this.lyric_ai_song(path, &ctx);
                let result = match outcome {
                    Ok(r) => {
                        streak.succeeded();
                        r
                    }
                    Err(message) => {
                        failed += 1;
                        if streak.failed(&message) {
                            aborted = Some(message.clone());
                        }
                        json!({ "path": path, "task": "error", "verdict": message, "need": "review" })
                    }
                };
                // No singing at all: the song is listed as instrumental (nothing is written to it, and one press in Review puts it back), so nobody has to
                // look at the many instrumentals of a library.
                if result["task"] == "instrumental" {
                    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).map_or(0, |d| d.as_secs());
                    let _ = crate::lyrics_instrumental::Store::new(&this.data_dir).mark(path, "no singing found (Lyric AI)", now);
                    nothing += 1;
                    this.output.emit("job-progress", json!({ "kind": "lyric_ai_result", "result": summary_of(&result, false) }));
                    continue;
                }
                match result["need"].as_str() {
                    Some("sure") => {
                        sure += 1;
                        if apply_sure
                            && let (Some(lrc), Some(batch)) = (result["lrc"].as_str(), batch.as_deref())
                            && this.lyric_ai_write(path, lrc, batch).is_ok()
                        {
                            applied += 1;
                            continue_after_apply(&results, path);
                            this.output.emit("job-progress", json!({ "kind": "lyric_ai_result", "result": summary_of(&result, true) }));
                            continue;
                        }
                        // Certain but not written (the person unticked "write"): put it under To review, timed, so it can be played and checked.
                        if result["lrc"].is_string() {
                            this.lyric_ai_to_review(path, &result);
                        }
                    }
                    Some("review") => {
                        review += 1;
                        if result["lrc"].is_string() {
                            this.lyric_ai_to_review(path, &result);
                        }
                    }
                    _ => nothing += 1,
                }
                // A song that could not be read is not remembered as "checked" (a dropped connection would otherwise keep it out for 30 days).
                if result["task"] != "error" {
                    let _ = std::fs::write(results.join(format!("{}.json", crate::lyrics_review::key_of(path))), result.to_string());
                }
                this.output.emit("job-progress", json!({ "kind": "lyric_ai_result", "result": summary_of(&result, false) }));
            }
            Ok(json!({ "songs": total, "sure": sure, "applied": applied, "review": review, "nothing": nothing, "skipped": skipped, "failed": failed, "aborted": aborted, "stopped": stop.load(std::sync::atomic::Ordering::SeqCst) }))
        }))
    }

    /// One song: its tags and lyrics, its audio, the engine.
    fn lyric_ai_song(&self, path: &str, ctx: &Context) -> Result<Value, String> {
        self.lyric_ai_song_as(path, ctx, None)
    }

    /// The same, searching for lyrics under `artist` instead of the song's own artist tag (a cover album's original artist).
    fn lyric_ai_song_as(
        &self,
        path: &str,
        ctx: &Context,
        artist: Option<&str>,
    ) -> Result<Value, String> {
        let file = resolve_in_library(path, ctx.root)?;
        // A song someone confirmed as instrumental carries the language "zxx" (no linguistic content): nothing to listen for.
        let tagged_instrumental = mediaverse_metadata_tags::read_tag_fields(
            &file,
            &[mediaverse_metadata_tags::TagField::Language],
        )
        .ok()
        .and_then(|fields| fields.into_iter().next())
        .and_then(|(_, value)| value)
        .is_some_and(|language| language.eq_ignore_ascii_case("zxx"));
        if tagged_instrumental {
            return Ok(
                json!({ "path": path, "task": "instrumental_confirmed", "verdict": "tagged instrumental (language zxx)", "need": "nothing" }),
            );
        }
        let tags =
            mediaverse_metadata_tags::read_track_metadata(&file).map_err(|e| e.to_string())?;
        let existing = crate::library_media::track_lyrics(path, ctx.root).unwrap_or(Value::Null);
        let (left, right) = decode_for_listening(&file)?;
        let (title, artist) = (
            tags.title.clone().unwrap_or_default(),
            artist
                .map(str::to_owned)
                .unwrap_or_else(|| tags.artist.clone().unwrap_or_default()),
        );
        self.lyric_ai
            .with_engine(|engine| {
                analyse_song(
                    engine,
                    path,
                    &existing,
                    |e| e.listen(&left, &right, |_| {}),
                    &title,
                    &artist,
                    ctx,
                )
            })
            .map(|mut r| {
                r["album"] = json!(tags.album);
                r
            })
    }

    /// Writes timed lyrics into a song through the same path as every other lyrics change (journalled under `batch`, so it can be undone).
    fn lyric_ai_write(&self, path: &str, lrc: &str, batch: &str) -> Result<Value, String> {
        crate::library_media::update_track_media(
            &json!({ "paths": [path], "lyrics": { "text": lrc }, "batch": batch }),
            (self.library_root)().as_deref(),
            &self.data_dir,
        )
    }

    /// A result that needs a person goes to Review > Lyrics > To review, where the song can be played and the lines nudged.
    fn lyric_ai_to_review(&self, path: &str, result: &Value) {
        let candidate = json!({
            "id": result["identity"]["candidate"]["id"], "track": result["title"], "artist": result["artist"], "album": result["album"], "duration": Value::Null,
            "plain": result["lrc"].as_str().map(|l| lyric_lines(l).join("\n")), "synced": result["lrc"],
            "confidence": judge::ai_confidence(result), "source": "lyric-ai", "other_version": false, "other_artist": false, "length_unknown": false,
            "band_words": result["band_words"] == true,
        });
        let now = std::time::SystemTime::now()
            .duration_since(std::time::UNIX_EPOCH)
            .map_or(0, |d| d.as_secs());
        let args = json!({ "title": result["title"], "artist": result["artist"], "album": result["album"], "candidates": [candidate] });
        let _ = crate::lyrics_review::LyricsReview::new(&self.data_dir).save(path, &args, now);
    }

    /// `lyric_ai_results`: what the last analyses found, without the lines (they are in the staged file).
    pub(crate) fn lyric_ai_results(&self) -> Value {
        let mut items: Vec<Value> = std::fs::read_dir(results_dir(&self.data_dir))
            .into_iter()
            .flatten()
            .flatten()
            .filter_map(|e| std::fs::read(e.path()).ok())
            .filter_map(|b| serde_json::from_slice::<Value>(&b).ok())
            .map(|r| summary_of(&r, false))
            .collect();
        items.sort_by(|a, b| a["path"].as_str().cmp(&b["path"].as_str()));
        json!({ "items": items })
    }

    /// `lyric_ai_apply {paths, batch}`: writes the staged timing of these songs (the person looked, or chose "apply all that are sure").
    pub(crate) fn lyric_ai_apply(&self, args: &Value) -> Result<Value, (String, String)> {
        let batch = args["batch"]
            .as_str()
            .filter(|b| {
                !b.is_empty()
                    && b.len() <= 64
                    && b.chars().all(|c| c.is_ascii_alphanumeric() || c == '-')
            })
            .ok_or_else(|| fail("invalid_arguments", "The batch id is not valid."))?;
        let (mut applied, mut problems) = (0usize, Vec::new());
        for path in args["paths"]
            .as_array()
            .into_iter()
            .flatten()
            .filter_map(Value::as_str)
        {
            let file = results_dir(&self.data_dir)
                .join(format!("{}.json", crate::lyrics_review::key_of(path)));
            let Some(result) = std::fs::read(&file)
                .ok()
                .and_then(|b| serde_json::from_slice::<Value>(&b).ok())
            else {
                problems.push(json!({ "path": path, "message": "no staged result" }));
                continue;
            };
            let Some(lrc) = result["lrc"].as_str() else {
                problems.push(json!({ "path": path, "message": "nothing to write for this song" }));
                continue;
            };
            match self.lyric_ai_write(path, lrc, batch) {
                Ok(_) => {
                    applied += 1;
                    let _ = std::fs::remove_file(&file);
                    let _ = crate::lyrics_review::LyricsReview::new(&self.data_dir)
                        .remove(&crate::lyrics_review::key_of(path));
                }
                Err(message) => problems.push(json!({ "path": path, "message": message })),
            }
        }
        Ok(json!({ "applied": applied, "problems": problems }))
    }
}

/// A staged result applied: its file is no longer needed.
fn continue_after_apply(results: &Path, path: &str) {
    let _ =
        std::fs::remove_file(results.join(format!("{}.json", crate::lyrics_review::key_of(path))));
}

/// A result without its lines, for lists and progress events.
pub fn summary_of(result: &Value, applied: bool) -> Value {
    let mut s = json!({});
    for key in [
        "path",
        "title",
        "artist",
        "album",
        "task",
        "verdict",
        "need",
        "identity",
        "ranking",
        "voice",
        "flagged",
        "offset_ms",
        "drift_ms_per_minute",
        "seconds",
        "candidates",
    ] {
        if !result[key].is_null() {
            s[key] = result[key].clone();
        }
    }
    s["lines"] = json!(result["lines"].as_array().map_or(0, Vec::len));
    s["has_timing"] = json!(result["lrc"].is_string());
    s["applied"] = json!(applied);
    s
}
#[cfg(test)]
mod tests {
    use super::*;

    fn timed(start: Option<f64>) -> LineTime {
        LineTime {
            text: "la".to_owned(),
            start,
            end: start.map(|s| s + 2.0),
            score: Some(0.5),
            words: Vec::new(),
            flags: Vec::new(),
        }
    }

    #[test]
    fn a_first_line_squeezed_in_at_the_start_is_recognised() {
        // The Break Free case: 0.3 s, then 17.6 s.
        assert!(first_line_stuck(&[timed(Some(0.3)), timed(Some(17.6))]));
        // An unplaced first line is skipped, the next two are compared.
        assert!(first_line_stuck(&[
            timed(None),
            timed(Some(0.4)),
            timed(Some(12.0))
        ]));
        // A song that really starts singing at once, or a normal late start, is not.
        assert!(!first_line_stuck(&[timed(Some(0.3)), timed(Some(4.0))]));
        assert!(!first_line_stuck(&[timed(Some(12.3)), timed(Some(19.9))]));
        assert!(!first_line_stuck(&[timed(Some(0.3))]));
        assert!(!first_line_stuck(&[]));
    }

    #[test]
    fn a_run_stops_after_the_same_failure_repeats_but_not_for_mixed_ones() {
        let mut streak = FailStreak::default();
        for _ in 0..MAX_SAME_FAILURES - 1 {
            assert!(!streak.failed("No music library folder is chosen."));
        }
        assert!(streak.failed("No music library folder is chosen."));

        // Different messages, or a song that worked in between, start counting again.
        let mut streak = FailStreak::default();
        for i in 0..50 {
            assert!(!streak.failed(&format!("problem {}", i % 2)));
        }
        for _ in 0..MAX_SAME_FAILURES - 1 {
            assert!(!streak.failed("same"));
        }
        streak.succeeded();
        assert!(!streak.failed("same"));
    }

    #[test]
    fn the_rule_needs_certain_words_and_few_flagged_lines() {
        assert_eq!(decide(true, 40, 2), Need::Sure);
        assert_eq!(
            decide(true, 40, 4),
            Need::Sure,
            "exactly a tenth is allowed"
        );
        assert_eq!(decide(true, 40, 5), Need::Review);
        assert_eq!(
            decide(false, 40, 0),
            Need::Review,
            "uncertain words always go to a person"
        );
        assert_eq!(decide(true, 0, 0), Need::Review);
    }

    #[test]
    fn the_music_reader_is_chosen_in_the_settings_and_its_files_are_checked() {
        let dir = std::env::temp_dir().join(format!("lyric-ai-music-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ai = LyricAi::new(&dir);
        // the music-lyrics reader is the default (D151) and the original reader stays choosable
        assert_eq!(ai.status()["reader_model"], "music");
        assert!(ai.configure(&json!({ "reader_model": "whisper" })).is_err());
        assert!(
            ai.configure(&json!({ "music_onnx": "..\\evil.onnx" }))
                .is_err(),
            "a model is named by its file name only"
        );
        assert!(ai.configure(&json!({ "music_vocab": "a/b.json" })).is_err());
        let status = ai
            .configure(&json!({ "reader_model": "music", "models": dir.to_string_lossy() }))
            .unwrap();
        assert_eq!(status["reader_model"], "music");
        assert_eq!(status["music_onnx"], "aligner-fp16.onnx");
        let missing = status["missing"].to_string();
        assert!(
            missing.contains("aligner-fp16.onnx") && missing.contains("vocab.json"),
            "{missing}"
        );
        assert!(
            !missing.contains("htdemucs"),
            "the music reader needs no separator: {missing}"
        );
        // its cut-offs are its own
        assert!(ai.limits().floor > FitLimits::default().floor);
        // the speech reader, once chosen, is kept
        let status = ai
            .configure(&json!({ "reader_model": "wav2vec2" }))
            .unwrap();
        assert_eq!(status["reader_model"], "wav2vec2");
        assert_eq!(LyricAi::new(&dir).status()["reader_model"], "wav2vec2");
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn the_whisper_files_are_found_in_a_folder_or_its_onnx_folder() {
        let dir = std::env::temp_dir().join(format!("lyric-ai-whisper-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(dir.join("onnx")).unwrap();
        let missing = whisper_files(&dir).unwrap_err();
        assert_eq!(missing.len(), 4, "{missing:?}");
        // as the download has them: the two ONNX files in an `onnx` folder, the other two beside it
        for f in ["encoder_model_fp16.onnx", "decoder_model_merged_fp16.onnx"] {
            std::fs::write(dir.join("onnx").join(f), b"x").unwrap();
        }
        assert_eq!(whisper_files(&dir).unwrap_err().len(), 2);
        for f in ["vocab.json", "generation_config.json"] {
            std::fs::write(dir.join(f), b"{}").unwrap();
        }
        let files = whisper_files(&dir).unwrap();
        assert!(
            files.encoder.ends_with("onnx/encoder_model_fp16.onnx")
                || files.encoder.ends_with("onnx\\encoder_model_fp16.onnx")
        );
        // the default place is a `whisper` folder inside the models folder
        let ai = LyricAi::new(&dir);
        let status = ai
            .configure(&json!({ "models": dir.to_string_lossy() }))
            .unwrap();
        assert!(
            status["whisper_folder"]
                .as_str()
                .unwrap()
                .ends_with("whisper")
        );
        assert_eq!(status["whisper_ready"], false);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn records_of_one_song_are_not_rivals() {
        let names: Vec<(String, String)> = [
            ("Deftones", "Rapture"),
            ("Deftones", "Rapture (Album Version)"),
            ("Someone Else", "Rapture"),
        ]
        .iter()
        .map(|(a, t)| ((*a).to_owned(), (*t).to_owned()))
        .collect();
        let mut texts: Vec<String> =
            vec!["words one".into(), "words two".into(), "other song".into()];
        merge_same_song(&mut texts, &[Some(-2.2), Some(-2.25), Some(-2.3)], &names);
        assert_eq!(
            texts,
            ["words one", "words one", "other song"],
            "same artist and title (brackets ignored) share the best text; another artist's does not"
        );
        // no fits at all: nothing changes
        let mut same = vec!["a".to_owned(), "b".to_owned()];
        merge_same_song(&mut same, &[None, None], &names[..2]);
        assert_eq!(same, ["a", "b"]);
    }

    #[test]
    fn audio_at_another_sample_rate_is_brought_to_44100() {
        let tone: Vec<f32> = (0..48_000).map(|n| (n as f32 * 0.05).sin()).collect();
        let (left, right) = to_44100(tone.clone(), tone.clone(), 48_000);
        assert!((left.len() as i64 - 44_100).abs() <= 2, "{}", left.len());
        assert_eq!(left.len(), right.len());
        let (same, _) = to_44100(tone.clone(), tone.clone(), 44_100);
        assert_eq!(same, tone, "44.1 kHz is left alone");
    }

    #[test]
    fn lyric_lines_drop_timestamps_and_blanks() {
        assert_eq!(
            lyric_lines("[00:01.00] First\n\n[00:04.50][00:30.00]Second\nThird [not a stamp]\n  "),
            ["First", "Second", "Third [not a stamp]"]
        );
    }

    #[test]
    fn the_settings_are_merged_and_checked() {
        let dir = std::env::temp_dir().join(format!("lyric-ai-test-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let ai = LyricAi::new(&dir);
        assert_eq!(ai.status()["ready"], false);
        assert!(ai.configure(&json!({ "separator": "tpu" })).is_err());
        let status = ai.configure(&json!({ "runtime": "C:\\x\\onnxruntime.dll", "models": "C:\\x\\models", "separator": "cuda", "library_folders": ["C:\\cuda"] })).unwrap();
        assert_eq!(status["separator"], "cuda");
        assert_eq!(
            status["reader"], "cpu",
            "what was not given keeps its default"
        );
        // the default (music) reader: the runtime plus its two files
        assert!(status["missing"].as_array().unwrap().len() >= 3);
        let again = load_config(&dir);
        assert_eq!(again.library_folders, [PathBuf::from("C:\\cuda")]);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
