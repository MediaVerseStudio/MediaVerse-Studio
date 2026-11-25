// Development aid: starts the real app with a throwaway data folder, plays the first album (muted), jumps close to the end of each song and records when the
// next song really starts relative to when the last one ends, for gapless playback and for a crossfade. Run:
//   npx electron scripts/check-gapless.cjs <library-folder> <output-dir>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const library = path.resolve(process.argv[2] || "");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-gapless-data-")));
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function window() {
  const { BrowserWindow } = require("electron");
  for (let i = 0; i < 100; i++) {
    const [first] = BrowserWindow.getAllWindows();
    if (first) return first;
    await wait(100);
  }
  throw new Error("No window appeared.");
}
async function waitFor(win, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await run(win, expression)) return;
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

const INSTRUMENT = `(() => {
  window.__log = [];
  const els = [...document.querySelectorAll('#player audio, audio')];
  els.forEach((el, i) => {
    for (const ev of ['playing', 'ended', 'pause', 'play']) el.addEventListener(ev, () => window.__log.push({ t: performance.now(), el: i, ev, time: el.currentTime }));
  });
  return els.length;
})()`;

async function playAlbum(win) {
  await run(win, "document.querySelector('[data-page=library]').click()");
  await waitFor(win, "document.querySelectorAll('.lib-artist').length >= 12", 60000, "the demo artists");
  await run(win, "[...document.querySelectorAll('.lib-artist')].find((e) => e.textContent.trim().startsWith('Copper Lantern')).click()");
  await waitFor(win, "document.querySelectorAll('#artist-page tr[data-path]').length > 5", 10000, "the artist page");
  await run(win, "document.querySelector('#artist-page tr[data-path]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
  await waitFor(win, "document.querySelector('#player-audio').currentTime > 0.3", 15000, "audio to play");
  await run(win, "document.querySelectorAll('audio').forEach((a) => { a.muted = true; })");
}

async function measure(win, label) {
  await run(win, "window.__log = []");
  const rows = [];
  for (let song = 0; song < 3; song++) {
    // Jump to five seconds from the end of whichever element is the current song, then wait for the hand-over.
    await run(win, `(() => { const playing = [...document.querySelectorAll('audio')].find((a) => !a.paused && a.getAttribute('src')); if (playing && playing.duration > 10) playing.currentTime = playing.duration - 5; })()`);
    await wait(9000);
  }
  const log = JSON.parse(await run(win, "JSON.stringify(window.__log)"));
  console.log(label, JSON.stringify(log.map((e) => ({ t: Math.round(e.t), el: e.el, ev: e.ev, time: Math.round(e.time * 1000) / 1000 }))));
  // For each 'playing' of an element after an 'ended' or while another still plays: overlap = ended(old) - playing(new)
  const ended = log.filter((e) => e.ev === 'ended');
  const playing = log.filter((e) => e.ev === 'playing');
  for (const end of ended) {
    const next = playing.filter((p) => p.el !== end.el && Math.abs(p.t - end.t) < 2500).sort((a, b) => Math.abs(a.t - end.t) - Math.abs(b.t - end.t))[0];
    rows.push(next ? { endedAt: Math.round(end.t), nextPlayingAt: Math.round(next.t), overlapMs: Math.round(end.t - next.t) } : { endedAt: Math.round(end.t), nextPlayingAt: null });
  }
  console.log(label, "joins:", JSON.stringify(rows));
}

app.whenReady().then(async () => {
  try {
    const win = await window();
    win.webContents.on("console-message", (e, level, message) => { if (String(message).startsWith("DBG")) console.log(message); });
    win.setSize(1180, 900);
    win.show();
    await waitFor(win, "document.readyState === 'complete'", 15000, "page load");
    await wait(1000);
    await run(win, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} }).then(() => 1)`);
    await run(win, "document.querySelector('#rescan-collection').click()");
    console.log("elements:", await run(win, INSTRUMENT));
    await playAlbum(win);
    await measure(win, "gapless");
    // Crossfade of 4 seconds: set the preference and look again.
    await run(win, "localStorage.setItem('mediaverse.sound-prefs.v1', JSON.stringify({ gapless: true, crossfade: 4 })); location.reload()");
    await wait(3000);
    await waitFor(win, "document.querySelector('#player-audio').getAttribute('src')", 15000, "the saved queue");
    await run(win, INSTRUMENT);
    await run(win, "document.querySelector('#player-play').click()");
    await wait(1500);
    await run(win, "document.querySelectorAll('audio').forEach((a) => { a.muted = true; })");
    await measure(win, "crossfade4");
  } catch (error) {
    console.error("check failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
