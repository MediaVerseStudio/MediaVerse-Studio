// Development aid: in the real app, gives a copy of a library song 40 time-stamped lyric lines, plays it, opens Now Playing
// (which shows the lyrics layout by itself) and checks that, as the song goes on, the current line stays in the middle of the
// lyrics box, the page itself never scrolls (it did, 2026-11-17: the page slid up out of reach), and the queue layout still works.
// Run: npx electron scripts/capture-now-playing.cjs <library-folder> <output-dir>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const source = path.resolve(process.argv[2] || "");
const outputDir = path.resolve(process.argv[3] || path.join(os.tmpdir(), "mediaverse-capture-now-playing"));
fs.mkdirSync(outputDir, { recursive: true });
const library = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-np-lib-"));
fs.cpSync(source, library, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-np-data-")));
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
  while (Date.now() < deadline) { if (await run(win, expression)) return; await wait(200); }
  throw new Error(`Timed out waiting for ${label}.`);
}
const mp3 = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f.toString())).find((f) => f.toLowerCase().endsWith(".mp3"));
app.whenReady().then(async () => {
  try {
    const win = await window();
    win.setSize(1360, 900);
    win.show();
    await waitFor(win, "document.readyState === 'complete'", 15000, "page load");
    await wait(800);
    // The fresh test profile starts with the welcome screen: take it away.
    await run(win, "[...document.querySelectorAll('a, button')].find((x) => /^Later/.test(x.textContent.trim()))?.click()");
    await wait(400);
    const song = mp3(library);
    console.log("import:", (await run(win, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} }).then((r) => JSON.stringify(r)).catch((e) => String(e))`)).slice(0, 160));
    const lrc = Array.from({ length: 40 }, (_, i) => `[${String(Math.floor((i * 3) / 60)).padStart(2, "0")}:${String((i * 3) % 60).padStart(2, "0")}.00]Line number ${i + 1} of the lyrics, sung here`).join("\n");
    await run(win, `window.mediaVerse.invoke('update_track_media', { paths: [${JSON.stringify(song)}], lyrics: { text: ${JSON.stringify(lrc)} } }).then((r) => JSON.stringify(r))`);
    await run(win, "document.querySelector('#rescan-collection')?.click()");
    await run(win, "document.querySelector('[data-page=library]').click()");
    await waitFor(win, "[...document.querySelectorAll('button')].some((b) => b.textContent.trim() === 'Play all')", 20000, "the Play all button");
    // "Play all" does nothing until the library has loaded: press it again until the music plays.
    for (let i = 0; i < 25 && !(await run(win, "document.querySelector('#player-audio').currentTime > 0.3")); i++) {
      await run(win, "[...document.querySelectorAll('button')].find((b) => b.textContent.trim() === 'Play all')?.click()");
      await wait(1000);
    }
    await waitFor(win, "document.querySelector('#player-audio').currentTime > 0.3", 5000, "playback");    await run(win, "document.querySelector('#player-expand').click()");
    await waitFor(win, "document.querySelectorAll('.np-lyric-line').length === 40", 10000, "the lyric lines");
    const state = () => run(win, `(() => {
      const root = document.querySelector('#now-playing'); const view = document.querySelector('#np-lyrics-view'); const now = document.querySelector('.np-lyric-now');
      const vb = view.getBoundingClientRect(); const nb = now ? now.getBoundingClientRect() : null;
      return JSON.stringify({ mode: root.classList.contains('lyrics-mode'), rootScroll: [root.scrollTop, root.scrollLeft], pageScroll: [window.scrollX, window.scrollY, document.scrollingElement.scrollTop],
        now: now ? now.textContent.slice(0, 14) : null, nowMiddleOffset: nb ? Math.round((nb.top + nb.height / 2) - (vb.top + vb.height / 2)) : null, viewHeight: Math.round(vb.height),
        outLines: document.querySelectorAll('.np-lyric-line.np-out').length, titleVisible: document.querySelector('#np-title').getBoundingClientRect().top >= 0 });
    })()`);
    let ok = true;
    for (let i = 0; i < 4; i++) {
      await run(win, `document.querySelector('#player-audio').currentTime = ${[1, 28, 70, 110][i]}`);
      await wait(1500);
      const s = JSON.parse(await state());
      console.log(`at ${[1, 28, 70, 110][i]} s:`, JSON.stringify(s));
      if (!s.mode || s.rootScroll.some((n) => n !== 0) || s.pageScroll.some((n) => n !== 0) || !s.titleVisible) ok = false;
      fs.writeFileSync(path.join(outputDir, `lyrics-${i + 1}.png`), (await win.webContents.capturePage()).toPNG());
    }
    await run(win, "document.querySelector('#np-tab-queue').click()");
    await wait(600);
    console.log("queue tab:", await run(win, "JSON.stringify({ lyricsMode: document.querySelector('#now-playing').classList.contains('lyrics-mode'), queueVisible: !document.querySelector('#np-queue').hidden })"));
    fs.writeFileSync(path.join(outputDir, "queue.png"), (await win.webContents.capturePage()).toPNG());
    // Settings > Display: the lyrics size slider changes the size at once and is remembered.
    await run(win, "document.querySelector('#np-back').click()");
    await run(win, "document.querySelector('[data-page=settings]').click()");
    await run(win, "document.querySelector('[data-settings-section=display]').click()");
    await wait(500);
    await run(win, "(() => { const s = document.querySelector('#display-lyrics-size'); s.value = '3'; s.dispatchEvent(new Event('input')); s.dispatchEvent(new Event('change')); })()");
    await wait(300);
    console.log("slider at +3:", await run(win, "JSON.stringify({ scale: document.documentElement.style.getPropertyValue('--np-lyric-scale'), saved: JSON.parse(localStorage.getItem('mediaverse.display')).lyricsSize, label: document.querySelector('.lyrics-size-row .field-hint:last-child').textContent })"));
    fs.writeFileSync(path.join(outputDir, "settings.png"), (await win.webContents.capturePage()).toPNG());
    console.log(ok ? "OK: the page stayed in place and the current line stayed in the middle" : "PROBLEM: see the lines above");
    if (!ok) process.exitCode = 1;
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
