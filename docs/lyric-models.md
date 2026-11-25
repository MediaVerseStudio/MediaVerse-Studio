# Lyric AI models: the known list, how they rank, and how a person adds one (plan, 2026-11-18)

Owner's decisions (2026-11-18): open to using several models; the person must be able to **download and select their own model**; keep a **list of known models ranked
by test result**, with links or a download mechanism. Nothing here is built yet: this is the list, the ranking method and the design. Test scripts and raw numbers are in
`MediaVerse-Lyric-Sync-Lab\judge-lab` (see D134 addendum 2 in the decision log); the original plan is `docs/lyric-ai-plan.md`.

## What a model is used for (roles)

| Role | What it does | Needs |
|---|---|---|
| **Reader** (CTC) | Gives, for every 20 ms of a song, the odds of each letter. Used to decide *which lyrics belong to a song* (fit), to *time* the lines, to score lines, and to hear whether anyone sings. | A CTC model whose letters are known (vocabulary file). |
| **Separator** (optional) | Splits the voice from the band before reading. | Not needed by the music-lyrics readers (see below). |
| **Transcriber** (later) | Writes a draft of the words for songs nobody has lyrics for (to Review only). | A speech-to-text model, e.g. Whisper. |

## Known models, ranked by our tests

Test set: 40 library songs with human-timed lyrics (the stamps are a noisy proxy for truth, so timing differences under about 3 points mean nothing). "Identity" is the
right lyrics against 12 wrong ones. "Lines" is how many swapped-in lines (a stand-in for a singer straying) are caught when 5% / 10% of genuine lines are flagged by mistake.
Speed is on the RTX 4090 (a 4 minute song).

| # | Model | Role | Licence | Audio | Identity (right ranks first) | Timing (0.5 s) | Lines caught 5% / 10% | Speed | Notes |
|---|---|---|---|---|---|---|---|---|---|
| 1 | **`mrfakename/w2v-bert-2.0-music-lyrics-ctc`** | Reader | MIT | full mix | **40/40** | 85.0% | 28% / 79% | 125x | Best for matching and timing. 0.6 B parameters (2.3 GB as released; an fp16/int8 ONNX export exists: `redbaty/ytm-lyrics-aligner`, MIT). Characters, 921 tokens, many scripts (not only English). Training data undocumented (accepted by the owner, D136). 12.8% character error on held-out songs (its card). Has a vocal-activity head (`aux_heads.safetensors`) that could replace the instrumental test. |
| 2 | **`radiant-lyrics/sylla-600m-v1`** | Reader / line hint | **GPL-3.0** (bases MIT) | full mix | 39/40 | 83.0% | **79% / 96%** | same architecture and size as row 1 (not timed separately) | Best at telling lines that are not sung as written. No lateness (usual offset 0 ms, the others +160 ms). Card: 95.7% of English word onsets within 0.3 s (JamendoLyrics++). Trained on commercial recordings with human-timed lyrics; the data is not released (provenance accepted by the owner, D136; offered as a separate download, never bundled, D137). |
| 3 | Current: wav2vec2 large 960 h (fairseq, ONNX) | Reader | MIT | **separated vocals** | 39/40 | 83.1% | 30% / 56% | 350x (plus separation) | What the program uses today. Speech-trained, so it needs the separation step. |
| 4 | **Whisper large-v3-turbo** (`onnx-community/whisper-large-v3-turbo`, ONNX fp16) | Transcriber (drafts) | MIT (OpenAI's weights) | full mix | n/a | n/a | n/a | 110x | **Built in (D142)**: used for drafts of songs nobody has lyrics for. 1.27 GB encoder + 344 MB decoder. Median word error 32% on the plain mix (greedy); the draft is checked against the singing by the music reader (fit predicts errors, -0.88). Needs no separator. |
| - | Whisper large-v3 (`Systran/faster-whisper-large-v3`, tests only) | Transcriber | MIT | separated vocals | n/a | n/a | 46% / 69% (as a helper) | slower | Hears nothing for about 14% of genuine lines of this music. Useful for drafts and as a second opinion; combined with the current reader 82% at 10%. |
| - | `htdemucs` (adefossez, ONNX core) | Separator | repository MIT, **weights' licence not stated** | n/a | n/a | n/a | n/a | 106x | Not needed by rows 1 and 2 (they were as good or better on the mix); skipping it saves about 35% of processing and removes this licence question. |
| - | `hcX02/echora-moss-0.9b-multilingual-lyrics-transcriber` | Transcriber | Apache-2.0 | ? | untested | untested | untested | ? | Multilingual lyrics transcription. Worth testing later. |
| - | `gary109/ai-light-dance_singing*_ft_wav2vec2-*` (many) | Reader | Apache-2.0 (most) | ? | untested | untested | untested | ? | wav2vec2 fine-tuned on a singing dataset. Worth one test. |
| - | `mikezzb/wav2vec2-base-singing` | Reader | Apache-2.0 | ? | untested | untested | untested | ? | Small. Worth one test. |
| - | Meta MMS aligner | Reader | **CC-BY-NC 4.0** | vocals | not run | not run | not run | | Non-commercial: personal use only. Not offered by the program; the person may add it by hand. |
| - | `Qwen3-ASR-*-Lyrics-Viet`, `kelvinbksoh/whisper-*-vietnamese-lyrics-*` | Transcriber | Apache-2.0 | | n/a | | | | Vietnamese only. Listed so nobody searches for them again. |

**Without the separator** (rows 1 and 2 on the mix against separated vocals, same songs): `mrfakename` identity 40/40 either way; timing 85.0% against 83.8%; lines caught at
10% false flags 79% against 59%. Sylla: identity 39/40 either way; lines caught 96% against 95%. So the mix is at least as good, and the pipeline is shorter.

### How the ranking is made

A model's rank is its score on **the same four tests** on the same songs, in this order of importance: (1) identity (right lyrics first among wrong ones: a wrong choice
is the one error that does harm); (2) timing against human stamps (after the model's own usual offset); (3) lines caught at 5% false flags; (4) speed. The tests are
`identity_test.py`, `ctc_model_test.py`, `detector_test.py` in the lab; to be turned into a **benchmark built into the program** (Settings > Lyric AI > Test this model),
which runs them on songs the person already has with timed lyrics (the library has thousands) and shows the same four numbers, so a person can rank a model we never saw.
The cut-offs for "certain" and "likely" depend on the model's scale (right lyrics score about -0.4 with `mrfakename`, -1.4 with the current reader, -3.2 with Sylla), so
**every model carries its own calibration**, measured by the same benchmark (right lyrics against wrong, 12 per song) and stored with the model.

## How a person gets and selects a model (design)

1. **Manifest** (`lyric-models.json`, shipped with the program and updatable without a new release): for each known model its id, role, name, licence (with an
   "offer by default" flag that is true only for licences compatible with the program and bundling), source page, file list with size and SHA-256, format (ONNX, with
   precision variants), input needs (mix or separated voice, sample rate, front end), vocabulary file, calibration, our test results (the table above), hardware notes
   (CPU speed, GPU memory) and a short plain-language description.
2. **Settings > Lyric AI > Models:** the list in rank order with size, licence, results and a **Download** button (progress, resume, SHA-256 check, nothing runs until the
   check passes) that fetches from the model's own page (Hugging Face), not from a copy of ours; **Use for matching and timing** and **Use for line hints** choices;
   **Test this model** (the benchmark); **Remove**. A licence that restricts use (non-commercial, GPL weights) is shown in words before the download, and the
   person confirms.
3. **Add a model from a file or link:** any ONNX CTC model plus a small description file (vocabulary order, blank token, sample rate, front end, language). The program
   runs a self-test on a bundled short sample and the benchmark; only a model that passes is offered for use. Nothing is uploaded anywhere.
4. **One selected reader at a time** for matching and timing; a second model may supply line hints. A job records which model produced each result (so a later model can
   redo only what the first was unsure about).

## What has to be built (order)

**Status 2026-11-19 (D140):** steps 1, 2 and 3 are done and calibrated; step 5 is done (the instrumental rule on the mix); step 6 is partly done. Steps 4 (manifest, download, benchmark) and Sylla's export are still to do. To try the music reader: put `aligner-fp16.onnx` and `vocab.json` (from `redbaty/ytm-lyrics-aligner`, MIT) in the Models folder and choose it in Settings > Lyrics > Lyric AI.


1. ONNX export check of `mrfakename` (use the community export, verify its output against the Python model on the 40 songs; fp16/int8 accuracy measured).
2. The model's audio front end in Rust (SeamlessM4T-style 80-bin log-mel, stacked in pairs, per-song normalisation; the export ships a golden file for testing the port),
   windows of 30 s with 2 s of context.
3. A reader abstraction in `crates/lyric-engine` (letters, blank, word break from the vocabulary file) so the current reader and the new ones are interchangeable; the
   fit, alignment and thresholds read the model's calibration.
4. The manifest, download and benchmark in the sidecar; the Settings page.
5. Retire the separator from the default pipeline (keep it selectable); replace the instrumental test by the model's vocal-activity head and re-measure it (the current
   test catches 48 of 60 instrumentals with 1 of 60 wrongly flagged).
6. Re-run the calibration (the To review list is the data) and the cover-album and instrumental checks with the new reader.

## Decisions taken (and what is open)

- **Provenance (D136):** the owner accepts the undocumented training data of mrfakename and the commercial-recording training data of Sylla, for his own library and for users who choose them.
- **Bundling (D137):** mrfakename may be bundled in the with-model download; **Sylla is a separate download**, never bundled, until its GPL-3.0-only grant next to a GPL-3.0-or-later program has been checked. Whisper (1.6 GB) is a separate download too.
- **Open:** which precision the bundled model ships at (fp16 is 1.1 GB and verified; int8 needs an ONNX Runtime operator the tested build lacks); the model list and download mechanism; Sylla's ONNX export.

## Whisper and Sylla: separate downloads, two ways to get them (owner's decision, 2026-11-20, D151)

Neither model is ever inside the installer. The model list (step 4 above) offers each one two ways, and the person may use either:

1. **Get it from the project's own copy.** A GitHub release in the project repository holds the files (Whisper large-v3-turbo fp16: `encoder_model_fp16.onnx` 1.27 GB and `decoder_model_merged_fp16.onnx` 0.34 GB plus `vocab.json` and `generation_config.json`; Sylla once its ONNX export exists), each with the model's licence text and a manifest entry with its **SHA-256**. A GitHub release file may be up to 2 GB, so every file fits. The program downloads with progress and resume, checks the SHA-256, and only then marks the model usable. The licence (MIT for Whisper; GPL-3.0 for Sylla, shown in words before the download) is part of the release.
2. **Download it yourself and say where it is.** The list links the model's own page (Hugging Face); the person downloads the latest revision and picks the folder in Settings > Lyrics > Lyric AI (the Whisper folder setting exists today: `whisper_folder`). The program checks the files are the ones it needs (names, sizes, a test run) and says what is missing; it uses the files as they are, so a newer revision works as long as it has the same files.

**Catch: a release on a private repository cannot be downloaded without signing in to GitHub.** Option 1 works for other people only once the repository is public (a private release works for the owner when signed in, never for the in-app download). Until then use option 2, or keep a copy on the owner's own computer.