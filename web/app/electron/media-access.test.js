const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { test } = require("node:test");
const { resolveAllowedAudio, mimeTypeFor } = require("./media-access");

function setup() {
  const base = fs.mkdtempSync(path.join(os.tmpdir(), "mv-media-"));
  const library = path.join(base, "library");
  const outside = path.join(base, "outside");
  fs.mkdirSync(path.join(library, "Artist"), { recursive: true });
  fs.mkdirSync(outside);
  fs.writeFileSync(path.join(library, "Artist", "song.mp3"), "x");
  fs.writeFileSync(path.join(library, "Artist", "notes.txt"), "x");
  fs.writeFileSync(path.join(outside, "secret.mp3"), "x");
  return { base, library, outside };
}

test("audio inside the library is allowed", () => {
  const { library } = setup();
  const file = path.join(library, "Artist", "song.mp3");
  assert.equal(resolveAllowedAudio(file, library), fs.realpathSync(file));
  assert.equal(resolveAllowedAudio(path.join(library, "Artist", "SONG.MP3"), library).toLowerCase(), fs.realpathSync(file).toLowerCase());
});

test("other file types, outside files and odd paths are refused", () => {
  const { library, outside } = setup();
  assert.throws(() => resolveAllowedAudio(path.join(library, "Artist", "notes.txt"), library), /Only audio/);
  assert.throws(() => resolveAllowedAudio(path.join(outside, "secret.mp3"), library), /outside your music library/);
  assert.throws(() => resolveAllowedAudio(path.join(library, "..", "outside", "secret.mp3"), library), /outside your music library/);
  assert.throws(() => resolveAllowedAudio("relative/song.mp3", library), /not valid/);
  assert.throws(() => resolveAllowedAudio("", library), /not valid/);
  assert.throws(() => resolveAllowedAudio(path.join(library, "Artist", "missing.mp3"), library), /could not be found/);
  assert.throws(() => resolveAllowedAudio(path.join(library, "Artist", "song.mp3"), ""), /No music library/);
  assert.throws(() => resolveAllowedAudio(library, library), /Only audio/);
});

test("a link leading out of the library is refused", (t) => {
  const { library, outside } = setup();
  const link = path.join(library, "escape");
  try {
    fs.symlinkSync(outside, link, "junction");
  } catch {
    t.skip("links cannot be made here");
    return;
  }
  assert.throws(() => resolveAllowedAudio(path.join(link, "secret.mp3"), library), /outside your music library/);
});

test("content types are right for common formats", () => {
  assert.equal(mimeTypeFor("a.MP3"), "audio/mpeg");
  assert.equal(mimeTypeFor("a.flac"), "audio/flac");
  assert.equal(mimeTypeFor("a.xyz"), "application/octet-stream");
});

test("a path from before the library moved plays the same song in the library", () => {
  const { library, outside } = setup();
  fs.mkdirSync(path.join(library, "Band", "Album"), { recursive: true });
  const real = path.join(library, "Band", "Album", "13 - Song.mp3");
  fs.writeFileSync(real, "x");
  // The old place, which still exists and is outside the library, and one that is gone.
  fs.mkdirSync(path.join(outside, "Band", "Album"), { recursive: true });
  fs.writeFileSync(path.join(outside, "Band", "Album", "13 - Song.mp3"), "old");
  assert.equal(resolveAllowedAudio(path.join(outside, "Band", "Album", "13 - Song.mp3"), library), fs.realpathSync(real));
  assert.equal(resolveAllowedAudio("C:\\Users\\Sam\\Music\\Band\\Album\\13 - Song.mp3".replace(/^C:/, path.parse(library).root.replace(/[\\/]$/, "")), library), fs.realpathSync(real));
  // Not in the library, or climbing out: still refused.
  assert.throws(() => resolveAllowedAudio(path.join(outside, "secret.mp3"), library), /outside your music library/);
  assert.throws(() => resolveAllowedAudio(path.join(outside, "Nobody", "Nothing", "1.mp3"), library), /could not be found/);
});
