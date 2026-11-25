"""Two independent opinions on when each line starts: the forced aligner (wav2vec2) and Whisper's own word times.

    python agreement.py <songs.json> <cache-folder> <model>

Where both opinions agree on a line (within 0.5 s, after taking away the song's steady difference between the two methods), the line is very
likely right; where they disagree it needs a look. Scored against the timing the songs already have: how right are the agreeing lines,
and how right are the others?
"""
from __future__ import annotations

import difflib
import json
import statistics
import sys
from pathlib import Path

import numpy as np
import torch

import align
from match import words
from transcribe import key


def whisper_line_starts(lines: list[str], transcript: dict) -> list[float | None]:
    """For each candidate line, the time Whisper says its first matched word starts (None when none of its words was matched)."""
    cand: list[str] = []
    owner: list[int] = []
    for n, line in enumerate(lines):
        for w in words(line):
            cand.append(w)
            owner.append(n)
    heard, times = [], []
    for item in transcript["words"]:
        for w in words(item["w"]):
            heard.append(w)
            times.append(item["start"])
    vocabulary = sorted(set(cand))
    snapped = []
    for w in heard:
        close = difflib.get_close_matches(w, vocabulary, n=1, cutoff=0.8) if w not in vocabulary else [w]
        snapped.append(close[0] if close else w)
    matcher = difflib.SequenceMatcher(None, cand, snapped, autojunk=False)
    starts: list[float | None] = [None] * len(lines)
    for block in matcher.get_matching_blocks():
        for k in range(block.size):
            n = owner[block.a + k]
            if starts[n] is None:
                starts[n] = times[block.b + k]
    return starts


def main() -> None:
    songs = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    cache = Path(sys.argv[2])
    model = sys.argv[3]
    align.MODEL = "w2v"
    agree_err, other_err = [], []
    clean_err, flagged_err, clean_agree_err = [], [], []   # lines the aligner did / did not flag; and lines that are both unflagged and in agreement
    song_rows = []
    for song in songs:
        f = cache / f"{key(song['path'])}-{model}.transcript.json"
        v = cache / f"{key(song['path'])}.vocals.npy"
        if not (f.exists() and v.exists()):
            continue
        truth = [l for l in song["lines"] if l["text"].strip()]
        texts = [l["text"] for l in truth]
        aligned = align.align_lines(torch.from_numpy(np.load(v).astype(np.float32)), texts)
        starts = whisper_line_starts(texts, json.loads(f.read_text(encoding="utf-8")))
        pairs = [(i, a["start"], w) for i, (a, w) in enumerate(zip(aligned, starts)) if a["start"] is not None and w is not None]
        if len(pairs) < 8:
            continue
        gap = statistics.median(c - w for _, c, w in pairs)  # the steady difference between the two methods
        own = statistics.median(a["start"] * 1000 - t["ms"] for a, t in zip(aligned, truth) if a["start"] is not None)
        flags = 0
        in_agreement = 0
        for i, c, w in pairs:
            error = abs(c * 1000 - truth[i]["ms"] - own)
            (flagged_err if aligned[i].get("flags") else clean_err).append(error)
            if abs(c - w - gap) <= 0.5 and not aligned[i].get("flags"):
                clean_agree_err.append(error)
            if abs(c - w - gap) <= 0.5:
                in_agreement += 1
                agree_err.append(error)
            else:
                other_err.append(error)
        song_rows.append((Path(song["path"]).name[:36], len(pairs), len(texts), in_agreement / len(pairs)))
    rate = lambda xs, t: sum(e <= t for e in xs) / max(1, len(xs))
    print(f"lines where both methods have an opinion: agree {len(agree_err)}, disagree {len(other_err)} ({len(agree_err) / (len(agree_err) + len(other_err)):.0%} agree)")
    for name, xs in (("lines the two methods agree on", agree_err), ("lines they disagree on", other_err)):
        print(f"{name:34}: within 0.5 s of the existing timing {rate(xs, 500):.0%}, within 1 s {rate(xs, 1000):.0%}, median error {statistics.median(xs):.0f} ms")
    for name, xs in (("lines the aligner did not flag", clean_err), ("lines it flagged", flagged_err), ("unflagged AND in agreement", clean_agree_err)):
        print(f"{name:34}: n={len(xs)}, within 0.5 s of the existing timing {rate(xs, 500):.0%}, within 1 s {rate(xs, 1000):.0%}")
    song_rows.sort(key=lambda r: r[3])
    print("songs by share of lines in agreement (lowest 5):", [(n, f"{a:.0%}") for n, _, _, a in song_rows[:5]])
    print("share of songs with at least 90% of their opinionated lines in agreement:", f"{sum(r[3] >= 0.9 for r in song_rows) / len(song_rows):.0%}", f"of {len(song_rows)}")


if __name__ == "__main__":
    main()
