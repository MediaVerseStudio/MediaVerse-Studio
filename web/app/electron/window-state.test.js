const assert = require("node:assert/strict");
const { test } = require("node:test");
const { fitBounds, miniPosition } = require("./window-state");

// A 1920 x 1080 screen with a 48-pixel taskbar, and a second screen to its right.
const main = { x: 0, y: 0, width: 1920, height: 1032 };
const right = { x: 1920, y: 0, width: 2560, height: 1392 };

test("the first start, or a damaged file, opens at the usual size in the middle", () => {
  assert.deepEqual(fitBounds(null, [main]), { width: 1120, height: 720, maximized: false });
  assert.deepEqual(fitBounds({ x: "a", y: 0, width: 900, height: 700 }, [main]), { width: 1120, height: 720, maximized: false });
});

test("a window that fits opens exactly where it was, maximized if it was", () => {
  assert.deepEqual(fitBounds({ x: 100, y: 80, width: 1300, height: 800, maximized: false }, [main]), { x: 100, y: 80, width: 1300, height: 800, maximized: false });
  assert.deepEqual(fitBounds({ x: 2000, y: 50, width: 1600, height: 1000, maximized: true }, [main, right]), { x: 2000, y: 50, width: 1600, height: 1000, maximized: true });
});

test("a window partly off the screen, or under the taskbar, is moved back fully onto it", () => {
  assert.deepEqual(fitBounds({ x: -300, y: -40, width: 1200, height: 800 }, [main]), { x: 0, y: 0, width: 1200, height: 800, maximized: false });
  assert.deepEqual(fitBounds({ x: 1500, y: 600, width: 1200, height: 800 }, [main]), { x: 720, y: 232, width: 1200, height: 800, maximized: false });
});

test("a window bigger than its screen (lower resolution or more scaling now) shrinks to fit, title bar in view", () => {
  const laptop = { x: 0, y: 0, width: 1280, height: 672 };
  assert.deepEqual(fitBounds({ x: 50, y: 30, width: 2400, height: 1300 }, [laptop]), { x: 0, y: 0, width: 1280, height: 672, maximized: false });
});

test("a window on a screen that is no longer connected opens in the middle of the main screen", () => {
  assert.deepEqual(fitBounds({ x: 2400, y: 100, width: 1400, height: 900, maximized: false }, [main]), { width: 1400, height: 900, maximized: false });
  assert.deepEqual(fitBounds({ x: 2400, y: 100, width: 3000, height: 1300, maximized: true }, [main]), { width: 1920, height: 1032, maximized: true });
});

test("the mini player returns to where it was left when all of it is still on a screen", () => {
  assert.deepEqual(miniPosition({ x: 2000, y: 300 }, [main, right], 380, 124), { x: 2000, y: 300 });
  assert.deepEqual(miniPosition({ x: 1540, y: 908 }, [main, right], 380, 124), { x: 1540, y: 908 }, "touching the corner of the work area is still inside");
});

test("the mini player goes back to its corner when part of it would be off the screen, or the screen is gone, or nothing was saved", () => {
  assert.equal(miniPosition({ x: 1700, y: 300 }, [main], 380, 124), null, "hangs over the right edge");
  assert.equal(miniPosition({ x: 100, y: 950 }, [main], 380, 124), null, "under the taskbar");
  assert.equal(miniPosition({ x: 2000, y: 300 }, [main], 380, 124), null, "the second screen is not there now");
  assert.equal(miniPosition(null, [main], 380, 124), null);
  assert.equal(miniPosition({ x: "a", y: 1 }, [main], 380, 124), null);
});
