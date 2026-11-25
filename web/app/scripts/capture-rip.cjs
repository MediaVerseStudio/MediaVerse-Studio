// Development aid: drives the real Electron app through the "Rip a CD" page with a real disc and
// saves screenshots. Needs: `npm run build`, `npm run sidecar:build`, the CD helper (debug or release
// build), LAME (MEDIAVERSE_LAME_PATH), and an audio CD in the drive. Uses throwaway data, library and
// archive folders. Rips only the first track. Run: npx electron scripts/capture-rip.cjs <output-dir>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mediaverse-capture-rip"));
fs.mkdirSync(outputDir, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-rip-"));
const dataDir = path.join(base, "data");
const libraryDir = path.join(base, "library");
const archiveDir = path.join(base, "archive");
for (const dir of [dataDir, libraryDir, archiveDir]) fs.mkdirSync(dir, { recursive: true });
app.setPath("userData", dataDir);
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function window() {
  const { BrowserWindow } = require("electron");
  for (let i = 0; i < 100; i++) {
    const [first] = BrowserWindow.getAllWindows();
    if (first) return first;
    await wait(100);
  }
  throw new Error("No window appeared.");
}
async function shot(win, name) {
  const image = await win.webContents.capturePage();
  const file = path.join(outputDir, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  console.log(`saved ${file}`);
}
const run = (win, code) => win.webContents.executeJavaScript(code);
async function waitFor(win, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await run(win, expression)) return;
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
const call = (win, command, args) =>
  run(win, `window.mediaVerse.invoke(${JSON.stringify(command)}, ${JSON.stringify(args ?? {})}).then((r) => JSON.stringify(r))`);

app.whenReady().then(async () => {
  try {
    const win = await window();
    win.setSize(1180, 1100);
    win.show();
    await waitFor(win, "document.readyState === 'complete'", 15000, "page load");
    await wait(1500);

    // Throwaway settings: the project's web address as the MusicBrainz contact; folders in the temp area.
    console.log(await call(win, "set_metadata_settings", { settings: { identity: { contact: "https://mediaverse.studio" } } }).then((s) => s.slice(0, 80)));
    console.log(await call(win, "import_collection", { root: libraryDir }).then((s) => s.slice(0, 80)));
    console.log(await call(win, "set_archive_dir", { path: archiveDir }));

    // The drive must be checked first (the real guided check).
    await run(win, "document.querySelector('[data-page=drives]').click()");
    await waitFor(win, "document.querySelectorAll('.drive-card').length > 0", 15000, "the drive list");
    await run(win, "document.querySelector('.drive-card button').click()");
    await waitFor(win, "!document.querySelector('#drive-result').hidden", 180000, "the drive check");

    await run(win, "document.querySelector('[data-page=rip]').click()");
    await waitFor(win, "document.querySelector('#rip-drive').options.length > 0", 15000, "the drive choice");
    await wait(500);
    await shot(win, "1-rip-start");

    await run(win, "document.querySelector('#rip-lookup').click()");
    await waitFor(win, "document.querySelector('#rip-lookup-note').innerText.match(/match|No match|could not|unable/i)", 60000, "the lookup");
    await wait(500);
    await shot(win, "2-looked-up");
    console.log("lookup:", await run(win, "document.querySelector('#rip-lookup-note').innerText"));
    console.log("candidates:", await run(win, "document.querySelector('#rip-candidates').innerText"));

    // Only the first track, to keep the run short.
    await run(win, "document.querySelectorAll('#rip-tracks input').forEach((box, i) => { if (box.checked !== (i === 0)) box.click(); })");
    await wait(300);
    console.log("problem:", JSON.stringify(await run(win, "document.querySelector('#rip-problem').innerText")));
    await shot(win, "3-ready");
    await run(win, "document.querySelector('#rip-start').click()");
    await waitFor(win, "!document.querySelector('#rip-progress').hidden", 10000, "progress box");
    await wait(4000);
    await shot(win, "4-ripping");
    await waitFor(win, "!document.querySelector('#rip-result').hidden", 300000, "the result");
    await wait(800);
    await shot(win, "5-finished");
    console.log("result:", await run(win, "document.querySelector('#rip-result').innerText"));

    const list = (dir) => fs.readdirSync(dir, { recursive: true, withFileTypes: true }).filter((e) => e.isFile()).map((e) => path.join(e.parentPath ?? e.path, e.name));
    console.log("library files:", list(libraryDir));
    console.log("archive files:", list(archiveDir));
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
