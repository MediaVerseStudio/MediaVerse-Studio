"""The two jobs the program would do, as prototype batch runs that only STAGE their results (nothing in any song is changed).

    python library_jobs.py check  <library-folder> <out.json> [count] [seed]   existing timing: does it fit the audio?
    python library_jobs.py sync   <library-folder> <out-folder> [count] [seed]  plain lyrics -> staged .lrc files + a summary

check: for songs that already have timed lyrics, aligns the words to the vocals and compares. Verdicts:
  fits         the lines are where the singing is (steady offset within 0.6 s of the usual, little drift)
  shifted      all lines are early or late by about the same amount (a correction of that size is proposed)
  drifts       the offset grows through the song (timing made for a different master); a re-alignment is proposed
  does-not-fit most lines are nowhere near the singing (likely the wrong words or a different song)
sync: for songs with words but no timing, writes <name>.lrc into the folder (staged, never into the song) with each line's
  start, and a score per song. Lines that could not be placed are written with the previous line's time and marked.
"""
from __future__ import annotations

import json
import random
import statistics
import sys
import time
from pathlib import Path

import numpy as np

from align import align_lines, load_audio, mix_to_mono16k, separate_vocals
from common import ascii_share, plain_lines, read_lyrics

# The aligner's line starts come out about 0.2 s after the singing starts (CTC letter spikes sit late in a sound), and
# timed lyrics are made to highlight a line as it begins, so a line is written 0.2 s earlier than the aligner says.
BIAS_S = 0.2
USUAL_OFFSET_MS = 180  # the median difference between this aligner and existing timings over 100 songs (see README)


def fit_line(points: list[tuple[float, float]]) -> tuple[float, float]:
    """(slope ms per minute, offset ms at the start) of error against time, ignoring lines far from the trend."""
    x = np.array([p[0] for p in points])
    y = np.array([p[1] for p in points])
    keep = np.ones(len(x), dtype=bool)
    a = b = 0.0
    for _ in range(4):
        if keep.sum() < 5:
            break
        a, b = np.polyfit(x[keep], y[keep], 1)
        keep = np.abs(y - (a * x + b)) < 1500
    return a * 60, b


def verdict(errors: list[tuple[float, float]]) -> dict:
    """errors: (existing time in s, aligner minus existing in ms) per line."""
    values = [e for _, e in errors]
    offset = statistics.median(values)
    slope, start = fit_line(errors)
    mid = (errors[0][0] + errors[-1][0]) / 2
    trend_mid = start + slope * mid / 60  # the offset in the middle of the song, from the trend
    near = lambda shift: sum(abs(e - shift) <= 700 for e in values) / len(values)
    result = {"offset_ms": round(offset), "drift_ms_per_min": round(slope), "lines": len(values)}
    off_usual = offset - USUAL_OFFSET_MS
    if near(USUAL_OFFSET_MS) < 0.4 and near(offset) < 0.5:
        result.update(verdict="does-not-fit", fit=round(max(near(USUAL_OFFSET_MS), near(offset)), 2))
    elif abs(slope) > 250 and abs(trend_mid - USUAL_OFFSET_MS) > 400:
        result.update(verdict="drifts", fit=round(near(offset), 2))
    elif abs(off_usual) > 600:
        result.update(verdict="shifted", shift_ms=-round(off_usual), fit=round(near(offset), 2))
    else:
        result.update(verdict="fits", fit=round(near(USUAL_OFFSET_MS), 2))
    return result


def check(root: Path, out: Path, count: int, seed: int) -> None:
    files = sorted(root.rglob("*.mp3"))
    random.Random(seed).shuffle(files)
    results = []
    for f in files:
        if len(results) >= count:
            break
        try:
            timed, _ = read_lyrics(f)
            lines = [l for l in timed if l.text.strip()]
            if len(lines) < 12 or ascii_share(" ".join(l.text for l in lines)) < 0.97:
                continue
            wav, rate = load_audio(str(f))
            aligned = align_lines(separate_vocals(wav, rate), [l.text for l in lines])
            errors = [(l.ms / 1000, a["start"] * 1000 - l.ms) for l, a in zip(lines, aligned) if a["start"] is not None]
            if len(errors) < 8:
                continue
            results.append({"path": str(f), **verdict(errors)})
            print(f"{f.name}: {results[-1]['verdict']} (offset {results[-1]['offset_ms']} ms, drift {results[-1]['drift_ms_per_min']} ms/min)", flush=True)
        except Exception as error:  # damaged tags or audio: skipped
            print(f"{f.name}: skipped ({error})", flush=True)
    out.write_text(json.dumps(results, ensure_ascii=False, indent=1), encoding="utf-8")
    counts: dict[str, int] = {}
    for r in results:
        counts[r["verdict"]] = counts.get(r["verdict"], 0) + 1
    print(f"\n{len(results)} songs: " + ", ".join(f"{v} {k}" for k, v in sorted(counts.items(), key=lambda kv: -kv[1])))


def lrc_time(seconds: float) -> str:
    seconds = max(0.0, seconds)
    return f"[{int(seconds // 60):02d}:{seconds % 60:05.2f}]"


def sync(root: Path, out: Path, count: int, seed: int) -> None:
    out.mkdir(parents=True, exist_ok=True)
    files = sorted(root.rglob("*.mp3"))
    random.Random(seed).shuffle(files)
    done = []
    for f in files:
        if len(done) >= count:
            break
        try:
            timed, plain = read_lyrics(f)
            lines = plain_lines(plain)
            if timed or len(lines) < 8 or ascii_share(plain) < 0.97:
                continue
            t0 = time.time()
            wav, rate = load_audio(str(f))
            aligned = align_lines(separate_vocals(wav, rate), lines)
            placed = [a for a in aligned if a["start"] is not None]
            if len(placed) < len(lines) * 0.8:
                print(f"{f.name}: too few lines placed ({len(placed)} of {len(lines)}), left alone")
                continue
            body = []
            previous = 0.0
            for a in aligned:
                if a["start"] is None:
                    body.append(f"{lrc_time(previous)}{a['text']}")  # not placed: with the line before, for the person to fix
                else:
                    previous = max(previous, a["start"] - BIAS_S)
                    body.append(f"{lrc_time(previous)}{a['text']}")
            (out / f"{f.stem}.lrc").write_text("\n".join(body) + "\n", encoding="utf-8")
            # lines the aligner is unsure about (see align.flag_lines), by line number, for a person to check
            (out / f"{f.stem}.flags.json").write_text(json.dumps({str(i): a["flags"] for i, a in enumerate(aligned) if a.get("flags")}), encoding="utf-8")
            score = statistics.mean(a["score"] for a in placed)
            done.append({"path": str(f), "lines": len(lines), "placed": len(placed), "mean_score": round(score, 3), "seconds": round(time.time() - t0, 1)})
            print(f"{f.name}: {len(placed)}/{len(lines)} lines placed, mean score {score:.2f}", flush=True)
        except Exception as error:
            print(f"{f.name}: skipped ({error})", flush=True)
    (out / "summary.json").write_text(json.dumps(done, indent=1), encoding="utf-8")
    print(f"\n{len(done)} songs timed, staged in {out}")


if __name__ == "__main__":
    mode, root, target = sys.argv[1], Path(sys.argv[2]), Path(sys.argv[3])
    n = int(sys.argv[4]) if len(sys.argv) > 4 else 30
    s = int(sys.argv[5]) if len(sys.argv) > 5 else 3
    (check if mode == "check" else sync)(root, target, n, s)
