// Development aid: previews the organiser on a small library with conflicts and duplicates and checks the comparison tables. Run: npx electron scripts/check-organise-compare.cjs <library-folder>
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");
const library = path.resolve(process.argv[2] || "");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-organise-data-")));
require("../electron/main.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
app.whenReady().then(async () => {
  try {
    let win; for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; await wait(100); }
    await wait(2500);
    await run(win, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} }).then(() => 1)`);
    await run(win, "document.querySelector('#rescan-collection').click()");
    await run(win, "document.querySelector('[data-page=settings]').click()");
    await run(win, "document.querySelector('[data-settings-section=organize]').click()");
    await run(win, "[...document.querySelectorAll('#settings-organize button')].find((b) => b.textContent === 'Preview').click()");
    for (let i = 0; i < 120; i++) { await wait(500); if (await run(win, "document.querySelectorAll('#settings-organize details').length > 0")) break; }
    await wait(500);
    console.log(await run(win, "document.querySelector('#settings-organize').innerText.slice(0, 2500)"));
    const tables = await run(win, "document.querySelectorAll('#settings-organize .organize-compare').length");
    const buttons = await run(win, "[...document.querySelectorAll('#settings-organize .organize-compare button')].filter((b) => b.textContent === 'Show in folder').length");
    const dupSummary = await run(win, "[...document.querySelectorAll('#settings-organize summary')].map((s) => s.textContent).join(' | ')");
    console.log("TABLES", tables, "BUTTONS", buttons);
    console.log("SUMMARIES", dupSummary);
    const selects = await run(win, "document.querySelectorAll('#settings-organize select').length");
    console.log("SELECTS (only the naming rule now):", selects);
  } catch (e) { console.error("failed:", e.message); process.exitCode = 1; } finally { app.quit(); }
});
