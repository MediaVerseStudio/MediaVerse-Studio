// Development aid: starts the real app with an empty data folder, shows the Getting Started box, completes
// its steps (the folder dialogs are replaced by direct commands; the email and the archive choice are
// done through the page), and checks that the box goes away. Run: npx electron scripts/capture-setup.cjs <output-dir>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mediaverse-capture-setup"));
fs.mkdirSync(outputDir, { recursive: true });
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-setup-"));
app.setPath("userData", path.join(base, "data"));
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
const call = (win, command, args) => run(win, `window.mediaVerse.invoke(${JSON.stringify(command)}, ${JSON.stringify(args ?? {})}).then((r) => JSON.stringify(r))`);
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
const box = (win) => run(win, "(() => { const b = document.querySelector('#home-setup'); return b.hidden ? '(hidden)' : b.innerText.replace(/\\n+/g, ' | ').slice(0, 260); })()");

app.whenReady().then(async () => {
  try {
    const win = await window();
    win.setSize(1280, 1000);
    win.show();
    await wait(2500);
    console.log("fresh box:", await box(win));
    await shot(win, "1-getting-started");

    // Library: make a new folder and use it.
    const made = JSON.parse(await call(win, "create_folder", { parent: base, name: "My Music" })).result;
    await call(win, "import_collection", { root: made.path });
    // Archive: say no through the page.
    await run(win, "document.querySelector('[data-page=library]').click(); document.querySelector('[data-page=home]').click()");
    await wait(1500);
    await run(win, "[...document.querySelectorAll('#home-setup input[type=radio]')][1].click()");
    await wait(1500);
    console.log("after library and 'No FLAC':", await box(win));
    // Email through the page: a bad one, then a good one.
    await run(win, "(() => { const i = document.querySelector('#home-setup input[type=email]'); i.value = 'not an email'; i.form.requestSubmit(); })()");
    await wait(800);
    console.log("bad email says:", await run(win, "document.querySelector('#home-setup .result-warning').textContent"));
    await run(win, "(() => { const i = document.querySelector('#home-setup input[type=email]'); i.value = 'tester@example.com'; i.form.requestSubmit(); })()");
    await wait(1500);
    console.log("after email:", await box(win));
    await shot(win, "2-done");
    console.log("settings now:", (await call(win, "get_archive_settings")).slice(0, 200));
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
