import assert from "node:assert/strict";
import { test } from "node:test";
import { describeCounts } from "./album-ids.ts";

test("the summary says what is ready, what waits and what is done", () => {
  assert.equal(describeCounts({ ready: 0, album_only: 0, review: 0, has_ids: 0, too_few: 0, applied: 0, dismissed: 0, error: 0, total: 0 }), "The library has not been checked yet.");
  const text = describeCounts({ ready: 800, album_only: 60, review: 90, has_ids: 40, too_few: 30, applied: 0, dismissed: 0, error: 0, total: 990 });
  assert.match(text, /990 albums: 800 albums ready/);
  assert.match(text, /60 where only the album is certain/);
  assert.match(text, /90 set aside for a look/);
  assert.match(text, /40 already tagged/);
  assert.match(text, /30 single-song folders left out/);
  assert.doesNotMatch(text, /written/);
});

