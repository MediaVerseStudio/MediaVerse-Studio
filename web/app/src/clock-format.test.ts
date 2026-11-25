import assert from "node:assert/strict";
import { test } from "node:test";
import { clockText } from "./clock-format.ts";

test("positions are written m:ss, with hours only for a very long track", () => {
  assert.equal(clockText(0), "0:00");
  assert.equal(clockText(5.9), "0:05");
  assert.equal(clockText(65), "1:05");
  assert.equal(clockText(11 * 60 + 27), "11:27");
  assert.equal(clockText(3600 + 62), "1:01:02");
});

test("an unknown length is shown as dashes", () => {
  for (const value of [null, undefined, Number.NaN, Number.POSITIVE_INFINITY, -1]) assert.equal(clockText(value), "–:––");
});
