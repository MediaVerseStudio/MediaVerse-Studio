// Development aid: drives the real Electron app through the Drive setup screen and saves
// screenshots, so the UI can be checked without clicking through it by hand.
//
// Needs: `npm run build`, `npm run sidecar:build`, the CD helper (tools/build-cd-helper.ps1), and
// an audio CD in the drive. Run: npx electron scripts/capture-drive-setup.cjs <output-dir>
// It uses a throwaway data directory, so your real library and drive profiles are untouched.
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mediaverse-capture"));
fs.mkdirSync(outputDir, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-data-"));
app.setPath("userData", dataDir);

require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function window() {
  const { BrowserWindow } = require("electron");
  for (let i = 0; i < 100; i++) {
    const [first] = BrowserWindow.getAllWindows();
    if (first) return first;
    await wait(100);
  }
  throw new Error("No window appeared.");
}

async function shot(win, name) {
  const image = await win.webContents.capturePage();
  const file = path.join(outputDir, `${name}.png`);
  fs.writeFileSync(file, image.toPNG());
  console.log(`saved ${file}`);
}

const run = (win, code) => win.webContents.executeJavaScript(code);

async function waitFor(win, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await run(win, expression)) return;
    await wait(250);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

app.whenReady().then(async () => {
  try {
    const win = await window();
    win.setSize(1180, 900);
    win.show();
    win.focus();
    await waitFor(win, "document.readyState === 'complete'", 15000, "page load");
    await wait(1500);

    await run(win, "document.querySelector('[data-page=drives]').click()");
    await waitFor(win, "document.querySelectorAll('.drive-card').length > 0", 15000, "the drive list");
    await shot(win, "1-drive-list");

    // Full run.
    await run(win, "document.querySelector('.drive-card button').click()");
    await waitFor(win, "!document.querySelector('#drive-progress').hidden", 10000, "progress box");
    await wait(9000);
    await shot(win, "2-in-progress");
    await waitFor(win, "!document.querySelector('#drive-result').hidden", 120000, "the result");
    await wait(1000);
    await shot(win, "3-finished");
    console.log("result:", await run(win, "document.querySelector('#drive-result').innerText"));
    console.log("card:", await run(win, "document.querySelector('.drive-facts').innerText"));

    // Cancelled run.
    await run(win, "document.querySelector('.drive-card button').click()");
    await waitFor(win, "!document.querySelector('#drive-cancel').disabled", 10000, "the cancel button");
    await wait(4000);
    await run(win, "document.querySelector('#drive-cancel').click()");
    await waitFor(win, "document.querySelector('#drive-result').innerText.includes('cancelled')", 30000, "cancellation");
    await wait(500);
    await shot(win, "4-cancelled");
    console.log("cancel result:", await run(win, "document.querySelector('#drive-result').innerText"));
    console.log("status:", await run(win, "document.querySelector('#drives-status').innerText"));
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});

