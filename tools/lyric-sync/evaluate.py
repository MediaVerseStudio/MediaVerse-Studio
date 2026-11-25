"""Scores an alignment run against the timing the songs already have.

    python evaluate.py <songs.json> <aligned.json>

Per song: how far the aligner's line starts are from the existing timing (median and spread), the same after taking the
song's own steady offset away (that offset is what an existing timing that fits another master looks like), and how many
lines land within half a second and one second. The existing timing is itself only as good as its source (LRCLIB), so
differences are not all the aligner's errors.
"""
from __future__ import annotations

import json
import statistics
import sys
from pathlib import Path


def main() -> None:
    truth = {s["path"]: [l for l in s["lines"] if l["text"].strip()] for s in json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))}
    runs = json.loads(Path(sys.argv[2]).read_text(encoding="utf-8"))
    rows = []
    for run in runs:
        if "error" in run:
            print(f"{Path(run['path']).name}: failed ({run['error']})")
            continue
        errors = []
        for ours, theirs in zip(run["lines"], truth[run["path"]]):
            if ours["start"] is not None:
                errors.append(ours["start"] * 1000 - theirs["ms"])
        if len(errors) < 5:
            print(f"{Path(run['path']).name}: too few lines aligned")
            continue
        offset = statistics.median(errors)
        spread = statistics.median(abs(e - offset) for e in errors)
        rows.append(
            {
                "name": Path(run["path"]).name,
                "lines": len(errors),
                "offset_ms": offset,
                "spread_ms": spread,
                "within500": sum(abs(e) <= 500 for e in errors) / len(errors),
                "within1000": sum(abs(e) <= 1000 for e in errors) / len(errors),
                "within500_after_offset": sum(abs(e - offset) <= 500 for e in errors) / len(errors),
                "x_realtime": run["seconds"] / max(0.01, run["separate_s"] + run["align_s"]),
            }
        )
    print(f"{'song':44} {'lines':>5} {'offset':>7} {'spread':>7} {'<0.5s':>6} {'<1s':>6} {'<0.5s*':>6} {'xRT':>5}")
    for r in rows:
        print(f"{r['name'][:44]:44} {r['lines']:5d} {r['offset_ms']:7.0f} {r['spread_ms']:7.0f} {r['within500']:6.0%} {r['within1000']:6.0%} {r['within500_after_offset']:6.0%} {r['x_realtime']:5.0f}")
    if rows:
        avg = lambda key: statistics.mean(r[key] for r in rows)
        print(
            f"\n{len(rows)} songs: median offset {statistics.median(r['offset_ms'] for r in rows):.0f} ms, median spread {statistics.median(r['spread_ms'] for r in rows):.0f} ms; "
            f"lines within 0.5 s {avg('within500'):.0%}, within 1 s {avg('within1000'):.0%}, within 0.5 s once the steady offset is taken away {avg('within500_after_offset'):.0%}; "
            f"speed {avg('x_realtime'):.0f}x real time (* = after taking away the song's offset)"
        )


if __name__ == "__main__":
    main()
