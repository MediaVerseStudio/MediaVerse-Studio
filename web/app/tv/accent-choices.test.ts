import assert from "node:assert/strict";
import { test } from "node:test";
import { ACCENT_CHOICES, DEFAULT_ACCENT, accentChoice, contrastOnDark, inkFor, paletteFromHex, parseHex } from "./accent-choices.ts";

test("there are 20 distinct highlight colours, the orange first, each readable on the dark screens", () => {
  assert.equal(ACCENT_CHOICES.length, 20);
  assert.equal(ACCENT_CHOICES[0].hex, DEFAULT_ACCENT);
  assert.equal(new Set(ACCENT_CHOICES.map((c) => c.hex)).size, 20);
  assert.equal(new Set(ACCENT_CHOICES.map((c) => c.name)).size, 20);
  for (const choice of ACCENT_CHOICES) {
    assert.ok(contrastOnDark(parseHex(choice.hex)!) >= 4.5, `${choice.name} reads on the dark background`);
  }
});

test("only offered colours are kept; anything else is the orange", () => {
  assert.equal(accentChoice("#FF2BD6"), "#ff2bd6");
  assert.equal(accentChoice("#123456"), DEFAULT_ACCENT);
  assert.equal(accentChoice(null), DEFAULT_ACCENT);
});

test("button text and the visualizer palette follow the chosen colour", () => {
  assert.equal(inkFor(parseHex("#ffe81a")!), "#120a05");
  const palette = paletteFromHex("#3ea0ff");
  assert.deepEqual(palette.mid, [62, 160, 255]);
  assert.ok(palette.hi[0] > palette.mid[0] && palette.lo[2] < palette.mid[2], "lighter above, darker below");
});
