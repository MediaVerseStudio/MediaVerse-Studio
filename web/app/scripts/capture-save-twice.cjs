// Development aid: the pictures dialog saving twice in a row (owner, 2026-11-05: after one Save & Close the button
// stayed greyed out for the next album). On a THROWAWAY library in the temp folder: two albums without covers; for
// each, Artwork > Missing > Add artwork, paste a picture into a square (the second one non-square, cropped), Save &
// Close; then report what the songs and the folders hold. Build first: npm run build.
// Run: npx electron scripts/capture-save-twice.cjs <output-dir>
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mediaverse-capture-save-twice"));
fs.mkdirSync(outputDir, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-save-twice-"));
const music = path.join(base, "Music");
const albums = ["First Album", "Second Album"].map((name) => path.join(music, "Test Band", name));
const song = (file, title) => {
  const text = Buffer.from(`\u0000${title}`, "latin1");
  const frame = Buffer.concat([Buffer.from("TIT2"), Buffer.from([0, 0, 0, text.length, 0, 0]), text]);
  const n = frame.length;
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (n >> 21) & 0x7f, (n >> 14) & 0x7f, (n >> 7) & 0x7f, n & 0x7f]);
  const audio = Buffer.alloc(417 * 40);
  for (let i = 0; i < 40; i++) audio.set([0xff, 0xfb, 0x90, 0x00], i * 417);
  fs.writeFileSync(file, Buffer.concat([header, frame, audio]));
};
for (const dir of albums) {
  fs.mkdirSync(dir, { recursive: true });
  song(path.join(dir, "01 One.mp3"), "One");
  song(path.join(dir, "02 Two.mp3"), "Two");
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
/** Pastes a generated picture (width × height) into the square of `kind`, as Ctrl+V would. */
const paste = (win, kind, width, height, colour) =>
  run(win, `(async () => {
    const c = document.createElement("canvas"); c.width = ${width}; c.height = ${height};
    const g = c.getContext("2d"); g.fillStyle = ${JSON.stringify(colour)}; g.fillRect(0, 0, ${width}, ${height}); g.fillStyle = "#fff"; g.fillRect(0, 0, ${width} / 4, ${height});
    const blob = await new Promise((r) => c.toBlob(r, "image/png"));
    const slot = document.querySelector('#media-slots .picture-slot[data-kind=${kind}]'); slot.focus();
    const data = new DataTransfer(); data.items.add(new File([blob], "p.png", { type: "image/png" }));
    slot.dispatchEvent(new ClipboardEvent("paste", { clipboardData: data, bubbles: true }));
    return true;
  })()`);
const slots = (win) => run(win, "[...document.querySelectorAll('#media-slots .picture-slot')].map((s) => s.querySelector('strong').textContent + ': ' + s.querySelector('.slot-size').textContent + ' [' + [...s.querySelectorAll('button')].map((b) => b.textContent).join(', ') + ']').join(' / ')");
const saveButton = (win) => run(win, "(() => { const b = document.querySelector('#media-save-pictures'); return b.textContent + (b.disabled ? ' (greyed out)' : ' (enabled)'); })()");

app.whenReady().then(async () => {
  try {
    let win;
    for (let i = 0; i < 100 && !win; i++) { [win] = BrowserWindow.getAllWindows(); await wait(100); }
    win.setSize(1500, 1100);
    await wait(2500);
    await run(win, `window.mediaVerse.invoke("import_collection", { root: ${JSON.stringify(music)} }).then(() => true)`);
    await run(win, "localStorage.setItem('mediaverse.welcome-seen', '1'); location.reload()");
    await wait(4000);
    await run(win, "document.querySelector('[data-page=review]').click()");
    await wait(500);
    await run(win, "document.querySelector('[data-review=artwork]').click()");
    await waitFor(win, "document.querySelectorAll('#review-panel-artwork tbody tr').length === 2", 30000);
    for (const [index, name] of ["First Album", "Second Album"].entries()) {
      await run(win, `[...document.querySelectorAll('#review-panel-artwork tbody tr')].find((r) => r.cells[0].textContent.includes("Unknown") || true) && [...document.querySelectorAll('#review-panel-artwork tbody button')][0].click()`);
      await waitFor(win, "document.querySelector('#media-dialog').open && document.querySelectorAll('#media-slots .picture-slot').length === 3", 10000);
      await wait(800);
      console.log(`${name}: Save button on opening: ${await saveButton(win)}`);
      await paste(win, "front_cover", 800, 800, "#c33");
      await waitFor(win, "document.querySelector('#media-slots .picture-slot[data-kind=front_cover]').classList.contains('is-changed')", 10000);
      if (index === 1) {
        await paste(win, "back_cover", 1200, 900, "#33c");
        await waitFor(win, "document.querySelector('#media-slots .picture-slot[data-kind=back_cover]').classList.contains('is-changed')", 10000);
        await run(win, "[...document.querySelectorAll('#media-slots .picture-slot[data-kind=back_cover] button')].find((b) => b.textContent === 'Crop to square').click()");
        await wait(1500);
      }
      console.log(`  squares: ${await slots(win)}`);
      console.log(`  Save button before saving: ${await saveButton(win)}`);
      fs.writeFileSync(path.join(outputDir, `save-${index + 1}.png`), (await win.webContents.capturePage()).toPNG());
      await run(win, "document.querySelector('#media-save-pictures').click()");
      const closed = await waitFor(win, "!document.querySelector('#media-dialog').open", 15000);
      console.log(`  closed after Save & Close: ${closed}; status: ${await run(win, "document.querySelector('#media-status').textContent")}`);
      if (!closed) break;
      await wait(800);
    }
    for (const dir of albums) {
      const paths = ["01 One.mp3", "02 Two.mp3"].map((f) => path.join(dir, f));
      const got = await run(win, `window.mediaVerse.invoke("album_pictures", { paths: ${JSON.stringify(paths)} }).then((r) => { const v = r.result ?? r; return JSON.stringify({ front: v.front_cover && v.front_cover.mime + " on " + v.front_cover.tracks, back: v.back_cover && v.back_cover.mime + " on " + v.back_cover.tracks, folder: v.folder }); })`);
      console.log(`${path.basename(dir)}: ${got} | files: ${fs.readdirSync(dir).filter((n) => !n.endsWith(".mp3")).join(", ")}`);
    }
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
