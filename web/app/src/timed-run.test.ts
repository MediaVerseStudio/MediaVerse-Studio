import assert from "node:assert/strict";
import { test } from "node:test";
import { HISTORY_KEY, pictureHistory } from "./picture-history.ts";
import { CHUNK_MS, FAILURES_BEFORE_STOPPING, describeDuration, describeRun, timedRun } from "./timed-run.ts";

/** A clock the steps move on: each item takes `size` seconds. */
const clock = () => {
  let at = 0;
  return { now: () => at, spend: (ms: number) => (at += ms) };
};

test("five minutes' worth ends between steps, without starting one that would overrun", async () => {
  const time = clock();
  const done: number[] = [];
  const report = await timedRun([60, 60, 60, 60, 200, 60], { mode: "chunk", size: (n) => n, now: time.now, step: async (n) => (time.spend(n * 1000), done.push(n), "ok") });
  assert.deepEqual([report.reason, report.steps, report.left, done.length], ["time", 4, 2, 4]);
  assert.ok(report.ms <= CHUNK_MS);
});

test("one very large step is still done, so a press always gets somewhere", async () => {
  const time = clock();
  const report = await timedRun([900, 1], { mode: "chunk", size: (n) => n, now: time.now, step: async (n) => (time.spend(n * 1000), "ok") });
  assert.deepEqual([report.reason, report.steps], ["time", 1]);
});

test("unattended does everything, however long, and carries on past single failures", async () => {
  const time = clock();
  const report = await timedRun([1, 2, 3, 4, 5, 6, 7], { mode: "all", now: time.now, step: async (n) => (time.spend(3_600_000), n % 2 ? "failed" : "ok") });
  assert.deepEqual([report.reason, report.steps, report.left], ["finished", 7, 0]);
});

test("many failures in a row stop an unattended run (the share has gone away)", async () => {
  const report = await timedRun(Array.from({ length: 50 }, (_, i) => i), {
    mode: "all",
    step: async () => {
      throw new Error("not reachable");
    },
  });
  assert.deepEqual([report.reason, report.steps], ["failing", FAILURES_BEFORE_STOPPING]);
});

test("Stop ends after the current step, a halting step ends at once, and progress counts parts", async () => {
  let stop = false;
  const seen: number[] = [];
  const report = await timedRun([10, 10, 10], {
    mode: "all",
    size: (n) => n,
    stopped: () => stop,
    progress: (done) => seen.push(done),
    step: async (_n, advance) => {
      advance(4);
      stop = true;
      advance(6);
      return "ok";
    },
  });
  assert.deepEqual([report.reason, report.steps, report.done], ["stopped", 1, 10]);
  assert.ok(seen.includes(4));
  const cut = await timedRun([10, 10], { mode: "all", size: (n) => n, stopped: () => stop, step: async () => "failed" });
  assert.deepEqual([cut.reason, cut.steps], ["stopped", 0]);
  const halted = await timedRun([1, 2], { mode: "all", step: async () => "halt" });
  assert.deepEqual([halted.reason, halted.left], ["halted", 2]);
});

test("the line under the bar says how far, how long and what happens next", () => {
  assert.equal(describeDuration(65 * 60_000), "1 hour 5 minutes");
  assert.equal(describeRun("songs", 100, 1000, 60_000, "chunk"), "100 of 1,000 songs · 1 minute so far · about 9 minutes for everything left · pausing in 4 minutes");
  assert.match(describeRun("songs", 0, 10, 1000, "all"), /under a minute so far · running unattended/);
});

test("undo history keeps each run's parts, newest run last, and takes over what earlier builds kept", () => {
  const kept = new Map<string, string>([["mediaverse.artwork-fill-batches", '["fill-1-0","fill-1-1"]']]);
  const store = { get: (k: string) => kept.get(k) ?? null, set: (k: string, v: string | null) => void (v === null ? kept.delete(k) : kept.set(k, v)) };
  const history = pictureHistory(store);
  assert.deepEqual(history.last()?.batches, ["fill-1-0", "fill-1-1"]);
  assert.equal(kept.has("mediaverse.artwork-fill-batches"), false);
  history.add("r2", "Oversized pictures fixed", "fix-2-0");
  history.add("r2", "Oversized pictures fixed", "fix-2-0");
  assert.deepEqual(history.last(), { id: "r2", label: "Oversized pictures fixed", batches: ["fix-2-0"] });
  history.remove("r2", "fix-2-0");
  assert.equal(history.last()?.label, "Pictures added to songs");
  history.remove("mediaverse.artwork-fill-batches", "fill-1-1");
  history.remove("mediaverse.artwork-fill-batches", "fill-1-0");
  assert.deepEqual([history.last(), kept.has(HISTORY_KEY)], [null, false]);
});
