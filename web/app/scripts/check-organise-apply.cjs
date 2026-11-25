const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");
const library = path.resolve(process.argv[2] || "");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-org-data-")));
require("../electron/main.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function waitFor(win, expr, ms, label) { const end = Date.now() + ms; while (Date.now() < end) { if (await run(win, expr)) return; await wait(300); } throw new Error("Timed out: " + label); }
app.whenReady().then(async () => {
  try {
    let win; for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; await wait(100); }
    await wait(2500);
    const old = path.join(library, "misc", "paper_boats_final.mp3");
    await run(win, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} }).then(() => 1)`);
    await run(win, "document.querySelector('#rescan-collection').click()");
    await wait(2500);
    await run(win, `window.mediaVerse.invoke('set_favorite', { path: ${JSON.stringify(old)}, favorite: true }).then(() => 1)`);
    await run(win, `window.mediaVerse.invoke('save_playlist', { name: 'Test', paths: [${JSON.stringify(old)}] }).then(() => 1)`);
    await run(win, "document.querySelector('[data-page=settings]').click()");
    await run(win, "document.querySelector('[data-settings-section=organize]').click()");
    await run(win, "[...document.querySelectorAll('#settings-organize button')].find((b) => b.textContent === 'Preview').click()");
    await waitFor(win, "document.querySelectorAll('#settings-organize details').length > 0", 60000, "the preview");
    console.log("preview:", (await run(win, "document.querySelector('#settings-organize .organize-results').innerText")).split("\n").slice(0, 8).join(" | "));
    await run(win, "[...document.querySelectorAll('#settings-organize button')].find((b) => b.textContent.startsWith('Make these')).click()");
    await run(win, "[...document.querySelectorAll('#settings-organize button')].find((b) => b.textContent.startsWith('Yes, move')).click()");
    await waitFor(win, "[...document.querySelectorAll('#settings-organize p')].some((p) => p.textContent.startsWith('Moved'))", 60000, "the result");
    console.log("result:", await run(win, "[...document.querySelectorAll('#settings-organize .organize-apply p, #settings-organize .organize-results p')].map((p) => p.textContent).join(' | ')"));
    const target = path.join(library, "Copper Lantern", "Night Ferry", "03 - Paper Boats.mp3");
    console.log("files:", JSON.stringify({ newSong: fs.existsSync(target), newLrc: fs.existsSync(target.replace(".mp3", ".lrc")), oldGone: !fs.existsSync(old), miscGone: !fs.existsSync(path.join(library, "misc")) }));
    const fav = await run(win, "window.mediaVerse.invoke('list_favorites').then((r) => JSON.stringify(r))");
    const pl = await run(win, "window.mediaVerse.invoke('list_playlists').then((r) => JSON.stringify(r))");
    console.log("favorites:", fav.includes("03 - Paper Boats"), "playlist:", pl.includes("03 - Paper Boats"));
    await waitFor(win, "[...document.querySelectorAll('#settings-organize button')].some((b) => b.textContent === 'Undo it')", 10000, "the undo button");
    await run(win, "[...document.querySelectorAll('#settings-organize button')].find((b) => b.textContent === 'Undo it').click()");
    await wait(3000);
    console.log("after undo:", JSON.stringify({ oldBack: fs.existsSync(old), lrcBack: fs.existsSync(old.replace(".mp3", ".lrc")), newGone: !fs.existsSync(target) }));
    const fav2 = await run(win, "window.mediaVerse.invoke('list_favorites').then((r) => JSON.stringify(r))");
    console.log("favorite back:", fav2.includes("paper_boats_final"));
  } catch (e) { console.error("failed:", e.message); process.exitCode = 1; } finally { app.quit(); }
});
