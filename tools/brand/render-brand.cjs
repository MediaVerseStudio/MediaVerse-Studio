/*
 * Makes every program icon and logo piece from the two sources in brand/ (no extra tools: it runs in the
 * Electron that the desktop app already uses, whose canvas draws the SVGs and the JPEG).
 *
 *   tools\make-brand-assets.ps1      (or: web\app\node_modules\electron\dist\electron.exe tools\brand\render-brand.cjs)
 *
 * Sources: brand/mediaverse-logo.jpg (the full artwork, on black), brand/icon.svg (48 px and up),
 * brand/icon-small.svg (24-40 px) and brand/icon-tiny.svg (16-20 px). Outputs are listed in brand/README.md.
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const root = path.resolve(__dirname, "..", "..");
const at = (...parts) => path.join(root, ...parts);
const dataUrl = (file, type) => `data:${type};base64,${fs.readFileSync(file).toString("base64")}`;

// Where the artwork sits in the 1408x768 master (measured: pixels brighter than near-black).
const EMBLEM = { x: 438, y: 114, w: 533, h: 365 };
const WORDMARK = { x: 450, y: 511, w: 509, h: 149 };

/** Runs in the page: draws one picture and returns it as a PNG data URL. */
const pageCode = String.raw`
const load = (src) => new Promise((ok, fail) => { const i = new Image(); i.onload = () => ok(i); i.onerror = fail; i.src = src; });
const canvas = (w, h) => { const c = document.createElement("canvas"); c.width = w; c.height = h; return c; };

// Black background to transparency: alpha is the brightest channel, colour is divided back out, so the copper
// glow keeps its soft edge on any background (the artwork was made on pure black).
function blackToAlpha(c) {
  const g = c.getContext("2d"); const d = g.getImageData(0, 0, c.width, c.height); const p = d.data;
  for (let i = 0; i < p.length; i += 4) {
    const a = Math.max(p[i], p[i + 1], p[i + 2]);
    if (a < 10) { p[i + 3] = 0; continue; }
    p[i] = Math.min(255, p[i] * 255 / a); p[i + 1] = Math.min(255, p[i + 1] * 255 / a); p[i + 2] = Math.min(255, p[i + 2] * 255 / a); p[i + 3] = a;
  }
  g.putImageData(d, 0, 0); return c;
}

async function crop(src, box, pad, height) {
  const img = await load(src);
  const scale = height / (box.h + 2 * pad);
  const c = canvas(Math.round((box.w + 2 * pad) * scale), height);
  const g = c.getContext("2d"); g.imageSmoothingQuality = "high";
  g.drawImage(img, box.x - pad, box.y - pad, box.w + 2 * pad, box.h + 2 * pad, 0, 0, c.width, c.height);
  return blackToAlpha(c).toDataURL("image/png");
}

async function icon(src, size, w = size, h = size) {
  const img = await load(src);
  const c = canvas(w, h); const g = c.getContext("2d"); g.imageSmoothingQuality = "high";
  g.drawImage(img, (w - size) / 2, (h - size) / 2, size, size);
  return c.toDataURL("image/png");
}
`;

async function main() {
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true } });
  await window.loadURL("data:text/html,<!doctype html><title>brand</title>");
  await window.webContents.executeJavaScript(pageCode + "; window.crop = crop; window.icon = icon; 0");

  const logo = dataUrl(at("brand", "mediaverse-logo.jpg"), "image/jpeg");
  const big = dataUrl(at("brand", "icon.svg"), "image/svg+xml");
  const small = dataUrl(at("brand", "icon-small.svg"), "image/svg+xml");
  const run = (call) => window.webContents.executeJavaScript(call);
  const save = async (file, png) => {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    const bytes = Buffer.from(png.split(",")[1], "base64");
    fs.writeFileSync(file, bytes);
    console.log(`  ${path.relative(root, file)} (${Math.round(bytes.length / 1024)} KB)`);
    return bytes;
  };
  const tiny = dataUrl(at("brand", "icon-tiny.svg"), "image/svg+xml");
  const sourceFor = (size) => (size <= 20 ? tiny : size <= 40 ? small : big);
  const iconPng = (size, w, h) => run(`icon(${JSON.stringify(sourceFor(size))}, ${size}, ${w ?? size}, ${h ?? size})`);

  console.log("Logo pieces for the desktop header:");
  await save(at("web", "app", "public", "mediaverse-emblem.png"), await run(`crop(${JSON.stringify(logo)}, ${JSON.stringify(EMBLEM)}, 6, 320)`));
  await save(at("web", "app", "public", "mediaverse-wordmark.png"), await run(`crop(${JSON.stringify(logo)}, ${JSON.stringify(WORDMARK)}, 4, 160)`));

  console.log("Windows icon (window, taskbar, shortcuts, Settings > Apps):");
  const icoSizes = [16, 20, 24, 32, 40, 48, 64, 128, 256];
  const entries = [];
  for (const size of icoSizes) entries.push({ size, bytes: Buffer.from((await iconPng(size)).split(",")[1], "base64") });
  writeIco(at("web", "app", "electron", "icon.ico"), entries);
  await save(at("web", "app", "electron", "icon.png"), await iconPng(256));
  await save(at("web", "app", "public", "favicon.png"), await iconPng(64));

  console.log("Samsung TV launcher icon (512x423):");
  await save(at("web", "app", "tv", "public", "icon.png"), await iconPng(400, 512, 423));

  console.log("Android launcher icons:");
  for (const [folder, size] of [["mdpi", 48], ["hdpi", 72], ["xhdpi", 96], ["xxhdpi", 144], ["xxxhdpi", 192]]) {
    await save(at("apps", "android", "app", "src", "main", "res", `mipmap-${folder}`, "ic_launcher.png"), await iconPng(size));
  }

  console.log("Previews in brand/png:");
  for (const size of [16, 24, 32, 48, 64, 128, 256, 512, 1024]) await save(at("brand", "png", `icon-${size}.png`), await iconPng(size));
  window.destroy();
}

/** A .ico made of PNG images (Windows Vista and later read these at every size). */
function writeIco(file, entries) {
  const header = Buffer.alloc(6 + 16 * entries.length);
  header.writeUInt16LE(0, 0); header.writeUInt16LE(1, 2); header.writeUInt16LE(entries.length, 4);
  let offset = header.length;
  entries.forEach(({ size, bytes }, i) => {
    const e = 6 + 16 * i;
    header.writeUInt8(size >= 256 ? 0 : size, e); header.writeUInt8(size >= 256 ? 0 : size, e + 1);
    header.writeUInt8(0, e + 2); header.writeUInt8(0, e + 3);
    header.writeUInt16LE(1, e + 4); header.writeUInt16LE(32, e + 6);
    header.writeUInt32LE(bytes.length, e + 8); header.writeUInt32LE(offset, e + 12);
    offset += bytes.length;
  });
  const all = Buffer.concat([header, ...entries.map((e) => e.bytes)]);
  fs.writeFileSync(file, all);
  console.log(`  ${path.relative(root, file)} (${entries.map((e) => e.size).join(", ")} px; ${Math.round(all.length / 1024)} KB)`);
}

app.disableHardwareAcceleration();
app.whenReady().then(main).then(() => app.quit(), (error) => { console.error(error); app.exit(1); });
