// Development aid: starts the real app with throwaway data, measures a small library and checks the levelling gains (never negative), the Sound page's
// "Let every device hear the levelling" section, and that the sidecar answers a gain request while a slow request is still being worked on. Run:
//   npx electron scripts/check-levelling.cjs <library-folder>
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");
const library = path.resolve(process.argv[2] || "");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-levelling-data-")));
require("../electron/main.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
const check = (ok, text) => { console.log(`${ok ? "PASS" : "FAIL"}  ${text}`); if (!ok) process.exitCode = 1; };
app.whenReady().then(async () => {
  try {
    let win; for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; await wait(100); }
    await wait(2500);
    await run(win, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} }).then(() => 1)`);
    await run(win, "document.querySelector('#rescan-collection').click()");
    await wait(3000);
    await run(win, "window.mediaVerse.invoke('scan_library_loudness').then(() => 1)");
    let status;
    for (let i = 0; i < 120; i++) { await wait(1000); status = await run(win, "window.mediaVerse.invoke('library_loudness_status').then((r) => r.result)"); if (!status.running && status.measured > 0) break; }
    console.log("status:", JSON.stringify(status));
    check(status.measured >= 1, `${status.measured} songs measured`);
    const songs = await run(win, "window.mediaVerse.invoke('collection_status').then((r) => r.result)");
    const paths = await run(win, "window.mediaVerse.invoke('list_tracks', {}).then((r) => (r.result.tracks || r.result).map((t) => t.source_uri)).catch((e) => [])");
    const gains = paths.length ? await run(win, `window.mediaVerse.invoke('loudness_gains', { paths: ${JSON.stringify(paths.slice(0, 50))} }).then((r) => r.result.gains)`) : {};
    const values = Object.values(gains).map((g) => g.gain_db);
    console.log("gains:", JSON.stringify(values.slice(0, 8)));
    check(values.every((g) => g >= 0), "no gain is below zero (nothing is turned down)");
    // A slow request must not hold up a gain request.
    const timing = await run(win, `(async () => {
      const slow = window.mediaVerse.invoke('library_gaps', {});
      const t0 = performance.now();
      await window.mediaVerse.invoke('loudness_gains', { paths: ${JSON.stringify(paths.slice(0, 3))} });
      return Math.round(performance.now() - t0);
    })()`);
    console.log("gain answered in", timing, "ms while library_gaps was running");
    check(timing < 1500, "a gain request is answered promptly while a bulk request runs");
    await run(win, "document.querySelector('[data-page=settings]').click()");
    await run(win, "document.querySelector('[data-settings-section=sound]').click()");
    await wait(1500);
    const text = await run(win, "document.querySelector('#settings-sound').innerText");
    check(/Let every device hear the levelling/.test(text), "the Sound page has the section for every device");
    console.log(text.split("\n").filter((l) => /songs|Nothing is measured|turned up/.test(l)).slice(0, 4).join("\n"));
  } catch (e) { console.error("failed:", e.message); process.exitCode = 1; } finally { app.quit(); }
});
