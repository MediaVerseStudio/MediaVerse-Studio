import assert from "node:assert/strict";
import test from "node:test";
import { analyseOnPage, analyseSamples, BANDS, bandEdges, fft, frameAt, joinSpectra, spectrumOf } from "./spectrum.ts";

test("the background thread's one-pass analysis matches the page's sliced one", async () => {
  // 50 seconds of stereo: a tone in one channel, a different one in the other, so mixing and slicing both count.
  const rate = 22_050;
  const left = new Float32Array(rate * 50);
  const right = new Float32Array(rate * 50);
  for (let i = 0; i < left.length; i++) {
    left[i] = 0.5 * Math.sin((2 * Math.PI * 220 * i) / rate);
    right[i] = 0.3 * Math.sin((2 * Math.PI * 3_000 * i) / rate);
  }
  const whole = analyseSamples([left, right], rate);
  const sliced = await analyseOnPage([left, right], rate, { stopped: false });
  assert.ok(sliced);
  assert.equal(whole.frames, sliced.frames);
  let largest = 0;
  for (let i = 0; i < whole.data.length; i++) largest = Math.max(largest, Math.abs(whole.data[i] - sliced.data[i]));
  assert.ok(largest <= 1, `frames differ by up to ${largest}`);
});

test("a song's start and the rest analysed separately join into the same analysis as the whole", () => {
  const rate = 22_050;
  const samples = new Float32Array(rate * 30);
  for (let i = 0; i < samples.length; i++) samples[i] = 0.4 * Math.sin((2 * Math.PI * (200 + i / 100) * i) / rate); // a rising tone
  const whole = analyseSamples([samples], rate);
  const first = analyseSamples([samples.subarray(0, rate * 12)], rate);
  const from = first.frames - 25;
  const rest = analyseSamples([samples.subarray(Math.round(from * (rate / 25)))], rate);
  const joined = joinSpectra(first, from, rest);
  assert.equal(joined.frames, whole.frames);
  let largest = 0;
  for (let i = 0; i < whole.data.length; i++) largest = Math.max(largest, Math.abs(whole.data[i] - joined.data[i]));
  assert.ok(largest <= 1, `frames differ by up to ${largest}`);
});

test("past the end of a song there is no frame, and asking again makes nothing new", () => {
  const spectrum = { fps: 25, bands: BANDS, frames: 1, data: new Uint8Array(BANDS) };
  assert.equal(frameAt(spectrum, 5).length, 0);
  assert.equal(frameAt(spectrum, 5), frameAt(spectrum, 6));
});

test("the FFT finds a pure tone in its bin", () => {
  const n = 64;
  const re = new Float32Array(n);
  const im = new Float32Array(n);
  for (let i = 0; i < n; i++) re[i] = Math.sin((2 * Math.PI * 5 * i) / n);
  fft(re, im);
  const magnitude = Array.from(re, (r, i) => Math.hypot(r, im[i]));
  const loudest = magnitude.slice(0, n / 2).indexOf(Math.max(...magnitude.slice(0, n / 2)));
  assert.equal(loudest, 5);
  assert.ok(Math.abs(magnitude[5] - n / 2) < 1e-3);
});

test("bands are in order, do not overlap and stay under half the FFT", () => {
  const edges = bandEdges(BANDS, 1024, 22_050);
  assert.equal(edges.length, BANDS);
  for (let b = 1; b < edges.length; b++) assert.equal(edges[b][0], edges[b - 1][1]);
  for (const [from, to] of edges) assert.ok(from < to && to <= 512);
});

test("a low tone lights the low bands and a high tone the high bands", () => {
  const rate = 22_050;
  const tone = (hz: number) => Float32Array.from({ length: rate }, (_, i) => 0.5 * Math.sin((2 * Math.PI * hz * i) / rate));
  const loudestBand = (hz: number) => {
    const spectrum = spectrumOf(tone(hz), rate);
    const frame = frameAt(spectrum, 0.5);
    return frame.indexOf(Math.max(...frame));
  };
  const low = loudestBand(80);
  const high = loudestBand(5_000);
  assert.ok(low < BANDS * 0.2, `80 Hz in band ${low}`);
  assert.ok(high > BANDS * 0.72, `5 kHz in band ${high}`);
  const spectrum = spectrumOf(tone(440), rate);
  assert.equal(spectrum.frames, Math.floor((rate - 1024) / (rate / 25)) + 1);
  assert.equal(frameAt(spectrum, 99).length, 0, "past the end");
  assert.ok(Math.max(...frameAt(spectrumOf(new Float32Array(rate), rate), 0.2)) === 0, "silence is zero");
});
