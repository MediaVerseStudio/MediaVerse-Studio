// Development aid for ADR 0008: how the app reacts to changes in a large music folder. Imports the folder
// given into a throwaway data folder, then (1) changes one song's modification time and times the
// library-updated event, (2) adds and removes a picture file, which must not cause an update, and (3) reports
// the sidecar's processor use while idle. The folder's audio is never rewritten; only one file's modification
// time is changed and a test picture is added and removed again.
// Run: npx electron scripts/measure-folder-change.cjs <music-folder>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const music = process.argv[2];
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-folder-change-"));
app.setPath("userData", path.join(base, "data"));
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function window() {
  const { BrowserWindow } = require("electron");
  for (let i = 0; i < 100; i++) { const [first] = BrowserWindow.getAllWindows(); if (first) return first; await wait(100); }
  throw new Error("No window appeared.");
}
function firstSong(folder) {
  for (const entry of fs.readdirSync(folder, { withFileTypes: true })) {
    const full = path.join(folder, entry.name);
    if (entry.isDirectory()) {
      const found = firstSong(full);
      if (found) return found;
    } else if (/\.mp3$/i.test(entry.name)) return full;
  }
  return null;
}
const updates = (win) => run(win, "window.__updates.length");

app.whenReady().then(async () => {
  try {
    const win = await window();
    win.show();
    await wait(2000);
    await run(win, "window.__updates = []; window.mediaVerse.listen('library-updated', (e) => window.__updates.push({ at: performance.now(), tracks: e.payload.tracks.length })); true");
    let t = Date.now();
    await run(win, `window.mediaVerse.invoke("import_collection", { root: ${JSON.stringify(music)} }).then(() => true)`);
    console.log(`import: ${Date.now() - t} ms`);
    await wait(3000);
    const before = await updates(win);

    const song = firstSong(music);
    const now = new Date();
    t = Date.now();
    fs.utimesSync(song, now, now);
    let seen = false;
    for (let i = 0; i < 300; i += 1) {
      if ((await updates(win)) > before) { seen = true; break; }
      await wait(100);
    }
    console.log(seen ? `one changed song: library updated after ${Date.now() - t} ms` : "one changed song: no update within 30 s");

    await wait(2000);
    const settled = await updates(win);
    const picture = path.join(path.dirname(song), "measure-test-picture.jpg");
    fs.writeFileSync(picture, "not a real picture");
    await wait(4000);
    fs.rmSync(picture);
    await wait(4000);
    console.log(`adding and removing a picture: ${(await updates(win)) - settled} library update(s) (0 expected)`);
  } catch (error) {
    console.error("measure failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
