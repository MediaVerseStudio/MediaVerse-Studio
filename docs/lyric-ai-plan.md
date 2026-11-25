# Lyric AI: finding, checking and timing lyrics (plan, 2026-11-17; status 2026-11-19)

**Status 2026-11-19: built.** The pipeline below, the sidecar jobs (`lyric_ai_analyse`, `lyric_ai_judge`, `lyric_ai_draft`), the review pages and the settings exist (D127 to D142).
Two parts of this plan changed on the way: the reader is now selectable, and the **music-lyrics reader on the full mix is a better default than the speech reader behind a
separator** (D140: no separation step, 59 of 60 instrumentals caught, right and wrong lyrics better separated); and Whisper drafts lyrics for songs nobody has (D142). Models, their
ranking and the download plan: `docs/lyric-models.md`. What is next: `docs/roadmap.md`, step 2.

Owner's decisions (2026-11-17): build it **into the program**, with the **models as separate, optional downloads**; the best and fastest models for
this PC and library by default, but **other models selectable** (Settings, including a file picked from disk); keep the program itself slim
(fixing a library is rarer than playing music); work happens on branch `lyric-sync` and is merged when it proves itself and the licences allow.
The Python prototype in `tools/lyric-sync/` is the reference and the test oracle; its README holds the measurements.

## What it does (the pipeline)

1. **Find candidates, loosely.** Ask LRCLIB (and later other allowed sources) with several spellings of the title (numbers, Roman numerals,
   "&"/"and", "(Live)", "[Remastered]", track numbers, "feat."), with and without the artist, and by free text; collect every record that roughly
   matches the artist and title.
2. **Listen.** Separate the vocals; read the letters the aligner model hears (greedy CTC reading). No speech-to-text model is needed (tested:
   letter 4-grams of the reading against the lyrics separate right from wrong as well as Whisper did).
3. **Decide which candidate is this song.** Score each candidate against the reading (share of its letter 4-grams found, vocables and spelling
   differences ignored); the best different text wins if it is clearly ahead of the runner-up (margin) and above a floor.
4. **Use the found lyrics as the baseline words.** Where the AI misheard, the found lyrics are right; the AI only supplies the timing.
5. **Time them.** CTC forced alignment of the words against the vocals; each line starts at its first word (written 0.2 s earlier, as the aligner
   runs late); lines with a stretched first word or a gap inside are flagged.
6. **Decide whether a person needs to listen.** Identity score high enough plus few flagged lines = apply without listening (journalled, undoable);
   otherwise the song goes to Review > Lyrics > To review with the flagged lines marked; below the floor nothing is used.
7. **Existing timing** can be checked the same way (fits / shifted / drifts / does not fit) and re-timed; **songs with no lyrics** are tested for a
   singing voice and listed as probably instrumental (the program's instrumental list).

## Measured (see `tools/lyric-sync/README.md`)

Speed 80-115x real time on the RTX 4090. Vocal separation matters (83% vs 48% of lines within 0.5 s). Text identity: right lyrics median 0.79 with
Whisper words, 0.29 with the aligner's own letters (4-grams); wrong lyrics at most 0.11 / 0.14. Aligner flags: unflagged lines 87% within 0.5 s of
existing timing, flagged 51%. A multilingual aligner (Meta MMS, non-commercial licence) is better on Spanish, worse on English.

## Running the models without PyTorch (verified 2026-11-17)

| Model | ONNX file | CPU (ONNX Runtime) | NVIDIA GPU (CUDA provider) | Any GPU (DirectML) |
|---|---|---|---|---|
| English aligner (wav2vec2 large 960 h) | 1262 MB float32 | exact (same letters in 100% of frames), 14x real time | fast | **exact, 0.12 s for 24 s of audio (200x)** |
| Vocal separator (htdemucs core, 7.8 s windows; STFT/ISTFT done by the program) | 174 MB float32 | exact (vocals error 0.00004), 7x real time | exact (0.0002), **115x** | **wrong output: not usable** |
| Multilingual aligner (MMS) | about 1.2 GB | to export and check | | |

So: runtime = ONNX Runtime loaded dynamically; the **GPU runtime is an optional download** (CUDA pack for NVIDIA, about 1 GB of libraries; DirectML for the
aligner on any other GPU; the CPU always works, slower). Quantised (float16/int8) files would be about 1/2 to 1/4 of the sizes above (accuracy to be measured).

## Shipping shape (keeps the program slim)

- The program itself gains only the engine code and (loaded when needed, not shipped in the installer) ONNX Runtime: roughly +45 MB installed.
- **Models are downloaded on demand** into `%APPDATA%\MediaVerse Studio\models\`, each with a manifest entry: id, role (`separator`, `aligner`),
  languages, files with size and SHA-256, licence and source URL, hardware notes, and what it was validated against. Settings > Lyrics AI lists
  installed and available models, shows size and licence, downloads with a progress bar and a checksum, removes, and recommends a set for this PC
  (NVIDIA GPU: separator on CUDA; any GPU: aligner on DirectML; otherwise CPU). "Add a model from a file..." takes any ONNX file with a description
  file (letters in order, which one is "nothing", sample rate, language); it runs a self-test on a bundled sample and only then offers Apply.
- Licences: wav2vec2 (MIT); Demucs code (MIT, weights' licence not stated separately: to confirm before it is offered by default; the manifest can
  list another separator); ONNX Runtime (MIT); MMS (CC-BY-NC): offered only with a clear non-commercial note, never required.

## Build order

1. **Engine crate `crates/lyric-ai` (pure logic, tested against the Python results):** text preparation and variants, CTC forced alignment, line flags,
   letter-4-gram identity score and the decision rule, instrumental test. (Started 2026-11-17.)
2. **Audio and models:** decode (Media Foundation, already used for conversions), resample, the Demucs STFT/ISTFT, chunked ONNX inference through the `ort`
   crate (dynamic loading), the reading of letters; golden-file tests against the Python outputs. Needs the owner's approval of the `ort` and `rustfft`
   crates (AGENTS.md) when reached.
3. **Sidecar commands and jobs** (`lyric_ai_*`): model status/download/remove/add, analyse a song or a folder as a cancellable job with progress, staged results.
4. **Interface:** Settings > Lyrics AI (models, hardware, thresholds); Review > Lyrics: "Find and time lyrics" for an album or the whole library with a report;
   confident results applied through `update_track_media` with a batch id (Undo), the rest into To review; the instrumental list.
5. **Calibrate** the cut-offs on more songs and on a whole real folder; later: transcription drafts for songs nobody has (an optional Whisper-class model).
