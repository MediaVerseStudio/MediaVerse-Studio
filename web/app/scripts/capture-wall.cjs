// Development aid: builds a small made-up library (16 albums, 10 artists, generated covers) from one real
// MP3, plays one album in the real app and captures the Now Playing wall, to judge tile sizes by eye.
// Run: npx electron scripts/capture-wall.cjs <real-library-folder> <output-dir>
const { app, nativeImage } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const source = path.resolve(process.argv[2] || "");
const outputDir = path.resolve(process.argv[3] || path.join(os.tmpdir(), "mediaverse-capture-wall"));
fs.mkdirSync(outputDir, { recursive: true });
const library = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-wall-lib-"));

function findMp3(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { const f = findMp3(full); if (f) return f; }
    else if (entry.name.toLowerCase().endsWith(".mp3")) return full;
  }
  return null;
}
const original = fs.readFileSync(findMp3(source));
const oldTag = 10 + ((original[6] << 21) | (original[7] << 14) | (original[8] << 7) | original[9]);
const audio = original.subarray(oldTag);

function frame(id, text) {
  const body = Buffer.concat([Buffer.from([0]), Buffer.from(text, "latin1")]);
  const header = Buffer.alloc(10);
  header.write(id, 0, "latin1"); header.writeUInt32BE(body.length, 4);
  return Buffer.concat([header, body]);
}
function tag(title, artist, album, track) {
  const frames = Buffer.concat([frame("TIT2", title), frame("TPE1", artist), frame("TALB", album), frame("TPE2", artist), frame("TRCK", String(track))]);
  const size = frames.length + 256;
  const header = Buffer.from("ID3\u0003\u0000\u0000", "latin1");
  const sync = Buffer.from([(size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127]);
  return Buffer.concat([header, sync, frames, Buffer.alloc(256)]);
}
function cover(index) {
  const w = 300, h = 300, data = Buffer.alloc(w * h * 4);
  const hue = (index * 47) % 360;
  const rgb = (hh, s, v) => { const c = v * s, x = c * (1 - Math.abs(((hh / 60) % 2) - 1)), m = v - c; const [r, g, b] = hh < 60 ? [c, x, 0] : hh < 120 ? [x, c, 0] : hh < 180 ? [0, c, x] : hh < 240 ? [0, x, c] : hh < 300 ? [x, 0, c] : [c, 0, x]; return [(r + m) * 255, (g + m) * 255, (b + m) * 255]; };
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const stripe = Math.floor((x + y * (index % 3 + 1)) / (20 + index * 3)) % 2;
    const [r, g, b] = rgb((hue + (stripe ? 40 : 0)) % 360, 0.7, stripe ? 0.9 : 0.55);
    const o = (y * w + x) * 4; data[o] = b; data[o + 1] = g; data[o + 2] = r; data[o + 3] = 255; // BGRA
  }
  return nativeImage.createFromBitmap(data, { width: w, height: h }).toJPEG(85);
}

const artists = ["The Rakes", "Mina Lopez", "Orchid Club", "Dub Hammer", "Sol Garden", "Night Ferry", "Kite & Key", "Brass Monkey", "Velvet Maps", "Paper Moons"];
const plan = [];
for (let i = 0; i < 16; i++) plan.push({ artist: artists[i % 10 < 3 && i > 9 ? 0 : i % 10], album: `Album ${i + 1}` });
plan[10].artist = artists[0]; plan[11].artist = artists[0]; // the first artist has three albums
plan.forEach((p, i) => {
  const dir = path.join(library, p.artist, p.album);
  fs.mkdirSync(dir, { recursive: true });
  for (let t = 1; t <= 2; t++) fs.writeFileSync(path.join(dir, `0${t} - Song ${t}.mp3`), Buffer.concat([tag(`Song ${t} of ${p.album}`, p.artist, p.album, t), audio]));
  fs.writeFileSync(path.join(dir, "cover.jpg"), cover(i));
});
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-wall-data-")));
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
  while (Date.now() < deadline) { if (await run(win, expression)) return; await wait(250); }
  throw new Error(`Timed out waiting for ${label}.`);
}
app.whenReady().then(async () => {
  try {
    const win = await window();
    win.setSize(1360, 900);
    win.show();
    await waitFor(win, "document.readyState === 'complete'", 15000, "page load");
    await wait(800);
    await run(win, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} })`);
    await run(win, "document.querySelector('#rescan-collection').click()");
    await run(win, "document.querySelector('[data-page=library]').click()");
    await waitFor(win, "document.querySelectorAll('.artist-card').length >= 10", 15000, "ten artists");
    await run(win, "[...document.querySelectorAll('.artist-card')].find((c) => c.textContent.includes('The Rakes')).click()");
    await waitFor(win, "document.querySelector('.album-card .play-button')", 5000, "play button");
    await run(win, "document.querySelector('.album-card .play-button').click()");
    await waitFor(win, "document.querySelector('#player-audio').currentTime > 1", 20000, "playback");
    await run(win, "document.querySelector('#player-expand').click()");
    await wait(4000);
    console.log("tiles:", await run(win, "JSON.stringify(Object.entries([...document.querySelectorAll('.np-tile')].reduce((m, t) => { const k = t.className.match(/np-tile-(\\w+)/)[1] + ':' + t.style.gridColumn; m[k] = (m[k] || 0) + 1; return m; }, {})).sort())"));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outputDir, "wall.png"), image.toPNG());
    console.log("saved wall");
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
