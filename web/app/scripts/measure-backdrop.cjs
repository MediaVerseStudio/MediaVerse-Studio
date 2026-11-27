// Development aid (2026-11-25): how the page backdrop (the collage) is sized and how bright it shows on each page, to find why it shifts between pages and why some pages are darker.
// Build first: npm run build. Run: npx electron scripts/measure-backdrop.cjs <demo-library> [output-dir] [WIDTHxHEIGHT, default 1600x1000]
// Uses a throwaway data folder and the made-up demo library; prints one JSON line per page and can save the pictures.
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const library = path.resolve(process.argv[2] || "");
const outputDir = process.argv[3] ? path.resolve(process.argv[3]) : null;
if (outputDir) fs.mkdirSync(outputDir, { recursive: true });
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mediaverse-measure-data-"));
fs.writeFileSync(path.join(dataDir, "library-share.json"), JSON.stringify({ enabled: false, port: 47791 }));
app.setPath("userData", dataDir);
require("../electron/main.js");

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const run = (win, code) => win.webContents.executeJavaScript(code);
const click = (win, selector, text) =>
  run(win, `(() => { const el = [...document.querySelectorAll(${JSON.stringify(selector)})].find((e) => ${text ? `e.textContent.trim().startsWith(${JSON.stringify(text)})` : "true"}); if (!el) return false; el.click(); return true; })()`);

/** Mean brightness (0 to 255) of the picture, every 7th pixel, and of the left and right 60 px strips (outside the content column). */
function brightness(image) {
  const { width, height } = image.getSize();
  const bitmap = image.toBitmap(); // BGRA
  const mean = (x0, x1) => {
    let sum = 0, count = 0;
    for (let y = 0; y < height; y += 7) for (let x = x0; x < x1; x += 7) {
      const i = (y * width + x) * 4;
      sum += 0.2126 * bitmap[i + 2] + 0.7152 * bitmap[i + 1] + 0.0722 * bitmap[i];
      count += 1;
    }
    return Math.round((sum / count) * 10) / 10;
  };
  return { all: mean(0, width), leftStrip: mean(0, Math.round(width * 0.04)), rightStrip: mean(Math.round(width * 0.9), Math.round(width * 0.97)) };
}

async function measure(win, label, wallSelector = ".backdrop-wall") {
  await wait(1200);
  const info = await run(win, `(() => {
    const rect = (el) => { if (!el) return null; const r = el.getBoundingClientRect(); return [Math.round(r.left * 10) / 10, Math.round(r.top), Math.round(r.width * 10) / 10, Math.round(r.height)]; };
    const wall = document.querySelector(${JSON.stringify(wallSelector)});
    const tiles = [...wall.children];
    const firstTile = tiles[0];
    const boxes = tiles.map((t) => t.getBoundingClientRect()).filter((r) => r.width > 0);
    const coverLeft = boxes.length ? Math.round(Math.min(...boxes.map((r) => r.left)) * 10) / 10 : null;
    const coverRight = boxes.length ? Math.round(Math.max(...boxes.map((r) => r.right)) * 10) / 10 : null;
    const cols = getComputedStyle(wall).gridTemplateColumns.split(" ").length;
    const page = document.querySelector("main > section.page:not([hidden])");
    return {
      innerWidth: innerWidth, clientWidth: document.documentElement.clientWidth, scrollbar: innerWidth - document.documentElement.clientWidth,
      scrolls: document.documentElement.scrollHeight > document.documentElement.clientHeight,
      backdrop: rect(document.querySelector("#backdrop")), wall: rect(wall), columns: cols, coverLeft, coverRight, bandLeft: coverLeft, bandRight: coverRight === null ? null : Math.round((innerWidth - coverRight) * 10) / 10, firstTileLeft: firstTile ? Math.round(firstTile.getBoundingClientRect().left * 10) / 10 : null,
      main: rect(document.querySelector("main")), pageBg: page ? getComputedStyle(page).backgroundColor : null,
      shade: getComputedStyle(document.querySelector(".backdrop-shade")).backgroundImage.replace(/rgba?\\(/g, "(").slice(0, 120),
    };
  })()`);
  const image = await win.webContents.capturePage();
  if (outputDir) fs.writeFileSync(path.join(outputDir, `${label}.png`), image.toPNG());
  console.log(JSON.stringify({ label, ...info, brightness: brightness(image) }));
}

app.whenReady().then(async () => {
  try {
    let win;
    for (let i = 0; i < 100 && !(win = BrowserWindow.getAllWindows()[0]); i++) await wait(100);
    win.unmaximize();
    const [sizeW, sizeH] = (process.argv[4] || "1600x1000").split("x").map(Number);
    win.setContentSize(sizeW, sizeH);
    win.center();
    await wait(1500);
    await run(win, "localStorage.setItem('mediaverse.welcome-seen', '1'); location.reload(); 0");
    await wait(2500);
    await run(win, `window.mediaVerse.invoke("import_collection", { root: ${JSON.stringify(library)} })`);
    await click(win, "#rescan-collection");
    await click(win, "[data-page=library]");
    await wait(4000); // covers
    await measure(win, "library-artists");
    await click(win, ".lib-pivot", "albums");
    await measure(win, "library-albums");
    await click(win, ".lib-pivot", "artists");
    await wait(500);
    await click(win, ".lib-artist", "Copper Lantern");
    await measure(win, "artist-page");
    await run(win, "(() => { const row = [...document.querySelectorAll('#artist-page tr[data-path]')].find((r) => r.textContent.includes('Night Ferry')); row.dispatchEvent(new MouseEvent('dblclick', { bubbles: true })); })()");
    await wait(2500);
    await click(win, "#player-expand");
    await measure(win, "now-playing", "#np-wall");
    await run(win, "document.querySelector('#np-back')?.click(); 0");
    await wait(800);
    await click(win, "[data-page=home]");
    await measure(win, "home");
    await click(win, "[data-page=rip]");
    await measure(win, "rip");
    await click(win, "[data-page=review]");
    for (const tab of ["flagged", "fixtags", "lyrics", "artwork", "defects"]) {
      await run(win, `document.querySelector('[data-review=${tab}]')?.click(); 0`);
      await measure(win, `review-${tab}`);
    }
    await click(win, "[data-page=settings]");
    for (const section of ["library", "lookups", "sound", "lyrics", "display", "about"]) {
      await run(win, `document.querySelector('[data-settings-section=${section}]')?.click(); 0`);
      await measure(win, `settings-${section}`);
    }
  } catch (error) {
    console.error("measure failed:", error.message);
    process.exitCode = 1;
  } finally {
    app.quit();
  }
});
