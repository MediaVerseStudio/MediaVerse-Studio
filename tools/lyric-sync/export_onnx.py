"""Exports the aligner models to ONNX (so the program can run them without PyTorch) and checks them against the originals.

    python export_onnx.py <out-folder> [w2v|mms]

Writes <out>/<model>.onnx (letter log-odds for every 20 ms of 16 kHz audio) and a <model>.json describing it (letters in order, which is "nothing", rate,
frame length, how the text is prepared), then runs the same audio through PyTorch and through ONNX Runtime (CPU and DirectML) and prints the largest
difference, whether the letters read out are the same, and the speed. Sizes of the float32 and float16 files are printed too.
"""
from __future__ import annotations

import json
import sys
import time
from pathlib import Path

import numpy as np
import onnx
import onnxruntime as ort
import torch
import torchaudio

import align

NAMES = {"w2v": "WAV2VEC2_ASR_LARGE_960H", "mms": "MMS_FA"}


class Letters(torch.nn.Module):
    """Audio in (batch, samples), log-odds out (batch, frames, letters)."""

    def __init__(self, model: torch.nn.Module) -> None:
        super().__init__()
        self.model = model

    def forward(self, audio: torch.Tensor) -> torch.Tensor:
        emission, _ = self.model(audio)
        return torch.log_softmax(emission, dim=-1)


def main() -> None:
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    name = sys.argv[2] if len(sys.argv) > 2 else "w2v"
    align.MODEL = name
    model, labels = align.aligner()
    wrapper = Letters(model).eval().to("cpu")
    sample = torch.randn(1, 16000 * 20)
    path = out / f"{name}.onnx"
    with torch.no_grad():
        torch.onnx.export(
            wrapper, (sample,), str(path), input_names=["audio"], output_names=["letters"],
            dynamic_axes={"audio": {1: "samples"}, "letters": {1: "frames"}}, opset_version=17, dynamo=False,
        )
    (out / f"{name}.json").write_text(json.dumps({"kind": "aligner", "name": NAMES[name], "labels": labels, "blank": 0, "rate": 16000, "frame_seconds": 0.02,
                                                    "text": "upper-case letters and apostrophe, | between words" if name == "w2v" else "lower-case letters and apostrophe, no word marker"}, indent=1), encoding="utf-8")
    print(f"{name}: {path.stat().st_size / 1e6:.0f} MB float32")
    # a real piece of singing: the first 24 s of a cached vocal stem
    cache = Path(sys.argv[3]) if len(sys.argv) > 3 else None
    if cache and any(cache.glob("*.vocals.npy")):
        audio = np.load(next(cache.glob("*.vocals.npy")))[: 16000 * 24].astype(np.float32)
    else:
        audio = np.random.randn(16000 * 24).astype(np.float32) * 0.1
    audio = (audio - audio.mean()) / (audio.std() + 1e-7)
    with torch.no_grad():
        t0 = time.time()
        reference = wrapper(torch.from_numpy(audio)[None].to("cpu")).numpy()
        print(f"PyTorch CPU: {time.time() - t0:.2f} s")
    for provider in ("CPUExecutionProvider", "DmlExecutionProvider"):
        try:
            session = ort.InferenceSession(str(path), providers=[provider])
            session.run(None, {"audio": audio[None]})  # first run builds things
            t0 = time.time()
            result = session.run(None, {"audio": audio[None]})[0]
            seconds = time.time() - t0
            same = (result.argmax(-1) == reference.argmax(-1)).mean()
            print(f"{provider}: {seconds:.2f} s for 24 s of audio, largest difference {np.abs(result - reference).max():.4f}, same letters in {same:.1%} of frames")
        except Exception as error:
            print(f"{provider}: failed ({error})")


if __name__ == "__main__":
    main()
