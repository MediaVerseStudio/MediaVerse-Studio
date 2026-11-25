// Development aid: starts the real app with a throwaway data folder, imports a library folder that
// holds audio, opens the first artist, presses Play, and checks the audio element really plays.
// Run: npx electron scripts/capture-playback.cjs <library-folder> <output-dir>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const library = path.resolve(process.argv[2] || "");
const outputDir = path.resolve(process.argv[3] || path.join(os.tmpdir(), "mediaverse-capture-play"));
fs.mkdirSync(outputDir, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-play-data-")));
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
async function shot(win, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, `${name}.png`), image.toPNG());
  console.log("saved", name);
}

app.whenReady().then(async () => {
  try {
    const win = await window();
    win.setSize(1180, 900);
    win.show();
    await waitFor(win, "document.readyState === 'complete'", 15000, "page load");
    await wait(1000);
    const imported = await run(win, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} }).then((r) => JSON.stringify(r).slice(0, 120))`);
    console.log("import:", imported);
    await run(win, "document.querySelector('#rescan-collection').click()");
    await waitFor(win, "document.querySelector('.artist-card')", 15000, "an artist card");
    await run(win, "document.querySelector('.artist-card').click()");
    await waitFor(win, "document.querySelector('.album-card .play-button')", 5000, "the play button");
    await shot(win, "1-album");
    await run(win, "document.querySelector('.album-card .play-button').click()");
    await waitFor(win, "document.querySelector('#player-audio').currentTime > 0.5", 15000, "audio to play");
    await wait(500);
    await shot(win, "2-playing");
    const state = await run(win, "(() => { const a = document.querySelector('#player-audio'); return JSON.stringify({ t: a.currentTime, paused: a.paused, error: a.error && a.error.message, dur: a.duration, title: document.querySelector('#player-title').textContent }); })()");
    console.log("player:", state);

    // The Now Playing view with the cover collage.
    await run(win, "document.querySelector('#player-expand').click()");
    await wait(2500);
    await shot(win, "3-now-playing");
    await run(win, "document.querySelector('#np-back').click()");

    // Shuffle and repeat, then reload the page: the queue comes back paused with the same settings.
    await run(win, "document.querySelector('#player-repeat').click(); document.querySelector('#player-shuffle').click()");
    await wait(6500);
    await run(win, "location.reload()");
    await wait(2500);
    console.log("after reload:", await run(win, "JSON.stringify({ visible: !document.querySelector('#player').hidden, title: document.querySelector('#player-title').textContent, repeat: document.querySelector('#player-repeat').textContent, shuffle: document.querySelector('#player-shuffle').getAttribute('aria-pressed'), paused: document.querySelector('#player-audio').paused })"));

  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
