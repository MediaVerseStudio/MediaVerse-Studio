// Development aid: like capture-setup.cjs, but goes through the Getting Started buttons themselves. The
// native folder dialog is replaced by a stub that answers with a prepared folder, so the page's own code
// path (button, dialog, import, re-render) is what runs. Run: npx electron scripts/capture-setup-buttons.cjs <output-dir>
const { app, dialog } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mediaverse-capture-setup-buttons"));
fs.mkdirSync(outputDir, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-setup-buttons-"));
const musicFolder = path.join(base, "Music");
fs.mkdirSync(musicFolder);
app.setPath("userData", path.join(base, "data"));
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [musicFolder] });
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
const call = (win, command, args) => run(win, `window.mediaVerse.invoke(${JSON.stringify(command)}, ${JSON.stringify(args ?? {})}).then((r) => JSON.stringify(r))`);
async function window() {
  const { BrowserWindow } = require("electron");
  for (let i = 0; i < 100; i++) { const [first] = BrowserWindow.getAllWindows(); if (first) return first; await wait(100); }
  throw new Error("No window appeared.");
}
const box = (win) => run(win, "(() => { const b = document.querySelector('#home-setup'); return b.hidden ? '(hidden)' : b.innerText.replace(/\\n+/g, ' | ').slice(0, 400); })()");
const clickButton = (win, text) => run(win, `(() => { const b = [...document.querySelectorAll('#home-setup button')].find((x) => x.textContent.startsWith(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`);

app.whenReady().then(async () => {
  try {
    const win = await window();
    win.setSize(1280, 1000);
    win.show();
    await wait(2500);
    console.log("fresh box:", await box(win));
    console.log("clicked library 'Choose an existing folder':", await clickButton(win, "Choose an existing folder"));
    await wait(2500);
    console.log("after choosing the library:", await box(win));
    console.log("collection_status:", (await call(win, "collection_status")).slice(0, 300));
    console.log("get_archive_settings:", (await call(win, "get_archive_settings")).slice(0, 300));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outputDir, "after-library.png"), image.toPNG());
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
