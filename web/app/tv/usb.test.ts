import assert from "node:assert/strict";
import test from "node:test";

// An in-memory stand-in for Samsung's tizen.filesystem, shaped like the real one (tried on the TV).
const files = new Map<string, Uint8Array>();
const ascii = (text: string) => new TextEncoder().encode(text);
function id3(title: string, artist: string, album: string, track: number): Uint8Array {
  const frame = (id: string, value: string) => {
    const data = new Uint8Array([3, ...ascii(value)]);
    return new Uint8Array([...ascii(id), 0, 0, 0, data.length, 0, 0, ...data]);
  };
  const body = new Uint8Array([...frame("TIT2", title), ...frame("TPE1", artist), ...frame("TALB", album), ...frame("TRCK", String(track))]);
  return new Uint8Array([...ascii("ID3"), 3, 0, 0, 0, 0, (body.length >> 7) & 0x7f, body.length & 0x7f, ...body, 0xff, 0xfb, 0, 0]);
}
files.set("removable_sda1/Bracket/4-Wheel Vibe/01 Trailer Park.mp3", id3("Trailer Park", "Bracket", "4-Wheel Vibe", 1));
files.set("removable_sda1/Bracket/4-Wheel Vibe/02 Warren's Song.mp3", id3("Warren's Song Pt. 3", "Bracket", "4-Wheel Vibe", 2));
files.set("removable_sda1/Bracket/4-Wheel Vibe/cover.jpg", new Uint8Array([0xff, 0xd8]));
files.set("removable_sda1/Untagged/Some Album/07 - Plain Song.flac", new Uint8Array([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]));
files.set("removable_sda1/notes.txt", ascii("not music"));
files.set("removable_sda1/._hidden.mp3", new Uint8Array(4));

const isDirectory = (path: string) => [...files.keys()].some((file) => file.startsWith(`${path}/`));
const fakeFs = {
  listStorages: (ok: (s: unknown[]) => void) => ok([{ label: "internal0", type: "INTERNAL", state: "MOUNTED" }, { label: "removable_sda1", type: "EXTERNAL", state: "MOUNTED" }]),
  listDirectory: (path: string, ok: (names: string[]) => void) =>
    ok([...new Set([...files.keys()].filter((file) => file.startsWith(`${path}/`)).map((file) => file.slice(path.length + 1).split("/")[0]))]),
  isDirectory,
  openFile: (path: string) => {
    const data = files.get(path);
    if (!data) throw new Error("NotFoundError");
    return { readData: (size?: number) => data.slice(0, size ?? data.length), seek: () => 0, close: () => undefined };
  },
  toURI: (path: string) => `file:///media/${path}`,
};
(globalThis as unknown as { window: unknown }).window = { tizen: { filesystem: fakeFs } };

const { listDrives, scanDrive } = await import("./usb.ts");

test("only mounted external storages are offered as drives", async () => {
  assert.deepEqual(await listDrives(), [{ label: "removable_sda1" }]);
});

test("a drive is walked for music, with tags, file names and folder pictures", async () => {
  const counts: number[] = [];
  const library = await scanDrive({ label: "removable_sda1" }, (n) => counts.push(n), { stopped: false });
  const byTitle = Object.fromEntries(library.tracks.map((t) => [t.title, t]));
  assert.deepEqual(Object.keys(byTitle).sort(), ["Plain Song", "Trailer Park", "Warren's Song Pt. 3"]);
  assert.equal(byTitle["Trailer Park"].artist, "Bracket");
  assert.equal(byTitle["Warren's Song Pt. 3"].track_number, 2);
  assert.deepEqual([byTitle["Plain Song"].album, byTitle["Plain Song"].artist, byTitle["Plain Song"].track_number], ["Some Album", "Untagged", 7]);
  const trailer = byTitle["Trailer Park"];
  assert.equal(library.audio.get(trailer.id), "file:///media/removable_sda1/Bracket/4-Wheel Vibe/01 Trailer Park.mp3");
  assert.equal(library.covers.get(trailer.cover_key), "file:///media/removable_sda1/Bracket/4-Wheel Vibe/cover.jpg");
  assert.equal(library.covers.has(byTitle["Plain Song"].cover_key), false);
  assert.equal(counts.at(-1), 3);
});

test("a stopped scan stops", async () => {
  const library = await scanDrive({ label: "removable_sda1" }, () => undefined, { stopped: true });
  assert.equal(library.tracks.length, 0);
});
