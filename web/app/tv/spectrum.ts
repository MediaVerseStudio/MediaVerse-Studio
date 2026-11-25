// The TV's visualizer data. On Samsung TVs the <audio> element plays through the TV's own media pipeline, and
// a Web Audio analyser attached to it hears only silence (tried on the S95F, 2026-11-03). The TV can decode a
// song itself (about 1.3 s for a 2.5-minute MP3), so each song is analysed once when it starts: decoded at a
// low sample rate, cut into short frames, and turned into a few frequency bands per frame. The visualizer then
// draws the frame matching the player's current time. The pure parts are here for testing; `analyseSong` does
// the decoding.

export const FRAMES_PER_SECOND = 25;
/** Bars on the screen: 38 (was 48; owner, 2026-11-17: 10-25% fewer elements to draw on the TV and the phone). Every style's
 * work grows with the number of bands; the log-spaced bands still cover 40 Hz to 10 kHz. */
export const BANDS = 38;
const FFT_SIZE = 1024;
const SAMPLE_RATE = 22_050;
const LOW_HZ = 40;
const HIGH_HZ = 10_000;

export type Spectrum = { fps: number; bands: number; frames: number; data: Uint8Array };

/** Cosine and sine of each angle an FFT of a given size uses, worked out once (they were recomputed in the inner loop). */
const twiddles = new Map<number, { cos: Float64Array; sin: Float64Array }>();
function twiddlesFor(n: number): { cos: Float64Array; sin: Float64Array } {
  let table = twiddles.get(n);
  if (!table) {
    table = { cos: new Float64Array(n / 2), sin: new Float64Array(n / 2) };
    for (let k = 0; k < n / 2; k++) {
      table.cos[k] = Math.cos((-2 * Math.PI * k) / n);
      table.sin[k] = Math.sin((-2 * Math.PI * k) / n);
    }
    twiddles.set(n, table);
  }
  return table;
}

/** In-place radix-2 FFT of `re`/`im` (length a power of two). */
export function fft(re: Float32Array, im: Float32Array): void {
  const n = re.length;
  const table = twiddlesFor(n);
  for (let i = 1, j = 0; i < n; i++) {
    let bit = n >> 1;
    for (; j & bit; bit >>= 1) j ^= bit;
    j ^= bit;
    if (i < j) {
      [re[i], re[j]] = [re[j], re[i]];
      [im[i], im[j]] = [im[j], im[i]];
    }
  }
  for (let size = 2; size <= n; size <<= 1) {
    const half = size >> 1;
    const stride = n / size; // this stage's angle k is the table's entry k * stride
    for (let start = 0; start < n; start += size) {
      for (let k = 0; k < half; k++) {
        const cos = table.cos[k * stride];
        const sin = table.sin[k * stride];
        const a = start + k;
        const b = a + half;
        const tr = re[b] * cos - im[b] * sin;
        const ti = re[b] * sin + im[b] * cos;
        re[b] = re[a] - tr;
        im[b] = im[a] - ti;
        re[a] += tr;
        im[a] += ti;
      }
    }
  }
}

/** The FFT bin range [from, to) of each band, spaced evenly on a log scale from LOW_HZ to HIGH_HZ. */
export function bandEdges(bands: number, fftSize: number, sampleRate: number): Array<[number, number]> {
  const hzPerBin = sampleRate / fftSize;
  const edges: Array<[number, number]> = [];
  const ratio = HIGH_HZ / LOW_HZ;
  let previous = Math.max(1, Math.round(LOW_HZ / hzPerBin));
  for (let b = 0; b < bands; b++) {
    const highHz = LOW_HZ * ratio ** ((b + 1) / bands);
    const to = Math.max(previous + 1, Math.round(highHz / hzPerBin));
    edges.push([previous, Math.min(to, fftSize / 2)]);
    previous = to;
  }
  return edges;
}

/**
 * Bands per frame (0..255) from mono samples. Levels are in decibels mapped from -70 dB (0) to 0 dB (255) after
 * a gentle tilt that lifts the treble, which otherwise looks dead next to the bass.
 */
export function spectrumOf(samples: Float32Array, sampleRate: number, fps = FRAMES_PER_SECOND, bands = BANDS): Spectrum {
  const hop = sampleRate / fps;
  const frames = Math.max(0, Math.floor((samples.length - FFT_SIZE) / hop) + 1);
  const data = new Uint8Array(frames * bands);
  const window = new Float32Array(FFT_SIZE);
  for (let i = 0; i < FFT_SIZE; i++) window[i] = 0.5 - 0.5 * Math.cos((2 * Math.PI * i) / (FFT_SIZE - 1));
  const edges = bandEdges(bands, FFT_SIZE, sampleRate);
  const re = new Float32Array(FFT_SIZE);
  const im = new Float32Array(FFT_SIZE);
  for (let f = 0; f < frames; f++) {
    const start = Math.round(f * hop);
    for (let i = 0; i < FFT_SIZE; i++) {
      re[i] = samples[start + i] * window[i];
      im[i] = 0;
    }
    fft(re, im);
    for (let b = 0; b < bands; b++) {
      const [from, to] = edges[b];
      let peak = 0;
      for (let k = from; k < to; k++) peak = Math.max(peak, re[k] * re[k] + im[k] * im[k]);
      const amplitude = Math.sqrt(peak) / (FFT_SIZE / 4); // a full-scale sine reads about 1
      const db = 20 * Math.log10(amplitude + 1e-9) + 6 * (b / bands); // tilt: up to +6 dB at the top
      data[f * bands + b] = Math.max(0, Math.min(255, Math.round(((db + 70) / 70) * 255)));
    }
  }
  return { fps, bands, frames, data };
}

const NO_FRAME = new Uint8Array(0);

/** The bands at `seconds` (an empty array past the end). */
export function frameAt(spectrum: Spectrum, seconds: number): Uint8Array {
  const f = Math.floor(seconds * spectrum.fps);
  if (f < 0 || f >= spectrum.frames) return NO_FRAME;
  return spectrum.data.subarray(f * spectrum.bands, (f + 1) * spectrum.bands);
}

/** The channels mixed down to one; a single channel is used as it is (no copy: a song's samples are tens of megabytes). */
function monoOf(channels: Float32Array[]): Float32Array {
  if (channels.length === 1) return channels[0];
  const length = channels[0]?.length ?? 0;
  const mono = new Float32Array(length);
  for (const channel of channels) for (let i = 0; i < length; i++) mono[i] += channel[i] / channels.length;
  return mono;
}

/** Decoded audio (one array per channel) mixed down to mono and analysed in one go: the background thread's job. */
export function analyseSamples(channels: Float32Array[], sampleRate: number): Spectrum {
  return spectrumOf(monoOf(channels), sampleRate);
}

/**
 * Turns decoded audio into a Spectrum. The TV app passes one that runs on a background thread
 * (spectrum-worker.ts); `analyseOnPage` is the fallback that runs on the page itself, in slices.
 */
export type Analyser = (channels: Float32Array[], sampleRate: number, signal: { stopped: boolean }) => Promise<Spectrum | null>;

/**
 * Analyses about 10 seconds at a time, resting `restMs` between slices. On the page the rest lets the remote
 * respond; on the background thread it leaves the TV's four processor cores to drawing the screen, which
 * otherwise waited for them at every song change (measured on the S95F).
 */
export async function analyseInSlices(channels: Float32Array[], sampleRate: number, signal: { stopped: boolean }, restMs: number): Promise<Spectrum | null> {
  const mono = monoOf(channels);
  const slice = sampleRate * 10;
  const parts: Spectrum[] = [];
  const hop = sampleRate / FRAMES_PER_SECOND;
  for (let start = 0; start < mono.length; start += slice) {
    if (signal.stopped) return null;
    const end = Math.min(mono.length, start + slice + FFT_SIZE);
    parts.push(spectrumOf(mono.subarray(start, end), sampleRate));
    await new Promise((resolve) => setTimeout(resolve, restMs));
  }
  // Slices are a whole number of frames long (10 s x 25 fps), so they join end to end.
  const framesPerSlice = Math.round(slice / hop);
  const frames = parts.reduce((sum, part, i) => sum + (i < parts.length - 1 ? framesPerSlice : part.frames), 0);
  const data = new Uint8Array(frames * BANDS);
  let at = 0;
  parts.forEach((part, i) => {
    const count = i < parts.length - 1 ? framesPerSlice : part.frames;
    data.set(part.data.subarray(0, count * BANDS), at * BANDS);
    at += count;
  });
  return { fps: FRAMES_PER_SECOND, bands: BANDS, frames, data };
}

/** Analyses on the page itself, yielding between slices so the remote stays responsive. */
export const analyseOnPage: Analyser = (channels, sampleRate, signal) => analyseInSlices(channels, sampleRate, signal, 0);

/** `first`'s frames up to `from`, then `rest` (analysed from frame `from` on): one spectrum for the whole song. */
export function joinSpectra(first: Spectrum, from: number, rest: Spectrum): Spectrum {
  const kept = Math.min(from, first.frames);
  const data = new Uint8Array((kept + rest.frames) * first.bands);
  data.set(first.data.subarray(0, kept * first.bands));
  data.set(rest.data, kept * first.bands);
  return { ...first, frames: kept + rest.frames, data };
}

/** Recordings longer than this (12 minutes) are not analysed. */
const MAX_SECONDS = 12 * 60;

/** Songs larger than this are not analysed (decoding them would need too much of the TV's memory). */
const MAX_BYTES = 80 * 1024 * 1024;

/** How much of the start of a song is analysed first, so the visualizer starts quickly (about a minute of MP3). */
const QUICK_BYTES = 1_500_000;

/**
 * Decodes audio bytes (a whole file, or the start of one) and analyses them from frame `fromFrame` on (the
 * result's frame 0 is that frame); null if they cannot be decoded.
 */
async function analyseBytes(bytes: ArrayBuffer, signal: { stopped: boolean }, analyse: Analyser, fromFrame = 0): Promise<Spectrum | null> {
  try {
    const context = new OfflineAudioContext(1, 1, SAMPLE_RATE);
    const buffer = await context.decodeAudioData(bytes);
    if (signal.stopped) return null;
    // Very long recordings (a live set, a DJ mix) are not analysed: decoded they would take hundreds of megabytes of the
    // TV's memory. The visualizer rests for them.
    if (buffer.duration > MAX_SECONDS) return null;
    // One mono copy, made straight from the decoded buffer (a copy can be handed to the background thread; the
    // buffer's own arrays cannot). Before, every channel was copied and the analyser mixed them down into a third
    // array: about twice the memory at the moment the TV can least spare it.
    const from = Math.min(buffer.length, Math.round(fromFrame * (buffer.sampleRate / FRAMES_PER_SECOND)));
    const mono = new Float32Array(buffer.length - from);
    const count = buffer.numberOfChannels;
    for (let c = 0; c < count; c++) {
      const data = buffer.getChannelData(c);
      for (let i = 0; i < mono.length; i++) mono[i] += data[from + i] / count;
    }
    return await analyse([mono], buffer.sampleRate, signal);
  } catch {
    return null; // a cut-off start of some files cannot be decoded: the whole file still is
  }
}

/**
 * Analyses one song in two steps: first its start (asked for with a Range request, or cut from a local file),
 * so the bars move within a second or two, then the whole song. `ready` is called after each step. Songs too
 * big to decode are skipped (the visualizer then rests); long songs yield between slices so the remote stays
 * responsive.
 */
export async function analyseSong(url: string, signal: { stopped: boolean }, ready: (spectrum: Spectrum) => void, analyse: Analyser = analyseOnPage): Promise<void> {
  try {
    const local = !/^https?:/i.test(url);
    let whole: ArrayBuffer | null = null;
    let quick: ArrayBuffer | null = null;
    if (local) {
      whole = await (await fetch(url)).arrayBuffer();
      if (whole.byteLength > MAX_BYTES) return;
      if (whole.byteLength > QUICK_BYTES * 1.5) quick = whole.slice(0, QUICK_BYTES);
    } else {
      const start = await fetch(url, { headers: { Range: `bytes=0-${QUICK_BYTES - 1}` } });
      if (!start.ok) return;
      if (start.status === 206) quick = await start.arrayBuffer();
      else {
        if (Number(start.headers.get("content-length") ?? 0) > MAX_BYTES) return;
        whole = await start.arrayBuffer(); // the server sent it all
      }
    }
    if (signal.stopped) return;
    let first: Spectrum | null = null;
    if (quick) {
      first = await analyseBytes(quick, signal, analyse);
      if (first && !signal.stopped) ready(first);
    }
    if (!whole) {
      const reply = await fetch(url);
      if (!reply.ok || Number(reply.headers.get("content-length") ?? 0) > MAX_BYTES) return;
      whole = await reply.arrayBuffer();
    }
    if (signal.stopped) return;
    // The start is already done: analyse only from a second before where the quick part ended (its last
    // moments may be cut short) and join the two.
    const from = first ? Math.max(0, first.frames - FRAMES_PER_SECOND) : 0;
    const rest = await analyseBytes(whole, signal, analyse, from);
    if (rest && !signal.stopped) ready(first && from > 0 ? joinSpectra(first, from, rest) : rest);
  } catch {
    // the visualizer rests for this song
  }
}