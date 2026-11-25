"""Is this song instrumental? Prototype detector on the vocal stem.

    python instrumental.py features <songs.json> <out.json> [instrumental|vocal]   measures songs
    python instrumental.py report <features.json>                                   scores the detector

Two measurements on the separated vocals: how much of the song the vocal stem is clearly present (against the mix), and how
much of it the speech model hears letters in (1 - the odds of "nothing", per 20 ms). A song with lyrics scores high on both;
an instrumental (even electronic, where the separator leaks synth into the vocal stem) scores low on the second.
The known instrumentals are the songs LRCLIB flagged (the program's lyrics-instrumental.json); the vocal songs are songs with
timed lyrics.
"""
from __future__ import annotations

import json
import sys
from pathlib import Path

import numpy as np
import torch

import align


def features(path: str) -> dict:
    wav, rate = align.load_audio(path)
    vocals = align.separate_vocals(wav, rate)  # mono 16 kHz
    mix = align.mix_to_mono16k(wav, rate)
    n = min(len(vocals), len(mix)) // align.RATE * align.RATE
    v = vocals[:n].reshape(-1, align.RATE).pow(2).mean(1).sqrt().numpy()
    m = mix[:n].reshape(-1, align.RATE).pow(2).mean(1).sqrt().numpy() + 1e-6
    present = float(np.mean((v / m > 0.25) & (v > 0.005)))
    em = align.emissions(vocals)
    letters = float((1 - em[:, 0].exp()).gt(0.5).float().mean())  # share of frames where the model hears a letter
    return {"seconds": round(n / align.RATE), "vocal_present": round(present, 3), "letters": round(letters, 3)}


def collect(songs_json: str, out: str, kind: str, count: int = 60) -> None:
    items = json.loads(Path(songs_json).read_text(encoding="utf-8"))
    paths = list(items) if isinstance(items, dict) else [s if isinstance(s, str) else s["path"] for s in items]
    out_rows = []
    for p in paths:
        if len(out_rows) >= count:
            break
        try:
            if not Path(p).exists():
                continue
            row = {"path": p, "kind": kind, **features(p)}
            if row["seconds"] < 30:
                continue
            out_rows.append(row)
            print(f"{kind} {Path(p).name}: present {row['vocal_present']}, letters {row['letters']}", flush=True)
        except Exception as error:
            print(f"skipped {p}: {error}", flush=True)
    Path(out).write_text(json.dumps(out_rows, indent=1), encoding="utf-8")


def report(*files: str) -> None:
    rows = [r for f in files for r in json.loads(Path(f).read_text(encoding="utf-8"))]
    inst = [r for r in rows if r["kind"] == "instrumental"]
    voc = [r for r in rows if r["kind"] == "vocal"]
    print(f"{len(inst)} instrumental, {len(voc)} with lyrics")
    for key in ("vocal_present", "letters"):
        a = np.array([r[key] for r in inst])
        b = np.array([r[key] for r in voc])
        # ROC AUC: the chance a random vocal song scores higher than a random instrumental one
        auc = float(np.mean([(y > x) + 0.5 * (y == x) for x in a for y in b]))
        best = max(((t, (np.sum(a <= t) + np.sum(b > t)) / (len(a) + len(b))) for t in np.linspace(0, 1, 201)), key=lambda p: p[1])
        print(f"{key}: instrumental median {np.median(a):.3f}, with lyrics median {np.median(b):.3f}, AUC {auc:.3f}, best threshold {best[0]:.3f} -> {best[1]:.0%} right")
    # the two together: instrumental when the letters share is low
    for t in (0.02, 0.04, 0.06, 0.08, 0.10, 0.15):
        wrong_inst = sum(r["letters"] > t for r in inst)
        wrong_voc = sum(r["letters"] <= t for r in voc)
        print(f"letters <= {t}: {len(inst) - wrong_inst}/{len(inst)} instrumentals caught, {wrong_voc}/{len(voc)} songs with lyrics wrongly called instrumental")


if __name__ == "__main__":
    if sys.argv[1] == "features":
        collect(sys.argv[2], sys.argv[3], sys.argv[4] if len(sys.argv) > 4 else "vocal")
    else:
        report(*sys.argv[2:])
