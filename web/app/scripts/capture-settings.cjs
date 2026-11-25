// Development aid: drives the real Electron app through the Settings page and saves screenshots.
// Uses a throwaway data directory (your real settings are untouched) and a made-up test key.
// Needs: `npm run build` and `npm run sidecar:build`. Run: npx electron scripts/capture-settings.cjs <dir>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mediaverse-capture"));
fs.mkdirSync(outputDir, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-settings-data-"));
app.setPath("userData", dataDir);

require("../electron/main.js");

const TEST_KEY = "TEST-KEY-NOT-REAL-12345";
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

const run = (win, code) => win.webContents.executeJavaScript(code);

async function shot(win, name) {
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, `${name}.png`), image.toPNG());
  console.log(`saved ${name}.png`);
}

async function waitFor(win, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await run(win, expression)) return;
    await wait(200);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}

/** Types into an input the way a user would, so the page's own handlers run. */
const type = (win, selector, value) =>
  run(win, `(() => { const i = document.querySelector(${JSON.stringify(selector)}); i.focus(); i.value = ${JSON.stringify(value)}; i.dispatchEvent(new Event('input', { bubbles: true })); })()`);

app.whenReady().then(async () => {
  try {
    const win = await window();
    win.setSize(1180, 1000);
    win.show();
    win.focus();
    await waitFor(win, "document.readyState === 'complete'", 15000, "page load");
    await wait(1500);

    await run(win, "document.querySelector('[data-page=settings]').click()");
    await waitFor(win, "document.querySelectorAll('#settings-form-body fieldset').length > 3", 15000, "the settings form");
    await shot(win, "s1-settings-top");
    console.log("setup notice:", await run(win, "document.querySelector('.setup-needed')?.innerText"));

    await run(win, "[...document.querySelectorAll('fieldset')].find((f) => f.querySelector('legend').innerText.startsWith('Your contact')).scrollIntoView()");
    await wait(300);
    await shot(win, "s4-identity");
    await run(win, "[...document.querySelectorAll('fieldset')].find((f) => f.querySelector('legend').innerText.startsWith('CDDB')).scrollIntoView()");
    await wait(300);
    await shot(win, "s5-servers");

    // Enter contact details and a made-up AcoustID key through the page, then save.
    await type(win, "#settings-form-body fieldset:nth-of-type(1) .field:nth-of-type(1) input", "tester@example.invalid");
    await run(win, "[...document.querySelectorAll('.secret-field button')].find((b) => b.textContent === 'Enter').click()");
    await wait(300);
    await type(win, ".secret-row input[type=password]", TEST_KEY);
    await run(win, "[...document.querySelectorAll('#settings-form-body input[type=checkbox]')].find((c) => c.closest('label').innerText.includes('Use AcoustID')).click()");
    await run(win, "document.querySelector('#settings-save').click()");
    await waitFor(win, "document.querySelector('#settings-status').innerText.includes('saved')", 10000, "the save");
    console.log("status after save:", await run(win, "document.querySelector('#settings-status').innerText"));

    const pageText = await run(win, "document.body.innerText + [...document.querySelectorAll('input')].map((i) => i.value).join(' ')");
    console.log("key visible anywhere on the page after saving:", pageText.includes(TEST_KEY));
    console.log("acoustid key status:", await run(win, "document.querySelector('.secret-field .secret-status').innerText"));
    await run(win, "[...document.querySelectorAll('fieldset')].find((f) => f.querySelector('legend').innerText === 'AcoustID').scrollIntoView()");
    await wait(300);
    await shot(win, "s2-after-save");

    // Reload the page's data from the sidecar: the key is remembered, still never shown.
    await run(win, "document.querySelector('#settings-reload').click()");
    await wait(800);
    console.log("after reload, key status:", await run(win, "[...document.querySelectorAll('.secret-status')][0].innerText"));
    console.log("after reload, key visible:", (await run(win, "document.body.innerText + [...document.querySelectorAll('input')].map((i) => i.value).join(' ')")).includes(TEST_KEY));

    // Add a server, give it a bad port, and try to save.
    await run(win, "[...document.querySelectorAll('button')].find((b) => b.textContent === 'Add a server').click()");
    await wait(300);
    await run(win, "(() => { const cards = document.querySelectorAll('.server-card'); const card = cards[cards.length - 1]; const inputs = card.querySelectorAll('input[type=number]'); inputs[0].value = '0'; inputs[0].dispatchEvent(new Event('input', { bubbles: true })); })()");
    await run(win, "document.querySelector('#settings-save').click()");
    await waitFor(win, "!document.querySelector('#settings-problems').hidden", 10000, "the problems list");
    console.log("problems:", await run(win, "document.querySelector('#settings-problems').innerText"));
    await shot(win, "s3-problems");
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
