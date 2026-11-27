import assert from "node:assert/strict";
import { test } from "node:test";
import { type Cover, flipChoice, wallGrid } from "./backdrop-plan.ts";

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

test("the wall grid fills the width exactly, whatever the window size", () => {
  for (const width of [320, 800, 1280, 1366, 1586, 1601, 1920, 2560, 3440, 3840]) {
    for (const [cell, gap] of [[96, 2], [80, 3]] as const) {
      const { cols, size } = wallGrid(width, cell, gap);
      assert.ok(Math.abs(cols * size + (cols - 1) * gap - width) < 1e-6, `${width}px: ${cols} columns of ${size}px`);
      // Never far from the intended size, so covers are not noticeably squashed or enlarged (wide windows within 4%).
      if (width >= 1280) assert.ok(Math.abs(size / cell - 1) < 0.04, `${width}px: ${size}px against ${cell}px`);
    }
  }
  assert.equal(wallGrid(100, 96, 2).cols, 1);
  assert.equal(wallGrid(10, 96, 2).cols, 1);
});
