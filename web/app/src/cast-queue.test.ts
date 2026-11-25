import assert from "node:assert/strict";
import test from "node:test";
import { CastQueue } from "./cast-queue.ts";

const seeded = (): (() => number) => {
  let x = 7;
  return () => {
    x = (x * 16807) % 2147483647;
    return x / 2147483647;
  };
};
const queue = (at = 0) => new CastQueue([1, 2, 3, 4, 5, 6], at, seeded());

test("the queue ends when repeat is off, and starts again when repeating all", () => {
  const q = queue(5);
  assert.equal(q.afterEnd(), null);
  assert.equal(q.afterNext(), null);
  q.cycleRepeat();
  assert.equal(q.repeat, "all");
  assert.equal(q.afterEnd(), 0);
  assert.equal(q.afterNext(), 0);
  q.cycleRepeat();
  assert.equal(q.repeat, "one");
  assert.equal(q.afterEnd(), 5, "the same song again");
  assert.equal(q.afterNext(), 0, "the Next button still moves on");
  assert.equal(q.cycleRepeat(), "off");
});

test("shuffle mixes only what is still to come, and turning it off restores the order around the current song", () => {
  const q = queue(2);
  assert.equal(q.toggleShuffle(), true);
  assert.deepEqual(q.items.slice(0, 3), [1, 2, 3], "what was played and the current song stay");
  assert.deepEqual([...q.items.slice(3)].sort(), [4, 5, 6]);
  q.moveTo(4);
  const now = q.current;
  assert.equal(q.toggleShuffle(), false);
  assert.deepEqual(q.items, [1, 2, 3, 4, 5, 6]);
  assert.equal(q.current, now, "still on the same song");
});

test("moving is kept inside the queue", () => {
  const q = queue();
  q.moveTo(99);
  assert.equal(q.index, 5);
  q.moveTo(-3);
  assert.equal(q.index, 0);
});
