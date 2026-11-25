"""Writes a song and its lyrics for crates/lyric-engine's `analyse` example.   python dump_song.py <songs.json> <name-part> <out-folder>"""
import json, sys
from pathlib import Path
import numpy as np
import align
songs = json.load(open(sys.argv[1], encoding="utf-8"))
song = [s for s in songs if sys.argv[2].lower() in s["path"].lower()][0]
wav, rate = align.load_audio(song["path"])
assert rate == 44100, rate
out = Path(sys.argv[3]); out.mkdir(parents=True, exist_ok=True)
np.concatenate([wav[0].numpy(), wav[1].numpy()]).astype("<f4").tofile(out / "song.f32")
(out / "lyrics.txt").write_text("\n".join(l["text"] for l in song["lines"] if l["text"].strip()), encoding="utf-8")
print(song["path"], round(wav.shape[1] / rate), "s")
