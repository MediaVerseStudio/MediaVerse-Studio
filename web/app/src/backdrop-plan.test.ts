import assert from "node:assert/strict";
import { test } from "node:test";
import { type Cover, flipChoice } from "./backdrop-plan.ts";

const cover = (folder: string): Cover => ({ folder, url: `blob:${folder}`, track: { source_uri: `${folder}\\1.mp3`, artist: null, title: "t" } });

test("a flip shows a cover that is not already on the wall", () => {
  const covers = ["A", "B", "C", "D"].map(cover);
  for (let i = 0; i < 20; i += 1) {
    const choice = flipChoice(["A", "B", "A"], covers, () => (i * 0.137) % 1)!;
    assert.ok(["C", "D"].includes(choice.cover.folder));
    assert.ok(choice.tile >= 0 && choice.tile < 3);
  }
});

test("when every cover is showing, a flip still changes the tile", () => {
  const covers = ["A", "B"].map(cover);
  const choice = flipChoice(["A", "B"], covers, () => 0)!;
  assert.equal(choice.tile, 0);
  assert.equal(choice.cover.folder, "B");
});

test("nothing to flip on an empty wall or with a single cover", () => {
  assert.equal(flipChoice([], [cover("A"), cover("B")], Math.random), null);
  assert.equal(flipChoice(["A"], [cover("A")], Math.random), null);
  assert.equal(flipChoice(["A"], [cover("A"), cover("B")], () => 0.999)?.cover.folder, "B", "a random value near 1 stays in range");
});
