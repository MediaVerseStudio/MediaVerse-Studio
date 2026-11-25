// Development aid: checks the TV app's safe resume (owner, 2026-11-03: a song paused for about 5 minutes did not
// continue). Runs the real app with a throwaway data folder and a small library, pairs the built TV app
// (dist-tv) with it like capture-tv.cjs does, plays a song, then checks:
//   1. Play after a pause longer than a minute reopens the song at the same position and it moves on.
//   2. A player that is meant to play but does not move (simulated with playbackRate 0) is reopened by the
//      watchdog within about 6 seconds and moves on.
// Build first: npm run build && npm run tv:build
// Run: npx electron scripts/check-tv-resume.cjs <library-folder>
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const library = path.resolve(process.argv[2] || "");
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-check-resume-"));
const PORT = 47791;
fs.writeFileSync(path.join(dataDir, "library-share.json"), JSON.stringify({ enabled: false, port: PORT }));
app.setPath("userData", dataDir);
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function firstWindow() {
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
    await wait(200);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
async function press(win, keyCode) {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode });
  await wait(140);
}
const position = (tv) => run(tv, "Math.round(document.querySelector('#audio').currentTime * 10) / 10");

app.whenReady().then(async () => {
  let failed = false;
  const check = (ok, text) => {
    console.log(`${ok ? "PASS" : "FAIL"}: ${text}`);
    if (!ok) failed = true;
  };
  try {
    const main = await firstWindow();
    await waitFor(main, "document.readyState === 'complete'", 15000, "app page");
    await wait(800);
    console.log("imported tracks:", await run(main, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} }).then((r) => r.ok ? r.result.track_count : JSON.stringify(r.error))`));
    const status = await run(main, "window.mediaVerse.share.setEnabled(true)");
    const host = `${status.addresses[0] ?? "127.0.0.1"}:${PORT}`;
    const tv = new BrowserWindow({ width: 1920, height: 1080, useContentSize: true, show: true, webPreferences: { contextIsolation: true, sandbox: true, backgroundThrottling: false } });
    await tv.loadFile(path.join(__dirname, "..", "dist-tv", "index.html"), { query: { look: host } });
    await waitFor(tv, "!document.querySelector('#who').hidden", 5000, "who is listening");
    await run(tv, "document.querySelector('#who-skip') && !document.querySelector('#who-skip').hidden ? document.querySelector('#who-skip').click() : (document.querySelector('#who-list .who-tile') || {}).click && document.querySelector('#who-list .who-tile').click()");
    await wait(600);
    if (!(await run(tv, "document.querySelector('#who').hidden"))) {
      for (const key of ["T", "Done"]) await run(tv, `[...document.querySelectorAll('#who-name-keys .key')].find((k) => k.textContent === '${key}').click()`);
    }
    await waitFor(tv, "document.querySelectorAll('#source-list .source').length > 0", 30000, "the computer in the list");
    await run(tv, "document.querySelector('#source-list .source').click()");
    main.webContents.setBackgroundThrottling(false);
    await waitFor(main, "window.mediaVerse.share.status().then((s) => !!s.pairing)", 10000, "pairing code");
    const code = await run(main, "window.mediaVerse.share.status().then((s) => s.pairing.code)");
    tv.focus();
    for (const digit of code) await press(tv, digit);
    await waitFor(tv, "!document.querySelector('#browse').hidden && document.querySelectorAll('.tile').length > 0", 30000, "albums");
    await run(tv, "document.querySelector('.tile').click()");
    await waitFor(tv, "!!document.querySelector('.album-view')", 5000, "album view");
    await run(tv, "[...document.querySelectorAll('#view button')].find((b) => b.textContent.trim() === 'Play').click()");
    await waitFor(tv, "document.querySelector('#audio').currentTime > 3", 20000, "playback");
    // Count reloads of the song from here on.
    await run(tv, "window.__loads = 0; document.querySelector('#audio').addEventListener('loadstart', () => window.__loads++)");

    // 1. A short pause resumes as it is; a long pause reopens the song where it stopped.
    await run(tv, "document.querySelector('#np-controls [data-action=playPause]').click()");
    await wait(1500);
    const pausedAt = await position(tv);
    await run(tv, "document.querySelector('#np-controls [data-action=playPause]').click()");
    await wait(2500);
    check((await run(tv, "window.__loads")) === 0 && (await position(tv)) > pausedAt, `a short pause resumes without reopening (paused at ${pausedAt} s, now ${await position(tv)} s)`);
    await run(tv, "document.querySelector('#np-controls [data-action=playPause]').click()");
    await wait(1500);
    const longPausedAt = await position(tv);
    // Pretend two minutes have passed.
    await run(tv, "(() => { const real = Date.now; Date.now = () => real() + 120000; })()");
    await run(tv, "document.querySelector('#np-controls [data-action=playPause]').click()");
    await wait(3500);
    const afterLong = await position(tv);
    const loadsAfterLong = await run(tv, "window.__loads");
    check(loadsAfterLong === 1 && afterLong > longPausedAt && afterLong < longPausedAt + 6, `after a long pause the song is reopened at ${longPausedAt} s and goes on (now ${afterLong} s, reloads ${loadsAfterLong})`);

    // 2. A player that should play but does not move is reopened by the watchdog.
    const frozenAt = await position(tv);
    await run(tv, "document.querySelector('#audio').playbackRate = 0");
    await wait(9000);
    const afterFreeze = await position(tv);
    const loadsAfterFreeze = await run(tv, "window.__loads");
    check(loadsAfterFreeze === 2 && afterFreeze > frozenAt, `a frozen player is reopened by the watchdog (frozen at ${frozenAt} s, now ${afterFreeze} s, reloads ${loadsAfterFreeze})`);
    // Electron's Chromium cannot play the clip's MPEG-4 video (the TV can): only checked where it plays.
    const clip = await run(tv, "(() => { const v = document.querySelector('#keep-awake'); return { playing: !v.paused, error: v.error && v.error.code }; })()");
    if (clip.error === 4) console.log("SKIP: the keep-awake clip (this browser cannot play its format; the TV can)");
    else check(clip.playing, "the keep-awake clip plays again after resuming");
  } catch (error) {
    console.error("check failed:", error.message);
    failed = true;
  } finally {
    process.exitCode = failed ? 1 : 0;
    app.quit();
  }
});
