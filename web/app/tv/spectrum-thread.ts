// Runs the song analysis on a background thread (spectrum-worker.ts), built into the app's one script as an
// inline worker. If the TV refuses the worker, or it fails, the analysis runs on the page as before.
import SpectrumWorker from "./spectrum-worker.ts?worker&inline";
import { analyseOnPage, type Analyser, type Spectrum } from "./spectrum.ts";

let worker: Worker | null = null;
let workerBroken = false;
let nextId = 1;
const waiting = new Map<number, (spectrum: Spectrum | null) => void>();

function startWorker(): Worker | null {
  if (worker || workerBroken) return worker;
  try {
    worker = new SpectrumWorker();
    worker.onmessage = (event: MessageEvent<{ id: number; spectrum?: Spectrum; error?: string }>) => {
      const done = waiting.get(event.data.id);
      waiting.delete(event.data.id);
      done?.(event.data.spectrum ?? null);
    };
    worker.onerror = () => {
      // The worker itself failed: answer what is waiting with nothing and use the page from now on.
      workerBroken = true;
      worker?.terminate();
      worker = null;
      for (const done of waiting.values()) done(null);
      waiting.clear();
    };
  } catch {
    workerBroken = true;
    worker = null;
  }
  return worker;
}

export const analyseInBackground: Analyser = (channels, sampleRate, signal) => {
  const thread = startWorker();
  if (!thread) return analyseOnPage(channels, sampleRate, signal);
  const id = nextId++;
  return new Promise<Spectrum | null>((resolve) => {
    waiting.set(id, (spectrum) => resolve(signal.stopped ? null : spectrum));
    thread.postMessage({ id, channels, sampleRate }, channels.map((channel) => channel.buffer));
  });
};
