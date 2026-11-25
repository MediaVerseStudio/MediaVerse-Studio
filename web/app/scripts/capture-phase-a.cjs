// Development aid for feedback round 2 (D32): starts the real app with a throwaway data folder, imports the
// music folder given as the second argument (read only; nothing in it is changed), and checks the new look
// and fixes: the album-art wall behind the pages, the top bar at a narrow width, a whole-library defect scan
// (more than 1,000 songs), Escape stopping the scan, and the Cast placeholder in Settings.
// Run: npx electron scripts/capture-phase-a.cjs <output-dir> <music-folder>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mediaverse-capture-phase-a"));
const music = process.argv[3];
fs.mkdirSync(outputDir, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-phase-a-"));
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

app.whenReady().then(async () => {
  try {
    if (!music) throw new Error("Give the music folder as the second argument.");
    const win = await window();
    win.setSize(1600, 1000);
    win.show();
    await wait(2000);
    const imported = JSON.parse(await call(win, "import_collection", { root: music }));
    console.log("imported tracks:", imported.result?.track_count, imported.error?.message ?? "");
    await run(win, "location.reload()");
    await wait(9000); // covers load a few at a time
    console.log("wall tiles:", await run(win, "document.querySelectorAll('.backdrop-tile').length"));
    console.log("page scrolls sideways:", await run(win, "document.documentElement.scrollWidth > document.documentElement.clientWidth"));
    await shot(win, "1-home-wide");
    win.setSize(820, 900);
    await wait(1200);
    console.log("narrow: nav buttons fully in view (of 5):", await run(win, "[...document.querySelectorAll('.nav-button')].filter((b) => { const r = b.getBoundingClientRect(); return r.left >= 0 && r.right <= document.documentElement.clientWidth && r.width > 0; }).length"));
    console.log("narrow: page scrolls sideways:", await run(win, "document.documentElement.scrollWidth > document.documentElement.clientWidth"));
    await shot(win, "2-home-narrow");
    win.setSize(1600, 1000);
    await wait(800);
    // Whole-library defect scan from Review > Audio defects.
    await run(win, "document.querySelector('[data-page=review]').click()");
    await wait(600);
    await run(win, "document.querySelector('[data-review=defects]').click()");
    await wait(2500);
    const started = await run(win, "(() => { const b = [...document.querySelectorAll('button')].find((x) => /^Scan the \\d+ unscanned/.test(x.textContent)); if (!b) return 'no button'; const t = b.textContent; b.click(); return t; })()");
    console.log("pressed:", started);
    await wait(15000);
    console.log("scan note after 15 s:", await run(win, "document.querySelector('#scan-note').textContent"));
    console.log("close button in view:", await run(win, "(() => { const r = document.querySelector('#scan-close').getBoundingClientRect(); return r.bottom <= window.innerHeight && r.top >= 0; })()"));
    await shot(win, "3-scan-running");
    // Count scan progress events from the sidecar; after Escape there must be none.
    await run(win, "window.__scanEvents = 0; window.mediaVerse.listen('job-progress', (e) => { if (e.payload.kind === 'defects') window.__scanEvents += 1; }); true");
    await wait(3000);
    console.log("progress events in 3 s before Escape:", await run(win, "window.__scanEvents"));
    win.webContents.sendInputEvent({ type: "keyDown", keyCode: "Escape" });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode: "Escape" });
    await wait(1500);
    console.log("dialog open after Escape:", await run(win, "document.querySelector('#scan-dialog').open"));
    await run(win, "window.__scanEvents = 0; true");
    await wait(12000);
    console.log("progress events in 12 s after Escape (0 means the scan stopped):", await run(win, "window.__scanEvents"));
    await run(win, "document.querySelector('[data-page=settings]').click()");
    await wait(1000);
    await run(win, "document.querySelector('#settings-cast').scrollIntoView()");
    await wait(400);
    await shot(win, "4-settings-cast");
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
