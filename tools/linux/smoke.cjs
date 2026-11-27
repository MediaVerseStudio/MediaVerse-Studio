/*
 * A first check that a built copy works on Linux: starts it with a throwaway data folder and a folder of two made-up
 * test tones, then, through the page itself, reads the version, imports the folder, plays a song, switches sharing on
 * and off, and saves pictures of the window.
 *
 *   xvfb-run -a node tools/linux/smoke.cjs /usr/bin/mediaverse-studio <output-folder>
 *
 * Exits with 1 when the program does not start, the library does not import or sharing fails. Whether sound advanced is
 * reported only: a build machine has no sound card.
 */
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const program = process.argv[2] || "/usr/bin/mediaverse-studio";
const out = path.resolve(process.argv[3] || "smoke");
const port = 9333;
const base = fs.mkdtempSync(path.join(os.tmpdir(), "mv-smoke-"));
const music = path.join(base, "music");
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

/** A short mono 16-bit tone as a WAV file. */
function tone(file, hertz, seconds = 8, rate = 44100) {
  const samples = rate * seconds;
  const data = Buffer.alloc(44 + samples * 2);
  data.write("RIFF", 0);
  data.writeUInt32LE(36 + samples * 2, 4);
  data.write("WAVEfmt ", 8);
  data.writeUInt32LE(16, 16);
  data.writeUInt16LE(1, 20);
  data.writeUInt16LE(1, 22);
  data.writeUInt32LE(rate, 24);
  data.writeUInt32LE(rate * 2, 28);
  data.writeUInt16LE(2, 32);
  data.writeUInt16LE(16, 34);
  data.write("data", 36);
  data.writeUInt32LE(samples * 2, 40);
  for (let i = 0; i < samples; i += 1) data.writeInt16LE(Math.round(Math.sin((2 * Math.PI * hertz * i) / rate) * 6000), 44 + i * 2);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, data);
}

/** The DevTools connection to the program's own page. */
async function connect() {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    try {
      const pages = await (await fetch(`http://127.0.0.1:${port}/json/list`)).json();
      const page = pages.find((p) => p.type === "page" && p.url.endsWith("index.html"));
      if (page) {
        const socket = new WebSocket(page.webSocketDebuggerUrl);
        await new Promise((resolve, reject) => {
          socket.onopen = resolve;
          socket.onerror = reject;
        });
        const pending = new Map();
        let id = 0;
        socket.onmessage = (event) => {
          const message = JSON.parse(event.data);
          pending.get(message.id)?.(message);
          pending.delete(message.id);
        };
        const send = (method, params = {}) =>
          new Promise((resolve, reject) => {
            const number = (id += 1);
            const timer = setTimeout(() => reject(new Error(`${method} did not answer.`)), 60_000);
            pending.set(number, (message) => {
              clearTimeout(timer);
              if (message.error) reject(new Error(message.error.message));
              else resolve(message.result);
            });
            socket.send(JSON.stringify({ id: number, method, params }));
          });
        const run = async (expression) => {
          const answer = await send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true, userGesture: true });
          if (answer.exceptionDetails) throw new Error(answer.exceptionDetails.exception?.description ?? answer.exceptionDetails.text);
          return answer.result.value;
        };
        return { send, run, close: () => socket.close() };
      }
    } catch {
      // not listening yet
    }
    await wait(500);
  }
  throw new Error("The program's window did not appear within a minute.");
}

async function main() {
  fs.mkdirSync(out, { recursive: true });
  tone(path.join(music, "Test Band", "Test Album", "01 - First Tone.wav"), 440);
  tone(path.join(music, "Test Band", "Test Album", "02 - Second Tone.wav"), 523);
  const log = fs.openSync(path.join(out, "program.log"), "w");
  const child = spawn(program, [`--remote-debugging-port=${port}`], {
    env: { ...process.env, MEDIAVERSE_USER_DATA: path.join(base, "data") },
    stdio: ["ignore", log, log],
    detached: true,
  });
  const failures = [];
  const check = (label, passed, detail = "") => {
    console.log(`${passed ? "ok  " : "FAIL"} ${label}${detail ? `: ${detail}` : ""}`);
    if (!passed) failures.push(label);
  };
  let page;
  try {
    page = await connect();
    const shot = async (file) => {
      const picture = await page.send("Page.captureScreenshot", { format: "png" });
      fs.writeFileSync(path.join(out, `${file}.png`), Buffer.from(picture.data, "base64"));
    };
    await wait(4000);
    check("window opened", true);
    console.log("about:", await page.run("window.mediaVerse.about().then((a) => JSON.stringify(a))"));
    const imported = await page.run(`window.mediaVerse.invoke("import_collection", { root: ${JSON.stringify(music)} })`);
    check("music folder imported", imported.ok && imported.result?.track_count === 2, JSON.stringify(imported.error ?? imported.result?.track_count));
    const song = path.join(music, "Test Band", "Test Album", "01 - First Tone.wav");
    const played = await page.run(`(async () => {
      const audio = new Audio("mediaverse-media://library/?path=" + encodeURIComponent(${JSON.stringify(song)}));
      try { await audio.play(); } catch (error) { return { error: String(error) }; }
      await new Promise((resolve) => setTimeout(resolve, 3000));
      const seconds = audio.currentTime; audio.pause();
      return { seconds, duration: audio.duration };
    })()`);
    check("song file read by the player", Math.round(played.duration ?? 0) === 8, JSON.stringify(played));
    console.log(`note playback position after 3 s: ${played.seconds ?? "none"}`);
    const drives = await page.run(`window.mediaVerse.invoke("list_drives", {}).then((r) => JSON.stringify(r))`);
    console.log("note CD drives:", drives.slice(0, 300));
    const shared = await page.run("window.mediaVerse.share.setEnabled(true).then(() => window.mediaVerse.share.status()).then((s) => JSON.stringify(s))");
    check("sharing switched on", /"running":true/.test(shared), shared.replace(/"addresses":\[[^\]]*\],?/, "").slice(0, 300));
    await page.run("window.mediaVerse.share.setEnabled(false).then(() => true)");
    await page.run("localStorage.setItem('mediaverse.welcome-seen', '1'); setTimeout(() => location.reload(), 50); true");
    await wait(8000);
    await shot("1-home");
    for (const [number, name] of [[2, "library"], [3, "settings"]]) {
      await page.run(`document.querySelector('[data-page=${name}]')?.click(); true`);
      await wait(3000);
      await shot(`${number}-${name}`);
    }
  } catch (error) {
    check("ran to the end", false, error.message);
  } finally {
    page?.close();
    try {
      process.kill(-child.pid, "SIGTERM");
    } catch {
      // already gone
    }
    await wait(1500);
    fs.closeSync(log);
    console.log("--- program log (last 60 lines)");
    console.log(fs.readFileSync(path.join(out, "program.log"), "utf8").split("\n").slice(-60).join("\n"));
  }
  process.exit(failures.length ? 1 : 0);
}

main();
