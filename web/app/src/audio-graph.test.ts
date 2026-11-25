import assert from "node:assert/strict";
import { test } from "node:test";
import { EQ_BANDS, EQ_LIMIT_DB, cleanEq, dbToGain } from "./audio-graph.ts";

test("the equalizer setting is cleaned: ten bands, whole decibels, within the limit, off by default", () => {
  const empty = cleanEq(null);
  assert.equal(empty.on, false);
  assert.equal(empty.gains.length, EQ_BANDS.length);
  assert.ok(empty.gains.every((g) => g === 0));
  const odd = cleanEq({ on: true, gains: [30, -30, 2.6, "x", null, 1] });
  assert.equal(odd.on, true);
  assert.deepEqual(odd.gains.slice(0, 6), [EQ_LIMIT_DB, -EQ_LIMIT_DB, 3, 0, 0, 1]);
  assert.equal(odd.gains.length, EQ_BANDS.length);
});

test("decibels become the multiplier a gain node takes", () => {
  assert.equal(dbToGain(0), 1);
  assert.ok(Math.abs(dbToGain(-6.0206) - 0.5) < 1e-4);
  assert.ok(Math.abs(dbToGain(20) - 10) < 1e-9);
});
