// Development aid: a screenshot of each main page (Home, Rip a CD, Library, Review, Settings) on a COPY of a data
// folder, to compare their layout. Nothing is changed. Build first: npm run build.
// Run: npx electron scripts/capture-pages.cjs <data-folder-copy> <output-dir> [width] [height]
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const [dataArg, outArg, widthArg, heightArg] = process.argv.slice(2);
const outputDir = path.resolve(outArg || ".");
fs.mkdirSync(outputDir, { recursive: true });
app.setPath("userData", path.resolve(dataArg));
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);

app.whenReady().then(async () => {
  try {
    let win;
    for (let i = 0; i < 100 && !win; i++) { [win] = BrowserWindow.getAllWindows(); await wait(100); }
    win.setSize(Number(widthArg) || 1600, Number(heightArg) || 1000);
    await wait(5000);
    for (const page of ["home", "rip", "library", "review", "settings"]) {
      await run(win, `document.querySelector('[data-page=${page}]').click()`);
      await wait(page === "review" ? 2500 : 1500);
      fs.writeFileSync(path.join(outputDir, `page-${page}.png`), (await win.webContents.capturePage()).toPNG());
      console.log("saved", page);
    }
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
