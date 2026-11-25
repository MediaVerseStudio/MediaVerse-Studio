import assert from "node:assert/strict";
import { test } from "node:test";
import { createAudioCache } from "./audio-cache.ts";

/** A fake store: each song is `size` bytes; counts reads and records which addresses were let go. */
function setup(options: { maxBytes?: number; maxEntries?: number; maxAgeMs?: number; sizes?: Record<string, number>; failing?: Set<string> } = {}) {
  let clock = 0;
  let made = 0;
  const reads: string[] = [];
  const revoked: string[] = [];
  const urls = new Map<Blob, string>();
  const cache = createAudioCache({
    fetchBlob: async (uri) => {
      reads.push(uri);
      if (options.failing?.has(uri)) throw new Error("no such song");
      return new Blob([new Uint8Array(options.sizes?.[uri] ?? 100)]);
    },
    createUrl: (blob) => {
      const url = `blob:${++made}`;
      urls.set(blob, url);
      return url;
    },
    revokeUrl: (url) => revoked.push(url),
    now: () => clock,
    maxBytes: options.maxBytes,
    maxEntries: options.maxEntries,
    maxAgeMs: options.maxAgeMs,
  });
  return { cache, reads, revoked, tick: (ms: number) => (clock += ms) };
}

const settle = () => new Promise((resolve) => setTimeout(resolve, 0));

test("a song is read once, and asking again gives the same address at once", async () => {
  const { cache, reads } = setup();
  assert.equal(cache.ready("a"), null);
  const url = await cache.load("a");
  assert.equal(cache.ready("a"), url);
  assert.equal(await cache.load("a"), url);
  const both = await Promise.all([cache.load("b"), cache.load("b")]);
  assert.equal(both[0], both[1]);
  assert.deepEqual(reads, ["a", "b"]);
});

test("the songs ahead are read one after another in the background", async () => {
  const { cache, reads } = setup();
  cache.warm(["b", "c"], ["a", "b", "c"]);
  await settle();
  await settle();
  assert.deepEqual(reads, ["b", "c"]);
  assert.ok(cache.ready("b") && cache.ready("c"));
});

test("a newer list of songs ahead replaces the older one", async () => {
  const { cache, reads } = setup();
  cache.warm(["b", "c", "d"], ["b", "c", "d"]);
  cache.warm(["x"], ["x"]); // the queue changed before the first list was read
  for (let i = 0; i < 6; i += 1) await settle();
  assert.ok(reads.includes("x"));
  assert.ok(!reads.includes("d"), "the older list stopped");
});

test("when memory is full the song used longest ago goes, never one that is playing or next", async () => {
  const { cache, revoked } = setup({ maxBytes: 250 });
  const a = await cache.load("a");
  await cache.load("b");
  await cache.load("c"); // 300 bytes: over the budget
  cache.warm([], ["c"]);
  assert.equal(cache.ready("a"), null, "the oldest was dropped");
  assert.ok(revoked.includes(a));
  assert.ok(cache.ready("c"));
  const keepAll = setup({ maxBytes: 50 });
  await keepAll.cache.load("p");
  await keepAll.cache.load("q");
  keepAll.cache.warm([], ["p", "q"]);
  assert.ok(keepAll.cache.ready("p") && keepAll.cache.ready("q"), "songs in use stay even over the budget");
});

test("at most so many songs are kept", async () => {
  const { cache } = setup({ maxEntries: 2 });
  for (const uri of ["a", "b", "c", "d"]) await cache.load(uri);
  cache.warm([], ["d"]);
  const held = ["a", "b", "c", "d"].filter((uri) => cache.ready(uri) !== null);
  assert.deepEqual(held, ["c", "d"].filter((uri) => held.includes(uri)));
  assert.ok(held.length <= 2);
  assert.ok(held.includes("d"));
});

test("a song kept for long is read again, in case its file changed", async () => {
  const { cache, reads, tick, revoked } = setup({ maxAgeMs: 1000 });
  const first = await cache.load("a");
  tick(2000);
  assert.equal(cache.ready("a"), null);
  const second = await cache.load("a");
  assert.notEqual(second, first);
  assert.deepEqual(reads, ["a", "a"]);
  assert.ok(revoked.includes(first));
});

test("a song whose file is about to change is let go, and read again after", async () => {
  const { cache, reads, revoked } = setup();
  const url = await cache.load("a");
  cache.forget(["a", "never-loaded"]);
  assert.ok(revoked.includes(url));
  assert.equal(cache.ready("a"), null);
  await cache.load("a");
  assert.deepEqual(reads, ["a", "a"]);
});

test("a song that cannot be read is an error to the one asking, and is tried again next time", async () => {
  const failing = new Set(["bad"]);
  const { cache, reads } = setup({ failing });
  await assert.rejects(() => cache.load("bad"), /no such song/);
  failing.delete("bad");
  assert.ok(await cache.load("bad"));
  assert.deepEqual(reads, ["bad", "bad"]);
  // Warming over a bad song goes on with the others.
  const warm = setup({ failing: new Set(["x"]) });
  warm.cache.warm(["x", "y"], ["y"]);
  for (let i = 0; i < 4; i += 1) await settle();
  assert.ok(warm.cache.ready("y"));
});

test("clearing lets go of everything", async () => {
  const { cache, revoked } = setup();
  const a = await cache.load("a");
  const b = await cache.load("b");
  cache.clear();
  assert.deepEqual(revoked.sort(), [a, b].sort());
  assert.equal(cache.ready("a"), null);
});
