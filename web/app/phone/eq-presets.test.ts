import { test } from "node:test";
import assert from "node:assert/strict";
import { decibels, hertz, presetLevels } from "./eq-presets.ts";

test("flat is all zeros; bass boost lifts the low bands most; treble the high ones", () => {
  assert.deepEqual(presetLevels("Flat", 5, -1500, 1500), [0, 0, 0, 0, 0]);
  const bass = presetLevels("Bass boost", 5, -1500, 1500);
  assert.ok(bass[0] > bass[2] && bass[2] > bass[4]);
  const treble = presetLevels("Treble boost", 5, -1500, 1500);
  assert.ok(treble[4] > treble[2] && treble[2] > treble[0]);
});

test("presets stay inside the effect's range and cope with one band", () => {
  for (const level of presetLevels("Bass boost", 5, -300, 300)) assert.ok(level >= -300 && level <= 300);
  assert.deepEqual(presetLevels("Vocal", 1, -1500, 1500).length, 1);
});

test("levels and frequencies read naturally", () => {
  assert.equal(decibels(350), "+3.5 dB");
  assert.equal(decibels(-600), "-6 dB");
  assert.equal(decibels(0), "0 dB");
  assert.equal(hertz(60), "60 Hz");
  assert.equal(hertz(3600), "3.6 kHz");
  assert.equal(hertz(14000), "14 kHz");
});
