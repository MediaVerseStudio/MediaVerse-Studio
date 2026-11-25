import assert from "node:assert/strict";
import { test } from "node:test";
import { pickQuality } from "./media-request.ts";

/** A pretend encoder: the picture's size in KB at each quality. */
const encoder = (sizes: Record<number, number>) => {
  const asked: number[] = [];
  const encode = async (quality: number) => {
    asked.push(quality);
    return new Blob([new Uint8Array(Math.round((sizes[quality] ?? 9999) * 1024))]);
  };
  return { encode, asked };
};

test("pictures in the songs keep the best quality that fits 200 KB, else the best under the limit", async () => {
  const small = encoder({ 0.92: 150 });
  assert.equal((await pickQuality(small.encode))!.size, 150 * 1024);
  assert.deepEqual(small.asked, [0.92], "a picture that fits at once is not squeezed");

  const busy = encoder({ 0.92: 380, 0.9: 340, 0.88: 300, 0.86: 280, 0.84: 260, 0.82: 240, 0.8: 220 });
  assert.equal((await pickQuality(busy.encode))!.size, 380 * 1024, "no quality is given up for 200 KB alone: 92 under the 450 KB limit");

  const fits = encoder({ 0.92: 260, 0.9: 230, 0.88: 199 });
  assert.equal((await pickQuality(fits.encode))!.size, 199 * 1024, "88 reaches the 200 KB ideal");

  const huge = encoder({ 0.75: 600, 0.7: 500, 0.6: 420 });
  assert.equal((await pickQuality(huge.encode))!.size, 420 * 1024, "only then lower qualities");
  assert.equal(await pickQuality(encoder({}).encode), null);
});
