// Development aid: in the real app, pins an album from the library, checks the Home page's Pins shelf
// (also after a page reload), then unpins it.
// Run: npx electron scripts/capture-pins.cjs <library-folder>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const library = path.resolve(process.argv[2] || "");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-pins-data-")));
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
const home = (win) => run(win, "document.querySelector('#home-shelves').innerText");

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
    await waitFor(win, "[...document.querySelectorAll('.album-card button')].some((b) => b.textContent.includes('Pin to Home'))", 5000, "the pin button");
    await run(win, "[...document.querySelectorAll('.album-card button')].find((b) => b.textContent.includes('Pin to Home')).click()");
    await waitFor(win, "[...document.querySelectorAll('.album-card button')].some((b) => b.textContent.includes('Unpin from Home'))", 5000, "the pin to be saved");
    await run(win, "document.querySelector('[data-page=home]').click()");
    await wait(1500);
    console.log("home after pinning:", JSON.stringify((await home(win)).slice(0, 120)));
    await run(win, "location.reload()");
    await wait(2500);
    console.log("after reload, has Pins shelf:", (await home(win)).includes("Pins"));
    await run(win, "[...document.querySelectorAll('.home-tile button')].find((b) => b.textContent === 'Unpin').click()");
    await wait(1500);
    console.log("after unpinning, has Pins shelf:", (await home(win)).includes("Pins"));
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
