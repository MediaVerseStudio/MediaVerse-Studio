import assert from "node:assert/strict";
import { test } from "node:test";
import { pageCount, pageItems, rangeText } from "./pager-pages.ts";

const show = (current: number, pages: number): string => pageItems(current, pages).map((i) => (i === "gap" ? "…" : String(i))).join(" ");

test("up to eight pages are all listed", () => {
  assert.equal(show(1, 1), "1");
  assert.equal(show(3, 5), "1 2 3 4 5");
  assert.equal(show(8, 8), "1 2 3 4 5 6 7 8");
});

test("more pages: the current page in the middle with two each side, the first and last page, and gaps", () => {
  assert.equal(show(8, 16), "1 … 6 7 8 9 10 … 16");
  assert.equal(show(7, 20), "1 … 5 6 7 8 9 … 20");
});

test("near the start or the end the first or last six pages are listed", () => {
  assert.equal(show(1, 16), "1 2 3 4 5 6 … 16");
  assert.equal(show(4, 16), "1 2 3 4 5 6 … 16");
  assert.equal(show(16, 16), "1 … 11 12 13 14 15 16");
  assert.equal(show(13, 16), "1 … 11 12 13 14 15 16");
});

test("a gap of a single page shows that page instead of the dots", () => {
  assert.equal(show(5, 16), "1 2 3 4 5 6 7 … 16");
  assert.equal(show(12, 16), "1 … 10 11 12 13 14 15 16");
  assert.equal(show(9, 12), "1 … 7 8 9 10 11 12");
});

test("the range text counts from one and ends at the total", () => {
  assert.equal(rangeText(8, 100, 1600, "song"), "Showing 801–900 of 1,600 songs");
  assert.equal(rangeText(1, 100, 150, "song"), "Showing 101–150 of 150 songs");
  assert.equal(rangeText(0, 100, 1, "song"), "Showing 1–1 of 1 song");
  assert.equal(rangeText(0, 100, 0, "song"), "No songs");
});

test("the page count is never below one", () => {
  assert.equal(pageCount(0, 100), 1);
  assert.equal(pageCount(100, 100), 1);
  assert.equal(pageCount(101, 100), 2);
});
