// Development aid: screenshots of the real desktop app for the website, using the made-up demo library
// (tools/make-demo-library.ps1) and a throwaway data folder, so no real music, covers or settings appear.
// Build first: npm run build. Run: npx electron scripts/capture-website.cjs <demo-library> <output-dir>
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const library = path.resolve(process.argv[2] || "");
const outputDir = path.resolve(process.argv[3] || path.join(os.tmpdir(), "mediaverse-capture-website"));
fs.mkdirSync(outputDir, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-website-data-"));
fs.writeFileSync(path.join(dataDir, "library-share.json"), JSON.stringify({ enabled: false, port: 47791 }));
app.setPath("userData", dataDir);
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function waitFor(win, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await run(win, expression).catch(() => false)) return;
    await wait(200);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
async function shot(win, name, settle = 900) {
  await wait(settle);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, `${name}.png`), image.toPNG());
  console.log("saved", name, JSON.stringify(image.getSize()));
}
const click = (win, selector, text) =>
  run(win, `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${text ? `e.textContent.trim().startsWith(${JSON.stringify(text)})` : "true"}); if (!el) return false; el.click(); return true; })()`);
const key = async (win, keyCode) => {
  win.webContents.sendInputEvent({ type: "keyDown", keyCode });
  win.webContents.sendInputEvent({ type: "keyUp", keyCode });
  await wait(300);
};

app.whenReady().then(async () => {
  try {
    let win;
    for (let i = 0; i < 100 && !(win = BrowserWindow.getAllWindows()[0]); i++) await wait(100);
    win.unmaximize();
    win.setContentSize(1440, 900);
    win.center();
    await waitFor(win, "document.readyState === 'complete'", 15000, "page load");
    await run(win, "localStorage.setItem('mediaverse.welcome-seen', '1'); location.reload(); 0");
    await wait(2500);
    await run(win, `window.mediaVerse.invoke("import_collection", { root: ${JSON.stringify(library)} })`);
    await click(win, "#rescan-collection");
    await click(win, "[data-page=library]");
    await waitFor(win, "document.querySelectorAll('.lib-artist').length >= 12", 60000, "the demo artists");
    await wait(2500); // covers
    await shot(win, "pc-library-artists", 1500);

    await click(win, ".lib-pivot", "albums");
    await shot(win, "pc-library-albums", 2000);

    await click(win, ".lib-pivot", "artists");
    await wait(800);
    await click(win, ".lib-artist", "Copper Lantern");
    await waitFor(win, "document.querySelectorAll('#artist-page tr').length > 5", 10000, "the artist page");
    await shot(win, "pc-artist-page", 1500);

    // Play the title song of Night Ferry (it has time-stamped lyrics) and move into the first chorus.
    await run(win, "(() => { const row = [...document.querySelectorAll('#artist-page tr')].find((r) => r.textContent.includes('Night Ferry') && r.textContent.includes('Harbour') === false && r.querySelector('td')); row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()");
    await waitFor(win, "document.querySelector('#player-audio').currentTime > 0.5", 20000, "playback");
    await run(win, "document.querySelector('#player-audio').currentTime = 39; 0");
    await shot(win, "pc-artist-playing", 2500);

    await click(win, "#player-expand");
    await shot(win, "pc-now-playing", 4000);
    await click(win, "#np-tab-lyrics");
    await shot(win, "pc-now-playing-lyrics", 3500);
    await key(win, "Escape");
    await wait(800);

    await click(win, "[data-page=home]");
    await shot(win, "pc-home", 2000);
    await click(win, "[data-page=review]");
    await shot(win, "pc-review", 2500);
    await click(win, "[data-page=settings]");
    await click(win, "[data-settings-section=display]");
    await shot(win, "pc-settings-display", 1200);
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
