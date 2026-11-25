// Development aid: Review > Missing lyrics > Automatic lyrics, end to end on a THROWAWAY library in the temp folder
// (never the person's music), against a small local stand-in for LRCLIB: it knows song 1 exactly, has only a live
// version (another length) of song 2, and nothing of song 3. Presses Start, waits, reports which songs got lyrics,
// then Undo. Build first: npm run build. Run: npx electron scripts/capture-auto-lyrics.cjs <output-dir>
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mediaverse-capture-auto-lyrics"));
fs.mkdirSync(outputDir, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-auto-lyrics-"));
const music = path.join(base, "Music");
const album = path.join(music, "Test Band", "Test Album");
fs.mkdirSync(album, { recursive: true });
const frame = (id, text) => {
  const body = Buffer.from(`\u0000${text}`, "latin1");
  return Buffer.concat([Buffer.from(id), Buffer.from([0, 0, (body.length >> 8) & 0xff, body.length & 0xff, 0, 0]), body]);
};
const paths = [1, 2, 3].map((n) => {
  const frames = Buffer.concat([frame("TIT2", `Song ${n}`), frame("TPE1", "Test Band"), frame("TALB", "Test Album"), frame("TRCK", String(n))]);
  const size = frames.length;
  const header = Buffer.from([0x49, 0x44, 0x33, 3, 0, 0, (size >> 21) & 0x7f, (size >> 14) & 0x7f, (size >> 7) & 0x7f, size & 0x7f]);
  const audio = Buffer.alloc(417 * 40);
  for (let i = 0; i < 40; i++) audio.set([0xff, 0xfb, 0x90, 0x00], i * 417);
  const file = path.join(album, `0${n} Song ${n}.mp3`);
  fs.writeFileSync(file, Buffer.concat([header, frames, audio]));
  return file;
});

let standInUrl = "";
const server = require("node:http").createServer((req, res) => {
  const url = new URL(req.url, "http://x");
  const track = url.searchParams.get("track_name");
  const json = (status, body) => {
    res.writeHead(status, { "content-type": "application/json" });
    res.end(JSON.stringify(body));
  };
  if (url.pathname === "/api/get" && track === "Song 1") return json(200, { id: 1, trackName: "Song 1", artistName: "Test Band", albumName: "Test Album", duration: 1, instrumental: false, plainLyrics: "First words", syncedLyrics: "[00:00.50]First words" });
  if (url.pathname === "/api/search" && track === "Song 2") return json(200, [{ id: 2, trackName: "Song 2 (Live)", artistName: "Test Band", duration: 400, instrumental: false, plainLyrics: "Live words", syncedLyrics: null }]);
  if (url.pathname === "/api/search") return json(200, []);
  json(404, { message: "not found" });
});
server.listen(0, "127.0.0.1", () => (standInUrl = `http://127.0.0.1:${server.address().port}`));

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
const lyricsOf = (win) =>
  run(win, `Promise.all(${JSON.stringify(paths)}.map((p) => window.mediaVerse.invoke("track_lyrics", { path: p }).then((r) => (r.result ?? r).plain))).then((all) => JSON.stringify(all))`);

app.whenReady().then(async () => {
  try {
    let win;
    for (let i = 0; i < 100 && !win; i++) { [win] = BrowserWindow.getAllWindows(); await wait(100); }
    win.setSize(1500, 1000);
    await wait(2500);
    await run(win, `window.mediaVerse.invoke("import_collection", { root: ${JSON.stringify(music)} }).then(() => true)`);
    console.log("lyrics settings:", await run(win, `window.mediaVerse.invoke("set_lyrics_settings", { enabled: true, base_url: "${standInUrl}" }).then((r) => JSON.stringify(r.result ?? r))`));
    await run(win, "localStorage.setItem('mediaverse.welcome-seen', '1'); location.reload()");
    await wait(4000);
    await run(win, "document.querySelector('[data-page=review]').click()");
    await wait(500);
    await run(win, "document.querySelector('[data-review=lyrics]').click()");
    await waitFor(win, "!!document.querySelector('#review-panel-lyrics .auto-covers')", 30000);
    console.log("before:", await lyricsOf(win));
    await run(win, "[...document.querySelectorAll('#review-panel-lyrics .auto-covers button')].find((b) => b.textContent === 'Start').click()");
    await wait(1000);
    await waitFor(win, "[...document.querySelectorAll('#review-panel-lyrics .auto-covers button')].some((b) => b.textContent === 'Start')", 60000);
    console.log("note:", await run(win, "[...document.querySelectorAll('#review-panel-lyrics .auto-covers p')].map((p) => p.textContent).slice(-1)[0]"));
    console.log("after:", await lyricsOf(win), "(only song 1: song 2 had only a live version, song 3 nothing)");
    try { fs.writeFileSync(path.join(outputDir, "auto-lyrics.png"), (await win.webContents.capturePage()).toPNG()); } catch { /* a hidden window cannot be captured */ }
    await run(win, "window.confirm = () => true; true");
    await run(win, "[...document.querySelectorAll('#review-panel-lyrics .auto-covers button')].find((b) => b.textContent === 'Undo the automatic lyrics')?.click()");
    await wait(3000);
    console.log("after Undo:", await lyricsOf(win));
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    server.close();
    app.quit();
  }
});
