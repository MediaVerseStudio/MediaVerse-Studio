const { app, BrowserWindow } = require("electron");
const fs = require("node:fs"); const os = require("node:os"); const path = require("node:path");
const library = path.resolve(process.argv[2] || "");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-lang-data-")));
require("../electron/main.js");
const wait = (ms) => new Promise((r) => setTimeout(r, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function waitFor(win, expr, ms, label) { const end = Date.now() + ms; while (Date.now() < end) { if (await run(win, expr)) return; await wait(300); } throw new Error("Timed out: " + label); }
app.whenReady().then(async () => {
  try {
    let win; for (let i = 0; i < 100 && !win; i++) { win = BrowserWindow.getAllWindows()[0]; await wait(100); }
    win.setSize(1250, 900); await wait(2500);
    await run(win, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} }).then(() => 1)`);
    await run(win, "document.querySelector('#rescan-collection').click()");
    await run(win, "document.querySelector('[data-page=settings]').click()");
    const tabs = () => run(win, "[...document.querySelectorAll('[data-settings-section]')].map((b) => b.textContent.trim()).join(', ')");
    console.log("default tabs:", await tabs());
    await run(win, "document.querySelector('[data-settings-section=language]').click()");
    console.log("language tab:", (await run(win, "document.querySelector('#settings-language').innerText")).split('\n').slice(0, 9).join(' | '));
    await run(win, "document.querySelector('input[name=language][value=en-GB]').click()"); await wait(600);
    console.log("en-GB tabs:", await tabs());
    await run(win, "document.querySelector('[data-settings-section=sound]').click()");
    console.log("en-GB sound:", (await run(win, "document.querySelector('#settings-sound h4').innerText")));
    await run(win, "document.querySelector('[data-settings-section=display]').click()");
    console.log("en-GB display mentions:", (await run(win, "document.querySelector('#settings-display').innerText")).match(/colou?r/gi)?.join(","));
    await run(win, "document.querySelector('[data-page=library]').click()");
    await waitFor(win, "document.querySelectorAll('.lib-artist').length >= 12", 60000, "artists");
    console.log("artist names untouched:", await run(win, "[...document.querySelectorAll('.lib-artist')].map((e) => e.textContent.trim().split('\\n')[0]).filter((n) => /Harbor|Harbour/.test(n)).join(',')"));
    await run(win, "document.querySelector('[data-page=settings]').click()");
    await run(win, "document.querySelector('[data-settings-section=language]').click()");
    await run(win, "document.querySelector('input[name=language][value=en-CA]').click()"); await wait(500);
    console.log("en-CA tabs:", await tabs());
    await run(win, "document.querySelector('input[name=language][value=en-US]').click()"); await wait(500);
    console.log("en-US tabs:", await tabs());
    // organise choices
    await run(win, "document.querySelector('[data-settings-section=organize]').click()");
    await run(win, "(() => { const s = document.querySelector('#settings-organize select'); s.value = 'space'; s.dispatchEvent(new Event('change')); })()");
    await run(win, "[...document.querySelectorAll('#settings-organize button')].find((b) => b.textContent === 'Preview').click()");
    await waitFor(win, "document.querySelectorAll('#settings-organize details').length > 0", 60000, "preview");
    console.log("organise (space rule):", (await run(win, "document.querySelector('#settings-organize .field .field-hint:last-of-type, #settings-organize p.field-hint:nth-of-type(3)')?.textContent")), "|", (await run(win, "[...document.querySelectorAll('#settings-organize details summary')].map((s) => s.textContent).join(' | ')")));
    console.log("status:", await run(win, "[...document.querySelectorAll('#settings-organize .field-hint')].map((p) => p.textContent).find((t) => /songs read/.test(t))"));
  } catch (e) { console.error("failed:", e.message); process.exitCode = 1; } finally { app.quit(); }
});
