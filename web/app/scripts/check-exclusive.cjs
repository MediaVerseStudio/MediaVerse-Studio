// Development aid: starts the real app with a throwaway data folder, switches exclusive (WASAPI) output on with the volume at 0 (nothing is heard),
// plays the first album and checks that the program, not the <audio> elements, plays it: the clock moves, pause/seek/next work, a song joins the next
// on its own, and switching the option off hands the song back to the elements. Run:
//   npx electron scripts/check-exclusive.cjs <library-folder>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const library = path.resolve(process.argv[2] || "");
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-exclusive-data-")));
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function window() {
  const { BrowserWindow } = require("electron");
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
const status = (win) => run(win, "window.mediaVerse.invoke('native_audio_status').then((r) => r.result)");
const elementsPlaying = (win) => run(win, "[...document.querySelectorAll('audio')].filter((a) => !a.paused).length");
const check = (ok, text) => {
  console.log(`${ok ? "PASS" : "FAIL"}  ${text}`);
  if (!ok) process.exitCode = 1;
};

app.whenReady().then(async () => {
  try {
    const win = await window();
    win.webContents.on("console-message", (e, level, message) => { if (level >= 2 || String(message).startsWith("DBG")) console.log("page:", message); });
    win.setSize(1180, 900);
    win.show();
    await waitFor(win, "document.readyState === 'complete'", 15000, "page load");
    await wait(1000);
    await run(win, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} }).then(() => 1)`);
    await run(win, "document.querySelector('#rescan-collection').click()");
    // Exclusive output on, volume at 0 so nothing is heard, then start again with those settings.
    await run(win, "localStorage.setItem('mediaverse.native-output.v1', JSON.stringify({ exclusive: true, device: '' })); localStorage.setItem('mediaverse.volume.v1', '0'); location.reload()");
    await wait(2500);
    await waitFor(win, "document.readyState === 'complete'", 15000, "reload");
    await run(win, "document.querySelector('[data-page=library]').click()");
    await waitFor(win, "document.querySelectorAll('.lib-artist').length >= 1", 60000, "the artists");
    await run(win, "document.querySelector('.lib-artist').click()");
    await waitFor(win, "document.querySelectorAll('#artist-page tr[data-path]').length >= 1", 10000, "the artist page");
    await run(win, "document.querySelector('#artist-page tr[data-path]').dispatchEvent(new MouseEvent('dblclick', { bubbles: true }))");
    await waitFor(win, "document.querySelector('#player-title').textContent.length > 0", 10000, "a song to be chosen");
    await wait(2500);

    let s = await status(win);
    console.log("status:", JSON.stringify(s));
    check(s.state === "playing" && s.rate > 0, `the program plays the song (${s.rate} Hz, ${s.bits}-bit, ${s.container_bits}-bit slots, ${s.device})`);
    check((await elementsPlaying(win)) === 0, "no <audio> element is playing");
    const first = await run(win, "document.querySelector('#player-title').textContent");
    const t1 = await run(win, "document.querySelector('#player-elapsed').textContent");
    await wait(2000);
    const t2 = await run(win, "document.querySelector('#player-elapsed').textContent");
    check(t1 !== t2, `the clock moves (${t1} then ${t2})`);

    // Pause and play
    await run(win, "document.querySelector('#player-play').click()");
    await wait(600);
    const pausedAt = (await status(win)).position_ms;
    await wait(800);
    s = await status(win);
    check(s.state === "paused" && Math.abs(s.position_ms - pausedAt) < 20, `pause holds the place (${pausedAt} ms)`);
    await run(win, "document.querySelector('#player-play').click()");
    await wait(800);
    check((await status(win)).state === "playing", "play carries on");

    // Seek with the bar
    await run(win, "(() => { const bar = document.querySelector('#player-seek'); bar.value = String(Number(bar.max) * 0.5); bar.dispatchEvent(new Event('change')); })()");
    await wait(700);
    s = await status(win);
    check(s.position_ms > (s.duration_ms || 0) * 0.45, `seeking goes to the middle (${s.position_ms} of ${s.duration_ms} ms)`);

    // The end of the song: the next one starts by itself, without the page opening it
    const before = s.token;
    await run(win, "(() => { const bar = document.querySelector('#player-seek'); bar.value = String(Number(bar.max) - 3); bar.dispatchEvent(new Event('change')); })()");
    await wait(5500);
    s = await status(win);
    const second = await run(win, "document.querySelector('#player-title').textContent");
    check(s.token !== before && s.state === "playing", `the next song started on its own (token ${before} to ${s.token})`);
    check(second !== first, `the page followed to "${second}"`);
    check((await elementsPlaying(win)) === 0, "still no <audio> element playing");

    // Next button, then off
    await run(win, "document.querySelector('#player-next').click()");
    await wait(1500);
    s = await status(win);
    check(s.state === "playing", "the next button works");
    await run(win, "document.querySelector('[data-page=settings]').click()");
    await run(win, "document.querySelector('[data-settings-section=sound]').click()");
    await wait(800);
    const line = await run(win, "[...document.querySelectorAll('#settings-sound .field-hint')].map((e) => e.textContent).find((t) => /Playing exclusively|No song has been played/.test(t)) || ''");
    console.log("settings line:", line);
    check(/Playing exclusively at/.test(line), "the settings page says what the song is played as");
    await run(win, "(() => { const box = [...document.querySelectorAll('#settings-sound input[type=checkbox]')][0]; box.click(); })()");
    await wait(2500);
    s = await status(win);
    check(s.state === "idle", "switching it off lets the sound card go");
    check((await elementsPlaying(win)) === 1, "and the song carries on through the player");
  } catch (error) {
    console.error("check failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
