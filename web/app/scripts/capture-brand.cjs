// Development aid: the real app's top bar (emblem + wordmark, D86) at a wide and a narrow window, and whether the
// window has a menu bar. Uses a throwaway data folder, so nothing in your library or settings is touched.
// Run: npx electron scripts/capture-brand.cjs <output-dir>
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mediaverse-capture-brand"));
fs.mkdirSync(outputDir, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-brand-data-")));
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function firstWindow() {
  for (let i = 0; i < 100; i++) {
    const [first] = BrowserWindow.getAllWindows();
    if (first) return first;
    await wait(100);
  }
  throw new Error("No window appeared.");
}
async function shot(win, name, height = 160) {
  const [width] = win.getContentSize();
  const image = await win.webContents.capturePage({ x: 0, y: 0, width, height });
  fs.writeFileSync(path.join(outputDir, `${name}.png`), image.toPNG());
  console.log("saved", path.join(outputDir, `${name}.png`));
}

app.whenReady().then(async () => {
  try {
    const win = await firstWindow();
    win.unmaximize();
    win.setSize(1400, 900);
    win.show();
    for (let i = 0; i < 60 && !(await win.webContents.executeJavaScript("document.readyState === 'complete'")); i++) await wait(250);
    await win.webContents.executeJavaScript("localStorage.setItem('mediaverse.welcome-seen', '1'); location.reload(); 0");
    await wait(3000);
    console.log("menu bar visible:", win.isMenuBarVisible(), "| application menu:", require("electron").Menu.getApplicationMenu() ? "present" : "none");
    console.log("images loaded:", await win.webContents.executeJavaScript("JSON.stringify([...document.querySelectorAll('.app-header img')].map((i) => [i.getAttribute('src'), i.naturalWidth, Math.round(i.getBoundingClientRect().width), Math.round(i.getBoundingClientRect().height)]))"));
    await shot(win, "header-wide");
    win.setSize(760, 900);
    await wait(800);
    await shot(win, "header-narrow", 220);
    // Settings > About (D88).
    win.setSize(1200, 900);
    await win.webContents.executeJavaScript("document.querySelector('[data-page=settings]').click(); document.querySelector('[data-settings-section=about]').click(); 0");
    await wait(1200);
    console.log("about:", await win.webContents.executeJavaScript("JSON.stringify([document.querySelector('#settings-about').innerText.slice(0, 400), document.querySelector('#settings-about button')?.disabled])"));
    await shot(win, "settings-about", 700);
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
