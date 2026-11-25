// Development aid for ADR 0008: the library-wide defect scan in the real app. Imports the folder given (read
// only), starts the scan from Review > Audio defects, leaves the page and comes back while it runs, lets it
// finish, then checks the paged list and Mark as good. Run: npx electron scripts/capture-library-scan.cjs <out> <music>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mediaverse-capture-library-scan"));
const music = process.argv[3];
fs.mkdirSync(outputDir, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-library-scan-"));
app.setPath("userData", path.join(base, "data"));
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function window() {
  const { BrowserWindow } = require("electron");
  for (let i = 0; i < 100; i++) { const [first] = BrowserWindow.getAllWindows(); if (first) return first; await wait(100); }
  throw new Error("No window appeared.");
}
async function shot(win, name) {
  fs.writeFileSync(path.join(outputDir, `${name}.png`), (await win.webContents.capturePage()).toPNG());
  console.log("saved", name);
}
const panelText = (win) => run(win, "document.querySelector('#review-defects, [data-review-panel=defects], .review-panel:not([hidden])')?.innerText.replace(/\\n+/g, ' | ').slice(0, 300) ?? '(none)'");
const click = (win, text) => run(win, `(() => { const b = [...document.querySelectorAll('button')].find((x) => x.offsetParent && x.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`);

app.whenReady().then(async () => {
  try {
    if (!music) throw new Error("Give the music folder as the second argument.");
    const win = await window();
    win.setSize(1500, 1000);
    win.show();
    await wait(2000);
    await run(win, `window.mediaVerse.invoke("import_collection", { root: ${JSON.stringify(music)} }).then(() => true)`);
    await run(win, "localStorage.setItem('mediaverse.welcome-seen', '1'); location.reload()");
    await wait(4000);
    await run(win, "document.querySelector('[data-page=review]').click()");
    await wait(400);
    await run(win, "document.querySelector('[data-review=defects]').click()");
    await wait(1500);
    console.log("before:", await panelText(win));
    console.log("pressed scan:", await click(win, "Scan the"));
    await wait(1500);
    console.log("running:", await panelText(win));
    await shot(win, "1-running");
    // Leave and come back: the page must find the running scan again.
    await run(win, "document.querySelector('[data-page=library]').click()");
    await wait(1500);
    await run(win, "document.querySelector('[data-page=review]').click()");
    await wait(300);
    await run(win, "document.querySelector('[data-review=defects]').click()");
    await wait(1200);
    console.log("after coming back:", await panelText(win));
    for (let i = 0; i < 240; i += 1) {
      const status = JSON.parse(await run(win, "window.mediaVerse.invoke('library_scan_status').then((r) => JSON.stringify(r.result))"));
      if (!status.running) break;
      await wait(1000);
    }
    await wait(1500);
    console.log("finished:", await panelText(win));
    console.log("cards listed:", await run(win, "document.querySelectorAll('.review-panel:not([hidden]) .review-card').length"));
    await shot(win, "2-finished");
    const more = await click(win, "Show ");
    await wait(1200);
    console.log("pressed Show more:", more, "cards now:", await run(win, "document.querySelectorAll('.review-panel:not([hidden]) .review-card').length"));
    console.log("marked one good:", await click(win, "✓ Mark as good"));
    await wait(1500);
    console.log("after marking:", (await panelText(win)).split(" | ")[1]);
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
