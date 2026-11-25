// Development aid: Review > Lyrics > To review, end to end on a THROWAWAY library in the temp folder (never the
// person's music), against a small local stand-in for LRCLIB: it knows song 1 exactly, has two other versions of
// song 2 (a live one and an acoustic one) and song 3 only by another artist. Runs the automatic lyrics, opens To
// review, rejects song 2's first candidate, times two lines with Tap and confirms. Screenshots in <output-dir>.
// Build first: npm run build. Run: npx electron scripts/capture-lyrics-review.cjs <output-dir>
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mediaverse-capture-lyrics-review"));
fs.mkdirSync(outputDir, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-lyrics-review-"));
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
  if (url.pathname === "/api/search" && track === "Song 2") return json(200, [
    { id: 2, trackName: "Song 2 (Live)", artistName: "Test Band", albumName: "Live at Home", duration: 260, instrumental: false, plainLyrics: "Live words\nmore live words", syncedLyrics: null },
    { id: 3, trackName: "Song 2", artistName: "Test Band", albumName: "Acoustic Sessions", duration: 230, instrumental: false, plainLyrics: "Wake up in the morning\nSee the light come in\n\nSing it once again\nAnd the day begins", syncedLyrics: "[00:10.00]Wake up in the morning" },
  ]);
  if (url.pathname === "/api/search" && track === "Song 3" && !url.searchParams.get("artist_name")) return json(200, [{ id: 4, trackName: "Song 3", artistName: "Original Singer", albumName: "First Pressing", duration: 190, instrumental: false, plainLyrics: "The original words\nof the third song", syncedLyrics: null }]);
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
    await waitFor(win, "!!document.querySelector('#review-panel-lyrics .lyrics-step-1')", 30000);
    await run(win, "[...document.querySelectorAll('#review-panel-lyrics .lyrics-step-1 button')].find((b) => b.textContent === 'Start').click()");
    await wait(1000);
    await waitFor(win, "[...document.querySelectorAll('#review-panel-lyrics .lyrics-step-1 button')].some((b) => b.textContent === 'Start')", 60000);
    console.log("note:", await run(win, "[...document.querySelectorAll('#review-panel-lyrics .lyrics-step-1 p')].map((p) => p.textContent).slice(-1)[0]"));
    const shot = async (name) => { try { fs.writeFileSync(path.join(outputDir, name), (await win.webContents.capturePage()).toPNG()); } catch { /* hidden window */ } };
    await run(win, "document.querySelector('#review-panel-lyrics [data-view=review]').click()");
    await waitFor(win, "!!document.querySelector('.lyrics-review-table')", 10000);
    console.log("list:", await run(win, "JSON.stringify([...document.querySelectorAll('.lyrics-review-table tbody tr')].map((r) => r.textContent))"));
    await shot("01-to-review.png");
    await run(win, "[...document.querySelectorAll('.lyrics-review-table tbody tr')].find((r) => r.textContent.includes('Song 2')).querySelector('button').click()");
    await waitFor(win, "!!document.querySelector('.sync-lines li')", 10000);
    console.log("candidates:", await run(win, "JSON.stringify([...document.querySelectorAll('.sync-choice option')].map((o) => o.textContent))"));
    await shot("02-editor.png");
    await run(win, "[...document.querySelectorAll('.lyrics-editor button')].find((b) => b.textContent === 'Not a match: reject').click()");
    await wait(1500);
    console.log("after reject:", await run(win, "JSON.stringify([...document.querySelectorAll('.sync-choice option')].map((o) => o.textContent))"), await run(win, "document.querySelector('.lyrics-editor').textContent.includes('Rejected')"));
    // Correct the words of the first line with the pencil.
    await run(win, "document.querySelector('.sync-line button[title^=\"Correct the words\"]').click()");
    await run(win, "(() => { const i = document.querySelector('.sync-line input.sync-edit'); i.value = 'Edited first words'; i.blur(); })()");
    console.log("edited line:", await run(win, "document.querySelector('.sync-line .sync-text').textContent"));
    await run(win, "[...document.querySelectorAll('.lyrics-editor button')].find((b) => b.textContent === '▶ Play the song').click()");
    await wait(300);
    await run(win, "[...document.querySelectorAll('.lyrics-editor button')].find((b) => b.textContent.startsWith('Tap')).click()");
    await wait(300);
    await run(win, "[...document.querySelectorAll('.lyrics-editor button')].find((b) => b.textContent.startsWith('Tap')).click()");
    await wait(300);
    console.log("times:", await run(win, "JSON.stringify([...document.querySelectorAll('.sync-time')].map((b) => b.textContent))"));
    await shot("03-tapped.png");
    await run(win, "window.confirm = () => true; [...document.querySelectorAll('.lyrics-editor button')].find((b) => b.textContent === 'Confirm and save to the song').click()");
    await wait(2500);
    console.log("note after save:", await run(win, "document.querySelector('#review-panel-lyrics .result-ok')?.textContent ?? ''"));
    console.log("lyrics now:", await lyricsOf(win));
    await shot("04-after-save.png");
    // Batch approve: tick the remaining song and save its first suggestion into the song.
    await run(win, "document.querySelector('.lyrics-review-table tbody tr input[type=checkbox]').click()");
    console.log("toolbar:", await run(win, "document.querySelector('.review-toolbar').textContent"));
    await shot("04b-ticked.png");
    await run(win, "window.confirm = () => true; [...document.querySelectorAll('.review-toolbar button')].find((b) => b.textContent === 'Approve and save to songs').click()");
    await wait(3000);
    console.log("batch note:", await run(win, "document.querySelector('#review-panel-lyrics .result-ok')?.textContent ?? ''"));
    console.log("lyrics after batch:", await lyricsOf(win));
    await run(win, "document.querySelector('#review-panel-lyrics [data-view=instrumental]').click()");
    await wait(1000);
    await shot("05-instrumental.png");
    await run(win, "document.querySelector('#review-panel-lyrics [data-view=review]').click()");
    await wait(1500);
    console.log("general review rows:", await run(win, "JSON.stringify([...document.querySelectorAll('.lyrics-review-table tbody tr')].map((r) => r.textContent))"));
    console.log("tabs:", await run(win, "JSON.stringify([...document.querySelectorAll('#review-panel-lyrics .view-links button')].map((b) => b.textContent))"));
    await run(win, "document.querySelector('#review-panel-lyrics .lyrics-step-1 .info-button').click()");
    await wait(500);
    await shot("06-info-window.png");
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    server.close();
    app.quit();
  }
});

