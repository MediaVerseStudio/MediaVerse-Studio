"""What does the AI hear? Transcribes the separated vocals of songs with Whisper (via faster-whisper, MIT), with word times.

    python transcribe.py <songs.json> <cache-folder> <model> [language]       e.g. large-v3, distil-large-v3, small

Writes <cache>/<song>-<model>.transcript.json: {"text": ..., "words": [{"w", "start", "end", "p"}]}. The vocal stems are kept
in <cache> (16 kHz, float16 .npy) so each song is separated once. GPU libraries come from the PyTorch install in the same venv.
"""
from __future__ import annotations

import json
import os
import sys
import time
import zlib
from pathlib import Path

import numpy as np
import torch

# CTranslate2 needs the CUDA libraries that PyTorch already ships.
_lib = os.path.join(os.path.dirname(torch.__file__), "lib")
os.add_dll_directory(_lib)
os.environ["PATH"] = _lib + os.pathsep + os.environ["PATH"]

import align  # noqa: E402


def key(path: str) -> str:
    return f"{Path(path).stem[:50].replace(' ', '_')}-{zlib.crc32(path.encode()):08x}"


def cached_vocals(path: str, cache: Path) -> np.ndarray:
    file = cache / f"{key(path)}.vocals.npy"
    if file.exists():
        return np.load(file).astype(np.float32)
    wav, rate = align.load_audio(path)
    vocals = align.separate_vocals(wav, rate).numpy()
    np.save(file, vocals.astype(np.float16))
    return vocals


def main() -> None:
    from faster_whisper import WhisperModel

    songs = json.loads(Path(sys.argv[1]).read_text(encoding="utf-8"))
    cache = Path(sys.argv[2])
    cache.mkdir(parents=True, exist_ok=True)
    name = sys.argv[3]
    language = sys.argv[4] if len(sys.argv) > 4 else "en"
    model = WhisperModel(name, device="cuda", compute_type="float16")
    for song in songs:
        path = song["path"] if isinstance(song, dict) else song
        out = cache / f"{key(path)}-{name}.transcript.json"
        if out.exists():
            continue
        try:
            t0 = time.time()
            vocals = cached_vocals(path, cache)
            t1 = time.time()
            segments, info = model.transcribe(vocals, language=language, word_timestamps=True, beam_size=5, condition_on_previous_text=False, vad_filter=False)
            words, texts = [], []
            for segment in segments:
                texts.append(segment.text.strip())
                for w in segment.words or []:
                    words.append({"w": w.word.strip(), "start": round(w.start, 2), "end": round(w.end, 2), "p": round(w.probability, 2)})
            out.write_text(json.dumps({"path": path, "text": " ".join(texts), "words": words, "seconds": round(len(vocals) / 16000)}, ensure_ascii=False), encoding="utf-8")
            print(f"{Path(path).name[:44]:44} {len(vocals) / 16000:5.0f} s of song, separation {t1 - t0:4.1f} s, transcription {time.time() - t1:4.1f} s, {len(words)} words", flush=True)
        except Exception as error:
            print(f"{Path(path).name}: FAILED {error}", flush=True)


if __name__ == "__main__":
    main()
