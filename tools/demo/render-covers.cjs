/*
 * Draws the demo library's album covers (tools/make-demo-library.ps1): original artwork made from shapes and type,
 * one style per album from tools/demo/demo-library.json. Runs in the app's own Electron (canvas), no image tools.
 *
 *   electron tools/demo/render-covers.cjs <library-folder>
 *
 * Writes <folder>/<artist>/<album>/cover.jpg (1000 px, the folder cover) and cover-embed.jpg (500 px, small enough
 * for LAME to embed in each MP3).
 */
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const plan = JSON.parse(fs.readFileSync(path.join(__dirname, "demo-library.json"), "utf8"));
const folder = path.resolve(process.argv[process.argv.length - 1]);
const safe = (name) => name.replace(/[\\/:*?"<>|]/g, "_").replace(/\.+$/, "");

const pageCode = String.raw`
function rng(seed) { let s = 0; for (const c of seed) s = (s * 31 + c.charCodeAt(0)) >>> 0; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
function hexA(hex, a) { const n = parseInt(hex.slice(1), 16); return "rgba(" + (n >> 16) + "," + ((n >> 8) & 255) + "," + (n & 255) + "," + a + ")"; }

const styles = {
  moon(g, S, [bg, accent, light], r) {
    const sky = g.createLinearGradient(0, 0, 0, S); sky.addColorStop(0, bg); sky.addColorStop(0.62, hexA(accent, 0.55)); sky.addColorStop(0.62, "#05080e"); sky.addColorStop(1, bg);
    g.fillStyle = sky; g.fillRect(0, 0, S, S);
    g.fillStyle = light; g.beginPath(); g.arc(S * 0.66, S * 0.3, S * 0.12, 0, Math.PI * 2); g.fill();
    for (let i = 0; i < 26; i++) { const y = S * 0.64 + i * S * 0.014; g.fillStyle = hexA(light, 0.5 - i * 0.017); const w = S * (0.22 - i * 0.006) * (0.7 + r() * 0.6); g.fillRect(S * 0.66 - w / 2, y, w, S * 0.004); }
    g.fillStyle = "#05080e"; g.beginPath(); g.moveTo(0, S * 0.62); for (let x = 0; x <= S; x += S / 40) g.lineTo(x, S * 0.62 - (Math.sin(x * 0.02) + 1) * S * 0.01 - (x > S * 0.1 && x < S * 0.34 ? S * 0.05 : 0)); g.lineTo(S, S * 0.63); g.lineTo(0, S * 0.63); g.fill();
  },
  sunset(g, S, [bg, accent, light], r) {
    const sky = g.createLinearGradient(0, 0, 0, S); sky.addColorStop(0, bg); sky.addColorStop(0.55, accent); sky.addColorStop(1, light);
    g.fillStyle = sky; g.fillRect(0, 0, S, S);
    const sun = g.createLinearGradient(0, S * 0.3, 0, S * 0.72); sun.addColorStop(0, light); sun.addColorStop(1, accent);
    g.fillStyle = sun; g.beginPath(); g.arc(S / 2, S * 0.56, S * 0.24, Math.PI, 0); g.fill();
    for (let i = 0; i < 7; i++) { g.fillStyle = bg; g.fillRect(S * 0.2, S * 0.4 + i * i * S * 0.0035 + i * S * 0.012, S * 0.6, S * (0.004 + i * 0.0025)); }
    g.fillStyle = bg; g.fillRect(0, S * 0.56, S, S * 0.44);
    for (let i = 0; i < 12; i++) { g.fillStyle = hexA(accent, 0.6 - i * 0.045); g.fillRect(S * (0.3 + r() * 0.05), S * (0.6 + i * 0.03), S * (0.4 - i * 0.025), S * 0.006); }
  },
  bloom(g, S, [bg, accent, light], r) {
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    g.filter = "blur(" + S * 0.05 + "px)";
    for (let i = 0; i < 9; i++) { g.fillStyle = hexA(i % 2 ? accent : light, 0.55); g.beginPath(); g.arc(S * (0.15 + r() * 0.7), S * (0.15 + r() * 0.6), S * (0.12 + r() * 0.18), 0, Math.PI * 2); g.fill(); }
    g.filter = "none";
    const grain = g.getImageData(0, 0, S, S); for (let i = 0; i < grain.data.length; i += 4) { const n = (r() - 0.5) * 18; grain.data[i] += n; grain.data[i + 1] += n; grain.data[i + 2] += n; } g.putImageData(grain, 0, 0);
  },
  stripes(g, S, [bg, accent, light], r) {
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    g.save(); g.translate(S / 2, S / 2); g.rotate(-Math.PI / 5);
    const colors = [accent, light, bg, accent];
    for (let i = -10; i < 10; i++) { g.fillStyle = colors[(i + 20) % colors.length]; g.fillRect(i * S * 0.09, -S, S * 0.06 + (i % 3 === 0 ? S * 0.03 : 0), S * 2); }
    g.restore();
    g.fillStyle = hexA(bg, 0.85); g.fillRect(S * 0.08, S * 0.62, S * 0.84, S * 0.3);
  },
  orbit(g, S, [bg, accent, light], r) {
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 160; i++) { g.fillStyle = hexA(light, r() * 0.8); g.fillRect(r() * S, r() * S, S * 0.002, S * 0.002); }
    g.lineWidth = S * 0.004;
    for (let i = 1; i <= 7; i++) { g.strokeStyle = hexA(i === 4 ? accent : light, i === 4 ? 0.95 : 0.25); g.beginPath(); g.ellipse(S / 2, S * 0.42, S * 0.06 * i, S * 0.022 * i, -0.35, 0, Math.PI * 2); g.stroke(); }
    const planet = g.createRadialGradient(S * 0.47, S * 0.39, S * 0.01, S / 2, S * 0.42, S * 0.07); planet.addColorStop(0, light); planet.addColorStop(1, accent);
    g.fillStyle = planet; g.beginPath(); g.arc(S / 2, S * 0.42, S * 0.07, 0, Math.PI * 2); g.fill();
    g.fillStyle = accent; g.beginPath(); g.arc(S * 0.74, S * 0.31, S * 0.014, 0, Math.PI * 2); g.fill();
  },
  dots(g, S, [bg, accent, light], r) {
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    const step = S / 22;
    for (let y = step / 2; y < S; y += step) for (let x = step / 2; x < S; x += step) {
      const d = Math.hypot(x - S * 0.5, y - S * 0.4) / S; const size = Math.max(0, 0.5 - d) * step * 1.25;
      g.fillStyle = d < 0.18 ? light : accent; g.beginPath(); g.arc(x, y, size, 0, Math.PI * 2); g.fill();
    }
  },
  waves(g, S, [bg, accent, light], r) {
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    for (let i = 0; i < 18; i++) {
      g.strokeStyle = hexA(i % 3 === 0 ? light : accent, 0.25 + (i / 18) * 0.7); g.lineWidth = S * 0.006;
      g.beginPath(); const base = S * (0.1 + i * 0.045); const amp = S * (0.015 + r() * 0.02); const phase = r() * 6;
      for (let x = 0; x <= S; x += S / 100) g.lineTo(x, base + Math.sin(x / S * 9 + phase) * amp);
      g.stroke();
    }
  },
  mountains(g, S, [bg, accent, light], r) {
    const sky = g.createLinearGradient(0, 0, 0, S); sky.addColorStop(0, light); sky.addColorStop(1, accent);
    g.fillStyle = sky; g.fillRect(0, 0, S, S);
    for (let layer = 0; layer < 5; layer++) {
      g.fillStyle = layer === 4 ? bg : hexA(bg, 0.25 + layer * 0.17);
      g.beginPath(); g.moveTo(0, S); let y = S * (0.35 + layer * 0.1);
      for (let x = 0; x <= S; x += S / 14) { y += (r() - 0.5) * S * 0.09; g.lineTo(x, Math.min(S * 0.9, Math.max(S * 0.25, y))); }
      g.lineTo(S, S); g.fill();
    }
  },
  grid(g, S, [bg, accent, light], r) {
    const sky = g.createLinearGradient(0, 0, 0, S * 0.55); sky.addColorStop(0, bg); sky.addColorStop(1, hexA(accent, 0.5));
    g.fillStyle = sky; g.fillRect(0, 0, S, S * 0.55); g.fillStyle = bg; g.fillRect(0, S * 0.55, S, S * 0.45);
    const sun = g.createLinearGradient(0, S * 0.2, 0, S * 0.55); sun.addColorStop(0, light); sun.addColorStop(1, accent);
    g.fillStyle = sun; g.beginPath(); g.arc(S / 2, S * 0.55, S * 0.2, Math.PI, 0); g.fill();
    g.strokeStyle = light; g.lineWidth = S * 0.003;
    for (let i = 0; i < 12; i++) { const y = S * 0.55 + Math.pow(i / 12, 2) * S * 0.45; g.globalAlpha = 0.3 + i / 18; g.beginPath(); g.moveTo(0, y); g.lineTo(S, y); g.stroke(); }
    for (let i = -10; i <= 10; i++) { g.globalAlpha = 0.6; g.beginPath(); g.moveTo(S / 2 + i * S * 0.02, S * 0.55); g.lineTo(S / 2 + i * S * 0.16, S); g.stroke(); }
    g.globalAlpha = 1;
  },
  burst(g, S, [bg, accent, light], r) {
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    g.save(); g.translate(S * 0.5, S * 0.42);
    for (let i = 0; i < 24; i++) { g.fillStyle = i % 2 ? accent : bg; g.beginPath(); g.moveTo(0, 0); g.arc(0, 0, S, (i / 24) * Math.PI * 2, ((i + 1) / 24) * Math.PI * 2); g.fill(); }
    g.fillStyle = light; g.beginPath(); for (let i = 0; i < 32; i++) { const a = (i / 32) * Math.PI * 2; const rad = S * (i % 2 ? 0.17 : 0.24); g.lineTo(Math.cos(a) * rad, Math.sin(a) * rad); } g.fill();
    g.restore();
    g.fillStyle = bg; g.fillRect(0, S * 0.66, S, S * 0.34);
  },
  noise(g, S, [bg, accent, light], r) {
    g.fillStyle = bg; g.fillRect(0, 0, S, S);
    g.fillStyle = accent; g.fillRect(S * 0.08, S * 0.08, S * 0.84, S * 0.5);
    g.fillStyle = bg; for (let i = 0; i < 5; i++) g.fillRect(S * 0.08, S * (0.12 + i * 0.1), S * (0.2 + r() * 0.6), S * 0.035);
    const grain = g.getImageData(0, 0, S, S); for (let i = 0; i < grain.data.length; i += 4) { const n = (r() - 0.5) * 34; grain.data[i] += n; grain.data[i + 1] += n; grain.data[i + 2] += n; } g.putImageData(grain, 0, 0);
  },
};

// Every style leaves a dark band at the bottom for the type, so it is always set in the light colour.
const lightText = { moon: 1, bloom: 1, stripes: 1, orbit: 1, dots: 1, waves: 1, grid: 1, noise: 1, sunset: 1, mountains: 1, burst: 1 };
async function cover(album, size) {
  const c = document.createElement("canvas"); c.width = c.height = size; const g = c.getContext("2d");
  const r = rng(album.artist + album.album);
  styles[album.style](g, size, album.colors, r);
  const [bg, accent, light] = album.colors;
  const textColor = lightText[album.style] ? light : bg;
  const serif = /Jazz|Folk|Americana|Ambient/.test(album.genre);
  const heavy = /Punk|Power Pop/.test(album.genre);
  g.textBaseline = "alphabetic"; g.fillStyle = textColor;
  const titleFont = (px) => (heavy ? "900 " + px + "px Impact, 'Arial Black', sans-serif" : serif ? "italic 600 " + px + "px Georgia, serif" : "300 " + px + "px 'Segoe UI Light', 'Segoe UI', sans-serif");
  let px = size * 0.1; g.font = titleFont(px);
  const title = heavy ? album.album.toUpperCase() : album.album;
  while (g.measureText(title).width > size * 0.84 && px > size * 0.04) { px *= 0.92; g.font = titleFont(px); }
  g.fillText(title, size * 0.08, size * 0.84);
  g.font = (serif ? "500 " : "600 ") + Math.round(size * 0.034) + "px 'Segoe UI', sans-serif";
  g.globalAlpha = 0.85;
  g.fillText(album.compilation ? "VARIOUS ARTISTS" : album.artist.toUpperCase(), size * 0.08, size * 0.84 - px * 1.05);
  g.globalAlpha = 1;
  return c.toDataURL("image/jpeg", size >= 1000 ? 0.9 : 0.82);
}
`;

async function main() {
  const window = new BrowserWindow({ show: false, webPreferences: { offscreen: true, sandbox: true } });
  await window.loadURL("data:text/html,<!doctype html><title>covers</title>");
  await window.webContents.executeJavaScript(pageCode + "; window.cover = cover; 0");
  for (const album of plan.albums) {
    const dir = path.join(folder, safe(album.compilation ? "Various Artists" : album.artist), safe(album.album));
    fs.mkdirSync(dir, { recursive: true });
    for (const [name, size] of [["cover.jpg", 1000], ["cover-embed.jpg", 500]]) {
      const url = await window.webContents.executeJavaScript(`cover(${JSON.stringify(album)}, ${size})`);
      fs.writeFileSync(path.join(dir, name), Buffer.from(url.split(",")[1], "base64"));
    }
    console.log(`  cover: ${album.artist} - ${album.album}`);
  }
  window.destroy();
}

app.disableHardwareAcceleration();
app.whenReady().then(main).then(() => app.quit(), (error) => { console.error(error); app.exit(1); });
