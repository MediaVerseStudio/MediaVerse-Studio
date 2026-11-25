// Development aid: builds a small library (a real MP3 with a cover but no lyrics, an untagged MP3 with no cover,
// and a generated WAV with known pops and a dropout), flags the WAV, and walks the Review sections in the real
// app: missing artwork, missing lyrics, tick-to-scan on flagged tracks, audio defects and the 8-second Listen sample.
// Run: npx electron scripts/capture-review.cjs <real-library-folder> <output-dir>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const source = path.resolve(process.argv[2] || "");
const outputDir = path.resolve(process.argv[3] || path.join(os.tmpdir(), "mediaverse-capture-review"));
fs.mkdirSync(outputDir, { recursive: true });
const library = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-review-lib-"));
fs.cpSync(source, library, { recursive: true });
function findMp3(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { const f = findMp3(full); if (f) return f; }
    else if (entry.name.toLowerCase().endsWith(".mp3")) return full;
  }
  return null;
}
const original = fs.readFileSync(findMp3(source));
const audio = original.subarray(10 + ((original[6] << 21) | (original[7] << 14) | (original[8] << 7) | original[9]));
function frame(id, text) { const body = Buffer.concat([Buffer.from([0]), Buffer.from(text, "latin1")]); const h = Buffer.alloc(10); h.write(id, 0, "latin1"); h.writeUInt32BE(body.length, 4); return Buffer.concat([h, body]); }
function tag(...frames) { const f = Buffer.concat(frames); const size = f.length + 128; return Buffer.concat([Buffer.from("ID3\u0003\u0000\u0000", "latin1"), Buffer.from([(size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127]), f, Buffer.alloc(128)]); }
const bare = path.join(library, "Nobody", "No Cover Album");
fs.mkdirSync(bare, { recursive: true });
fs.writeFileSync(path.join(bare, "01 - Plain.mp3"), Buffer.concat([tag(frame("TIT2", "Plain"), frame("TPE1", "Nobody"), frame("TALB", "No Cover Album")), audio]));
// A WAV with pops at 1.36 s, 2.72 s and 4.54 s and a short dropout at 3.40 s.
const frames = 44100 * 10; const data = Buffer.alloc(frames * 4); let state = 12345;
for (let i = 0; i < frames; i++) {
  state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
  let v = Math.round(6000 * Math.sin((i / 44100) * 2 * Math.PI * 330) + 2000 * Math.sin((i / 44100) * 2 * Math.PI * 1500) + ((state >>> 22) - 512));
  if ([60000, 120000, 200000].includes(i)) v += 20000;
  if (i >= 150000 && i < 150400) v = 0;
  data.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 4); data.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 4 + 2);
}
const header = Buffer.alloc(44); header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8); header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(44100, 24); header.writeUInt32LE(176400, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(data.length, 40);
const wavDir = path.join(library, "Test Tones", "Pops"); fs.mkdirSync(wavDir, { recursive: true });
const wav = path.join(wavDir, "pops-test.wav"); fs.writeFileSync(wav, Buffer.concat([header, data]));
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-review-data-")));
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function window() { const { BrowserWindow } = require("electron"); for (let i = 0; i < 100; i++) { const [f] = BrowserWindow.getAllWindows(); if (f) return f; await wait(100); } throw new Error("No window appeared."); }
async function waitFor(win, expression, timeoutMs, label) { const end = Date.now() + timeoutMs; while (Date.now() < end) { if (await run(win, expression)) return; await wait(250); } throw new Error(`Timed out waiting for ${label}.`); }
const text = (win, selector) => run(win, `document.querySelector(${JSON.stringify(selector)}).innerText.replace(/\\n+/g, ' | ').slice(0, 330)`);
app.whenReady().then(async () => {
  try {
    const win = await window();
    win.setSize(1280, 1000);
    win.show();
    await waitFor(win, "document.readyState === 'complete'", 15000, "page load");
    await wait(800);
    await run(win, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} })`);
    await run(win, "document.querySelector('#rescan-collection').click()");
    await wait(1500);
    await run(win, `window.mediaVerse.invoke('set_flag', { path: ${JSON.stringify(wav)}, flagged: true, reasons: ['audio'], note: 'pops', title: 'pops-test', artist: 'Test Tones' })`);
    await run(win, "location.reload()");
    await wait(3000);
    const tab = async (name) => { await run(win, `document.querySelector('[data-page=review]').click(); document.querySelector('.subnav-button[data-review=${name}]').click()`); await wait(2500); };

    await tab("artwork");
    console.log("MISSING ARTWORK:", await text(win, "#review-panel-artwork"));
    await tab("lyrics");
    console.log("MISSING LYRICS:", await text(win, "#review-panel-lyrics"));

    await tab("flagged");
    await run(win, "document.querySelector('#review-list .review-card input[type=checkbox]').click()");
    await wait(400);
    console.log("scan button:", await run(win, "[...document.querySelectorAll('#review-list button')].map((b) => b.textContent).find((t) => t.startsWith('Scan')) "));
    await run(win, "[...document.querySelectorAll('#review-list button')].find((b) => b.textContent.startsWith('Scan')).click()");
    await waitFor(win, "document.querySelector('#scan-note').textContent.startsWith('Scan finished')", 60000, "the scan");
    console.log("scan dialog:", await text(win, "#scan-results"));
    await run(win, "document.querySelector('#scan-close').click()");

    await tab("defects");
    console.log("AUDIO DEFECTS:", await text(win, "#review-panel-defects"));
    try { fs.writeFileSync(path.join(outputDir, "defects.png"), (await win.webContents.capturePage()).toPNG()); } catch (e) { console.log("(screenshot skipped:", e.message + ")"); }

    // Listen to the third pop (4.5 s): an 8 second sample from about 0.5 s, stopping by itself.
    await run(win, "[...document.querySelectorAll('#review-panel-defects button')].filter((b) => b.textContent.includes('Listen')).pop().click()");
    await wait(1500);
    const first = await run(win, "JSON.stringify({ t: Math.round(document.querySelector('#player-audio').currentTime * 10) / 10, paused: document.querySelector('#player-audio').paused })");
    await wait(9000);
    const last = await run(win, "JSON.stringify({ t: Math.round(document.querySelector('#player-audio').currentTime * 10) / 10, paused: document.querySelector('#player-audio').paused })");
    console.log("listen sample, 1.5 s in:", first, "| 10.5 s later:", last);
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
