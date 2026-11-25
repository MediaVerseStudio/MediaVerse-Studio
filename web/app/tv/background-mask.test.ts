import { test } from "node:test";
import assert from "node:assert/strict";
import { parseMask } from "./background-mask.ts";

test("the colour mask keeps valid choices and falls back to the app's starting look", () => {
  assert.deepEqual(parseMask(null, true), { on: true, hex: null });
  assert.deepEqual(parseMask(undefined, false), { on: false, hex: null });
  assert.deepEqual(parseMask({ on: false, hex: "#00E5FF" }, true), { on: false, hex: "#00e5ff" }, "off is kept, the colour is one of the offered ones");
  assert.deepEqual(parseMask({ on: true, hex: "#123456" }, false), { on: true, hex: null }, "a colour that is not offered means drifting");
  assert.deepEqual(parseMask({ on: "yes", hex: 5 }, true), { on: true, hex: null });
});
