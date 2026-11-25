// Development aid: in the real app, scans a real ripped MP3 from a library for defects through the
// dialog (checking real music is not flagged without cause), then scans a generated WAV with pops added.
// Run: npx electron scripts/capture-defects.cjs <library-folder> <output-dir>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const source = path.resolve(process.argv[2] || "");
const outputDir = path.resolve(process.argv[3] || path.join(os.tmpdir(), "mediaverse-capture-defects"));
fs.mkdirSync(outputDir, { recursive: true });
const library = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-defects-lib-"));
fs.cpSync(source, library, { recursive: true });

// A 6 second WAV: tones plus noise, with three pops and a short dropout.
function makeWav(file) {
  const frames = 44100 * 6;
  const data = Buffer.alloc(frames * 4);
  let state = 12345;
  for (let i = 0; i < frames; i++) {
    state = (Math.imul(state, 1664525) + 1013904223) >>> 0;
    const noise = ((state >>> 22) - 512);
    let v = Math.round(6000 * Math.sin((i / 44100) * 2 * Math.PI * 330) + 2000 * Math.sin((i / 44100) * 2 * Math.PI * 1500) + noise);
    if ([60000, 120000, 200000].includes(i)) v += 20000;
    if (i >= 150000 && i < 150400) v = 0;
    data.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 4);
    data.writeInt16LE(Math.max(-32768, Math.min(32767, v)), i * 4 + 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(2, 22); header.writeUInt32LE(44100, 24);
  header.writeUInt32LE(176400, 28); header.writeUInt16LE(4, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}
const wavPath = path.join(library, "pops-test.wav");
makeWav(wavPath);

app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-defects-data-")));
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
    await waitFor(win, "[...document.querySelectorAll('.album-card button')].some((b) => b.textContent.startsWith('Scan album'))", 5000, "scan button");
    await run(win, "[...document.querySelectorAll('.album-card button')].find((b) => b.textContent.startsWith('Scan album')).click()");
    const started = Date.now();
    await waitFor(win, "document.querySelector('#scan-note').textContent.startsWith('Scan finished')", 60000, "the scan");
    console.log("real MP3 scan took", Date.now() - started, "ms");
    console.log("dialog:", JSON.stringify(await run(win, "document.querySelector('#scan-results').innerText")), "|", await run(win, "document.querySelector('#scan-note').innerText"));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outputDir, "1-real-mp3.png"), image.toPNG());
    await run(win, "document.querySelector('#scan-close').click()");

    // The generated WAV with known defects, straight through the command.
    const reply = await run(win, `new Promise((resolve) => {
      const stop = window.mediaVerse.listen('job-finished', (event) => { stop(); resolve(JSON.stringify(event.payload.result ?? event.payload.error)); });
      window.mediaVerse.invoke('scan_defects', { paths: [${JSON.stringify(wavPath)}] });
    })`);
    const report = JSON.parse(reply).tracks[0].report;
    console.log("generated WAV:", report.verdict, JSON.stringify(report.counts), report.findings.filter((f) => f.kind !== "clipping").map((f) => `${f.kind}@${f.time_ms}ms`).join(", "));
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
