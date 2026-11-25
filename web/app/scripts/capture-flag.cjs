// Development aid: in the real app, plays a track, flags it from the player bar, checks the Review
// page and the library mark, restarts the page to prove the flag was saved, then removes it.
// Run: npx electron scripts/capture-flag.cjs <library-folder> <output-dir>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const library = path.resolve(process.argv[2] || "");
const outputDir = path.resolve(process.argv[3] || path.join(os.tmpdir(), "mediaverse-capture-flag"));
fs.mkdirSync(outputDir, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-flag-data-")));
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
async function shot(win, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, `${name}.png`), image.toPNG());
  console.log("saved", name);
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
    await waitFor(win, "document.querySelector('.album-card .play-button')", 5000, "play button");
    await run(win, "document.querySelector('.album-card .play-button').click()");
    await waitFor(win, "document.querySelector('#player-audio').currentTime > 2.5", 20000, "playback");

    await run(win, "document.querySelector('#player-flag').click()");
    await waitFor(win, "document.querySelector('#flag-dialog').open", 3000, "the flag dialog");
    await run(win, "document.querySelector('#flag-reasons input[value=audio]').click(); document.querySelector('#flag-note').value = 'a pop near the start'");
    await shot(win, "1-flag-dialog");
    await run(win, "document.querySelector('#flag-save').click()");
    await waitFor(win, "document.querySelector('#review-badge').textContent === '(1)'", 5000, "the badge");
    console.log("paused after flagging:", await run(win, "document.querySelector('#player-audio').paused"));
    console.log("row mark:", await run(win, "!!document.querySelector('.flagged-mark')"));

    await run(win, "document.querySelector('[data-page=review]').click()");
    await wait(300);
    console.log("review page:", JSON.stringify(await run(win, "document.querySelector('#review-list').innerText")));
    await shot(win, "2-review");

    // Restart the page: the flag comes back from the saved list.
    await run(win, "location.reload()");
    await wait(2500);
    console.log("after reload, badge:", await run(win, "document.querySelector('#review-badge').textContent"));

    await run(win, "document.querySelector('[data-page=review]').click()");
    await run(win, "[...document.querySelectorAll('#review-list button')].find((b) => b.textContent.startsWith('Done')).click()");
    await waitFor(win, "document.querySelector('#review-badge').textContent === ''", 5000, "the flag to be removed");
    console.log("after removing:", JSON.stringify(await run(win, "document.querySelector('#review-count').textContent")));
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
