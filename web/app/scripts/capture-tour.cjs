// Development aid: opens every main page of the real app with a throwaway data folder and saves a screenshot
// of each, so the page structure can be checked by eye. Run: npx electron scripts/capture-tour.cjs <output-dir> [library-folder]
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mediaverse-capture-tour"));
const library = process.argv[3] ? path.resolve(process.argv[3]) : null;
fs.mkdirSync(outputDir, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-tour-data-")));
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function window() {
  const { BrowserWindow } = require("electron");
  for (let i = 0; i < 100; i++) { const [first] = BrowserWindow.getAllWindows(); if (first) return first; await wait(100); }
  throw new Error("No window appeared.");
}
async function shot(win, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, `${name}.png`), image.toPNG());
  console.log("saved", name);
}
app.whenReady().then(async () => {
  try {
    const win = await window();
    win.setSize(1280, 900);
    win.show();
    await wait(2000);
    if (library) {
      await run(win, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} })`);
      await run(win, "document.querySelector('#rescan-collection').click()");
      await wait(1200);
    }
    for (const page of ["home", "rip", "library", "review", "settings"]) {
      await run(win, `document.querySelector('[data-page=${page}]').click()`);
      await wait(1800);
      await shot(win, page);
    }
    for (const tab of ["metadata", "artwork", "lyrics", "defects"]) {
      await run(win, "document.querySelector('[data-page=review]').click()");
      await run(win, `document.querySelector('.subnav-button[data-review=${tab}]').click()`);
      await wait(1500);
      await shot(win, `review-${tab}`);
    }
    console.log("nav buttons:", await run(win, "[...document.querySelectorAll('.nav-button')].map((b) => b.textContent.trim()).join(' | ')"));
    console.log("collection box outside Settings:", await run(win, "!!document.querySelector('#collection-section')"));
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
