"""Golden data for crates/lyric-engine (dsp.rs): Demucs's own spectrogram transforms on a short deterministic signal.
   python make_golden_dsp.py <out-folder>      writes signal.f32, cac.f32, back.f32 (little-endian float32)"""
import sys
from pathlib import Path
import numpy as np, torch
from demucs.pretrained import get_model
model = get_model("htdemucs").models[0].eval()
L = 6000
t = np.arange(L, dtype=np.float32)
x = np.stack([0.5 * np.sin(2 * np.pi * 330 * t / 44100) + 0.1 * np.sin(2 * np.pi * 9000 * t / 44100),
              0.4 * np.sin(2 * np.pi * 1000 * t / 44100) + 0.3 * np.sin(2 * np.pi * 5000 * t / 44100) + 0.05 * np.cos(t * 0.37)]).astype(np.float32)
mix = torch.from_numpy(x)[None]
with torch.no_grad():
    z = model._spec(mix)
    cac = model._magnitude(z)                      # (1, 4, 2048, frames)
    zout = model._mask(z, cac[:, None])            # one "source": the same spectrogram
    back = model._ispec(zout[:, 0], L)             # (1, 2, L)
out = Path(sys.argv[1]); out.mkdir(parents=True, exist_ok=True)
x.astype("<f4").tofile(out / "signal.f32"); cac.numpy().astype("<f4").tofile(out / "cac.f32"); back.numpy().astype("<f4").tofile(out / "back.f32")
print("cac", tuple(cac.shape), "back", tuple(back.shape), "round trip worst error in torch:", float((back[0] - mix[0]).abs().max()))
