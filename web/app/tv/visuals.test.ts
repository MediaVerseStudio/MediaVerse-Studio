import assert from "node:assert/strict";
import test from "node:test";
import { DEFAULT_PALETTE, hslToRgb, mixPalette, NEUTRAL_PALETTE, paletteFromPixels } from "./visuals.ts";

const cover = (colours: Array<[number, number, number, number]>): Uint8Array => {
  const pixels = new Uint8Array(32 * 32 * 4);
  for (let i = 0; i < 32 * 32; i++) {
    const [r, g, b, share] = colours.find((_, k) => i < colours.slice(0, k + 1).reduce((n, c) => n + c[3], 0)) ?? [128, 128, 128, 0];
    void share;
    pixels.set([r, g, b, 255], i * 4);
  }
  return pixels;
};

const hueOf = ([r, g, b]: [number, number, number]): number => {
  const max = Math.max(r, g, b);
  const min = Math.min(r, g, b);
  if (max === min) return 0;
  const d = max - min;
  const h = max === r ? (g - b) / d + (g < b ? 6 : 0) : max === g ? (b - r) / d + 2 : (r - g) / d + 4;
  return h * 60;
};

test("a blue cover gives blue shades, light to dark", () => {
  const palette = paletteFromPixels(cover([[30, 60, 200, 1024]]));
  assert.ok(Math.abs(hueOf(palette.mid) - 229) < 8, `hue ${hueOf(palette.mid)}`);
  const light = (c: number[]) => c[0] + c[1] + c[2];
  assert.ok(light(palette.hi) > light(palette.mid) && light(palette.mid) > light(palette.lo));
});

test("a small red logo on a grey cover wins over the grey", () => {
  const palette = paletteFromPixels(cover([[200, 20, 30, 120], [120, 120, 120, 904]]));
  const hue = hueOf(palette.mid);
  assert.ok(hue < 10 || hue > 350, `hue ${hue}`);
});

test("a vivid red logo on a large sepia photo wins over the sepia (1876, Pow Wow Punk Rock 2)", () => {
  const palette = paletteFromPixels(cover([[200, 20, 25, 40], [196, 160, 120, 700], [30, 25, 35, 284]]));
  const hue = hueOf(palette.mid);
  assert.ok(hue < 10 || hue > 350, `hue ${hue}`);
});

test("black and white covers give silver; an unreadable cover keeps the app's own colours", () => {
  assert.deepEqual(paletteFromPixels(cover([[250, 250, 250, 500], [10, 10, 10, 524]])), NEUTRAL_PALETTE);
  assert.deepEqual(paletteFromPixels(new Uint8Array(0)), DEFAULT_PALETTE);
});

test("palettes blend, and HSL converts back to RGB", () => {
  assert.deepEqual(hslToRgb(0, 1, 0.5), [255, 0, 0]);
  assert.deepEqual(hslToRgb(240, 1, 0.5), [0, 0, 255]);
  const half = mixPalette(DEFAULT_PALETTE, { hi: [0, 0, 0], mid: [0, 0, 0], lo: [0, 0, 0] }, 0.5);
  assert.deepEqual(half.mid, [116, 67, 35.5]);
});
