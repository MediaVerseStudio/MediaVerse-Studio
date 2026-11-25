// Development aid: Review > Missing artwork and the Album pictures dialog, in the real app on a COPY of a data
// folder (so a running copy is not disturbed). Saves screenshots of the compact list and of the dialog for the
// first album, and runs the online cover search for it (MusicBrainz, then Discogs) reporting what came back.
// Nothing is saved to any file and no browser is opened: the dialog is closed without saving.
// Build first: npm run build. Run: npx electron scripts/capture-artwork.cjs <data-folder-copy> <output-dir>
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const dataDir = path.resolve(process.argv[2] || "");
const outputDir = path.resolve(process.argv[3] || ".");
fs.mkdirSync(outputDir, { recursive: true });
app.setPath("userData", dataDir);
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function firstWindow() {
  for (let i = 0; i < 100; i++) {
    const [first] = BrowserWindow.getAllWindows();
    if (first) return first;
    await wait(100);
  }
  throw new Error("No window appeared.");
}
async function waitFor(win, test, ms) {
  for (let waited = 0; waited < ms; waited += 250) {
    if (await run(win, test)) return true;
    await wait(250);
  }
  return false;
}
async function shot(win, name) {
  await wait(600);
  fs.writeFileSync(path.join(outputDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  console.log("saved", name);
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
    const win = await firstWindow();
    win.setSize(1500, 1100);
    await wait(4000);
    await run(win, "document.querySelector('[data-page=review]').click()");
    await wait(600);
    let t = Date.now();
    await run(win, "document.querySelector('[data-review=artwork]').click()");
    await waitFor(win, "!!document.querySelector('#review-panel-artwork .gap-table') || /Every album/.test(document.querySelector('#review-panel-artwork').textContent)", 120000);
    console.log(`artwork list ready in ${Date.now() - t} ms:`, await run(win, "document.querySelector('#review-panel-artwork p:nth-of-type(2)')?.textContent"));
    console.log("first rows:", await run(win, "[...document.querySelectorAll('#review-panel-artwork tbody tr')].slice(0, 4).map((r) => [...r.cells].slice(0, 4).map((c) => c.textContent).join(' | ')).join(' / ')"));
    await shot(win, "01-missing-artwork");
    console.log("views:", await run(win, "[...document.querySelectorAll('#review-panel-artwork .view-links button')].map((b) => b.textContent).join(' | ')"));
    const view = (label) => run(win, `[...document.querySelectorAll('#review-panel-artwork .view-links button')].find((b) => b.textContent.startsWith(${JSON.stringify(label)}))?.click()`);
    const rows = () => run(win, "[...document.querySelectorAll('#review-panel-artwork tbody tr')].slice(0, 5).map((r) => [...r.cells].slice(0, -1).map((c) => c.textContent).join(' | ')).join('\\n    ')");
    await view("Low resolution");
    await wait(500);
    console.log("low resolution (500):\n    " + (await rows()));
    await shot(win, "01b-low-500");
    await run(win, "(() => { const s = document.querySelector('#review-panel-artwork select'); s.value = '1000'; s.dispatchEvent(new Event('change')); })()");
    await wait(500);
    console.log("low resolution (1000):", await run(win, "[...document.querySelectorAll('#review-panel-artwork .view-links button')].map((b) => b.textContent).join(' | ')"));
    await run(win, "(() => { const s = document.querySelector('#review-panel-artwork select'); s.value = '500'; s.dispatchEvent(new Event('change')); })()");
    await view("Oversized");
    await wait(500);
    console.log("oversized groups:", await run(win, "[...document.querySelectorAll('#review-panel-artwork .gap-group-head h3')].map((h) => h.textContent).join(' | ')"));
    console.log("find-a-better-cover buttons:", await run(win, "[...document.querySelectorAll('#review-panel-artwork button')].filter((b) => b.textContent === 'Find a better cover').length"));
    await shot(win, "01c-oversized");
    await view("Missing");
    await wait(500);

    await run(win, "document.querySelector('#review-panel-artwork tbody button')?.click()");
    await waitFor(win, "document.querySelectorAll('#media-slots .picture-slot').length === 3", 10000);
    await wait(1500);
    console.log("slots:", await run(win, "[...document.querySelectorAll('#media-slots .picture-slot')].map((s) => s.querySelector('strong').textContent + ': ' + s.querySelector('.slot-size').textContent + ' [' + [...s.querySelectorAll('button')].map((b) => b.textContent).join(', ') + ']').join(' / ')"));
    await shot(win, "02-album-pictures");

    // The online search for the same album, as the dialog would ask it (the browser is not opened here).
    const wanted = await run(win, "(() => { const r = document.querySelector('#review-panel-artwork tbody tr'); return { album: r.cells[0].textContent, artist: r.cells[1].textContent, year: Number(r.cells[2].textContent) || undefined, tracks: Number(r.cells[3].textContent) }; })()");
    t = Date.now();
    const found = await job(win, "find_album_art", wanted);
    if (!found.ok) console.log("find_album_art failed:", found.error);
    else {
      const r = found.result;
      console.log(`find_album_art for ${JSON.stringify(wanted)} in ${Date.now() - t} ms: best ${r.best_match}% (sure at ${r.sure_match}), ${r.candidates.length} covers, discogs: ${r.discogs ? r.discogs.url : "none"}`);
      for (const c of r.candidates) console.log(`  ${c.match}% ${c.title} · ${c.artist} · ${c.date} · ${c.country} · ${c.tracks} tracks`);
      for (const p of r.problems) console.log(`  problem: ${p.source}: ${p.message}`);
    }
    // The dialog's own search: Cover database search, then Approve (fills the squares; nothing is saved), then
    // Undo and Exit. Only when the first result is a sure match, so no browser search is opened.
    if (found.ok && found.result.best_match >= found.result.sure_match) {
      await run(win, "document.querySelector('#media-find-art').click()");
      await waitFor(win, "[...document.querySelectorAll('#media-art-results button')].some((b) => b.textContent === 'Approve')", 30000);
      await run(win, "[...document.querySelectorAll('#media-art-results button')].find((b) => b.textContent === 'Approve').click()");
      await waitFor(win, "document.querySelectorAll('#media-slots .picture-slot.is-changed').length > 0", 30000);
      await wait(800);
      console.log("after Approve:", await run(win, "[...document.querySelectorAll('#media-slots .picture-slot')].map((s) => s.querySelector('strong').textContent + ': ' + s.querySelector('.slot-size').textContent).join(' / ')"));
      console.log("status:", await run(win, "document.querySelector('#media-status').textContent"));
      console.log("footer:", await run(win, "[...document.querySelectorAll('#media-dialog .media-foot button')].filter((b) => !b.hidden).map((b) => b.textContent).join(' | ')"));
      await shot(win, "03-approved");
      await run(win, "document.querySelector('#media-discard-pictures').click()");
      await wait(500);
      console.log("dialog open after Undo and Exit:", await run(win, "document.querySelector('#media-dialog').open"));
    } else {
      await run(win, "document.querySelector('#media-dialog').close()"); // closed without saving
    }
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
