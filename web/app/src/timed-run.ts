// A long job done one step at a time (owner, 2026-11-26: nothing may mean an unplanned wait of ten minutes or more):
// either five minutes' worth, ending cleanly between steps, or everything, unattended. No DOM or bridge access, so it
// is unit tested.

/** `chunk`: about five minutes' worth; `all`: everything, with nobody watching. */
export type RunMode = "chunk" | "all";
export const CHUNK_MS = 5 * 60 * 1000;
/** Steps failing one after another before an unattended run gives up (the music folder has probably gone away). */
export const FAILURES_BEFORE_STOPPING = 5;

/** What one step did; `halt`: the run should end here (a service is refusing, say). */
export type StepResult = "ok" | "failed" | "halt";
export type RunEnd = "finished" | "time" | "stopped" | "failing" | "halted";
export type RunReport = { reason: RunEnd; steps: number; left: number; done: number; total: number; ms: number };

export type RunOptions<T> = {
  mode: RunMode;
  /** How much work an item is (songs, say); 1 each when not given. */
  size?: (item: T) => number;
  /** Does one item; `advance` reports parts of it as they are done. A thrown error counts as `failed`. */
  step: (item: T, advance: (amount: number) => void) => Promise<StepResult>;
  stopped?: () => boolean;
  progress?: (done: number, total: number, item: T) => void;
  now?: () => number;
  limitMs?: number;
};

export async function timedRun<T>(items: T[], options: RunOptions<T>): Promise<RunReport> {
  const now = options.now ?? Date.now;
  const limit = options.limitMs ?? CHUNK_MS;
  const sizeOf = options.size ?? (() => 1);
  const total = items.reduce((sum, item) => sum + sizeOf(item), 0);
  const started = now();
  let done = 0;
  let steps = 0;
  let failures = 0;
  const report = (reason: RunEnd): RunReport => ({ reason, steps, left: items.length - steps, done, total, ms: now() - started });
  for (const item of items) {
    if (options.stopped?.()) return report("stopped");
    const size = sizeOf(item);
    if (options.mode === "chunk" && steps > 0) {
      // A step that would run past the time is left for the next press (judged by the speed so far).
      const spent = now() - started;
      const expected = done > 0 ? (spent / done) * size : 0;
      if (spent + expected > limit) return report("time");
    }
    const before = done;
    options.progress?.(done, total, item);
    let result: StepResult;
    try {
      result = await options.step(item, (amount) => {
        done = Math.min(before + size, done + amount);
        options.progress?.(done, total, item);
      });
    } catch {
      result = "failed";
    }
    // A step cut short by Stop is not counted as done.
    if (options.stopped?.() && done < before + size && result !== "ok") return report("stopped");
    if (result === "halt") return report("halted");
    done = before + size;
    steps += 1;
    failures = result === "failed" ? failures + 1 : 0;
    options.progress?.(done, total, item);
    if (failures >= FAILURES_BEFORE_STOPPING) return report("failing");
  }
  return report(options.stopped?.() ? "stopped" : "finished");
}

/** "under a minute", "12 minutes", "2 hours 5 minutes". */
export function describeDuration(ms: number): string {
  const minutes = Math.round(ms / 60_000);
  if (minutes < 1) return "under a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return `${hours} hour${hours === 1 ? "" : "s"}${rest ? ` ${rest} minute${rest === 1 ? "" : "s"}` : ""}`;
}

/** How long the rest will take at the speed so far; null until there is enough to judge by. */
export function timeLeft(done: number, total: number, ms: number): number | null {
  return done > 0 && ms >= 5000 && total > done ? (ms / done) * (total - done) : null;
}

/** The line under a progress bar. */
export function describeRun(unit: string, done: number, total: number, ms: number, mode: RunMode, limit = CHUNK_MS): string {
  const parts = [`${done.toLocaleString("en-US")} of ${total.toLocaleString("en-US")} ${unit}`, `${describeDuration(ms)} so far`];
  const left = timeLeft(done, total, ms);
  if (left !== null) parts.push(`about ${describeDuration(left)} for everything left`);
  if (mode === "chunk") parts.push(ms >= limit ? "finishing the current step, then pausing" : `pausing in ${describeDuration(limit - ms)}`);
  else parts.push("running unattended");
  return parts.join(" · ");
}
