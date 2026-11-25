// Development aid: opens the real app on a copy of a data folder (so a running copy is not disturbed) and saves
// screenshots of Review > Fix tags: the first page, an album's editions, and each filter.
// Build first: npm run build
// Run: npx electron scripts/capture-fix-tags.cjs <data-folder-copy> <output-dir>
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const dataDir = path.resolve(process.argv[2] || "");
const outputDir = path.resolve(process.argv[3] || ".");
fs.mkdirSync(outputDir, { recursive: true });
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
async function shot(win, name) {
  await wait(800);
  const image = await win.webContents.capturePage();
  fs.writeFileSync(path.join(outputDir, `${name}.png`), image.toPNG());
  console.log("saved", name);
}

app.whenReady().then(async () => {
  try {
    const win = await firstWindow();
    win.setSize(1600, 1000);
    await wait(4000);
    await run(win, "document.querySelector('[data-page=review]').click()");
    await wait(800);
    await run(win, "document.querySelector('[data-review=fixtags]').click()");
    await wait(4000);
    console.log("summary:", await run(win, "document.querySelector('#review-panel-fixtags .ft-chips')?.innerText.replace(/\\n/g, ' | ')"));
    console.log("cards:", await run(win, "[...document.querySelectorAll('#review-panel-fixtags .ft-card-title')].map((e) => e.textContent).join(' / ')"));
    await shot(win, "01-fix-tags");
    await run(win, "window.scrollTo(0, 0); [...document.querySelectorAll('#review-panel-fixtags .ft-actions button')].find((b) => b.textContent.startsWith('Other editions'))?.click()");
    await shot(win, "02-editions");
    for (const [index, name] of [[1, "03-ready"], [2, "04-choose"], [3, "05-not-identified"]]) {
      await run(win, `document.querySelectorAll('#review-panel-fixtags .ft-chip')[${index}].click()`);
      await wait(1500);
      await run(win, "document.querySelector('#review-panel-fixtags .ft-actions button:last-child')?.click()");
      await shot(win, name);
    }
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
