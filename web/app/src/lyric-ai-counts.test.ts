import assert from "node:assert/strict";
import { test } from "node:test";
import { classify } from "./lyric-ai-counts.ts";

test("a result is counted by what happened to it", () => {
  assert.equal(classify({ need: "sure", applied: true, has_timing: true }), "applied");
  assert.equal(classify({ task: "instrumental", need: "review" }), "instrumental");
  assert.equal(classify({ task: "error", need: "review" }), "failed");
  // certain but not written (the box was unticked): waits for the person, never "nothing to do"
  assert.equal(classify({ need: "sure", has_timing: true }), "ready");
  assert.equal(classify({ need: "review", has_timing: true }), "ready");
  // nothing fitted, or the timing already fits
  assert.equal(classify({ need: "review", verdict: "no found lyrics match this recording" }), "nothing");
  assert.equal(classify({ need: "nothing" }), "nothing");
});
