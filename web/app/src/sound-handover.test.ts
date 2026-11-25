import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_SOUND_PREFS, MAX_CROSSFADE, cleanSoundPrefs, fadeFor, shouldHandOver, startLatency, type HandoffInput } from "./sound-handover.ts";

const base: HandoffInput = { prefs: { gapless: true, crossfade: 0 }, remaining: 5, duration: 200, paused: false, nextReady: true, sample: false, latency: 0.03, alreadyHandedOver: false };

test("preferences are cleaned: gapless is on and no crossfade by default, a crossfade is a whole number of seconds up to the limit", () => {
  assert.deepEqual(cleanSoundPrefs(null), DEFAULT_SOUND_PREFS);
  assert.deepEqual(cleanSoundPrefs({ gapless: false, crossfade: 5.4 }), { gapless: false, crossfade: 5 });
  assert.equal(cleanSoundPrefs({ crossfade: 99 }).crossfade, MAX_CROSSFADE);
  assert.equal(cleanSoundPrefs({ crossfade: -3 }).crossfade, 0);
  assert.equal(cleanSoundPrefs({ crossfade: "six" }).crossfade, 0);
});

test("the start-up time of the spare element is the middle of the readings, with a default before any", () => {
  assert.equal(startLatency([]), 0.03);
  assert.equal(startLatency([0.03, 0.9, 0.04, 0.05, 7, -1]), 0.05);
  assert.equal(startLatency([0.001, 0.002]), 0.03, "never less than the default: the playing event comes before the sound does");
  assert.equal(startLatency([Number.NaN]), 0.03);
});

test("a crossfade is never longer than half of a song", () => {
  assert.equal(fadeFor({ gapless: true, crossfade: 8 }, 200), 8);
  assert.equal(fadeFor({ gapless: true, crossfade: 8 }, 10), 5);
  assert.equal(fadeFor({ gapless: true, crossfade: 8 }, 0), 0);
});

test("gapless: the next song starts when only the start-up time is left", () => {
  assert.equal(shouldHandOver({ ...base, remaining: 5 }), false);
  assert.equal(shouldHandOver({ ...base, remaining: 0.025 }), true);
  assert.equal(shouldHandOver({ ...base, remaining: 0 }), false, "already over: the ended event takes it from there");
});

test("crossfade: the next song starts when the fade length is left", () => {
  const faded = { ...base, prefs: { gapless: true, crossfade: 6 } };
  assert.equal(shouldHandOver({ ...faded, remaining: 6.5 }), false);
  assert.equal(shouldHandOver({ ...faded, remaining: 5.9 }), true);
});

test("nothing is handed over when paused, when a sample is playing, when nothing is ready, or when both options are off", () => {
  const near = { ...base, remaining: 0.03 };
  assert.equal(shouldHandOver({ ...near, paused: true }), false);
  assert.equal(shouldHandOver({ ...near, sample: true }), false);
  assert.equal(shouldHandOver({ ...near, nextReady: false }), false);
  assert.equal(shouldHandOver({ ...near, alreadyHandedOver: true }), false);
  assert.equal(shouldHandOver({ ...near, prefs: { gapless: false, crossfade: 0 } }), false);
  assert.equal(shouldHandOver({ ...near, duration: Number.NaN }), false);
});
