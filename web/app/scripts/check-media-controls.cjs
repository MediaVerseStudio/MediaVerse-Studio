// Development aid: starts the real app (throwaway data folder), plays an album muted, opens the mini player, and checks that the mini player shows the song,
// that its buttons control the main window, and that the media keys are registered. Run:
//   npx electron scripts/check-media-controls.cjs <library-folder> <output-dir>
const { app, BrowserWindow, globalShortcut } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const library = path.resolve(process.argv[2] || "");
const outputDir = path.resolve(process.argv[3] || path.join(os.tmpdir(), "mediaverse-mini"));
fs.mkdirSync(outputDir, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-mini-data-")));
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
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
    let main;
    for (let i = 0; i < 100 && !main; i++) {
      main = BrowserWindow.getAllWindows()[0];
      await wait(100);
    }
    main.setSize(1180, 900);
    await waitFor(main, "document.readyState === 'complete'", 15000, "page load");
    await wait(1000);
    await run(main, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} }).then(() => 1)`);
    await run(main, "document.querySelector('#rescan-collection').click()");
    await run(main, "document.querySelector('[data-page=library]').click()");
    await waitFor(main, "document.querySelectorAll('.lib-artist').length >= 12", 60000, "the demo artists");
    await run(main, "[...document.querySelectorAll('.lib-artist')].find((e) => e.textContent.trim().startsWith('Copper Lantern')).click()");
    await waitFor(main, "document.querySelectorAll('#artist-page tr[data-path]').length > 5", 10000, "the artist page");
    await run(main, "document.querySelector('#artist-page tr[data-path]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
    await waitFor(main, "document.querySelector('#player-audio').currentTime > 0.5", 20000, "playback");
    await run(main, "document.querySelectorAll('audio').forEach((a) => { a.muted = true; })");
    console.log("keys registered:", ["MediaPlayPause", "MediaNextTrack", "MediaPreviousTrack", "MediaStop"].map((k) => `${k}=${globalShortcut.isRegistered(k)}`).join(" "));
    console.log("mini button visible:", await run(main, "!document.querySelector('#player-mini').hidden"));
    const before = await run(main, "document.querySelector('#player-title').textContent");
    await run(main, "document.querySelector('#player-mini').click()");
    let mini;
    for (let i = 0; i < 50 && !mini; i++) {
      mini = BrowserWindow.getAllWindows().find((w) => w !== main && w.webContents.getURL().includes("mini.html"));
      await wait(100);
    }
    if (!mini) throw new Error("The mini player did not open.");
    await wait(1500);
    console.log("mini shows:", await run(mini, "JSON.stringify({ title: document.querySelector('#title').textContent, artist: document.querySelector('#artist').textContent, play: document.querySelector('#toggle').textContent, hasCover: document.querySelector('#cover').style.backgroundImage !== 'none' && document.querySelector('#cover').style.backgroundImage !== '' })"));
    fs.writeFileSync(path.join(outputDir, "mini.png"), (await mini.webContents.capturePage()).toPNG());
    // Its buttons control the main window.
    await run(mini, "document.querySelector('#next').click()");
    await wait(1500);
    const after = await run(main, "document.querySelector('#player-title').textContent");
    console.log("next from mini:", JSON.stringify({ before, after, changed: before !== after }));
    await run(mini, "document.querySelector('#toggle').click()");
    await wait(600);
    console.log("paused from mini:", await run(main, "document.querySelector('#player-audio').paused || document.querySelectorAll('audio')[1].paused"));
    console.log("mini now shows:", await run(mini, "JSON.stringify({ title: document.querySelector('#title').textContent, play: document.querySelector('#toggle').textContent })"));
    await run(mini, "document.querySelector('#close').click()");
    await wait(600);
    console.log("mini closed:", !BrowserWindow.getAllWindows().some((w) => w !== main && !w.isDestroyed() && w.webContents.getURL().includes("mini.html")));
  } catch (error) {
    console.error("check failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
