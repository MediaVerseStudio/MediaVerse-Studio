// Development aid: in the real app, adds time-stamped lyrics to a copy of a library song, plays it, opens
// Now Playing's Lyrics tab, and checks the highlighted line follows the song and that clicking a line seeks.
// Run: npx electron scripts/capture-lyrics.cjs <library-folder> <output-dir>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const source = path.resolve(process.argv[2] || "");
const outputDir = path.resolve(process.argv[3] || path.join(os.tmpdir(), "mediaverse-capture-lyrics"));
fs.mkdirSync(outputDir, { recursive: true });
const library = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-lyrics-lib-"));
fs.cpSync(source, library, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-lyrics-data-")));
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function window() {
  const { BrowserWindow } = require("electron");
  for (let i = 0; i < 100; i++) { const [first] = BrowserWindow.getAllWindows(); if (first) return first; await wait(100); }
  throw new Error("No window appeared.");
}
async function waitFor(win, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await run(win, expression)) return; await wait(200); }
  throw new Error(`Timed out waiting for ${label}.`);
}
const mp3 = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f.toString())).find((f) => f.toLowerCase().endsWith(".mp3"));
app.whenReady().then(async () => {
  try {
    const win = await window();
    win.setSize(1360, 900);
    win.show();
    await waitFor(win, "document.readyState === 'complete'", 15000, "page load");
    await wait(800);
    const song = mp3(library);
    await run(win, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} })`);
    const lrc = "[00:01.00]First line of the song\n[00:04.00]Second line follows\n[00:07.00]Third line is here\n[00:10.00]And a fourth to finish";
    const saved = await run(win, `window.mediaVerse.invoke('update_track_media', { paths: [${JSON.stringify(song)}], lyrics: { text: ${JSON.stringify(lrc)} } }).then((r) => JSON.stringify(r))`);
    console.log("saved:", saved.slice(0, 80));
    await run(win, "document.querySelector('#rescan-collection').click()");
    await run(win, "document.querySelector('[data-page=library]').click()");
    await waitFor(win, "document.querySelector('.artist-card')", 10000, "an artist card");
    await run(win, "document.querySelector('.artist-card').click()");
    await waitFor(win, "document.querySelector('.album-card .play-button')", 5000, "play button");
    await run(win, "document.querySelector('.album-card .play-button').click()");
    await waitFor(win, "document.querySelector('#player-audio').currentTime > 0.3", 20000, "playback");
    await run(win, "document.querySelector('#player-expand').click()");
    await run(win, "document.querySelector('#np-tab-lyrics').click()");
    await waitFor(win, "document.querySelectorAll('.np-lyric-line').length === 4", 10000, "the lyric lines");
    console.log("note:", await run(win, "document.querySelector('#np-lyrics-note').textContent"));
    const now = () => run(win, "(document.querySelector('.np-lyric-now') || {}).textContent || '(none)'");
    const seen = [];
    for (let i = 0; i < 6; i++) { seen.push(await now()); await wait(2000); }
    console.log("highlighted over 12 s:", JSON.stringify([...new Set(seen)]));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outputDir, "lyrics.png"), image.toPNG());
    await run(win, "document.querySelectorAll('.np-lyric-line')[0].click()");
    await wait(600);
    console.log("after clicking line 1, position (s):", await run(win, "Math.round(document.querySelector('#player-audio').currentTime * 10) / 10"), "highlighted:", await now());
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
