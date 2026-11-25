"""Is the match score safe to act on? Scores true lyrics, and lyrics of other songs, against what the AI heard.

    python match_experiment.py <songs.json> <cache-folder> <model>

For each song with a transcript: its own lyrics (should score high), the lyrics of another song by the same artist when there is one
and of a random other song (should score low). Prints the score distributions and how many true / wrong pairs land above each cut.
"""
from __future__ import annotations

import json
import random
import statistics
import sys
from pathlib import Path

from match import similarity
from transcribe import key


def main() -> None:
    songs = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    cache = Path(sys.argv[2])
    model = sys.argv[3]
    texts = {s["path"]: " ".join(l["text"] for l in s["lines"]) for s in songs}
    heard = {}
    for s in songs:
        f = cache / f"{key(s['path'])}-{model}.transcript.json"
        if f.exists():
            heard[s["path"]] = json.loads(f.read_text(encoding="utf-8"))["text"]
    rng = random.Random(5)
    true_scores, same_artist, random_other = [], [], []
    rows = []
    for path, transcript in heard.items():
        t = similarity(texts[path], transcript)
        true_scores.append(t["score"])
        rows.append((Path(path).name[:40], t["recall"], t["precision"], t["score"]))
        artist = Path(path).parts[-3] if len(Path(path).parts) >= 3 else ""
        mates = [p for p in texts if p != path and len(Path(p).parts) >= 3 and Path(p).parts[-3] == artist]
        if mates:
            same_artist.append(similarity(texts[rng.choice(mates)], transcript)["score"])
        others = [p for p in texts if p != path]
        for p in rng.sample(others, 2):
            random_other.append(similarity(texts[p], transcript)["score"])
    rows.sort(key=lambda r: r[3])
    print("lowest true matches:", [(n, s) for n, _, _, s in rows[:6]])
    q = lambda xs, n: round(statistics.quantiles(xs, n=20)[n], 2) if len(xs) > 20 else None
    for name, xs in (("true lyrics", true_scores), ("another song, same artist", same_artist), ("a random other song", random_other)):
        print(f"{name:28} n={len(xs):3d} median {statistics.median(xs):.2f}  10th pct {q(xs, 1)}  90th pct {q(xs, 17)}  max {max(xs):.2f}")
    for cut in (0.5, 0.6, 0.7, 0.8, 0.9):
        print(f"cut {cut:.1f}: true lyrics at or above {sum(s >= cut for s in true_scores) / len(true_scores):.0%}, wrong lyrics at or above {sum(s >= cut for s in same_artist + random_other) / max(1, len(same_artist + random_other)):.1%}")


if __name__ == "__main__":
    main()
