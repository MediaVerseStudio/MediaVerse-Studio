// Development aid for Phase B (D32): measures how the real app copes with a large library. Imports the
// folder given (read only) into a throwaway data folder, then times start-up, each main page and the Review
// sections, and reports the page's memory. Run: npx electron scripts/measure-large-library.cjs <music-folder>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const music = process.argv[2];
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-measure-"));
app.setPath("userData", path.join(base, "data"));
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function window() {
  const { BrowserWindow } = require("electron");
  for (let i = 0; i < 100; i++) { const [first] = BrowserWindow.getAllWindows(); if (first) return first; await wait(100); }
  throw new Error("No window appeared.");
}
/** Clicks something, then waits until the page has painted twice and reports how long that took. */
const timed = (win, label, code) =>
  run(win, `new Promise((done) => { const t0 = performance.now(); ${code}; requestAnimationFrame(() => requestAnimationFrame(() => done(performance.now() - t0))); })`).then((ms) => console.log(`${label}: ${Math.round(ms)} ms`));

app.whenReady().then(async () => {
  try {
    if (!music) throw new Error("Give the music folder as the argument.");
    const win = await window();
    win.setSize(1600, 1000);
    win.show();
    await wait(2000);
    await run(win, `window.mediaVerse.invoke("import_collection", { root: ${JSON.stringify(music)} }).then(() => true)`);
    await run(win, "localStorage.setItem('mediaverse.welcome-seen', '1')"); // measure the pages, not the welcome
    const t0 = Date.now();
    await run(win, "location.reload()");
    // Started when the header shows the track count.
    for (let i = 0; i < 600; i += 1) {
      const text = await run(win, "document.querySelector('#status')?.textContent ?? ''").catch(() => "");
      const count = Number(/(\d+) tracks? in your library/.exec(text)?.[1] ?? 0);
      if (count > 0) {
        console.log(`tracks listed: ${count}`);
        break;
      }
      await wait(100);
    }
    console.log(`start-up until the library is listed: ${Date.now() - t0} ms`);
    await wait(1500);
    await timed(win, "open Library", "document.querySelector('[data-page=library]').click()");
    console.log("library page elements:", await run(win, "document.querySelector('#library-page').getElementsByTagName('*').length"));
    await timed(win, "find an artist (type '042')", "(() => { const f = document.querySelector('.artist-find'); f.value = '042'; f.dispatchEvent(new Event('input')); })()");
    console.log("artist cards after finding:", await run(win, "document.querySelectorAll('.artist-card').length"));
    if (process.env.MEDIAVERSE_SHOTS) {
      fs.mkdirSync(process.env.MEDIAVERSE_SHOTS, { recursive: true });
      fs.writeFileSync(path.join(process.env.MEDIAVERSE_SHOTS, "library-find.png"), (await win.webContents.capturePage()).toPNG());
    }
    await run(win, "(() => { const f = document.querySelector('.artist-find'); f.value = ''; f.dispatchEvent(new Event('input')); })()");
    await timed(win, "open Review (flagged)", "document.querySelector('[data-page=review]').click()");
    await timed(win, "Review > metadata", "document.querySelector('[data-review=metadata]').click()");
    await wait(1500);
    console.log("review page elements:", await run(win, "document.querySelector('[data-page-root=review], #review-hub, #flag-review-page, main')?.getElementsByTagName('*').length ?? -1"));
    const shotDir = process.env.MEDIAVERSE_SHOTS;
    if (shotDir) {
      fs.mkdirSync(shotDir, { recursive: true });
      fs.writeFileSync(path.join(shotDir, "review-metadata.png"), (await win.webContents.capturePage()).toPNG());
    }
    await timed(win, "Review > audio defects", "document.querySelector('[data-review=defects]').click()");
    await wait(2000);
    await timed(win, "open Home", "document.querySelector('[data-page=home]').click()");
    const memory = await win.webContents.executeJavaScript("performance.memory ? Math.round(performance.memory.usedJSHeapSize / 1048576) : -1");
    console.log(`page memory in use: ${memory} MB; whole document elements: ${await run(win, "document.getElementsByTagName('*').length")}`);
  } catch (error) {
    console.error("measure failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
