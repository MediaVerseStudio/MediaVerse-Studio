// Development aid: in the real app, makes three untagged MP3s in "Various Artists\Mix Tape", finds them under
// Review > Missing or uncertain metadata, groups and selects them, batch-edits them with the compilation box,
// and reads the files back. Run: npx electron scripts/capture-batch.cjs <real-library-folder> <output-dir>
const { app } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const source = path.resolve(process.argv[2] || "");
const outputDir = path.resolve(process.argv[3] || path.join(os.tmpdir(), "mediaverse-capture-batch"));
fs.mkdirSync(outputDir, { recursive: true });
const library = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-batch-lib-"));
function findMp3(dir) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) { const f = findMp3(full); if (f) return f; }
    else if (entry.name.toLowerCase().endsWith(".mp3")) return full;
  }
  return null;
}
const original = fs.readFileSync(findMp3(source));
const audio = original.subarray(10 + ((original[6] << 21) | (original[7] << 14) | (original[8] << 7) | original[9]));
function titleOnlyTag(title) {
  const body = Buffer.concat([Buffer.from([0]), Buffer.from(title, "latin1")]);
  const frameHeader = Buffer.alloc(10); frameHeader.write("TIT2", 0, "latin1"); frameHeader.writeUInt32BE(body.length, 4);
  const frame = Buffer.concat([frameHeader, body]);
  const size = frame.length + 128;
  return Buffer.concat([Buffer.from("ID3\u0003\u0000\u0000", "latin1"), Buffer.from([(size >> 21) & 127, (size >> 14) & 127, (size >> 7) & 127, size & 127]), frame, Buffer.alloc(128)]);
}
const folder = path.join(library, "Various Artists", "Mix Tape");
fs.mkdirSync(folder, { recursive: true });
const files = [1, 2, 3].map((n) => { const f = path.join(folder, `0${n} - Track ${n}.mp3`); fs.writeFileSync(f, Buffer.concat([titleOnlyTag(`Track ${n}`), audio])); return f; });
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-batch-data-")));
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
async function window() {
  const { BrowserWindow } = require("electron");
  for (let i = 0; i < 100; i++) { const [first] = BrowserWindow.getAllWindows(); if (first) return first; await wait(100); }
  throw new Error("No window appeared.");
}
async function waitFor(win, expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) { if (await run(win, expression)) return; await wait(250); }
  throw new Error(`Timed out waiting for ${label}.`);
}
app.whenReady().then(async () => {
  try {
    const win = await window();
    win.setSize(1280, 1000);
    win.show();
    await waitFor(win, "document.readyState === 'complete'", 15000, "page load");
    await wait(800);
    await run(win, `window.mediaVerse.invoke('import_collection', { root: ${JSON.stringify(library)} })`);
    await run(win, "document.querySelector('#rescan-collection').click()");
    await wait(1500);
    await run(win, "document.querySelector('[data-page=review]').click(); document.querySelector('.subnav-button[data-review=metadata]').click()");
    await waitFor(win, "document.querySelectorAll('.issue-group').length > 0", 10000, "the issue groups");
    console.log("count:", await run(win, "document.querySelector('#issue-count').textContent"));
    console.log("groups:", JSON.stringify(await run(win, "[...document.querySelectorAll('.issue-group strong')].map((s) => s.textContent)")));
    const shot = async (name) => fs.writeFileSync(path.join(outputDir, name), (await win.webContents.capturePage()).toPNG());
    await shot("1-issues.png");
    // Group a different way, then select the first group and edit it.
    await run(win, "const s = document.querySelector('#issue-tools select'); s.value = 'folder'; s.dispatchEvent(new Event('change'))");
    await wait(500);
    console.log("by folder:", JSON.stringify(await run(win, "[...document.querySelectorAll('.issue-group strong')].map((s) => s.textContent)")));
    await run(win, "document.querySelector('.issue-group input[type=checkbox]').click()");
    await wait(300);
    console.log("edit button:", await run(win, "document.querySelector('.issue-edit-selected').textContent"));
    await run(win, "document.querySelector('.issue-edit-selected').click()");
    await waitFor(win, "document.querySelector('#tag-editor').open", 3000, "the editor");
    console.log("prefilled album:", JSON.stringify(await run(win, "document.querySelector('#edit-album').value")), "album artist:", JSON.stringify(await run(win, "document.querySelector('#edit-album-artist').value")));
    console.log("compilation box already ticked (suggested album artist is Various Artists):", await run(win, "document.querySelector('#edit-compilation').checked"), "read-only:", await run(win, "document.querySelector('#edit-album-artist').readOnly"));
    await shot("2-batch-editor.png");
    await run(win, "document.querySelector('#tag-editor-form').requestSubmit()");
    await waitFor(win, "/saved on 3 tracks/i.test(document.querySelector('#status').textContent)", 30000, "the batch save");
    console.log("status:", await run(win, "document.querySelector('#status').textContent"));
    for (const f of files) {
      const bytes = fs.readFileSync(f);
      const text = bytes.toString("latin1");
      console.log(path.basename(f), "| id3 version", bytes[3], "| TPE2:", text.includes("TPE2"), "VA:", bytes.includes(Buffer.from("Various Artists", "utf16le")) || text.includes("Various Artists"), "| TCMP:", text.includes("TCMP"), "| album Mix Tape:", bytes.includes(Buffer.from("Mix Tape", "utf16le")) || text.includes("Mix Tape"));
    }
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
