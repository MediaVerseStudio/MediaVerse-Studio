"""Lyric alignment prototype: given a song and its words, find when each line starts.

    python align.py <songs.json> <out.json> [--mix]      (songs.json from pick_songs.py; --mix skips vocal separation)

Pipeline (every part open source; see README.md for licences):
  1. decode the MP3 (libsndfile, no ffmpeg),
  2. separate the vocals with Demucs (htdemucs), unless --mix,
  3. wav2vec2 (fairseq, 960 h English, MIT) gives, for every 20 ms of the vocals, the odds of each letter,
  4. CTC forced alignment of the known words against those odds (torchaudio.functional.forced_align),
  5. each line starts where its first word starts.
English only for now (the letter set of this wav2vec2 model).
"""
from __future__ import annotations

import json
import re
import sys
import time
from pathlib import Path

import numpy as np
import soundfile as sf
import torch
import torchaudio
import torchaudio.functional as AF

DEVICE = "cuda" if torch.cuda.is_available() else "cpu"
RATE = 16_000
FRAME_S = 0.02  # wav2vec2 gives one frame per 20 ms
_models: dict = {}


def load_audio(path: str) -> tuple[torch.Tensor, int]:
    """Stereo float32 (2, samples) and its rate."""
    data, rate = sf.read(path, dtype="float32", always_2d=True)
    wav = torch.from_numpy(data.T.copy())
    if wav.shape[0] == 1:
        wav = wav.repeat(2, 1)
    return wav[:2], rate


def separate_vocals(wav: torch.Tensor, rate: int) -> torch.Tensor:
    """The vocals of a stereo song, mono at 16 kHz."""
    from demucs.apply import apply_model
    from demucs.pretrained import get_model

    if "demucs" not in _models:
        model = get_model("htdemucs")
        model.to(DEVICE).eval()
        _models["demucs"] = model
    model = _models["demucs"]
    if rate != model.samplerate:
        wav = AF.resample(wav, rate, model.samplerate)
    ref = wav.mean(0)
    mixture = (wav - ref.mean()) / (ref.std() + 1e-8)
    with torch.no_grad():
        sources = apply_model(model, mixture[None].to(DEVICE), device=DEVICE, split=True, overlap=0.25, progress=False)[0]
    vocals = sources[model.sources.index("vocals")].cpu() * (ref.std() + 1e-8) + ref.mean()
    return AF.resample(vocals.mean(0, keepdim=True), model.samplerate, RATE)[0]


def mix_to_mono16k(wav: torch.Tensor, rate: int) -> torch.Tensor:
    return AF.resample(wav.mean(0, keepdim=True), rate, RATE)[0]


MODEL = "w2v"  # "w2v": English wav2vec2 (MIT); "mms": Meta's multilingual MMS aligner (CC-BY-NC 4.0: personal tests only)


def aligner():
    if MODEL not in _models:
        if MODEL == "mms":
            bundle = torchaudio.pipelines.MMS_FA
            dictionary = bundle.get_dict(star=None)
            labels = [token for token, _ in sorted(dictionary.items(), key=lambda kv: kv[1])]
            _models[MODEL] = (bundle.get_model(with_star=False).to(DEVICE).eval(), labels)
        else:
            bundle = torchaudio.pipelines.WAV2VEC2_ASR_LARGE_960H
            _models[MODEL] = (bundle.get_model().to(DEVICE).eval(), bundle.get_labels())
    return _models[MODEL]


def emissions(mono16k: torch.Tensor) -> torch.Tensor:
    """Log-odds of every letter for every 20 ms, (frames, labels). Long songs go through in pieces with overlap, so memory stays small."""
    model, _ = aligner()
    window, hop = 24 * RATE, 20 * RATE
    margin = (window - hop) // 2
    pieces = []
    start = 0
    total = mono16k.shape[0]
    with torch.no_grad():
        while True:
            lo = max(0, start - margin)
            hi = min(total, start + hop + margin)
            chunk = mono16k[lo:hi]
            chunk = (chunk - chunk.mean()) / (chunk.std() + 1e-7)
            out, _ = model(chunk[None].to(DEVICE))
            out = torch.log_softmax(out[0].float(), dim=-1).cpu()
            first = int(round((start - lo) / RATE / FRAME_S)) if start > 0 else 0
            keep = int(round(hop / RATE / FRAME_S))
            pieces.append(out[first:first + keep] if hi < total else out[first:])
            start += hop
            if start >= total:
                break
    return torch.cat(pieces, 0)


def tidy_words(line: str) -> list[str]:
    """Letters and apostrophes only (accents taken off; upper case for wav2vec2, lower case for MMS): what the model's
    alphabet holds. Digits and symbols are dropped."""
    import unicodedata

    text = unicodedata.normalize("NFKD", line.replace("’", "'")).encode("ascii", "ignore").decode("ascii")
    text = text.replace("&", " and ")
    text = text.lower() if MODEL == "mms" else text.upper()
    text = re.sub(r"[^A-Za-z' ]", " ", text)
    return [w.strip("'") for w in text.split() if w.strip("'")]


TRIM = False  # correcting starts by these rules made no net improvement against the existing timings (29 lines closer, 29 further for the first-word rule; 64 closer, 91 further for the gap rule), so it is off: lines are flagged instead (flag_lines)
TRIM_FIRST = True  # sign (1) below
TRIM_GAP = True  # sign (2) below
TRIM_GAP_S = 1.2  # the smallest gap inside a line that sign (2) acts on


def trim_starts(result: list[dict]) -> None:
    """Fixes line starts pulled too early by sounds that are not in the words (an ad-libbed "whoa" before the line, backing vocals).
    Forced alignment has to give every word some sound, so the first words of a line can be stretched back over such a sound.
    Two signs, both seen on the owner's songs (2026-11-17): (1) the first word is long (over 1 s) and low in confidence (under 0.3):
    the line really starts about 0.4 s before the word ends; (2) a gap of over 1.2 s inside the line, early in it: the words before
    the gap are brought up to just before the word after it (0.3 s per word)."""
    for line in result:
        words = line.get("words") or []
        if line["start"] is None or len(words) < 2:
            continue
        start = line["start"]
        first = words[0]
        if TRIM_FIRST and first["score"] < 0.3 and first["end"] - first["start"] > 1.0:
            start = max(start, first["end"] - 0.4)
        gaps = [i for i in range(1, len(words)) if words[i]["start"] - words[i - 1]["end"] > TRIM_GAP_S]
        if TRIM_GAP and gaps and gaps[-1] <= max(1, len(words) // 2 + 1):
            j = gaps[-1]
            start = max(start, words[j]["start"] - 0.3 * j)
        if start > line["start"] + 0.05:
            line["start_before_trim"] = line["start"]
            line["start"] = round(start, 3)


def flag_lines(result: list[dict]) -> None:
    """Marks lines whose start is probably wrong, for a person to check (about 6% of lines on 100 songs): the same two signs as
    trim_starts. Adds `flags` (a list of "stretched first word" / "gap inside the line") to those lines."""
    for line in result:
        words = line.get("words") or []
        if line["start"] is None or len(words) < 2:
            continue
        flags = []
        if words[0]["score"] < 0.3 and words[0]["end"] - words[0]["start"] > 1.0:
            flags.append("stretched first word")
        gaps = [i for i in range(1, len(words)) if words[i]["start"] - words[i - 1]["end"] > 1.2]
        if gaps and gaps[-1] <= max(1, len(words) // 2 + 1):
            flags.append("gap inside the line")
        if flags:
            line["flags"] = flags


def align_lines(mono16k: torch.Tensor | None, lines: list[str], em: torch.Tensor | None = None, star: float | None = None) -> list[dict]:
    """For each line: {text, start, end, score} in seconds (start None when the line has no words this model can read).

    `em`: the letter odds when already worked out (so several settings can be tried on one song). `star`: a log-odds value for a
    "something else" token put before the first line, between lines and after the last, which can soak up sounds that are not in
    the words (a sung "whoa", an ad-lib, an instrumental break) instead of pushing them onto the next line's first words. Each
    frame of it costs `star` (about -2 to -3 works: a frame is given to it only when no letter explains the frame better)."""
    _, labels = aligner()
    index = {c: i for i, c in enumerate(labels)}
    words: list[tuple[int, str]] = []  # (line number, word)
    for n, line in enumerate(lines):
        words += [(n, w) for w in tidy_words(line)]
    result = [{"text": l, "start": None, "end": None, "score": None} for l in lines]
    if not words:
        return result
    if em is None:
        em = emissions(mono16k)
    star_index = em.shape[1]
    if star is not None:
        em = torch.cat([em, torch.full((em.shape[0], 1), float(star))], dim=1)
    tokens: list[int] = []
    owner: list[int] = []  # the word number of each token ("|" belongs to the word before it; -1 for a star)
    for k, (n, word) in enumerate(words):
        if star is not None and (k == 0 or words[k - 1][0] != n):
            tokens.append(star_index)  # a star before every line
            owner.append(-1)
        for c in word:
            tokens.append(index[c])
            owner.append(k)
        if k < len(words) - 1 and "|" in index:  # wav2vec2 puts a word-break letter between words; MMS has none
            tokens.append(index["|"])
            owner.append(k)
    if star is not None:
        tokens.append(star_index)  # and one after the last
        owner.append(-1)
    if len(tokens) > em.shape[0]:
        return result  # more letters than frames: not this song's words
    aligned, scores = AF.forced_align(em[None], torch.tensor([tokens], dtype=torch.int32), blank=0)
    spans = AF.merge_tokens(aligned[0], scores[0].exp())
    # merge_tokens drops repeated-blank frames and gives one span per target token, in order.
    if len(spans) != len(tokens):
        return result
    word_times: dict[int, list[tuple[float, float, float]]] = {}
    for span, k in zip(spans, owner):
        if k < 0:
            continue
        word_times.setdefault(k, []).append((span.start * FRAME_S, span.end * FRAME_S, span.score))
    first: dict[int, float] = {}
    last: dict[int, float] = {}
    quality: dict[int, list[float]] = {}
    for k, (n, _) in enumerate(words):
        times = word_times.get(k)
        if not times:
            continue
        first[n] = min(first.get(n, 1e9), times[0][0])
        last[n] = max(last.get(n, 0.0), times[-1][1])
        quality.setdefault(n, []).extend(t[2] for t in times)
    for n in first:
        result[n].update(start=round(first[n], 3), end=round(last[n], 3), score=round(float(np.mean(quality[n])), 3))
    for k, (n, word) in enumerate(words):  # each word's own place, for looking at what went wrong in a line
        times = word_times.get(k)
        if times:
            result[n].setdefault("words", []).append({"word": word, "start": round(times[0][0], 2), "end": round(times[-1][1], 2), "score": round(float(np.mean([t[2] for t in times])), 2)})
    flag_lines(result)
    if TRIM:
        trim_starts(result)
    return result


def main() -> None:
    songs = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    out = Path(sys.argv[2])
    use_mix = "--mix" in sys.argv
    global MODEL
    star = float(sys.argv[sys.argv.index("--star") + 1]) if "--star" in sys.argv else None
    if "--model" in sys.argv:
        MODEL = sys.argv[sys.argv.index("--model") + 1]
    results = []
    for song in songs:
        t0 = time.time()
        try:
            wav, rate = load_audio(song["path"])
            seconds = wav.shape[1] / rate
            mono = mix_to_mono16k(wav, rate) if use_mix else separate_vocals(wav, rate)
            t1 = time.time()
            lines = [l["text"] for l in song["lines"] if l["text"].strip()]
            aligned = align_lines(mono, lines, star=star)
            t2 = time.time()
            results.append({"path": song["path"], "seconds": round(seconds, 1), "separate_s": round(t1 - t0, 2), "align_s": round(t2 - t1, 2), "lines": aligned})
            print(f"{Path(song['path']).name}: {seconds:.0f} s of music, separation {t1 - t0:.1f} s, alignment {t2 - t1:.1f} s", flush=True)
        except Exception as error:  # one bad file must not stop the run
            results.append({"path": song["path"], "error": str(error)})
            print(f"{Path(song['path']).name}: FAILED {error}", flush=True)
    out.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
