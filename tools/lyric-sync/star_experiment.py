"""Tries several "something else" (star) settings on one set of songs, working out each song's vocals and letter odds once.

    python star_experiment.py <songs.json> <cache-folder> [value ...]      values: log-odds per star frame, or "none"

Scores each setting against the existing timing (lines within 0.5 s after the song's own steady offset, within 1 s raw, the share
of songs with a good fit), so a setting that soaks up ad-libs without hurting everything else shows up. Existing timing is not the
truth (see README); a better score means "closer to what people stamped", which is a fair proxy for most lines.
"""
from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path

import torch

import align


def cached_emissions(path: str, cache: Path) -> torch.Tensor:
    file = cache / (Path(path).stem[:60].replace(" ", "_") + f"-{abs(hash(path)) % 10**8}-{align.MODEL}.pt")
    if file.exists():
        return torch.load(file)
    wav, rate = align.load_audio(path)
    em = align.emissions(align.separate_vocals(wav, rate))
    torch.save(em, file)
    return em


def main() -> None:
    songs = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    cache = Path(sys.argv[2])
    cache.mkdir(parents=True, exist_ok=True)
    # a setting is "none" or a star value, with "+trim" to also fix line starts (align.trim_starts)
    names = sys.argv[3:] or ["none", "none+trim", "-0.05", "-0.05+trim"]
    settings = [(None if n.split("+")[0] == "none" else float(n.split("+")[0]), n.endswith("+trim")) for n in names]
    scores: dict = {s: [] for s in settings}
    for song in songs:
        try:
            em = cached_emissions(song["path"], cache)
        except Exception as error:
            print(f"{Path(song['path']).name}: skipped ({error})")
            continue
        lines = [l for l in song["lines"] if l["text"].strip()]
        for s in settings:
            align.TRIM = s[1]
            aligned = align.align_lines(None, [l["text"] for l in lines], em=em, star=s[0])
            errors = [a["start"] * 1000 - l["ms"] for a, l in zip(aligned, lines) if a["start"] is not None]
            if len(errors) < 5:
                continue
            offset = statistics.median(errors)
            scores[s].append(
                {
                    "within500_raw": sum(abs(e - 180) <= 500 for e in errors) / len(errors),
                    "within500_own": sum(abs(e - offset) <= 500 for e in errors) / len(errors),
                    "within1000_raw": sum(abs(e - 180) <= 1000 for e in errors) / len(errors),
                    "spread": statistics.median(abs(e - offset) for e in errors),
                    "name": Path(song["path"]).name,
                }
            )
    print(f"{'setting':>11} {'songs':>5} {'<0.5s raw':>9} {'<0.5s own':>9} {'<1s raw':>8} {'median spread':>13}")
    for s in settings:
        rows = scores[s]
        label = str(s[0]) + ("+trim" if s[1] else "")
        mean = lambda k: statistics.mean(r[k] for r in rows)
        print(f"{label:>11} {len(rows):5d} {mean('within500_raw'):9.1%} {mean('within500_own'):9.1%} {mean('within1000_raw'):8.1%} {statistics.median(r['spread'] for r in rows):11.0f} ms")
    Path(cache / "last-experiment.json").write_text(json.dumps({str(k): v for k, v in scores.items()}, indent=1), encoding="utf-8")


if __name__ == "__main__":
    main()
