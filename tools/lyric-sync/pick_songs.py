"""Picks songs that already have timed lyrics (the ground truth for scoring an aligner) from the library.

    python pick_songs.py <library-folder> <out.json> [count] [seed]

Keeps English-looking songs (the first aligner is English), at least 12 timed lines, 90 s to 7 min is not checked here
(the aligner reads the file). The output lists each song's path and its timed lines.
"""
from __future__ import annotations

import json
import random
import sys
from pathlib import Path

from common import ascii_share, read_lyrics


def main() -> None:
    root = Path(sys.argv[1])
    out = Path(sys.argv[2])
    count = int(sys.argv[3]) if len(sys.argv) > 3 else 30
    seed = int(sys.argv[4]) if len(sys.argv) > 4 else 1
    files = sorted(root.rglob("*.mp3"))
    random.Random(seed).shuffle(files)
    picked = []
    for f in files:
        try:
            timed, _ = read_lyrics(f)
        except Exception:  # damaged tags: skipped
            continue
        text = " ".join(l.text for l in timed)
        if len(timed) < 12 or ascii_share(text) < 0.97:
            continue
        picked.append({"path": str(f), "lines": [{"ms": l.ms, "text": l.text} for l in timed]})
        if len(picked) >= count:
            break
    out.write_text(json.dumps(picked, ensure_ascii=False, indent=1), encoding="utf-8")
    print(f"{len(picked)} songs with timed lyrics -> {out}")


if __name__ == "__main__":
    main()
