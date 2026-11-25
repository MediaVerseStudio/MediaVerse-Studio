import { test } from "node:test";
import assert from "node:assert/strict";
import { addBookmark, dropQueue, freeQueueName, putQueue, removeBookmark, type SavedQueue } from "./keep-places.ts";

test("bookmarks stay in time order and one within a second replaces the old one", () => {
  let list = addBookmark([], 90_000, "chorus", 1);
  list = addBookmark(list, 30_000, "", 2);
  assert.deepEqual(list.map((b) => b.ms), [30_000, 90_000]);
  list = addBookmark(list, 90_500, "better chorus", 3);
  assert.equal(list.length, 2);
  assert.equal(list[1].note, "better chorus");
  assert.deepEqual(removeBookmark(list, 0).map((b) => b.ms), [90_500]);
});

const q = (id: string, name: string): SavedQueue => ({ id, name, ids: ["1"], index: 0, position: 0, updated: 0 });

test("saved queues: the latest first, replaced by id, dropped by id", () => {
  let list = putQueue([], q("a", "Road trip"));
  list = putQueue(list, q("b", "Gym"));
  assert.deepEqual(list.map((x) => x.id), ["b", "a"]);
  list = putQueue(list, { ...q("a", "Road trip"), position: 5 });
  assert.deepEqual(list.map((x) => x.id), ["a", "b"]);
  assert.deepEqual(dropQueue(list, "a").map((x) => x.id), ["b"]);
});

test("a queue name is made unique", () => {
  const list = [q("a", "Gym"), q("b", "Gym 2")];
  assert.equal(freeQueueName("Gym", list), "Gym 3");
  assert.equal(freeQueueName("  ", list), "Queue");
  assert.equal(freeQueueName("Road trip", list), "Road trip");
});
