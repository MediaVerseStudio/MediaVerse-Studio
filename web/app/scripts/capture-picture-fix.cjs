// Development aid: the Artwork > "Too large in the songs" Fix and its Undo, end to end on a THROWAWAY library in
// the temp folder (never the person's music). Makes a two-song album, embeds a 1400 × 1400 PNG front cover, then
// presses Fix and Undo in the real page and reports what the songs and the album folder hold after each step.
// Build first: npm run build. Run: npx electron scripts/capture-picture-fix.cjs <output-dir>
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mediaverse-capture-picture-fix"));
fs.mkdirSync(outputDir, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-picture-fix-"));
const music = path.join(base, "Music");
const album = path.join(music, "Test Band", "Big Cover");
fs.mkdirSync(album, { recursive: true });
// Two tiny MP3s: an empty ID3v2.3 tag (with a title) and a few silent MPEG frames.
for (const n of [1, 2]) {
  const title = Buffer.from(`\u0000Song ${n}`, "latin1");
  const frame = Buffer.concat([Buffer.from("TIT2"), Buffer.from([0, 0, 0, title.length, 0, 0]), title]);
  const size = frame.length;
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  const audio = Buffer.alloc(417 * 40);
  for (let i = 0; i < 40; i++) audio.set([0xff, 0xfb, 0x90, 0x00], i * 417);
  fs.writeFileSync(path.join(album, `0${n} Song ${n}.mp3`), Buffer.concat([header, frame, audio]));
}
app.setPath("userData", path.join(base, "data"));
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function waitFor(win, test, ms) {
  for (let waited = 0; waited < ms; waited += 250) {
    if (await run(win, test)) return true;
    await wait(250);
  }
  return false;
}
const paths = [1, 2].map((n) => path.join(album, `0${n} Song ${n}.mp3`));
const state = (win) =>
  run(win, `window.mediaVerse.invoke("album_pictures", { paths: ${JSON.stringify(paths)} }).then((r) => { const v = r.result ?? r; const f = v.front_cover; return JSON.stringify({ front: f && { mime: f.mime, from: f.from, songs: f.tracks, kb: Math.round(f.data_base64.length * 0.75 / 1024) }, folder: v.folder?.front_cover }); })`);
const folderFiles = () => fs.readdirSync(album).filter((n) => !n.endsWith(".mp3")).join(", ") || "(none)";

app.whenReady().then(async () => {
  try {
    let win;
    for (let i = 0; i < 100 && !win; i++) { [win] = BrowserWindow.getAllWindows(); await wait(100); }
    win.setSize(1500, 1000);
    await wait(2500);
    await run(win, `window.mediaVerse.invoke("import_collection", { root: ${JSON.stringify(music)} }).then(() => true)`);
    await run(win, "localStorage.setItem('mediaverse.welcome-seen', '1'); location.reload()");
    await wait(4000);
    // A 1400 × 1400 PNG front cover in both songs (as some programs embed them).
    const embedded = await run(win, `(async () => {
      const c = document.createElement("canvas"); c.width = 1400; c.height = 1400;
      const g = c.getContext("2d"); g.fillStyle = "#c33"; g.fillRect(0, 0, 1400, 700); g.fillStyle = "#33c"; g.fillRect(0, 700, 1400, 700); g.fillStyle = "#fff"; g.font = "bold 160px sans-serif"; g.fillText("BIG COVER", 120, 760);
      const blob = await new Promise((r) => c.toBlob(r, "image/png"));
      const bytes = new Uint8Array(await blob.arrayBuffer()); let s = ""; for (let i = 0; i < bytes.length; i += 0x8000) s += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
      const r = await window.mediaVerse.invoke("update_track_media", { paths: ${JSON.stringify(paths)}, pictures: [{ kind: "front_cover", data_base64: btoa(s) }] });
      return JSON.stringify((r.result ?? r).results.map((x) => x.ok)) + " " + Math.round(bytes.length / 1024) + " KB";
    })()`);
    console.log("embedded a 1400 px PNG:", embedded);
    console.log("before:", await state(win), "| folder:", folderFiles());

    await run(win, "document.querySelector('[data-page=review]').click()");
    await wait(500);
    await run(win, "document.querySelector('[data-review=artwork]').click()");
    await waitFor(win, "[...document.querySelectorAll('#review-panel-artwork .row-actions button')].some((b) => b.textContent.startsWith('Too large'))", 30000);
    await run(win, "[...document.querySelectorAll('#review-panel-artwork .row-actions button')].find((b) => b.textContent.startsWith('Too large')).click()");
    await wait(500);
    console.log("listed:", await run(win, "[...document.querySelectorAll('#review-panel-artwork tbody tr')].map((r) => [...r.cells].slice(0, -1).map((c) => c.textContent).join(' | ')).join(' / ')"));
    fs.writeFileSync(path.join(outputDir, "fix-1-listed.png"), (await win.webContents.capturePage()).toPNG());

    await run(win, "[...document.querySelectorAll('#review-panel-artwork tbody button')].find((b) => b.textContent === 'Fix').click()");
    await waitFor(win, "/fixed|:/.test(document.querySelector('#review-panel-artwork .field-hint:last-of-type')?.textContent ?? '') && !!document.querySelector('#review-panel-artwork')", 30000);
    await wait(1500);
    console.log("note:", await run(win, "[...document.querySelectorAll('#review-panel-artwork p')].map((p) => p.textContent).filter((t) => /fixed|Problem|:/.test(t)).join(' / ')"));
    console.log("after Fix:", await state(win), "| folder:", folderFiles());
    console.log("chips:", await run(win, "[...document.querySelectorAll('#review-panel-artwork .row-actions button')].map((b) => b.textContent).join(' | ')"));
    fs.writeFileSync(path.join(outputDir, "fix-2-after.png"), (await win.webContents.capturePage()).toPNG());

    await run(win, "window.confirm = () => true; true");
    await run(win, "[...document.querySelectorAll('#review-panel-artwork button')].find((b) => b.textContent === 'Undo the last fix')?.click()");
    await wait(4000);
    console.log("after Undo:", await state(win), "| folder:", folderFiles());
    console.log("undo note:", await run(win, "[...document.querySelectorAll('#review-panel-artwork p')].map((p) => p.textContent).filter((t) => /Undone|undo/i.test(t)).join(' / ')"));
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
