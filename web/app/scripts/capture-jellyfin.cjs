// Development aid: Settings > Jellyfin (D90) in the real app with a throwaway data folder. Searches the network for
// Jellyfin servers, prints what the page says and saves a picture. It changes nothing (no firewall button is pressed).
// Run: npx electron scripts/capture-jellyfin.cjs <output-dir>
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const outputDir = path.resolve(process.argv[2] || path.join(os.tmpdir(), "mediaverse-capture-jellyfin"));
fs.mkdirSync(outputDir, { recursive: true });
app.setPath("userData", fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-capture-jellyfin-data-")));
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
app.whenReady().then(async () => {
  try {
    let win;
    for (let i = 0; i < 100 && !(win = BrowserWindow.getAllWindows()[0]); i++) await wait(100);
    win.unmaximize();
    win.setSize(1200, 1000);
    for (let i = 0; i < 60 && !(await win.webContents.executeJavaScript("document.readyState === 'complete'")); i++) await wait(250);
    await win.webContents.executeJavaScript("localStorage.setItem('mediaverse.welcome-seen', '1'); location.reload(); 0");
    await wait(3000);
    await win.webContents.executeJavaScript("document.querySelector('[data-page=settings]').click(); document.querySelector('[data-settings-section=jellyfin]').click(); 0");
    for (let i = 0; i < 40 && (await win.webContents.executeJavaScript("document.querySelector('#settings-jellyfin [role=status]').textContent.startsWith('Looking')")); i++) await wait(250);
    await wait(2500); // the firewall check
    console.log("page:\n" + (await win.webContents.executeJavaScript("document.querySelector('#settings-jellyfin').innerText")));
    const image = await win.webContents.capturePage();
    fs.writeFileSync(path.join(outputDir, "settings-jellyfin.png"), image.toPNG());
  } catch (error) {
    console.error("capture failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
