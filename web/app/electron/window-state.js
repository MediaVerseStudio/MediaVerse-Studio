// The main window opens where it was last closed, at the same size, or maximized if it was (D73). Windows
// does not do this for an app by itself. What was saved is checked against the screens there are now: a
// window on a screen that has gone, or bigger than its screen (another resolution or scaling), is moved and
// shrunk so all of it, title bar and window buttons included, is on one screen's work area (above the taskbar).
// `fitBounds` is pure, so the rules are unit tested; the rest reads and writes window-state.json.

const fs = require("node:fs");
const path = require("node:path");

const DEFAULT_SIZE = { width: 1120, height: 720 };
const MIN_SIZE = { width: 800, height: 600 };

const isNumber = (n) => typeof n === "number" && Number.isFinite(n);

/** How many pixels of `a` lie inside `b`. */
function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w > 0 && h > 0 ? w * h : 0;
}

/**
 * Where to open the window: `saved` ({x, y, width, height, maximized} or anything else) fitted to `workAreas`
 * (each screen's {x, y, width, height} without the taskbar; the primary screen first). Returns
 * {x, y, width, height, maximized}; x and y are left out when the window should be centred on the primary screen.
 */
function fitBounds(saved, workAreas) {
  const primary = workAreas[0];
  const centred = (size) => ({ width: Math.min(size.width, primary.width), height: Math.min(size.height, primary.height), maximized: false });
  if (!saved || typeof saved !== "object" || !["x", "y", "width", "height"].every((k) => isNumber(saved[k]))) return centred(DEFAULT_SIZE);
  const maximized = saved.maximized === true;
  const rect = { x: Math.round(saved.x), y: Math.round(saved.y), width: Math.round(saved.width), height: Math.round(saved.height) };
  // The screen holding most of the window; none at all (that screen is gone) means start afresh.
  let area = null;
  let best = 0;
  for (const candidate of workAreas) {
    const shared = overlap(rect, candidate);
    if (shared > best) {
      best = shared;
      area = candidate;
    }
  }
  if (!area) return { ...centred({ width: Math.max(MIN_SIZE.width, rect.width), height: Math.max(MIN_SIZE.height, rect.height) }), maximized };
  // No bigger than the screen, no smaller than the app allows (unless the screen itself is smaller).
  const width = Math.min(area.width, Math.max(Math.min(MIN_SIZE.width, area.width), rect.width));
  const height = Math.min(area.height, Math.max(Math.min(MIN_SIZE.height, area.height), rect.height));
  // Wholly on that screen, so the title bar and its buttons can always be reached.
  const x = Math.min(Math.max(rect.x, area.x), area.x + area.width - width);
  const y = Math.min(Math.max(rect.y, area.y), area.y + area.height - height);
  return { x, y, width, height, maximized };
}

/**
 * Where the mini player was left: `saved` ({x, y}) if the whole window of the given size lies inside one screen's work area (above the taskbar) now, otherwise
 * null (the caller then uses its usual corner). A screen that has gone, or a lower resolution, therefore never leaves it out of reach.
 */
function miniPosition(saved, workAreas, width, height) {
  if (!saved || typeof saved !== "object" || !isNumber(saved.x) || !isNumber(saved.y)) return null;
  const x = Math.round(saved.x);
  const y = Math.round(saved.y);
  const inside = workAreas.some((a) => x >= a.x && y >= a.y && x + width <= a.x + a.width && y + height <= a.y + a.height);
  return inside ? { x, y } : null;
}

/** Reads the mini player's saved place from `file` (null when there is none or it is unreadable). */
function readMiniPlace(file) {
  try {
    return JSON.parse(fs.readFileSync(file, "utf8"));
  } catch {
    return null;
  }
}

/** Remembers the mini player's place in `file` whenever it is moved (and when it closes). */
function manageMiniPlace(window, file) {
  const save = () => {
    if (window.isDestroyed()) return;
    const { x, y } = window.getBounds();
    try {
      fs.writeFileSync(file, JSON.stringify({ x, y }));
    } catch {
      // Not saved: it opens in its usual corner next time.
    }
  };
  let timer = null;
  window.on("move", () => {
    clearTimeout(timer);
    timer = setTimeout(save, 400);
  });
  window.on("close", () => {
    clearTimeout(timer);
    save();
  });
}

/** Opens `window` where it was, and remembers where it is whenever it is moved, resized or closed. */
function manageWindowState(window, screen, userData) {
  const file = path.join(userData, "window-state.json");
  const save = () => {
    if (window.isDestroyed() || window.isMinimized() || window.isFullScreen()) return;
    const bounds = window.getNormalBounds(); // the size it goes back to from maximized
    try {
      fs.writeFileSync(file, JSON.stringify({ ...bounds, maximized: window.isMaximized() }));
    } catch {
      // Not saved: it opens at the usual size next time.
    }
  };
  let timer = null;
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, 500);
  };
  for (const event of ["resize", "move", "maximize", "unmaximize"]) window.on(event, later);
  window.on("close", () => {
    clearTimeout(timer);
    save();
  });
}

/** The bounds to create the window with, from what was saved last time. */
function initialBounds(screen, userData) {
  let saved = null;
  try {
    saved = JSON.parse(fs.readFileSync(path.join(userData, "window-state.json"), "utf8"));
  } catch {
    saved = null;
  }
  const primary = screen.getPrimaryDisplay();
  const areas = [primary, ...screen.getAllDisplays().filter((d) => d.id !== primary.id)].map((d) => d.workArea);
  return fitBounds(saved, areas);
}

module.exports = { fitBounds, initialBounds, manageWindowState, miniPosition, readMiniPlace, manageMiniPlace, MIN_SIZE };
