"""One pass over a folder of MP3s: decides for each song what is needed and does it, STAGING everything (no song is changed).

    python run_folder.py <folder> <out-folder> [--limit N] [--seed S]

Per song (by what its tags hold):
  timed lyrics   -> "check": does the timing fit the audio? (fits / shifted / drifts / does-not-fit), the lines to look at, and for
                    a shifted or drifting song a proposed re-timed .lrc
  plain lyrics   -> "sync": a staged .lrc with each line's start, lines the aligner is unsure about flagged
  no lyrics      -> "instrumental?": is there a singing voice at all? Probably instrumental songs are listed; the others still need
                    lyrics from somewhere (LRCLIB lookup, or a transcription draft later)
The language of the words picks the aligner (English wav2vec2; Spanish, French, German, Portuguese, Italian: Meta's MMS, personal use
only); other languages are skipped. Writes <out>/report.json, <out>/report.csv, staged .lrc files under <out>/lrc/ and an
<out>/index.html listing what was found. Needs the lab environment (see README.md).
"""
from __future__ import annotations

import csv
import json
import random
import statistics
import sys
import time
from pathlib import Path

import align
import instrumental
from common import plain_lines, read_lyrics
from language import language_of, model_for
from library_jobs import BIAS_S, lrc_time, verdict


def to_lrc(aligned: list[dict]) -> str:
    body, previous = [], 0.0
    for a in aligned:
        if a["start"] is not None:
            previous = max(previous, a["start"] - BIAS_S)
        body.append(f"{lrc_time(previous)}{a['text']}")  # a line that could not be placed shares the previous line's time
    return "\n".join(body) + "\n"


def process(path: Path, out: Path) -> dict:
    timed, plain = read_lyrics(path)
    lines_timed = [l for l in timed if l.text.strip()]
    text = " ".join(l.text for l in lines_timed) if lines_timed else plain
    row: dict = {"path": str(path), "has_timed": bool(lines_timed), "has_plain": bool(plain.strip())}
    t0 = time.time()
    wav, rate = align.load_audio(str(path))
    row["seconds"] = round(wav.shape[1] / rate)
    vocals = align.separate_vocals(wav, rate)
    if not text.strip():
        # No words: is anybody singing?
        mix = align.mix_to_mono16k(wav, rate)
        n = min(len(vocals), len(mix)) // align.RATE * align.RATE
        v = vocals[:n].reshape(-1, align.RATE).pow(2).mean(1).sqrt().numpy()
        m = mix[:n].reshape(-1, align.RATE).pow(2).mean(1).sqrt().numpy() + 1e-6
        present = float(((v / m > 0.25) & (v > 0.005)).mean())
        align.MODEL = "w2v"
        em = align.emissions(vocals)
        letters = float((1 - em[:, 0].exp()).gt(0.5).float().mean())
        row.update(job="no-lyrics", vocal_present=round(present, 3), letters=round(letters, 3),
                   verdict="probably instrumental" if letters <= 0.08 and present <= 0.35 else "has a voice: lyrics wanted")
        row["elapsed_s"] = round(time.time() - t0, 1)
        return row
    language = language_of(text)
    model = model_for(language)
    row["language"] = language
    if model is None:
        row.update(job="skipped", verdict=f"language not supported yet ({language})")
        return row
    align.MODEL = model
    row["model"] = model
    lines = [l.text for l in lines_timed] if lines_timed else plain_lines(plain)
    aligned = align.align_lines(vocals, lines)
    placed = [a for a in aligned if a["start"] is not None]
    flagged = [i for i, a in enumerate(aligned) if a.get("flags")]
    row.update(lines=len(lines), placed=len(placed), flagged=len(flagged), flagged_lines=[(i + 1, aligned[i]["text"][:40], aligned[i]["flags"]) for i in flagged[:12]])
    stem = path.stem[:60]
    if lines_timed:
        errors = [(l.ms / 1000, a["start"] * 1000 - l.ms) for l, a in zip(lines_timed, aligned) if a["start"] is not None]
        if len(errors) < 8:
            row.update(job="check", verdict="too few lines placed to tell")
        else:
            row.update(job="check", **verdict(errors))
            if row["verdict"] in ("shifted", "drifts"):
                (out / "lrc").mkdir(parents=True, exist_ok=True)
                (out / "lrc" / f"{stem}.retimed.lrc").write_text(to_lrc(aligned), encoding="utf-8")
                row["staged"] = f"lrc/{stem}.retimed.lrc"
    else:
        if len(placed) < len(lines) * 0.8:
            row.update(job="sync", verdict="too few lines placed: left alone")
        else:
            (out / "lrc").mkdir(parents=True, exist_ok=True)
            (out / "lrc" / f"{stem}.lrc").write_text(to_lrc(aligned), encoding="utf-8")
            row.update(job="sync", verdict="timed (staged)", staged=f"lrc/{stem}.lrc", mean_score=round(statistics.mean(a["score"] for a in placed), 2))
    row["elapsed_s"] = round(time.time() - t0, 1)
    return row


def main() -> None:
    args = sys.argv[1:]
    root, out = Path(args[0]), Path(args[1])
    limit = int(args[args.index("--limit") + 1]) if "--limit" in args else 40
    seed = int(args[args.index("--seed") + 1]) if "--seed" in args else 1
    out.mkdir(parents=True, exist_ok=True)
    files = sorted(root.rglob("*.mp3"))
    random.Random(seed).shuffle(files)
    rows = []
    for f in files[:limit]:
        try:
            row = process(f, out)
        except Exception as error:  # damaged tags or audio: noted, never fatal
            row = {"path": str(f), "job": "error", "verdict": str(error)[:120]}
        rows.append(row)
        print(f"{f.name[:46]:46} {row.get('job', ''):10} {row.get('verdict', '')} ({row.get('elapsed_s', 0)} s)", flush=True)
    (out / "report.json").write_text(json.dumps(rows, ensure_ascii=False, indent=1), encoding="utf-8")
    with (out / "report.csv").open("w", newline="", encoding="utf-8-sig") as f:
        writer = csv.writer(f)
        writer.writerow(["song", "job", "verdict", "language", "lines", "flagged lines", "offset ms", "drift ms/min", "voice present", "letters", "staged file", "seconds"])
        for r in rows:
            writer.writerow([Path(r["path"]).name, r.get("job"), r.get("verdict"), r.get("language", ""), r.get("lines", ""), r.get("flagged", ""), r.get("offset_ms", ""),
                             r.get("drift_ms_per_min", ""), r.get("vocal_present", ""), r.get("letters", ""), r.get("staged", ""), r.get("seconds", "")])
    counts: dict[str, int] = {}
    for r in rows:
        key = f"{r.get('job')}: {r.get('verdict')}"
        counts[key] = counts.get(key, 0) + 1
    print("\n" + "\n".join(f"{n:4d}  {k}" for k, n in sorted(counts.items(), key=lambda kv: -kv[1])))
    total_audio = sum(r.get("seconds", 0) for r in rows)
    total_time = sum(r.get("elapsed_s", 0) for r in rows)
    print(f"\n{len(rows)} songs, {total_audio / 60:.0f} min of music in {total_time / 60:.1f} min ({total_audio / max(1, total_time):.0f}x real time)")


if __name__ == "__main__":
    main()
