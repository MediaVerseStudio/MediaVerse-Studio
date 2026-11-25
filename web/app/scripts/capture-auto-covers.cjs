// Development aid: Artwork > Automatic covers, end to end on a THROWAWAY library in the temp folder (never the
// person's music), against the real cover database. Makes a 15-song "Dude Ranch" by blink-182 (1997) with no cover,
// presses Start, waits for it to finish, and reports what the songs and the folder hold; then Undo.
// With a second argument "stand-in", a small local server answers in place of MusicBrainz and the Cover Art Archive
// (one 100% release; the cover is the JPEG file given as the third argument), to test without asking them.
// Build first: npm run build. Run: npx electron scripts/capture-auto-covers.cjs <output-dir> [stand-in <cover.jpg>]
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mediaverse-capture-auto-covers"));
fs.mkdirSync(outputDir, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-auto-covers-"));
const music = path.join(base, "Music");
const album = path.join(music, "blink-182", "Dude Ranch");
fs.mkdirSync(album, { recursive: true });
const frame = (id, text) => {
  const body = Buffer.from(`\u0000${text}`, "latin1");
  return Buffer.concat([Buffer.from(id), Buffer.from([0, 0, (body.length >> 8) & 0xff, body.length & 0xff, 0, 0]), body]);
};
for (let n = 1; n <= 15; n++) {
  const frames = Buffer.concat([frame("TIT2", `Song ${n}`), frame("TPE1", "blink-182"), frame("TPE2", "blink-182"), frame("TALB", "Dude Ranch"), frame("TYER", "1997"), frame("TRCK", String(n))]);
  const size = frames.length;
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  const audio = Buffer.alloc(417 * 40);
  for (let i = 0; i < 40; i++) audio.set([0xff, 0xfb, 0x90, 0x00], i * 417);
  fs.writeFileSync(path.join(album, `${String(n).padStart(2, "0")} Song ${n}.mp3`), Buffer.concat([header, frames, audio]));
}
app.setPath("userData", path.join(base, "data"));
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function waitFor(win, test, ms) {
  for (let waited = 0; waited < ms; waited += 500) {
    if (await run(win, test)) return true;
    await wait(500);
  }
  return false;
}
const paths = Array.from({ length: 15 }, (_, i) => path.join(album, `${String(i + 1).padStart(2, "0")} Song ${i + 1}.mp3`));
const state = (win) =>
  run(win, `window.mediaVerse.invoke("album_pictures", { paths: ${JSON.stringify(paths)} }).then((r) => { const v = r.result ?? r; return JSON.stringify({ front: v.front_cover && v.front_cover.mime + " on " + v.front_cover.tracks + " songs, " + Math.round(v.front_cover.data_base64.length * 0.75 / 1024) + " KB", back: v.back_cover && v.back_cover.mime + " on " + v.back_cover.tracks, folder: v.folder }); })`);
const files = () => fs.readdirSync(album).filter((n) => !n.endsWith(".mp3")).join(", ") || "(none)";

const standIn = process.argv[3] === "stand-in";
let standInUrl = "";
if (standIn) {
  const cover = fs.readFileSync(path.resolve(process.argv[4]));
  const release = "aaaaaaaa-0000-0000-0000-000000000001";
  const server = require("node:http").createServer((req, res) => {
    if (req.url.startsWith("/ws/2/release/")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify({ releases: [{ id: release, score: 100, title: "Dude Ranch", "track-count": 15, date: "1997-06-17", country: "US", "artist-credit": [{ name: "blink-182", joinphrase: "" }] }] }));
    } else if (req.url === `/release/${release}/front-1200` || req.url === `/release/${release}/front-500`) {
      res.writeHead(200, { "content-type": "image/jpeg" });
      res.end(cover);
    } else {
      res.writeHead(404);
      res.end();
    }
    console.log("stand-in served", req.url.slice(0, 60));
  });
  server.listen(0, "127.0.0.1", () => (standInUrl = `http://127.0.0.1:${server.address().port}`));
}

app.whenReady().then(async () => {
  try {
    let win;
    for (let i = 0; i < 100 && !win; i++) { [win] = BrowserWindow.getAllWindows(); await wait(100); }
    win.setSize(1500, 1000);
    await wait(2500);
    await run(win, `window.mediaVerse.invoke("import_collection", { root: ${JSON.stringify(music)} }).then(() => true)`);
    if (standIn) {
      const saved = await run(win, `window.mediaVerse.invoke("set_metadata_settings", { settings: { musicbrainz: { enabled: true, base_url: "${standInUrl}", min_interval_ms: 50 }, cover_art: { enabled: true, base_url: "${standInUrl}" } } }).then((r) => JSON.stringify(r.ok === false ? r : "ok"))`);
      console.log("stand-in at", standInUrl, saved);
    }
    await run(win, "localStorage.setItem('mediaverse.welcome-seen', '1'); location.reload()");
    await wait(4000);
    await run(win, "document.querySelector('[data-page=review]').click()");
    await wait(500);
    await run(win, "document.querySelector('[data-review=artwork]').click()");
    await waitFor(win, "!!document.querySelector('#review-panel-artwork .auto-covers')", 30000);
    console.log("missing:", await run(win, "[...document.querySelectorAll('#review-panel-artwork tbody tr')].map((r) => [...r.cells].slice(0, 4).map((c) => c.textContent).join(' | ')).join(' / ')"));
    console.log("before:", await state(win), "| folder:", files());
    await run(win, "[...document.querySelectorAll('#review-panel-artwork .auto-covers button')].find((b) => b.textContent === 'Start').click()");
    await wait(1500);
    console.log("running:", await run(win, "document.querySelector('#review-panel-artwork .auto-covers').innerText.split('\\n')[0]"));
    fs.writeFileSync(path.join(outputDir, "auto-1-running.png"), (await win.webContents.capturePage()).toPNG());
    await waitFor(win, "[...document.querySelectorAll('#review-panel-artwork .auto-covers button')].some((b) => b.textContent === 'Start')", 180000);
    console.log("finished:", await run(win, "document.querySelector('#review-panel-artwork .auto-covers').innerText.replace(/\\n+/g, ' / ')"));
    console.log("after:", await state(win), "| folder:", files());
    fs.writeFileSync(path.join(outputDir, "auto-2-done.png"), (await win.webContents.capturePage()).toPNG());
    await run(win, "window.confirm = () => true; true");
    await run(win, "[...document.querySelectorAll('#review-panel-artwork .auto-covers button')].find((b) => b.textContent === 'Undo the automatic covers')?.click()");
    await wait(4000);
    console.log("after Undo:", await state(win), "| folder:", files());
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
