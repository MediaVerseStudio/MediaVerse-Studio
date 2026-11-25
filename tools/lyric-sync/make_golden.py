"""Writes the golden fixture for crates/lyric-ai (tests/golden.rs): 20 s of real singing as letter log-odds in thousandths, the lyrics,
and what the Python aligner (align.align_lines) says about them.   python make_golden.py <songs.json> <cache> <out.json>"""
import json, sys
from pathlib import Path
import numpy as np, torch
import align
from transcribe import cached_vocals
songs = json.load(open(sys.argv[1], encoding="utf-8")); cache = Path(sys.argv[2])
song = [s for s in songs if "Bent But Not" in s["path"]][0]
vocals = cached_vocals(song["path"], cache)[16000 * 25:16000 * 45]
align.MODEL = "w2v"; align.TRIM = False
thousandths = np.round(align.emissions(torch.from_numpy(vocals)).numpy() * 1000).astype(np.int32)
em = torch.from_numpy((thousandths / 1000.0).astype(np.float32))
_, labels = align.aligner()
lines = [l["text"] for l in song["lines"] if l["text"].strip()][8:16]
expected = align.align_lines(None, lines, em=em)
# the fit of these lyrics, and of other words, against the same audio (identity by fit; see crates/lyric-ai identity.rs)
import torchaudio.functional as AF
_, labels = align.aligner(); index = {c: i for i, c in enumerate(labels)}
def fit(text):
    ws = [w for line in text.split("\n") for w in align.tidy_words(line)]
    tokens = []
    for k, w in enumerate(ws):
        tokens += [index[c] for c in w]
        if k < len(ws) - 1: tokens.append(index["|"])
    _, scores = AF.forced_align(em[None], torch.tensor([tokens], dtype=torch.int32), blank=0)
    return (scores[0].sum().item() - em.max(-1).values.sum().item()) / len(tokens)
other = "Maybe we are missing the point that we are living in a world of pain and nobody wants to know about the truth anymore"
fits = {"right": fit("\n".join(lines)), "other": fit(other), "other_text": other}
out = {"labels": labels, "frames": int(em.shape[0]), "classes": int(em.shape[1]), "thousandths": thousandths.reshape(-1).tolist(), "lines": lines, "expected": expected, "fits": fits}
Path(sys.argv[3]).write_text(json.dumps(out, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")
print("frames", tuple(em.shape), "lines", len(lines), "size", Path(sys.argv[3]).stat().st_size // 1024, "KB")
