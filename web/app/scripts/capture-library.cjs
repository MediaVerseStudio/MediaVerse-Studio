// Development aid for D52: opens the real app on a copy of a data folder and saves screenshots of the library: the
// artist wall, a letter jump, an artist's page with a song selected, and the columns dialog.
// Build first: npm run build
// Run: npx electron scripts/capture-library.cjs <data-folder-copy> <output-dir> [artist]
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const dataDir = path.resolve(process.argv[2] || "");
const outputDir = path.resolve(process.argv[3] || ".");
const artist = process.argv[4] || "Against Me!";
fs.mkdirSync(outputDir, { recursive: true });
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
async function shot(win, name) {
  await wait(1500);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, `${name}.png`), image.toPNG());
  console.log("saved", name);
}

app.whenReady().then(async () => {
  try {
    const win = await firstWindow();
    win.setSize(Number(process.env.SHOT_W || 1600), Number(process.env.SHOT_H || 1000));
    win.webContents.on("console-message", (_e, level, message) => { if (level >= 2) console.log("PAGE", message); });
    win.show();
    win.focus();
    // The first read of every file (lengths, bitrates) finishes a while after start; wait for its update.
    for (let i = 0; i < 120; i++) {
      if (await run(win, "window.mediaVerse.invoke('library_snapshot').then(r => r.result.tracks.some(t => t.length_ms))")) break;
      await wait(1000);
    }
    await wait(2000);
    await run(win, "document.querySelector('[data-page=library]').click()");
    await shot(win, "1-wall");
    await run(win, "[...document.querySelectorAll('.lib-letters button')].find(b => b.textContent === 'A').click()");
    await shot(win, "2-letter-a");
    const found = await run(win, `(() => { const tile = [...document.querySelectorAll('.lib-artist')].find(t => t.querySelector('.lib-artist-name').textContent === ${JSON.stringify(artist)}); if (tile) tile.click(); return !!tile; })()`);
    console.log("artist found:", found);
    await wait(3000);
    console.log("artist covers:", await run(win, "JSON.stringify({ arts: document.querySelectorAll('#artist-page .lib-art').length, imgs: document.querySelectorAll('#artist-page .lib-art img').length })"));
    await shot(win, "3-artist");
    await run(win, "document.querySelectorAll('.lib-row')[Number(process.env.SHOT_ROW || 2)]?.click()".replace("process.env.SHOT_ROW || 2", process.env.SHOT_ROW || "2"));
    console.log("facts:", await run(win, "window.mediaVerse.invoke('library_snapshot').then(r => { const t = r.result.tracks; return JSON.stringify({ total: t.length, withLength: t.filter(x => x.length_ms).length, sample: Object.keys(t[0]) }); })"));
    console.log("after click:", await run(win, "JSON.stringify({ selected: document.querySelectorAll('.lib-row.is-selected').length, bar: document.querySelector('.lib-selection')?.hidden, status: document.querySelector('#status')?.textContent, imgs: document.querySelectorAll('#artist-page img').length })"));
    await shot(win, "4-selected");
    // Shift-click two rows further, then right-click inside the selection: the menu.
    await run(win, "(() => { const rows = document.querySelectorAll('.lib-row'); const r = rows[2]; r.dispatchEvent(new MouseEvent('click', { bubbles: true, shiftKey: true })); const box = r.getBoundingClientRect(); r.dispatchEvent(new MouseEvent('contextmenu', { bubbles: true, cancelable: true, clientX: box.left + 200, clientY: box.top + 10 })); })()");
    await shot(win, "4b-menu");
    await run(win, "document.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape' }))");
    await run(win, "window.scrollBy(0, 500)");
    await shot(win, "5-scrolled");
    await run(win, "[...document.querySelectorAll('.lib-artist-heading button')].find(b => b.textContent.includes('Columns')).click()");
    await shot(win, "6-columns");
    const errors = await run(win, "window.__errors || []");
    console.log("errors:", JSON.stringify(errors));
  } catch (error) {
    console.error(error);
  } finally {
    app.quit();
  }
});
