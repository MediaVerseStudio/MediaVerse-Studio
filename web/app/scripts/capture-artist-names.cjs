// Development aid: in the real app, tags two songs of one band with two spellings ("AFI", "A.F.I."), opens Review > Artists, picks the
// spelling that is not suggested, presses "Use", and checks that the name is gone from the list within a moment (it was not: the list
// was drawn from the library before the background scan had read the new tags, so it took several clicks), and that the tags changed.
// Run: npx electron scripts/capture-artist-names.cjs <library-folder with two mp3 files> <output-dir>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const source = path.resolve(process.argv[2] || "");
const outputDir = path.resolve(process.argv[3] || path.join(os.tmpdir(), "mediaverse-capture-artist-names"));
fs.mkdirSync(outputDir, { recursive: true });
const library = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-names-lib-"));
fs.cpSync(source, library, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-names-data-")));
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
  while (Date.now() < deadline) { if (await run(win, expression)) return; await wait(100); }
  throw new Error(`Timed out waiting for ${label}.`);
}
const mp3s = (dir) => fs.readdirSync(dir, { recursive: true }).map((f) => path.join(dir, f.toString())).filter((f) => f.toLowerCase().endsWith(".mp3"));
app.whenReady().then(async () => {
  try {
    const win = await window();
    win.setSize(1360, 900);
    win.show();
    await waitFor(win, "document.readyState === 'complete'", 15000, "page load");
    await wait(800);
    await run(win, "[...document.querySelectorAll('a, button')].find((x) => /^Later/.test(x.textContent.trim()))?.click()");
    const [one, two] = mp3s(library);
    await run(win, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} })`);
    for (const [file, name] of [[one, "AFI"], [two, "A.F.I."]]) {
      await run(win, `window.mediaVerse.invoke('write_track_tags', { request: { source_uri: ${JSON.stringify(file)}, artist: ${JSON.stringify(name)}, album_artist: ${JSON.stringify(name)}, album: 'Test', title: 'Song ${name}', genre: null, release_year: null, track_number: 1, album_artist_unused: null } })`).catch((e) => console.log("tag write:", e?.message ?? e));
    }
    await run(win, "document.querySelector('#rescan-collection')?.click()");
    await wait(1500);
    await run(win, "document.querySelector('[data-page=review]').click()");
    await wait(300);
    await run(win, "[...document.querySelectorAll('.subnav-button, .subnav button')].find((b) => /artists/i.test(b.textContent))?.click()");
    await waitFor(win, "document.querySelector('.artist-name-group')", 8000, "the artist name card");
    console.log("card before:", await run(win, "document.querySelector('.artist-name-group').innerText.replace(/\\n/g, ' | ')"));
    // pick the spelling that is not suggested, and press Use; confirm() would block the test, so it is answered yes
    await run(win, "void (window.confirm = () => true)");
    await run(win, "(() => { const radios = [...document.querySelectorAll('.artist-name-group input[type=radio]')]; const other = radios.find((r) => !r.checked); other.checked = true; other.dispatchEvent(new Event('change')); })()");
    const chosenLabel = await run(win, "[...document.querySelectorAll('.artist-name-group > button')].map((b) => b.textContent).join(' / ')");
    console.log("buttons:", chosenLabel);
    const started = Date.now();
    await run(win, "[...document.querySelectorAll('.artist-name-group button')].find((b) => /^Use/.test(b.textContent)).click()");
    await waitFor(win, "!document.querySelector('.artist-name-group')", 6000, "the name to leave the list");
    console.log(`the name left the list ${Date.now() - started} ms after one click`);
    console.log("note:", await run(win, "document.querySelector('.artists-panel .ft-report')?.innerText.replace(/\\n/g, ' ')"));
    const tags = [];
    for (const file of [one, two]) tags.push(await run(win, `window.mediaVerse.invoke('track_tags', { path: ${JSON.stringify(file)} }).then((r) => JSON.stringify(r).slice(0, 120)).catch(() => 'n/a')`));
    console.log("still listed after another second:", await run(win, "(async () => { await new Promise((r) => setTimeout(r, 1200)); return !!document.querySelector('.artist-name-group'); })()"));
    fs.writeFileSync(path.join(outputDir, "names.png"), (await win.webContents.capturePage()).toPNG());
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
