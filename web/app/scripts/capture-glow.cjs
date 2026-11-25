// Development aid for D32: plays an album from Home in the real app (sound muted at the output, so nothing is
// heard) and checks that music still plays through the media scheme in CORS mode, that the music glow rises
// while it plays and goes to zero when paused, and that the Display settings and Now Playing look right.
// Run: npx electron scripts/capture-glow.cjs <output-dir> <music-folder>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

app.commandLine.appendSwitch("mute-audio");
const outputDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mediaverse-capture-glow"));
const music = process.argv[3];
fs.mkdirSync(outputDir, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-glow-"));
app.setPath("userData", path.join(base, "data"));
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
const call = (win, command, args) => run(win, `window.mediaVerse.invoke(${JSON.stringify(command)}, ${JSON.stringify(args ?? {})}).then((r) => JSON.stringify(r))`);
async function window() {
  const { BrowserWindow } = require("electron");
  for (let i = 0; i < 100; i++) { const [first] = BrowserWindow.getAllWindows(); if (first) return first; await wait(100); }
  throw new Error("No window appeared.");
}
async function shot(win, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, `${name}.png`), image.toPNG());
  console.log("saved", name);
}
const glow = (win) => run(win, "getComputedStyle(document.querySelector('.music-glow')).getPropertyValue('--glow')");

app.whenReady().then(async () => {
  try {
    if (!music) throw new Error("Give the music folder as the second argument.");
    const win = await window();
    win.setSize(1600, 1000);
    win.show();
    await wait(2000);
    await call(win, "import_collection", { root: music });
    await run(win, "location.reload()");
    await wait(6000);
    console.log("motion level:", await run(win, "document.documentElement.dataset.motion"));
    console.log("clicked a Home tile:", await run(win, "(() => { const b = document.querySelector('.home-tile-play'); if (!b) return false; b.click(); return true; })()"));
    await wait(5000);
    const state = JSON.parse(await run(win, "JSON.stringify((() => { const a = document.querySelector('#player-audio'); return { t: a.currentTime, paused: a.paused, error: a.error && a.error.code, cors: a.crossOrigin }; })())"));
    console.log("audio after 5 s:", state);
    const samples = [];
    for (let i = 0; i < 80; i += 1) { samples.push(Number(await glow(win))); await wait(50); }
    console.log(`glow while playing (80 samples over 4 s): min ${Math.min(...samples).toFixed(2)}, max ${Math.max(...samples).toFixed(2)}, mean ${(samples.reduce((a, b) => a + b, 0) / samples.length).toFixed(2)}`);
    await shot(win, "1-home-playing");
    await run(win, "document.querySelector('#player-expand').click()");
    await wait(3000);
    await shot(win, "2-now-playing");
    await run(win, "document.querySelector('#player-audio').pause()");
    await wait(1500);
    console.log("glow after pause:", await glow(win));
    await shot(win, "3-now-playing-paused");
    await run(win, "document.querySelector('#np-back').click()");
    await run(win, "document.querySelector('[data-page=settings]').click()");
    await wait(800);
    await run(win, "document.querySelector('#settings-display').scrollIntoView()");
    await wait(400);
    await shot(win, "4-display-settings");
    // Choosing Still stops the glow and the tint.
    await run(win, "[...document.querySelectorAll('input[name=display-motion]')][2].click()");
    await wait(300);
    console.log("after choosing Still, motion level:", await run(win, "document.documentElement.dataset.motion"));
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
