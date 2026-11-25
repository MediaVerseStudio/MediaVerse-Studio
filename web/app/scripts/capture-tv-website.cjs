// Development aid: TV app screenshots for the website with the made-up demo library (tools/make-demo-library.ps1).
// Pairs like capture-tv.cjs, then shows an album page, Now Playing and lyrics. Build first: npm run build && npm run tv:build
// Run: npx electron scripts/capture-tv-website.cjs <demo-library> <output-dir>
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const library = path.resolve(process.argv[2] || "");
const outputDir = path.resolve(process.argv[3] || path.join(os.tmpdir(), "mediaverse-capture-tv-website"));
fs.mkdirSync(outputDir, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-tv-website-data-"));
const PORT = 47792; // not the default, so a copy of the app already running is not disturbed
fs.writeFileSync(path.join(dataDir, "library-share.json"), JSON.stringify({ enabled: false, port: PORT }));
app.setPath("userData", dataDir);
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function firstWindow() {
  for (let i = 0; i < 100; i++) {
    const [first] = BrowserWindow.getAllWindows();
    if (first) return first;
    await wait(100);
  }
  throw new Error("No window appeared.");
}
async function waitFor(win, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await run(win, expression)) return;
    await wait(200);
  }
  throw new Error(`Timed out waiting for ${label}.`);
}
async function press(win, keyCode, times = 1) {
  for (let i = 0; i < times; i++) {
    win.webContents.sendInputEvent({ type: "keyDown", keyCode });
    win.webContents.sendInputEvent({ type: "keyUp", keyCode });
    await wait(140);
  }
}
async function shot(win, name) {
  await wait(700);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, `${name}.png`), image.toPNG());
  console.log("saved", name);
}
const focused = (win) => run(win, "(document.activeElement && (document.activeElement.textContent || document.activeElement.id || '').trim().slice(0, 60)) || '(none)'");

/** Moves the highlight to a keypad key by its label using arrows only, then presses OK. */
async function typeOnKeypad(win, text) {
  for (const ch of text) {
    for (let guard = 0; guard < 30; guard++) {
      const at = await run(win, "[...document.querySelectorAll('.key')].indexOf(document.activeElement)");
      const target = await run(win, `[...document.querySelectorAll('.key')].findIndex((k) => k.textContent === ${JSON.stringify(ch)})`);
      if (at === target) break;
      if (at < 0) await press(win, "Down");
      else await press(win, at < target ? "Right" : "Left");
    }
    await press(win, "Return");
  }
}

app.whenReady().then(async () => {
  try {
    const main = await firstWindow();
    await waitFor(main, "document.readyState === 'complete'", 15000, "app page");
    await wait(800);
    const imported = await run(main, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} }).then((r) => r.ok ? r.result.track_count : JSON.stringify(r.error))`);
    console.log("imported tracks:", imported);
    const status = await run(main, "window.mediaVerse.share.setEnabled(true)");
    console.log("share:", JSON.stringify({ running: status.running, problem: status.problem, addresses: status.addresses, port: status.port }));
    const host = `${status.addresses[0] ?? "127.0.0.1"}:${PORT}`;

    const tv = new BrowserWindow({ width: 1920, height: 1080, useContentSize: true, show: true, webPreferences: { contextIsolation: true, sandbox: true } });
    // Errors on the TV page are worth knowing about while capturing.
    tv.webContents.on("console-message", (_event, level, message) => { if (level >= 2) console.log("TV page:", message); });
    // ?look= stands in for the TV telling the app its own address (Samsung's network API).
    await tv.loadFile(path.join(__dirname, "..", "dist-tv", "index.html"), { query: { look: host } });
    // Who's listening? (D45): add a person with the letter keys, like the remote would.
    await waitFor(tv, "!document.querySelector('#who').hidden", 5000, "who is listening");
    await shot(tv, "00a-who-first");
    await press(tv, "Return"); // "Add a person" is highlighted on a new TV
    await waitFor(tv, "!document.querySelector('#who-name').hidden", 3000, "name entry");
    for (const key of ["A", "L", "E", "X", "Done"]) await run(tv, `[...document.querySelectorAll('#who-name-keys .key')].find((k) => k.textContent === '${key}').click()`);
    await wait(500);
    console.log("listener:", await run(tv, "document.querySelector('#listener-tab').textContent"));
    await waitFor(tv, "!document.querySelector('#sources').hidden && document.querySelector('#who').hidden", 5000, "sources screen")
    const started = Date.now();
    await waitFor(tv, "document.querySelectorAll('#source-list .source').length > 0", 30000, "the computer in the list");
    console.log(`found in ${Date.now() - started} ms:`, await run(tv, "document.querySelector('#source-list').innerText.replace(/\\n/g, ' ')"));
    await waitFor(tv, "!/Looking/.test(document.querySelector('#sources-status').textContent)", 30000, "search finished");
    console.log(`search finished in ${Date.now() - started} ms:`, await run(tv, "document.querySelector('#sources-status').textContent"));
    await shot(tv, "01-sources");
    const probeStart = Date.now();
    console.log("probe after search:", await run(tv, `fetch("http://${host}/api/hello").then((r) => r.status)`), `${Date.now() - probeStart} ms`);

    console.log("highlight:", await focused(tv));
    await press(tv, "Return"); // the computer is highlighted
    await wait(1500);
    console.log("tv pair screen:", await run(tv, "!document.querySelector('#pair').hidden"), await run(tv, "document.querySelector('#pair-status').textContent"));
    // Bring the computer's window forward (a hidden window's page is throttled and cannot be captured).
    main.webContents.setBackgroundThrottling(false);
    main.show();
    main.focus();
    await waitFor(main, "window.mediaVerse.share.status().then((s) => !!s.pairing)", 10000, "pairing code on the computer");
    await waitFor(main, "document.querySelector('#pair-dialog').open", 3000, "pairing window on the computer");
    await shot(main, "02a-computer-shows-code");
    const pairCode = await run(main, "window.mediaVerse.share.status().then((s) => s.pairing.code)");
    tv.show();
    tv.focus();
    await wait(300);
    // One wrong code first, then the right one, as number keys.
    for (const digit of pairCode === "000000" ? "000001" : "000000") await press(tv, digit);
    await waitFor(tv, "/not the code/.test(document.querySelector('#pair-status').textContent)", 5000, "wrong code message");
    await shot(tv, "02-pair-wrong");
    for (const digit of pairCode) await press(tv, digit);
    await waitFor(tv, "!document.querySelector('#browse').hidden && document.querySelectorAll('.tile').length > 0", 30000, "albums");
    console.log("paired TVs:", JSON.stringify((await run(main, "window.mediaVerse.share.status()")).devices.map((d) => d.name)));
    console.log("pairing window closed:", await run(main, "!document.querySelector('#pair-dialog').open"));    await wait(2500);
    await shot(tv, "03-albums");

    await wait(1500); await shot(tv, "tv-albums");
    // An album page (Night Ferry, whose title song has time-stamped lyrics), then Play.
    await run(tv, "[...document.querySelectorAll('.tile')].find((t) => t.textContent.includes('Night Ferry')).click()");
    await waitFor(tv, "!!document.querySelector('.album-view')", 5000, "album view");
    await wait(1500); await shot(tv, "tv-album");
    await run(tv, "document.querySelector('.album-view [data-action=play], .album-view button.f').click()");
    await waitFor(tv, "!document.querySelector('#playing').hidden", 8000, "now playing");
    await waitFor(tv, "document.querySelector('#audio').currentTime > 1", 20000, "playback");
    await run(tv, "document.querySelector('#audio').currentTime = 40; 0");
    await wait(6000); await shot(tv, "tv-now-playing");
    await wait(9000); // the controls fade, leaving the wall, the details and the lyrics
    await shot(tv, "tv-now-playing-faded");
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
