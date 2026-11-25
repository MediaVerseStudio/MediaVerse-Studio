// Development aid for ADR 0008: Review > Missing or uncertain metadata grouped by "Suspected album (tags
// disagree)". Imports the folder given into a throwaway data folder, switches the grouping, reports the
// groups, opens the first group's editor to read the proposed values, and closes it WITHOUT saving (nothing
// is written to any file). Run: npx electron scripts/capture-suspected-albums.cjs <output-dir> <music-folder>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mediaverse-capture-suspected"));
const music = process.argv[3];
fs.mkdirSync(outputDir, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-suspected-"));
app.setPath("userData", path.join(base, "data"));
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function window() {
  const { BrowserWindow } = require("electron");
  for (let i = 0; i < 100; i++) { const [first] = BrowserWindow.getAllWindows(); if (first) return first; await wait(100); }
  throw new Error("No window appeared.");
}

app.whenReady().then(async () => {
  try {
    if (!music) throw new Error("Give the music folder as the second argument.");
    const win = await window();
    win.setSize(1500, 1000);
    win.show();
    await wait(2000);
    await run(win, `window.mediaVerse.invoke("import_collection", { root: ${JSON.stringify(music)} }).then(() => true)`);
    await run(win, "localStorage.setItem('mediaverse.welcome-seen', '1'); location.reload()");
    await wait(4000);
    await run(win, "document.querySelector('[data-page=review]').click()");
    await wait(300);
    await run(win, "document.querySelector('[data-review=metadata]').click()");
    await wait(800);
    await run(win, "(() => { const s = document.querySelector('#issue-tools select'); s.value = 'suspected_album'; s.dispatchEvent(new Event('change')); })()");
    await wait(800);
    console.log("count:", await run(win, "document.querySelector('#issue-count')?.textContent ?? [...document.querySelectorAll('p, span')].find((e) => /suspected album/.test(e.textContent))?.textContent"));
    const groups = await run(win, "[...document.querySelectorAll('#issue-list .issue-group strong')].slice(0, 8).map((s) => s.textContent)");
    for (const g of groups) console.log("  group:", g);
    fs.writeFileSync(path.join(outputDir, "suspected.png"), (await win.webContents.capturePage()).toPNG());
    const opened = await run(win, "(() => { const b = document.querySelector('#issue-list .issue-group button'); if (!b) return false; b.click(); return true; })()");
    await wait(600);
    if (opened) {
      const fields = await run(win, "JSON.stringify({ album: document.querySelector('#edit-album').value, album_artist: document.querySelector('#edit-album-artist').value, year: document.querySelector('#edit-release-year').value, genre: document.querySelector('#edit-genre').value })");
      console.log("editor proposes:", fields);
      fs.writeFileSync(path.join(outputDir, "suspected-editor.png"), (await win.webContents.capturePage()).toPNG());
      await run(win, "document.querySelector('#tag-editor').close()"); // closed without saving
    }
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
