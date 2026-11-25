// Development aid for D32: the first-run welcome. Fresh data folder; the folder window is stubbed to answer
// with a prepared folder. Goes through "set it up now" with the page's own buttons, checks the welcome closes
// when all three steps are done, then reloads to check it does not come back.
// Run: npx electron scripts/capture-welcome.cjs <output-dir>
const { app, dialog } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mediaverse-capture-welcome"));
fs.mkdirSync(outputDir, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-welcome-"));
const musicFolder = path.join(base, "Music");
fs.mkdirSync(musicFolder);
app.setPath("userData", path.join(base, "data"));
dialog.showOpenDialog = async () => ({ canceled: false, filePaths: [musicFolder] });
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function window() {
  const { BrowserWindow } = require("electron");
  for (let i = 0; i < 100; i++) { const [first] = BrowserWindow.getAllWindows(); if (first) return first; await wait(100); }
  throw new Error("No window appeared.");
}
async function shot(win, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, `${name}.png`), image.toPNG());
  console.log("saved", name);
}
const welcomeOpen = (win) => run(win, "!!document.querySelector('.welcome')");
const click = (win, selector, text) => run(win, `(() => { const b = [...document.querySelectorAll(${JSON.stringify(selector)})].find((x) => x.textContent.trim().startsWith(${JSON.stringify(text)})); if (!b) return false; b.click(); return true; })()`);

app.whenReady().then(async () => {
  try {
    const win = await window();
    win.setSize(1400, 950);
    win.show();
    await wait(2500);
    console.log("welcome shown on first run:", await welcomeOpen(win));
    await shot(win, "1-welcome");
    console.log("pressed Set it up now:", await click(win, ".welcome button", "Set it up now"));
    await wait(800);
    await shot(win, "2-steps");
    console.log("library:", await click(win, ".welcome button", "Choose an existing folder"));
    await wait(2000);
    console.log("chose No FLAC:", await run(win, "(() => { const r = [...document.querySelectorAll('.welcome input[type=radio]')][1]; if (!r) return false; r.click(); return true; })()"));
    await wait(1500);
    await run(win, "(() => { const i = document.querySelector('.welcome input[type=email]'); i.value = 'tester@example.com'; i.form.requestSubmit(); })()");
    await wait(2000);
    console.log("welcome still open after all three steps:", await welcomeOpen(win));
    console.log("Home's Getting Started box hidden:", await run(win, "document.querySelector('#home-setup').hidden"));
    await shot(win, "3-after");
    await run(win, "location.reload()");
    await wait(2500);
    console.log("welcome shown after a restart:", await welcomeOpen(win));
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
