"""Exports the neural core of Demucs (htdemucs) to ONNX, with the spectrogram transforms left outside the model.

    python export_demucs.py <out-folder>

The model is exported as (mix, spectrogram-as-real-channels) -> (frequency-branch output, time-branch output) for one fixed 7.8 s window of
stereo 44.1 kHz audio. The transform before it (STFT with a 4096 window, hop 1024) and after it (the mask and the inverse STFT) are
ordinary signal processing, done by the program itself. This script rebuilds the vocals with the exported model plus PyTorch's own
transforms and compares them with the original model, so a difference would show up here before any Rust is written.
"""
from __future__ import annotations

import sys
import time
from pathlib import Path

import numpy as np
import onnxruntime as ort
import torch
from demucs.pretrained import get_model


class Core(torch.nn.Module):
    """htdemucs without its _spec and _ispec: the middle of HTDemucs.forward, copied as it is."""

    def __init__(self, m) -> None:
        super().__init__()
        self.m = m

    def forward(self, mix: torch.Tensor, cac: torch.Tensor):
        m = self.m
        x = cac
        B, C, Fq, T = x.shape
        mean = x.mean(dim=(1, 2, 3), keepdim=True)
        std = x.std(dim=(1, 2, 3), keepdim=True)
        x = (x - mean) / (1e-5 + std)
        xt = mix
        meant = xt.mean(dim=(1, 2), keepdim=True)
        stdt = xt.std(dim=(1, 2), keepdim=True)
        xt = (xt - meant) / (1e-5 + stdt)
        saved, saved_t, lengths, lengths_t = [], [], [], []
        for idx, encode in enumerate(m.encoder):
            lengths.append(x.shape[-1])
            inject = None
            if idx < len(m.tencoder):
                lengths_t.append(xt.shape[-1])
                tenc = m.tencoder[idx]
                xt = tenc(xt)
                if not tenc.empty:
                    saved_t.append(xt)
                else:
                    inject = xt
            x = encode(x, inject)
            if idx == 0 and m.freq_emb is not None:
                frs = torch.arange(x.shape[-2], device=x.device)
                emb = m.freq_emb(frs).t()[None, :, :, None].expand_as(x)
                x = x + m.freq_emb_scale * emb
            saved.append(x)
        if m.crosstransformer:
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_upsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_upsampler_t(xt)
            x, xt = m.crosstransformer(x, xt)
            if m.bottom_channels:
                b, c, f, t = x.shape
                x = x.reshape(b, c, f * t)
                x = m.channel_downsampler(x)
                x = x.reshape(b, -1, f, t)
                xt = m.channel_downsampler_t(xt)
        for idx, decode in enumerate(m.decoder):
            skip = saved.pop(-1)
            x, pre = decode(x, skip, lengths.pop(-1))
            offset = m.depth - len(m.tdecoder)
            if idx >= offset:
                tdec = m.tdecoder[idx - offset]
                length_t = lengths_t.pop(-1)
                if tdec.empty:
                    pre = pre[:, :, 0]
                    xt, _ = tdec(pre, None, length_t)
                else:
                    skip = saved_t.pop(-1)
                    xt, _ = tdec(xt, skip, length_t)
        S = len(m.sources)
        x = x.view(B, S, -1, Fq, T)
        x = x * std[:, None] + mean[:, None]
        xt = xt.view(B, S, -1, mix.shape[-1])
        xt = xt * stdt[:, None] + meant[:, None]
        return x, xt


def main() -> None:
    torch.backends.mha.set_fastpath_enabled(False)  # the fast attention kernel of eval mode cannot be exported
    out = Path(sys.argv[1])
    out.mkdir(parents=True, exist_ok=True)
    model = get_model("htdemucs").models[0].eval()  # the "bag" holds one model
    core = Core(model).eval()
    length = int(model.segment * model.samplerate)
    print("window:", length, "samples at", model.samplerate, "Hz; sources:", model.sources)
    torch.manual_seed(1)
    from_file = Path(sys.argv[2]) if len(sys.argv) > 2 else None
    if from_file and from_file.exists():
        import align

        wav, rate = align.load_audio(str(from_file))
        import torchaudio.functional as AF

        wav = AF.resample(wav, rate, model.samplerate)[:, 30 * model.samplerate : 30 * model.samplerate + length]
    else:
        wav = torch.randn(2, length) * 0.1
    mix = wav[None].contiguous()
    with torch.no_grad():
        z = model._spec(mix)
        cac = model._magnitude(z)
        reference = model(mix)  # the whole original model
        x_ref, xt_ref = core(mix, cac)
    path = out / "htdemucs-core.onnx"
    with torch.no_grad():
        torch.onnx.export(core, (mix, cac), str(path), input_names=["mix", "cac"], output_names=["freq", "time"], opset_version=17, dynamo=False)
    print(f"htdemucs core: {path.stat().st_size / 1e6:.0f} MB float32; spectrogram input {tuple(cac.shape)}")
    # the original's own tail turns the frequency branch into audio: use it on the exported model's output
    for provider in ("CPUExecutionProvider", "DmlExecutionProvider"):
        try:
            session = ort.InferenceSession(str(path), providers=[provider])
            args = {"mix": mix.numpy(), "cac": cac.numpy()}
            session.run(None, args)
            t0 = time.time()
            freq, time_out = session.run(None, args)
            seconds = time.time() - t0
            zout = model._mask(z, torch.from_numpy(freq))
            audio = model._ispec(zout, length) + torch.from_numpy(time_out)
            diff = (audio - reference).abs().max().item()
            vocals = model.sources.index("vocals")
            ref_v = reference[0, vocals]
            error = ((audio[0, vocals] - ref_v).pow(2).sum() / ref_v.pow(2).sum()).sqrt().item()
            print(f"{provider}: {seconds:.2f} s for one 7.8 s window, largest sample difference {diff:.5f}, vocals relative error {error:.5f}")
        except Exception as error:
            print(f"{provider}: failed ({str(error)[:200]})")


if __name__ == "__main__":
    main()
