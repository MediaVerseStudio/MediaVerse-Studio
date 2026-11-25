import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_ACCENT, accentFromPixels, inkFor, parseHex, toHex } from "./accent.ts";
import { NEUTRAL_PALETTE } from "../tv/visuals.ts";

test("colours are read and written as #rrggbb, and anything else is refused", () => {
  assert.deepEqual(parseHex(DEFAULT_ACCENT), [232, 134, 71]);
  assert.deepEqual(parseHex("#00FF7f"), [0, 255, 127]);
  assert.equal(parseHex("orange"), null);
  assert.equal(parseHex("#fff"), null);
  assert.equal(parseHex(42), null);
  assert.equal(toHex([232, 134, 71]), DEFAULT_ACCENT);
  assert.equal(toHex([300, -4, 15.6]), "#ff0010");
});

test("button text is dark on light accents and light on dark ones", () => {
  assert.equal(inkFor([232, 134, 71]), "#120a05");
  assert.equal(inkFor([255, 240, 120]), "#120a05");
  assert.equal(inkFor([40, 30, 160]), "#fdf8f4");
});

test("a cover gives its colour, a black-and-white one silver, and an unreadable one none", () => {
  const fill = (rgb: number[], count = 64) => Array.from({ length: count }, () => [...rgb, 255]).flat();
  const blue = accentFromPixels(fill([30, 60, 220]))!;
  assert.ok(blue[2] > blue[0] && blue[2] > blue[1], "blue cover, blue accent");
  assert.deepEqual(accentFromPixels(fill([128, 128, 128])), NEUTRAL_PALETTE.mid);
  assert.equal(accentFromPixels([]), null);
});
