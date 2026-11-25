# Lyric sync prototype (branch `lyric-sync`)

Research tools for timing lyrics to the audio automatically. **Nothing here is part of the shipped program and nothing changes a
song**: results are staged. If it proves itself and the licences allow, it is merged back (as a helper the program runs, like
`apps/cd-helper`); if not, it stays a personal tool.

Started 2026-11-17 (owner: "create a branch build that can be merged back if/when it proves successful and the licensing works out;
if not, still try it in a personal capacity"). The Python environment and downloaded models live **outside the repo** in
`C:\Users\<you>\Developer\MediaVerse\MediaVerse-Lyric-Sync-Lab\` (Python 3.12 venv made with `uv`, PyTorch 2.8 + CUDA 12.6 on the RTX 4090).

## How it works

1. Decode the MP3 (libsndfile, no ffmpeg).
2. **Separate the vocals** (Demucs `htdemucs`).
3. **wav2vec2** (fairseq, 960 h English) gives the odds of every letter for every 20 ms of the vocals.
4. **CTC forced alignment** of the known words against those odds (`torchaudio.functional.forced_align`; deprecated in torchaudio 2.8
   and removed in 2.9, so a real integration needs its own ~60-line implementation or `ctc-forced-aligner`).
5. A line starts where its first word starts, written 0.2 s earlier (the aligner's word starts come out about 0.2 s late; see below).

| Script | What it does |
|---|---|
| `pick_songs.py` | picks songs that already have timed lyrics (the ground truth) |
| `align.py` | the pipeline above for a list of songs (`--mix` skips the separation) |
| `evaluate.py` | scores an alignment against the existing timing |
| `library_jobs.py check` | job 1: does a song's existing timing fit the audio? (fits / shifted / drifts / does-not-fit) |
| `library_jobs.py sync` | job 2: plain lyrics to a staged `.lrc` per song |

## Results (2026-11-17, English songs of the owner's library with LRCLIB timing)

- **Speed:** about 80-90x real time on the RTX 4090 (a 4-minute song in about 3 s; the whole 13,600-song library would take roughly 9 hours).
- **Vocal separation is essential:** 30 songs, lines within 0.5 s of the existing timing once each song's steady offset is removed:
  **83% with separation, 48% on the full mix.**
- **100 songs (with separation):** median spread inside a song 162 ms (the aligner is consistent); 77% of lines within 0.5 s after removing
  the song's own offset; median offset between this aligner and the existing timings +178 ms (CTC letter spikes sit late in a sound, and
  LRC makers stamp slightly early; hence the 0.2 s earlier). Existing timings differ a lot from each other: 10th to 90th percentile of
  their offset was -284 to +724 ms.
- **Job 1 on 100 other songs:** 67 fit, 13 shifted (a whole-song correction proposed), 12 drift or fail to align (re-alignment or a look
  needed), 8 do not fit (probably the wrong words). So roughly **a third of existing timings could be improved or checked.**
- **Job 2:** 30 songs with plain lyrics timed in seconds each; the first one read sensibly (lines at plausible places); the line score is
  only a weak sign of quality (a lines' score does not predict its error well), so staging and a quick check remain necessary.
- **Not measured:** the absolute truth. The "ground truth" is itself someone's timing; the only real check is to listen (the program's
  timing editor can play a staged result). Songs with non-English lyrics, spoken parts and rap (fast) align worst. Songs with long
  instrumental gaps or repeated choruses can place a line in the wrong repeat.

## Licences (checked 2026-11-17; AGENTS.md: ask before shipping anything)

| Part | Licence | For merging |
|---|---|---|
| wav2vec2 `WAV2VEC2_ASR_LARGE_960H` | MIT ("originally published by the authors of wav2vec 2.0 under MIT License and redistributed with the same license", torchaudio docs) | fine |
| Demucs code | MIT (repository README) | fine |
| Demucs `htdemucs` weights | **not stated separately**; trained on MUSDB18 (a research / non-commercial dataset) plus 800 songs. The repository is archived (Jan 2025). | **to confirm before shipping**; fine for personal use; the program is non-commercial (GPL-3.0, donations only) |
| PyTorch / torchaudio | BSD-3 | fine, but a 2.5 GB runtime: a merged version would rather use ONNX Runtime or CTranslate2 and ship small exported models |
| mutagen (lab only, reads tags) | GPL-2.0-or-later | not shipped; the program has its own tag reader |
| *Avoid:* MMS forced-aligner (`torchaudio.pipelines.MMS_FA`) | CC-BY-NC 4.0 | would limit later commercial use; not used |

## Next steps

- Listen-test a handful of staged songs in the program's timing editor to confirm the aligner's absolute placement.
- Add faster-whisper (MIT) for songs with no lyrics at all (job 3, drafts only) and for non-English lyrics.
- Decide the integration shape (a helper process with exported models vs. a Python sidecar) once the licence question for the vocal
  separation model is settled; look at `Open-Unmix` and a re-trained separation model as alternatives.

## Second round (2026-11-17, later)

- **Multilingual (Meta's MMS aligner, `--model mms`):** on *Yo Me Estreso* (Spanish, existing timing) 81% of lines are within 0.5 s of the
  existing timing once the steady offset is taken away, spread 125 ms, against 62% / 195 ms for the English model. On the 30 English
  songs MMS is a little worse than the English model (72% against 83%), so the best choice is **a model per language**, picked from the
  song's language. MMS is CC-BY-NC 4.0: fine for personal tests, not for shipping in a merge.
- **Instrumental detector (`instrumental.py`):** from the separated vocals, how much of the song a voice is present and how much of it the
  speech model hears letters in. On 60 songs LRCLIB flags as instrumental and 60 with lyrics: "letters <= 0.08 and voice present <= 0.35"
  catches **48 of 60 instrumentals with 1 of 60 songs with lyrics wrongly flagged**. The misses are partly songs with a wordless voice
  (e.g. *The Great Gig In The Sky*), which are voice without lyrics. A song flagged this way would go to a "probably instrumental" list for a
  look, never marked automatically.
- **Listen test (`make_listen_test.py`):** a local page (no changes to the library) that plays a handful of songs and highlights lines, with
  Existing / New timing buttons and Earlier / Later nudges; built into `MediaVerse-Lyric-Sync-Lab\listen-test\index.html`.

## Modularity (design note for a merge)

The aligner can be a swappable part if its contract is narrow: *a CTC speech model* (audio in at its sample rate, a score per letter per
20 ms out) plus a small description file (letters in order, which one is "nothing", the sample rate, the language, how to prepare the text).
That fits exported ONNX models: an English one, a multilingual one, a language-specific one a user trained or downloaded. Settings could
then offer "Browse for a model file...", read the description, run a short self-test on a bundled sample song, and only then "Apply". It
cannot accept any model file (it must output letter scores in that form), and the vocal-separation model could follow the same pattern.

## Third round (2026-11-17, after the first listening)

Owner's listening notes: nearly all the songs were too close to tell apart; on *Bent But Not Broken* the new timing was generally better
except where an unofficial "whoa" sung after "To liars and thieves" was given to the start of "You're bent...", which the existing timing
got right; on *Linoleum* the existing timing handled the gap before the first line better, the new timing was better afterwards; on
*Great Big White World* (no existing timing) the new timing was very good except "All my stitches itch" (about 2 s early).
- **Cause (checked in the per-word output):** forced alignment must give every word some sound, so words just after a non-lyric sound are
  stretched back over it: "YOU'RE" came out 2.5 s long with confidence 0.12; "ALL MY" of the stitches line was placed 3 s before "STITCHES";
  the first word of *Linoleum* was placed on a sound at 5 s with the next word 18 s later.
- **Things tried:** a wildcard "something else" token between lines (`--star`): about +1 point at best, did not fix these lines (the model
  hears the ad-lib as faint letters, not as clear non-lyric sound). Automatic corrections of line starts (`align.trim_starts`) were no net
  gain against the existing timings (first-word rule 29 lines closer / 29 further; gap rule 64 / 91; even a gap over 4 s only 28 / 25), so
  they are **off**.
- **What is done instead (`align.flag_lines`):** a line is flagged for review when its first word is long and unsure ("stretched first
  word") or there is a gap over 1.2 s early in the line ("gap inside the line"). About 6% of lines. Every line the owner named is flagged
  (all four "You're bent..." lines, both "All my stitches itch" lines, the first line of *Linoleum*). The listen page shows a yellow
  warning sign on them; in the program they would be the lines to check first.

## Fourth round (2026-11-17, evening): one pass over a folder (`run_folder.py`)

`python run_folder.py <folder> <out> --limit N --seed S` decides per song what is needed and stages the result (nothing in any song changes):
songs with timed lyrics are checked (fits / shifted / drifts / does-not-fit, flagged lines, a re-timed `.lrc` for shifted or drifting ones), songs
with plain lyrics get a staged `.lrc` with flagged lines, songs with no lyrics are tested for a singing voice (probably instrumental, or lyrics
wanted). `language.py` guesses the language of the words (stop-word counts; 98.6% of 500 library songs came out English, Spanish and German
ones were found) and picks the model: English wav2vec2 for English, MMS for other Latin-script languages, others skipped. Output: `report.json`,
`report.csv`, `lrc/*.lrc`. First run on 60 random songs (200 minutes of music): 2.5 minutes, 81x real time; 17 fit, 16 plain-lyrics songs timed,
8 shifted or drifting (re-timed `.lrc` staged), 2 do not fit, 15 with no lyrics have a voice (lyrics wanted), 1 probably instrumental.

## Fifth round (2026-11-17, night): matching found lyrics to the song by what the AI hears

Owner's idea: search lyrics loosely (any record that roughly matches artist and title, e.g. "World War III" / "World War 3"), have the AI listen and
say whether a candidate is the right song, use the found lyrics as the baseline text where the AI misheard, then time them; no listening needed above
about 90%. Measured (Whisper large-v3 on the separated vocals, 40 songs with known lyrics; `transcribe.py`, `match.py`, `match_experiment.py`):
- **Identity is very reliable.** Score = the smaller of (share of the candidate's words the AI heard, share of what the AI heard that is in the candidate),
  after ignoring vocables ("oh", "whoa", "yeah", "la la": the wildcards), case, accents, punctuation, numbers and Roman numerals as words, and spelling
  variants. True lyrics: median 0.79 (82% at or above 0.5, 68% at or above 0.7, 18% at or above 0.9); lyrics of another song by the same artist (14) or a random
  other song (80): never above 0.11. So a cut at 0.5 had no false accepts in this test. Whisper alone rarely reaches 0.9 on sung words, so the 90% bar is
  better applied to the timing (below), with the text score as the "is it this song" gate.
- **The hard case works with a margin.** *World War III* (Bad Religion, a fast 57-second punk song, no lyrics in the file): 75 LRCLIB records from three
  spellings of the title; the Bad Religion ones all scored 0.27, the best record by another artist 0.05 (5x). A low absolute score with a large margin over
  every different text is "likely, check"; a high score is "sure".
- **Timing confidence (`agreement.py`):** the aligner's own flags (`align.flag_lines`) are the useful signal: lines it does not flag are within 0.5 s of the
  existing timing 87% of the time (93% within 1 s), the 5% it flags only 51%. A second opinion from Whisper's word times adds little on top (88% when both
  agree), so it is not worth the extra step.
- **Proposed rule (to calibrate on more songs):** text score at or above 0.5 (or a clear margin) plus at most about 10% flagged lines = no listening needed;
  a flagged song goes to review with the flagged lines marked; anything below the text cut is not used. Songs with no usable lyrics anywhere get a transcript
  draft only, in review, never saved by themselves.
