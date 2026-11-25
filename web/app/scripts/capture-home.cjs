// Development aid: in the real app, plays a library track for over 30 seconds, checks the Home page shows
// it under "Recently played", switches history off in Settings (checking nothing more is recorded),
// and checks the Now Playing wall emphasises the playing album.
// Run: npx electron scripts/capture-home.cjs <library-folder> <output-dir>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const library = path.resolve(process.argv[2] || "");
const outputDir = path.resolve(process.argv[3] || path.join(os.tmpdir(), "mediaverse-capture-home"));
fs.mkdirSync(outputDir, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-home-data-")));
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
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
async function shot(win, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, `${name}.png`), image.toPNG());
  console.log("saved", name);
}
const invoke = (win, command, args) => run(win, `window.mediaVerse.invoke(${JSON.stringify(command)}, ${JSON.stringify(args ?? {})}).then((r) => JSON.stringify(r))`);

app.whenReady().then(async () => {
  try {
    const win = await window();
    win.setSize(1180, 1000);
    win.show();
    await waitFor(win, "document.readyState === 'complete'", 15000, "page load");
    await wait(800);
    await invoke(win, "import_collection", { root: library });
    await run(win, "document.querySelector('#rescan-collection').click()");
    await run(win, "document.querySelector('[data-page=home]').click()");
    await wait(1500);
    console.log("home before playing:", JSON.stringify(await run(win, "document.querySelector('#home-shelves').innerText")));
    await shot(win, "1-home-before");

    // Play from the library, then listen for over 30 seconds.
    await run(win, "document.querySelector('[data-page=library]').click()");
    await waitFor(win, "document.querySelector('.artist-card')", 10000, "an artist card");
    await run(win, "document.querySelector('.artist-card').click()");
    await waitFor(win, "document.querySelector('.album-card .play-button')", 5000, "play button");
    await run(win, "document.querySelector('.album-card .play-button').click()");
    await waitFor(win, "document.querySelector('#player-audio').currentTime > 31", 60000, "31 seconds of playback");
    await wait(1500);
    console.log("history:", (await invoke(win, "list_history")).slice(0, 220));

    await run(win, "document.querySelector('[data-page=home]').click()");
    await wait(1500);
    console.log("home after playing:", JSON.stringify(await run(win, "document.querySelector('#home-shelves').innerText")));
    await shot(win, "2-home-after");

    // Switch history off in Settings.
    await run(win, "document.querySelector('[data-page=settings]').click()");
    await waitFor(win, "[...document.querySelectorAll('#settings-history label')].length > 0", 10000, "the history setting");
    await run(win, "document.querySelector('#settings-history input[type=checkbox]').click()");
    await wait(800);
    console.log("setting now:", await invoke(win, "list_history").then((s) => JSON.parse(s).result.enabled));
    await shot(win, "3-settings-history-off");
    await run(win, "document.querySelector('[data-page=home]').click()");
    await wait(1200);
    console.log("home with history off:", JSON.stringify(await run(win, "document.querySelector('#home-shelves').innerText")));

    // The Now Playing wall.
    await run(win, "document.querySelector('#player-expand').click()");
    await wait(2500);
    console.log("wall tiles by tier:", await run(win, "JSON.stringify(['current','queue','artist','library'].map((t) => [t, document.querySelectorAll('.np-tile-' + t).length]))"));
    await shot(win, "4-now-playing");
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
