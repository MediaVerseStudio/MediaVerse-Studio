import assert from "node:assert/strict";
import test from "node:test";
import { createCycle, flipDelay, wallSizes } from "./cover-flip.ts";

function seeded(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 2 ** 32;
  };
}

test("every tile turns once before any turns twice, and never twice in a row", () => {
  const cycle = createCycle(40, seeded(7));
  let previous = -1;
  for (let round = 0; round < 5; round++) {
    const seen = new Set<number>();
    for (let i = 0; i < 40; i++) {
      const next = cycle.next();
      assert.notEqual(next, previous);
      previous = next;
      seen.add(next);
    }
    assert.equal(seen.size, 40, `round ${round} covers every tile`);
  }
  assert.equal(createCycle(0).next(), -1);
});

test("a tile turns every 5 seconds", () => {
  assert.equal(flipDelay(seeded(3)), 5_000);
});

test("wall sizes vary, cover the wall, and keep large tiles few", () => {
  const sizes = wallSizes(14 * 8, seeded(11));
  const area = sizes.reduce((sum, s) => sum + s * s, 0);
  assert.ok(area >= 14 * 8, "covers the wall");
  assert.ok(new Set(sizes).size === 3, "small, medium and large");
  assert.ok(sizes.filter((s) => s === 3).length <= 2);
  assert.ok(wallSizes(100, seeded(1), 2).every((s) => s <= 2));
});
