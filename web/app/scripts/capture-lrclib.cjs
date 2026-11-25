// Development aid: in the real app, looks up lyrics for a real song on the real LRCLIB (one search, sending
// only the title, artist, album and length), uses the first result, saves it, and reads it back.
// Run: npx electron scripts/capture-lrclib.cjs <library-folder> <output-dir>   (needs the internet)
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const source = path.resolve(process.argv[2] || "");
const outputDir = path.resolve(process.argv[3] || path.join(os.tmpdir(), "mediaverse-capture-lrclib"));
fs.mkdirSync(outputDir, { recursive: true });
const library = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-lrclib-lib-"));
fs.cpSync(source, library, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-lrclib-data-")));
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
  while (Date.now() < deadline) { if (await run(win, expression)) return; await wait(250); }
  throw new Error(`Timed out waiting for ${label}.`);
}
app.whenReady().then(async () => {
  try {
    const win = await window();
    win.setSize(1180, 1000);
    win.show();
    await waitFor(win, "document.readyState === 'complete'", 15000, "page load");
    await wait(800);
    await run(win, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} })`);
    await run(win, "document.querySelector('#rescan-collection').click()");
    await run(win, "document.querySelector('[data-page=library]').click()");
    await waitFor(win, "document.querySelector('.artist-card')", 10000, "an artist card");
    await run(win, "document.querySelector('.artist-card').click()");
    await waitFor(win, "[...document.querySelectorAll('.track-list button')].some((b) => b.textContent.startsWith('Pictures'))", 5000, "the track button");
    await run(win, "[...document.querySelectorAll('.track-list button')].find((b) => b.textContent.startsWith('Pictures')).click()");
    await waitFor(win, "document.querySelector('#media-dialog').open && !document.querySelector('#media-find-lyrics').hidden", 5000, "the dialog");
    await run(win, "document.querySelector('#media-find-lyrics').click()");
    await waitFor(win, "document.querySelector('#media-find-note').textContent && !document.querySelector('#media-find-note').textContent.startsWith('Asking')", 60000, "the answer");
    console.log("note:", await run(win, "document.querySelector('#media-find-note').textContent"));
    console.log("results:", JSON.stringify(await run(win, "[...document.querySelectorAll('#media-find-results .find-row span')].map((s) => s.textContent)")));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outputDir, "lookup.png"), image.toPNG());
    const hasUse = await run(win, "!!document.querySelector('#media-find-results button')");
    if (hasUse) {
      await run(win, "document.querySelector('#media-find-results button').click()");
      console.log("box now starts:", JSON.stringify((await run(win, "document.querySelector('#media-lyrics').value")).slice(0, 70)));
      await run(win, "document.querySelector('#media-save-lyrics').click()");
      await waitFor(win, "/saved/i.test(document.querySelector('#media-status').textContent)", 10000, "the save");
      console.log("status:", await run(win, "document.querySelector('#media-status').textContent"));
    }
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
