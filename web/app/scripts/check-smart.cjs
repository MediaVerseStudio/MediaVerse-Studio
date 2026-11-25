const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");
const library = path.resolve(process.argv[2] || "");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-smart-data-")));
require("../electron/main.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function waitFor(win, expr, ms, label) { const end = Date.now() + ms; while (Date.now() < end) { if (await run(win, expr)) return; await wait(200); } throw new Error("Timed out: " + label); }
app.whenReady().then(async () => {
  try {
    let win; for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; await wait(100); }
    win.setSize(1250, 900); await wait(2500);
    await run(win, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} }).then(() => 1)`);
    await run(win, "document.querySelector('#rescan-collection').click()");
    await run(win, "document.querySelector('[data-page=library]').click()");
    await waitFor(win, "document.querySelectorAll('.lib-artist').length >= 12", 60000, "artists");
    // smart playlist
    await run(win, "[...document.querySelectorAll('.lib-pivot')].find((b) => b.textContent.trim().startsWith('playlists'))?.click()");
    await waitFor(win, "[...document.querySelectorAll('button')].some((b) => b.textContent.includes('New smart playlist'))", 8000, "the smart button");
    await run(win, "[...document.querySelectorAll('button')].find((b) => b.textContent.includes('New smart playlist')).click()");
    await waitFor(win, "document.querySelector('.smart-pane')", 5000, "the smart pane");
    await run(win, "document.querySelector('.smart-pane .settings-actions') && [...document.querySelectorAll('.smart-rules button')].find((b) => b.textContent === 'Add a rule').click()");
    await run(win, "(() => { const row = document.querySelector('.smart-rule'); const sel = row.querySelectorAll('select'); sel[0].value = 'year'; sel[0].dispatchEvent(new Event('change')); })()");
    await run(win, "(() => { const row = document.querySelector('.smart-rule'); const sel = row.querySelectorAll('select'); sel[1].value = 'gt'; sel[1].dispatchEvent(new Event('change')); const v = row.querySelector('input'); v.value = '2015'; v.dispatchEvent(new Event('input')); v.dispatchEvent(new Event('change')); })()");
    await wait(1500);
    console.log("smart summary:", await run(win, "document.querySelector('.smart-pane .field-hint')?.textContent"));
    console.log("smart rows:", await run(win, "document.querySelectorAll('.smart-results tbody tr').length"));
    fs.writeFileSync(path.join(os.tmpdir(), "smart.png"), (await win.webContents.capturePage()).toPNG());
    // Auto-DJ
    await run(win, "localStorage.setItem('mediaverse.auto-dj.v1', 'on')");
    await run(win, "document.querySelector('[data-page=library]').click()");
    await run(win, "[...document.querySelectorAll('.lib-pivot')].find((b) => b.textContent.trim().startsWith('artists'))?.click()");
    await wait(500);
    await run(win, "[...document.querySelectorAll('.lib-artist')].find((e) => e.textContent.trim().startsWith('Copper Lantern')).click()");
    await waitFor(win, "document.querySelectorAll('#artist-page tr[data-path]').length > 5", 10000, "artist page");
    await run(win, "document.querySelector('#artist-page tr[data-path]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
    await waitFor(win, "document.querySelector('#player-audio').currentTime > 0.3", 20000, "playback");
    await run(win, "document.querySelectorAll('audio').forEach((a) => { a.muted = true; })");
    console.log("before:", await run(win, "document.querySelector('#player-detail').textContent"));
    for (let i = 0; i < 40; i++) { const more = await run(win, "(() => { const b = document.querySelector('#player-next'); if (b.disabled) return false; b.click(); return true; })()"); await wait(250); if (!more) break; }
    await wait(1500);
    console.log("after:", await run(win, "document.querySelector('#player-detail').textContent"), "next enabled:", await run(win, "!document.querySelector('#player-next').disabled"));
  } catch (e) { console.error("failed:", e.message); process.exitCode = 1; } finally { app.quit(); }
});
