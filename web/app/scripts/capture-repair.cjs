// Development aid: in the real app, pastes a picture and lyrics onto a copy of a small library and
// checks the results. Run: npx electron scripts/capture-repair.cjs <library-folder> <output-dir>
// The library folder is copied first, so the original is never edited.
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const source = path.resolve(process.argv[2] || "");
const outputDir = path.resolve(process.argv[3] || path.join(os.tmpdir(), "mediaverse-capture-repair"));
fs.mkdirSync(outputDir, { recursive: true });
const library = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-repair-lib-"));
fs.cpSync(source, library, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-repair-data-")));
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
    await wait(200);
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
    win.setSize(1180, 1000);
    win.show();
    await waitFor(win, "document.readyState === 'complete'", 15000, "page load");
    await wait(800);
    await run(win, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} })`);
    await run(win, "document.querySelector('#rescan-collection').click()");
    await waitFor(win, "document.querySelector('.artist-card')", 15000, "an artist card");
    await run(win, "document.querySelector('.artist-card').click()");
    await waitFor(win, "[...document.querySelectorAll('.album-card button')].some((b) => b.textContent === 'Album pictures…')", 5000, "the album pictures button");

    // Paste a generated picture as the back cover of the album.
    await run(win, "[...document.querySelectorAll('.album-card button')].find((b) => b.textContent === 'Album pictures…').click()");
    await waitFor(win, "document.querySelector('#media-dialog').open", 3000, "the dialog");
    await run(win, `(() => {
      document.querySelector('#media-kind').value = 'back_cover';
      const canvas = document.createElement('canvas'); canvas.width = 1600; canvas.height = 1600;
      const c = canvas.getContext('2d'); c.fillStyle = '#2060c0'; c.fillRect(0, 0, 1600, 1600);
      c.fillStyle = '#ffffff'; c.font = '200px sans-serif'; c.fillText('BACK', 400, 850);
      return new Promise((resolve) => canvas.toBlob((blob) => {
        const data = new DataTransfer();
        data.items.add(new File([blob], 'pasted.png', { type: 'image/png' }));
        document.querySelector('#media-paste').dispatchEvent(new ClipboardEvent('paste', { clipboardData: data, bubbles: true, cancelable: true }));
        resolve(true);
      }, 'image/png'));
    })()`);
    await waitFor(win, "!document.querySelector('#media-save-picture').disabled", 10000, "the picture to be prepared");
    console.log("preview note:", await run(win, "document.querySelector('#media-preview-note').textContent"));
    await shot(win, "1-picture-ready");
    await run(win, "document.querySelector('#media-save-picture').click()");
    await waitFor(win, "/saved/i.test(document.querySelector('#media-status').textContent)", 10000, "the save");
    console.log("status:", await run(win, "document.querySelector('#media-status').textContent"));
    await run(win, "document.querySelector('#media-close').click()");

    // Lyrics for one track.
    await waitFor(win, "[...document.querySelectorAll('.track-list button')].some((b) => b.textContent.startsWith('Pictures'))", 5000, "the track button");
    await run(win, "[...document.querySelectorAll('.track-list button')].find((b) => b.textContent.startsWith('Pictures')).click()");
    await waitFor(win, "!document.querySelector('#media-lyrics-box').hidden", 3000, "lyrics box");
    await run(win, "document.querySelector('#media-lyrics').value = '[00:01.00]First line\\n[00:04.00]Second line é'");
    await run(win, "document.querySelector('#media-save-lyrics').click()");
    await waitFor(win, "/saved/i.test(document.querySelector('#media-status').textContent)", 10000, "the lyrics save");
    console.log("status:", await run(win, "document.querySelector('#media-status').textContent"));
    await shot(win, "2-lyrics-saved");
    await run(win, "document.querySelector('#media-close').click()");

    // Reopen: the lyrics come back from the file.
    await run(win, "[...document.querySelectorAll('.track-list button')].find((b) => b.textContent.startsWith('Pictures')).click()");
    await waitFor(win, "document.querySelector('#media-lyrics').value.includes('First line')", 5000, "lyrics to load");
    console.log("lyrics read back:", JSON.stringify(await run(win, "document.querySelector('#media-lyrics').value")));
    await run(win, "document.querySelector('#media-close').click()");

    // Check the file itself with the sidecar's own commands.
    const files = fs.readdirSync(library, { recursive: true }).filter((f) => f.toString().endsWith('.mp3')).map((f) => path.join(library, f.toString()));
    const bytes = fs.readFileSync(files[0]);
    console.log("file has APIC x", bytes.toString("latin1").split("APIC").length - 1, "USLT", bytes.toString("latin1").includes("USLT"), "SYLT", bytes.toString("latin1").includes("SYLT"));
    console.log("temp files left:", fs.readdirSync(library, { recursive: true }).filter((f) => f.toString().includes("mediaverse-tmp")).length);
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
