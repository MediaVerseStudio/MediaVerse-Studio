// A progress bar for work that takes a while (reading a whole library, moving files): a bar, the words of progress-text.ts, and a clock that keeps
// running even between updates, so it is clear the program is still working. All text is set with textContent.

import { el } from "./dom";
import { describeProgress } from "./progress-text";

export type ProgressBar = {
  element: HTMLElement;
  /** `total` 0 means unknown: the bar then just moves to and fro. */
  set: (done: number, total: number) => void;
  /** Stops the clock; the bar stays on screen until it is removed. */
  stop: () => void;
};

export function createProgress(label: string): ProgressBar {
  const box = el("div", "progress-bar");
  const bar = el("progress");
  bar.max = 1;
  const text = el("p", "field-hint");
  box.append(bar, text);
  const started = Date.now();
  let done = 0;
  let total = 0;
  const paint = (): void => {
    if (total > 0) {
      bar.max = total;
      bar.value = done;
    } else bar.removeAttribute("value"); // no value: an indeterminate bar
    text.textContent = describeProgress(label, done, total, Date.now() - started);
  };
  const timer = window.setInterval(paint, 1000);
  paint();
  return {
    element: box,
    set(nextDone, nextTotal) {
      done = nextDone;
      total = nextTotal;
      paint();
    },
    stop() {
      window.clearInterval(timer);
    },
  };
}

/** The counts in a `job-progress` event, whichever names the job used. */
export function progressCounts(payload: { done?: number; total?: number; tracks_done?: number; tracks_total?: number }): { done: number; total: number } {
  return { done: payload.tracks_done ?? payload.done ?? 0, total: payload.tracks_total ?? payload.total ?? 0 };
}
