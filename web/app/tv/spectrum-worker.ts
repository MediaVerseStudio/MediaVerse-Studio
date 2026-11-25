// The visualizer's song analysis on a background thread (performance pass): the frequency maths for a whole
// song takes the TV's processor a noticeable moment, and on the page itself it held up the visualizer's frames
// at the start of every song. Decoding stays on the page (the TV's audio decoder is not offered to workers);
// the decoded channels come here, and the finished analysis goes back. It rests briefly between slices so the
// TV's processor cores stay free for drawing the screen.
import { analyseInSlices } from "./spectrum.ts";

type Job = { id: number; channels: Float32Array[]; sampleRate: number };

const REST_MS = 12;
/** Only the newest song matters: a new job stops the one before (it was for a song no longer playing). */
let current = { stopped: false };

self.onmessage = async (event: MessageEvent<Job>) => {
  const { id, channels, sampleRate } = event.data;
  current.stopped = true;
  const mine = (current = { stopped: false });
  try {
    const spectrum = await analyseInSlices(channels, sampleRate, mine, REST_MS);
    if (!spectrum) throw new Error("stopped");
    (self as unknown as Worker).postMessage({ id, spectrum }, [spectrum.data.buffer]);
  } catch (error) {
    (self as unknown as Worker).postMessage({ id, error: String(error) });
  }
};
