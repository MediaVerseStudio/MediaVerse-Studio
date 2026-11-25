import assert from "node:assert/strict";
import { test } from "node:test";
import { readSavedPosition, readSavedQueue, restoreQueue, snapshotQueue } from "./queue-memory.ts";

const song = (id: string) => ({ id, title: id });
const library = (...ids: string[]) => new Map(ids.map((id) => [id, song(id)]));

test("an empty queue, no source or a position outside the queue is not saved", () => {
  assert.equal(snapshotQueue("s", [], [], -1, false, "off"), null);
  assert.equal(snapshotQueue("", [song("a")], [0], 0, false, "off"), null);
  assert.equal(snapshotQueue("s", [song("a")], [0], 3, false, "off"), null);
  assert.ok(snapshotQueue("s", [song("a")], [0], 0, true, "all"));
});

test("a saved queue survives being written and read back, and damaged text is refused", () => {
  const saved = snapshotQueue("jellyfin:x", [song("a"), song("b"), song("c")], [2, 0, 1], 1, true, "one")!;
  assert.deepEqual(readSavedQueue(JSON.stringify(saved)), saved);
  for (const bad of [null, "", "{", "[]", JSON.stringify({ ...saved, v: 2 }), JSON.stringify({ ...saved, ids: [] }), JSON.stringify({ ...saved, ids: [1, 2] }), JSON.stringify({ ...saved, order: [0, 9] }), JSON.stringify({ ...saved, position: 7 }), JSON.stringify({ ...saved, source: "" })]) {
    assert.equal(readSavedQueue(bad), null, String(bad));
  }
  assert.equal(readSavedQueue(JSON.stringify({ ...saved, repeat: "bogus" }))?.repeat, "off");
});

test("a position is read back only when it is well formed", () => {
  assert.deepEqual(readSavedPosition(JSON.stringify({ source: "s", id: "a", seconds: 12.5 })), { source: "s", id: "a", seconds: 12.5 });
  for (const bad of [null, "x", JSON.stringify({ source: "s", id: "a", seconds: -1 }), JSON.stringify({ source: "s", id: 1, seconds: 1 }), JSON.stringify({})]) assert.equal(readSavedPosition(bad), null);
});

test("the queue comes back in the same order, on the same song, at the same second, with shuffle and the order kept", () => {
  const saved = snapshotQueue("s", [song("a"), song("b"), song("c"), song("d")], [3, 1, 0, 2], 2, true, "all")!;
  const back = restoreQueue(saved, library("a", "b", "c", "d"), { source: "s", id: "a", seconds: 61 })!;
  assert.deepEqual(back.queue.map((t) => t.id), ["a", "b", "c", "d"]);
  assert.deepEqual(back.order, [3, 1, 0, 2]);
  assert.equal(back.position, 2);
  assert.equal(back.queue[back.order[back.position]].id, "a");
  assert.equal(back.seconds, 61);
  assert.equal(back.missing, 0);
});

test("songs no longer in the library are left out and the order closes up", () => {
  const saved = snapshotQueue("s", [song("a"), song("b"), song("c"), song("d")], [0, 1, 2, 3], 2, false, "off")!;
  const back = restoreQueue(saved, library("a", "c", "d"), { source: "s", id: "c", seconds: 5 })!;
  assert.deepEqual(back.queue.map((t) => t.id), ["a", "c", "d"]);
  assert.deepEqual(back.order, [0, 1, 2]);
  assert.equal(back.queue[back.order[back.position]].id, "c");
  assert.equal(back.missing, 1);
  assert.equal(back.seconds, 5);
});

test("if the playing song is gone the next one that is still there is where it resumes, from the start", () => {
  const saved = snapshotQueue("s", [song("a"), song("b"), song("c")], [0, 1, 2], 1, false, "off")!;
  const back = restoreQueue(saved, library("a", "c"), { source: "s", id: "b", seconds: 99 })!;
  assert.equal(back.queue[back.order[back.position]].id, "c");
  assert.equal(back.seconds, 0);
  // and when everything from there on is gone, the last song left
  const tail = restoreQueue(saved, library("a"), null)!;
  assert.equal(tail.queue[tail.order[tail.position]].id, "a");
});

test("nothing comes back when none of the songs is in the library, and a place from another source or song is not used", () => {
  const saved = snapshotQueue("s", [song("a"), song("b")], [0, 1], 0, false, "off")!;
  assert.equal(restoreQueue(saved, library("x", "y"), null), null);
  assert.equal(restoreQueue(saved, library("a", "b"), { source: "other", id: "a", seconds: 30 })!.seconds, 0);
  assert.equal(restoreQueue(saved, library("a", "b"), { source: "s", id: "b", seconds: 30 })!.seconds, 0);
});
