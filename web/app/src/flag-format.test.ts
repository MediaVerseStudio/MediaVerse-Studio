import assert from "node:assert/strict";
import { test } from "node:test";
import { FlagIndex, describeFlag, flagRequest, positionText, reasonLabels, sortFlags, type Flag } from "./flag-format.ts";

const flag = (path: string, at: number, extra: Partial<Flag> = {}): Flag => ({
  path,
  reasons: ["audio"],
  note: "",
  position_ms: null,
  title: "T",
  artist: "A",
  album: null,
  flagged_at: at,
  ...extra,
});

test("reasons and positions read in words", () => {
  assert.equal(reasonLabels(["audio", "tags"]), "Audio problem, Missing or wrong tags");
  assert.equal(reasonLabels([]), "Something else");
  assert.equal(positionText(72_500), "1:12");
  assert.equal(describeFlag(flag("a", 1, { position_ms: 72_500 })), "Audio problem · noticed at 1:12");
  assert.equal(describeFlag(flag("a", 1)), "Audio problem");
});

test("the newest flag comes first", () => {
  assert.deepEqual(sortFlags([flag("a", 1), flag("c", 3), flag("b", 2)]).map((f) => f.path), ["c", "b", "a"]);
});

test("the request carries the moment the problem was noticed", () => {
  const request = flagRequest({ source_uri: "C:\\m\\a.mp3", title: "Song", artist: "Band", album: "LP" }, ["audio"], "  pop  ", 72.5);
  assert.deepEqual(request, { path: "C:\\m\\a.mp3", flagged: true, reasons: ["audio"], note: "pop", position_ms: 72_500, title: "Song", artist: "Band", album: "LP" });
  assert.equal(flagRequest({ source_uri: "x", title: "t", artist: null }, [], "", 0).position_ms, null);
  assert.equal(flagRequest({ source_uri: "x", title: "t", artist: null }, [], "", Number.NaN).position_ms, null);
});

test("the index answers whether a path is flagged", () => {
  const index = new FlagIndex();
  index.replace([flag("a", 1), flag("b", 2)]);
  assert.equal(index.has("a"), true);
  assert.equal(index.has("z"), false);
  assert.equal(index.get("b")?.flagged_at, 2);
  index.replace([]);
  assert.equal(index.has("a"), false);
});
