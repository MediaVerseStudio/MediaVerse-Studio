/*
 * Builds the demo library's MP3s (run through tools/make-demo-library.ps1, after render-covers.cjs has drawn the
 * covers): generated audio (soft chords over a beat, so the music glow has something to follow; nothing recorded),
 * tagged and with the cover embedded by the project's own LAME, plus time-stamped .lrc lyrics for some songs.
 *
 *   node tools/demo/make-demo-library.cjs <library-folder> <lame.exe>
 */
const { execFile } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const plan = JSON.parse(fs.readFileSync(path.join(__dirname, "demo-library.json"), "utf8"));
const folder = path.resolve(process.argv[2]);
const lame = path.resolve(process.argv[3]);
const safe = (name) => name.replace(/[\\/:*?"<>|]/g, "_").replace(/\.+$/, "");
const RATE = 22050;

/** A mono 16-bit WAV: three-note chords changing every two bars, a soft kick on each beat. */
function writeWav(file, seconds, seed) {
  const count = Math.round(seconds * RATE);
  const data = Buffer.alloc(count * 2);
  const roots = [220, 196, 174.61, 246.94, 207.65, 185];
  const root = roots[seed % roots.length];
  const progression = [[1, 1.25, 1.5], [0.8909, 1.122, 1.3348], [0.749, 0.9439, 1.1225], [0.8409, 1.0595, 1.26]];
  const bpm = 84 + (seed * 13) % 60;
  const beat = 60 / bpm;
  const fade = Math.min(4, seconds / 10);
  for (let i = 0; i < count; i++) {
    const t = i / RATE;
    const chord = progression[Math.floor(t / (beat * 8)) % progression.length];
    let v = 0;
    for (const ratio of chord) v += Math.sin(2 * Math.PI * root * ratio * t) * 0.18;
    const inBeat = (t % beat) / beat;
    v += Math.sin(2 * Math.PI * 55 * t) * Math.exp(-inBeat * 18) * 0.55; // kick
    v *= 0.55 + 0.45 * Math.exp(-inBeat * 3); // pump with the beat
    const edge = Math.min(1, t / fade, (seconds - t) / fade);
    data.writeInt16LE(Math.max(-32767, Math.min(32767, Math.round(v * edge * 12000))), i * 2);
  }
  const header = Buffer.alloc(44);
  header.write("RIFF", 0); header.writeUInt32LE(36 + data.length, 4); header.write("WAVEfmt ", 8);
  header.writeUInt32LE(16, 16); header.writeUInt16LE(1, 20); header.writeUInt16LE(1, 22); header.writeUInt32LE(RATE, 24);
  header.writeUInt32LE(RATE * 2, 28); header.writeUInt16LE(2, 32); header.writeUInt16LE(16, 34); header.write("data", 36); header.writeUInt32LE(data.length, 40);
  fs.writeFileSync(file, Buffer.concat([header, data]));
}

const mmss = (s) => `${String(Math.floor(s / 60)).padStart(2, "0")}:${(s % 60).toFixed(2).padStart(5, "0")}`;

/** Lyrics spread over the song: blank lines in the text are short gaps between verses. */
function lrc(lines, seconds, tags) {
  const start = 10, end = seconds - 18;
  const slots = lines.length + lines.filter((l) => !l).length * 0.5;
  const step = (end - start) / slots;
  let at = start;
  const out = [`[ar:${tags.artist}]`, `[al:${tags.album}]`, `[ti:${tags.title}]`, "[by:MediaVerse Studio demo library]"];
  for (const line of lines) {
    if (!line) { at += step * 0.5; continue; }
    out.push(`[${mmss(at)}]${line}`);
    at += step;
  }
  return out.join("\n") + "\n";
}

function run(file, args) {
  return new Promise((resolve, reject) => execFile(file, args, { windowsHide: true }, (error) => (error ? reject(error) : resolve())));
}

async function main() {
  const work = fs.mkdtempSync(path.join(os.tmpdir(), "mv-demo-"));
  // A handful of generated pieces of different lengths, shared between songs (it is the tags that matter here).
  const lengths = [168, 187, 203, 214, 226, 239, 251, 262, 278, 295, 311, 334];
  const wavs = lengths.map((seconds, i) => {
    const file = path.join(work, `piece-${i}.wav`);
    writeWav(file, seconds, i);
    return { file, seconds };
  });

  const jobs = [];
  let n = 0;
  for (const album of plan.albums) {
    const albumArtist = album.compilation ? "Various Artists" : album.artist;
    const dir = path.join(folder, safe(albumArtist), safe(album.album));
    const embed = path.join(dir, "cover-embed.jpg");
    const total = album.tracks.length;
    album.tracks.forEach((entry, index) => {
      const title = typeof entry === "string" ? entry : entry.title;
      const artist = typeof entry === "string" ? album.artist : entry.artist;
      const piece = wavs[(n++ * 7) % wavs.length];
      const number = String(index + 1).padStart(2, "0");
      const out = path.join(dir, `${number} - ${safe(title)}.mp3`);
      const args = ["--quiet", "-b", "192", "--id3v2-only", "--ta", artist, "--tl", album.album, "--tt", title,
        "--tn", `${index + 1}/${total}`, "--ty", String(album.year), "--tg", album.genre, "--tv", `TPE2=${albumArtist}`];
      if (album.compilation) args.push("--tv", "TCMP=1");
      if (fs.existsSync(embed)) args.push("--ti", embed);
      jobs.push({ args: [...args, piece.file, out], out });
      const words = plan.lyrics[`${artist}|${title}`];
      if (words) fs.writeFileSync(out.replace(/\.mp3$/, ".lrc"), lrc(words, piece.seconds, { artist, album: album.album, title }));
    });
  }

  const parallel = Math.max(1, os.cpus().length - 1);
  let next = 0;
  await Promise.all(Array.from({ length: parallel }, async () => {
    while (next < jobs.length) {
      const job = jobs[next++];
      await run(lame, job.args);
    }
  }));
  for (const album of plan.albums) {
    const embed = path.join(folder, safe(album.compilation ? "Various Artists" : album.artist), safe(album.album), "cover-embed.jpg");
    fs.rmSync(embed, { force: true });
  }
  fs.rmSync(work, { recursive: true, force: true });
  fs.writeFileSync(path.join(folder, "ABOUT THIS LIBRARY.txt"), plan.about + "\r\n");
  console.log(`Made ${jobs.length} songs in ${plan.albums.length} albums, ${Object.keys(plan.lyrics).length} with lyrics, under ${folder}`);
}

main().catch((error) => { console.error(error); process.exit(1); });
