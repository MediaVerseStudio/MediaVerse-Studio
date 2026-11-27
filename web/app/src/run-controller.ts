// The one long job that changes the library at a time (two writing the same songs could undo each other), with its
// progress bar, Stop, the two ways of running it, keeping the computer awake meanwhile, and Undo. All text is set with
// textContent.

import { invoke, keepAwake } from "./desktop-bridge";
import { el } from "./dom";
import { type PictureRun, pictureHistory } from "./picture-history";
import { type RunMode, type RunOptions, type RunReport, describeDuration, describeRun, timedRun } from "./timed-run";

const stored = (key: string): string | null => {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
};
const store = (key: string, value: string | null): void => {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // a convenience only
  }
};

export const history = pictureHistory({ get: stored, set: store });

export const button = (label: string, run: () => void, kind = "secondary"): HTMLButtonElement => {
  const b = el("button", kind, label);
  b.type = "button";
  b.addEventListener("click", run);
  return b;
};

export type StepTools = {
  advance: (amount: number) => void;
  stopped: () => boolean;
  /** Waits, saying why under the bar; ends early on Stop. */
  wait: (ms: number, why: string) => Promise<void>;
};

export type LongJob<T> = {
  title: string;
  /** What is counted: "songs", "albums". */
  unit: string;
  mode: RunMode;
  items: T[];
  size?: (item: T) => number;
  label: (item: T) => string;
  step: (item: T, tools: StepTools) => ReturnType<RunOptions<T>["step"]>;
  /** Asks a step under way to finish early (a job running in the background). */
  onStop?: () => void;
};

type Current = { title: string; unit: string; mode: RunMode; done: number; total: number; label: string; waiting: string; started: number; stopping: boolean; onStop?: () => void };

let current: Current | null = null;
const listeners = new Set<() => void>();
const changed = (): void => listeners.forEach((listener) => listener());
const views = new Set<() => boolean>();
let ticker: number | null = null;
const paint = (): void => {
  for (const view of views) if (!view()) views.delete(view);
};

/** Told when a job starts or ends (buttons appear and go). */
export function onRunChange(listener: () => void): void {
  listeners.add(listener);
}

export const runningTitle = (): string | null => current?.title ?? null;

/** Runs a job; null (and nothing done) when another is running. */
export async function startRun<T>(job: LongJob<T>): Promise<RunReport | null> {
  if (current) return null;
  const mine: Current = { title: job.title, unit: job.unit, mode: job.mode, done: 0, total: 0, label: "", waiting: "", started: Date.now(), stopping: false, onStop: job.onStop };
  current = mine;
  ticker = window.setInterval(paint, 1000);
  await keepAwake(true).catch(() => false);
  changed();
  const tools = (advance: (amount: number) => void): StepTools => ({
    advance,
    stopped: () => mine.stopping,
    wait: async (ms, why) => {
      const until = Date.now() + ms;
      while (!mine.stopping && Date.now() < until) {
        mine.waiting = `${why} Carrying on in ${describeDuration(until - Date.now())}.`;
        paint();
        await new Promise((resolve) => setTimeout(resolve, 1000));
      }
      mine.waiting = "";
    },
  });
  try {
    return await timedRun(job.items, {
      mode: job.mode,
      size: job.size,
      step: (item, advance) => job.step(item, tools(advance)),
      stopped: () => mine.stopping,
      progress: (done, total, item) => {
        mine.done = done;
        mine.total = total;
        mine.label = job.label(item);
        paint();
      },
    });
  } finally {
    current = null;
    if (ticker !== null) window.clearInterval(ticker);
    paint();
    await keepAwake(false).catch(() => false);
    changed();
  }
}

/** The progress of the running job, or an empty element when there is none; it keeps itself up to date. */
export function runView(): HTMLElement {
  const box = el("div", "long-run");
  const title = el("strong");
  const bar = el("progress");
  const text = el("p", "field-hint");
  const extra = el("p", "field-hint");
  const stop = button("Stop", () => {
    if (!current) return;
    current.stopping = true;
    current.onStop?.();
    paint();
  });
  box.append(title, bar, text, extra, stop);

  const update = (): boolean => {
    box.hidden = !current;
    if (current) {
      title.textContent = current.title;
      bar.max = Math.max(1, current.total);
      bar.value = current.done;
      text.textContent = describeRun(current.unit, current.done, current.total, Date.now() - current.started, current.mode);
      extra.textContent = current.waiting || current.label;
      stop.textContent = current.stopping ? "Stopping after this step…" : "Stop";
      stop.disabled = current.stopping;
    }
    // Views no longer on screen are dropped once their job has ended.
    return !!current || box.isConnected;
  };
  views.add(update);
  update();
  return box;
}

/** The two ways to run a long job; nothing while another runs. */
export function modeButtons(what: string, start: (mode: RunMode) => void): HTMLElement {
  const row = el("div", "row-actions");
  if (current) row.append(el("span", "field-hint", `${current.title} is running; one change at a time.`));
  else row.append(el("span", undefined, what), button("5 minutes' worth", () => start("chunk"), ""), button("Everything, unattended", () => start("all")));
  return row;
}

/** What a run ended with, in words. `left` says what remains ("12 albums"). */
export function describeEnd(report: RunReport, left: string): string {
  const took = describeDuration(report.ms);
  if (report.reason === "finished") return `Finished in ${took}.`;
  if (report.reason === "time") return `Five minutes' worth done (${took}). ${left} left: press again to carry on.`;
  if (report.reason === "stopped") return `Stopped after ${took}. ${left} left.`;
  if (report.reason === "failing") return `Stopped after ${took}: several in a row could not be done, so check that the music folder can be reached. ${left} left.`;
  return `Paused after ${took}. ${left} left.`;
}

type Problem = { path?: string; message: string };

let undoNote = "";

/** Undo the latest picture change, a few minutes at a time or all of it. `after` is told once songs were put back. */
export function undoBar(after: (run: PictureRun) => void): HTMLElement {
  const box = el("div", "undo-bar");
  const run = history.last();
  if (undoNote) box.append(el("p", "field-hint", undoNote));
  if (!run || current) return box;
  box.append(
    modeButtons(`Undo the latest change, "${run.label}" (${run.batches.length} ${run.batches.length === 1 ? "part" : "parts"}):`, (mode) => {
      if (!window.confirm(`Put the songs back as they were before "${run.label}"?`)) return;
      let songs = 0;
      const problems: Problem[] = [];
      void startRun({
        title: `Undoing: ${run.label}`,
        unit: "parts",
        mode,
        items: [...run.batches].reverse(),
        label: () => "",
        step: async (batch) => {
          try {
            const reply = await invoke<{ songs: number; problems: Problem[] }>("undo_picture_batch", { batch });
            songs += reply.songs;
            problems.push(...reply.problems);
          } catch (thrown) {
            const message = (thrown as { message?: string })?.message ?? String(thrown);
            // A journal that is not there belongs to a step nothing was written in.
            if (!/not found|already undone/i.test(message)) {
              problems.push({ message });
              return "failed";
            }
          }
          history.remove(run.id, batch);
          return "ok";
        },
      }).then((report) => {
        if (!report) return;
        undoNote = `${songs.toLocaleString("en-US")} songs put back. ${describeEnd(report, `${report.left} parts`)}${problems.length ? ` ${problems.length} problems, the first: ${problems[0].message}` : ""}`;
        after(run);
      });
    }),
  );
  return box;
}
