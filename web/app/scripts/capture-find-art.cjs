// Development aid: finding album artwork online, in the real app and against the real services (MusicBrainz
// and the Cover Art Archive, the same ones ripping uses). Asks for one album, fetches the chosen cover, and
// drives the Pictures dialog of an album in the library: Find the cover online, choose the first, check the
// preview. Closes the dialog WITHOUT saving. Run: npx electron scripts/capture-find-art.cjs <out> <music> <artist> <album>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const [outputArg, music, artist, album] = process.argv.slice(2);
const outputDir = path.resolve(outputArg || path.join(os.tmpdir(), "mediaverse-capture-find-art"));
fs.mkdirSync(outputDir, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-find-art-"));
app.setPath("userData", path.join(base, "data"));
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function window() {
  const { BrowserWindow } = require("electron");
  for (let i = 0; i < 100; i++) { const [first] = BrowserWindow.getAllWindows(); if (first) return first; await wait(100); }
  throw new Error("No window appeared.");
}
/** Runs a sidecar job from the page and returns its finished payload. */
const job = (win, command, args) =>
  run(win, `new Promise((done) => {
    let id = null; const early = [];
    window.mediaVerse.listen("job-finished", (e) => { if (id === null) early.push(e.payload); else if (e.payload.job_id === id) done(JSON.stringify(e.payload)); });
    window.mediaVerse.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)}).then((r) => { id = r.result.job_id; const hit = early.find((p) => p.job_id === id); if (hit) done(JSON.stringify(hit)); });
  })`).then(JSON.parse);

app.whenReady().then(async () => {
  try {
    const win = await window();
    win.setSize(1500, 1000);
    win.show();
    await wait(2000);
    await run(win, `window.mediaVerse.invoke("import_collection", { root: ${JSON.stringify(music)} }).then(() => true)`);
    let t = Date.now();
    const found = await job(win, "find_album_art", { artist, album });
    if (!found.ok) throw new Error(`find_album_art failed: ${found.error.code} ${found.error.message}`);
    console.log(`find_album_art: ${found.result.candidates.length} candidates in ${Date.now() - t} ms`);
    for (const c of found.result.candidates) console.log(`  ${c.title} · ${c.artist} · ${c.date} · ${c.country} (preview ${Math.round(c.preview_base64.length * 0.75 / 1024)} KB)`);
    if (found.result.candidates.length > 0) {
      t = Date.now();
      const full = await job(win, "fetch_album_art", { release_id: found.result.candidates[0].release_id });
      console.log(full.ok ? `fetch_album_art: ${full.result.width}x${full.result.height} ${full.result.mime}, ${Math.round(full.result.data_base64.length * 0.75 / 1024)} KB in ${Date.now() - t} ms` : `fetch_album_art failed: ${full.error.message}`);
    }
    // The dialog, from the artist page's Album pictures button.
    await run(win, "localStorage.setItem('mediaverse.welcome-seen', '1'); location.reload()");
    await wait(4000);
    await run(win, "document.querySelector('[data-page=library]').click()");
    await wait(800);
    await run(win, `(() => { const f = document.querySelector('.artist-find'); f.value = ${JSON.stringify(artist)}; f.dispatchEvent(new Event('input')); })()`);
    await wait(300);
    const openedArtist = await run(win, `(() => { const b = [...document.querySelectorAll('.artist-card')].find((x) => x.textContent.includes(${JSON.stringify(artist)})); if (!b) return false; b.click(); return true; })()`);
    await wait(1200);
    const openedDialog = await run(win, "(() => { const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent && x.textContent.trim() === 'Album pictures…'); if (!b) return false; b.click(); return true; })()");
    console.log("opened artist:", openedArtist, "opened album pictures:", openedDialog);
    await wait(500);
    console.log("find button shown:", await run(win, "!document.querySelector('#media-find-art-box').hidden"));
    await run(win, "document.querySelector('#media-find-art').click()");
    for (let i = 0; i < 60; i += 1) {
      if (await run(win, "document.querySelectorAll('#media-art-results .art-choice').length > 0 || /No front cover|could not|limiting/i.test(document.querySelector('#media-find-art-note').textContent)")) break;
      await wait(500);
    }
    console.log("dialog note:", await run(win, "document.querySelector('#media-find-art-note').textContent"));
    await run(win, "document.querySelector('#media-art-results .art-choice')?.click()");
    for (let i = 0; i < 60; i += 1) {
      if (await run(win, "!document.querySelector('#media-preview').hidden")) break;
      await wait(500);
    }
    console.log("preview shown:", await run(win, "!document.querySelector('#media-preview').hidden"), "|", await run(win, "document.querySelector('#media-preview-note').textContent"), "|", await run(win, "document.querySelector('#media-status').textContent"));
    console.log("save enabled (not pressed):", await run(win, "!document.querySelector('#media-save-picture').disabled"));
    fs.writeFileSync(path.join(outputDir, "find-art.png"), (await win.webContents.capturePage()).toPNG());
    await run(win, "document.querySelector('#media-dialog').close()"); // closed without saving
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
