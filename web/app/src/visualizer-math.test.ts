import assert from "node:assert/strict";
import { test } from "node:test";
import { glowLevel, nextGlow } from "./visualizer-math.ts";

const frame = (fill: (hz: number) => number): number[] => Array.from({ length: 256 }, (_, i) => fill((i + 0.5) * (44_100 / 2 / 256)));

test("silence gives no glow", () => {
  assert.deepEqual(glowLevel(frame(() => 0), 44_100), { level: 0, warm: 0 });
  assert.deepEqual(glowLevel([], 44_100), { level: 0, warm: 0 });
});

test("a strong bass glows more than the same energy in the treble", () => {
  const bassy = glowLevel(frame((hz) => (hz < 180 ? 230 : 20)), 44_100);
  const trebly = glowLevel(frame((hz) => (hz > 2_000 ? 230 : 20)), 44_100);
  assert.ok(bassy.level > trebly.level, `${bassy.level} > ${trebly.level}`);
  assert.ok(trebly.warm > bassy.warm, "treble shifts the colour");
});

test("the level stays between 0 and 1 even at full scale", () => {
  const loud = glowLevel(frame(() => 255), 44_100);
  assert.ok(loud.level <= 1 && loud.level > 0.9);
  assert.ok(loud.warm >= 0 && loud.warm <= 1);
});

test("steady loud music settles to a calm glow, and beats pulse above it", () => {
  let state = { average: 0, out: 0 };
  for (let i = 0; i < 600; i += 1) state = nextGlow(state, 0.9); // ten seconds of a constant loud level
  assert.ok(state.out > 0.2 && state.out < 0.35, `settles low: ${state.out}`);
  const calm = state.out;
  for (let i = 0; i < 4; i += 1) state = nextGlow(state, 1); // a beat
  assert.ok(state.out > calm + 0.1, `the beat lifts it: ${calm} -> ${state.out}`);
  let after = state;
  for (let i = 0; i < 3; i += 1) after = nextGlow(after, 0.9);
  assert.ok(after.out < state.out && after.out > calm, "it falls back slowly, not at once");
});

test("the glow never goes outside 0..1", () => {
  let state = { average: 0, out: 0 };
  for (const level of [0, 1, 0, 1, 1, 1, 0, 0.5]) {
    state = nextGlow(state, level);
    assert.ok(state.out >= 0 && state.out <= 1);
  }
});
