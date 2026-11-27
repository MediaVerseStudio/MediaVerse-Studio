const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { createLibraryShare } = require("./library-share");
const { syncList, syncIdOf, cleanUploadPath, placeFile } = require("./share-sync");

const folder = (name) => fs.mkdtempSync(path.join(os.tmpdir(), `mv-sync-${name}-`));

test("a song is named by its place in the library, the same wherever the library is", () => {
  const a = syncIdOf(path.join("C:", "Music", "Band", "Song.mp3"), path.join("C:", "Music"));
  assert.match(a, /^[0-9a-f]{32}$/);
  assert.equal(syncIdOf(path.join("D:", "Moved", "band", "song.MP3"), path.join("D:", "Moved")), a);
  assert.notEqual(syncIdOf(path.join("C:", "Music", "Band", "Other.mp3"), path.join("C:", "Music")), a);
});

test("an unreadable music folder is an error, not an empty library", async () => {
  const tracks = Array.from({ length: 10 }, (_, i) => ({ id: `t${i}`, title: `S${i}`, source_uri: path.join("Z:", "gone", `${i}.mp3`) }));
  await assert.rejects(syncList(tracks, path.join("Z:", "gone"), async () => { throw new Error("ENOENT"); }), /cannot be read/);
  await assert.rejects(syncList([], path.join("Z:", "gone")), /empty/);
  const some = await syncList(tracks, path.join("Z:", "gone"), async (file) => {
    if (file.endsWith("3.mp3")) throw new Error("ENOENT");
    return { size: 10, mtimeMs: 5 };
  });
  assert.equal(some.list.length, 9);
  assert.equal(some.list[0].etag, "10-5");
});

test("only plain song paths are accepted from a phone", () => {
  assert.deepEqual(cleanUploadPath("Band/Record/01 Song.mp3"), ["Band", "Record", "01 Song.mp3"]);
  for (const bad of ["../x.mp3", "a/../../x.mp3", "C:/x.mp3", "a\\b.mp3", "a//b.mp3", "run.exe", "a/b.mp3.", "nul.mp3", "a/con/x.mp3", "", "1/2/3/4/5/6/7.mp3", null]) {
    assert.equal(cleanUploadPath(bad), null, String(bad));
  }
});

test("a received song never writes over another", async () => {
  const dir = folder("place");
  const temp = path.join(dir, "in.part");
  const put = async (text) => {
    fs.writeFileSync(temp, text);
    return placeFile(temp, path.join(dir, "Incoming"), ["Band", "Song.mp3"]);
  };
  assert.equal(path.basename((await put("one")).saved), "Song.mp3");
  assert.equal((await put("one")).already, true);
  const second = await put("two");
  assert.equal(path.basename(second.saved), "Song (2).mp3");
  assert.equal(fs.readFileSync(path.join(dir, "Incoming", "Band", "Song.mp3"), "utf8"), "one");
});

test("a paired phone syncs favorites, flags, playlists and new music; a TV cannot", async () => {
  const dir = folder("run");
  const settingsFile = path.join(dir, "library-share.json");
  const port = 47600 + Math.floor(Math.random() * 300);
  fs.writeFileSync(settingsFile, JSON.stringify({ enabled: false, port }));
  const root = path.join(dir, "Music");
  fs.mkdirSync(root);
  const [one, two] = ["one.mp3", "two.mp3"].map((n) => path.join(root, n));
  fs.writeFileSync(one, "first song");
  fs.writeFileSync(two, "second song");
  const tracks = [{ id: "track-1", title: "One", artist: "A", source_uri: one }, { id: "track-2", title: "Two", artist: "A", source_uri: two }];
  const favorites = new Set();
  const flags = new Set();
  let lists = [{ id: "p1", name: "Mix", paths: [one] }];
  let marked = 0;
  const share = createLibraryShare({
    settingsFile,
    onMarks: () => marked++,
    source: {
      snapshot: async () => ({ tracks }),
      root: async () => root,
      cover: async () => null,
      lyrics: async () => null,
      favorites: async () => [...favorites].map((p) => ({ path: p })),
      flags: async () => [...flags].map((p) => ({ path: p })),
      playlists: async () => lists.map((l) => ({ ...l, paths: [...l.paths] })),
      setFavorite: async (p, { favorite }) => void (favorite ? favorites.add(p) : favorites.delete(p)),
      setFlag: async (p, { flagged }) => void (flagged ? flags.add(p) : flags.delete(p)),
      savePlaylist: async ({ id, name, paths }) => {
        // a slow save, so two changes arriving together would overlap if they were not taken in turn
        await new Promise((resolve) => setTimeout(resolve, 20));
        const entry = { id: id ?? `p${lists.length + 1}`, name, paths };
        lists = id ? lists.map((l) => (l.id === id ? entry : l)) : [...lists, entry];
        return { playlist: entry };
      },
      deletePlaylist: async (id) => void (lists = lists.filter((l) => l.id !== id)),
      incoming: async () => path.join(dir, "Incoming"),
    },
  });
  const base = `http://127.0.0.1:${port}`;
  const pair = async (kind) => {
    share.armPairing();
    assert.equal((await fetch(`${base}/api/pair?name=Device${kind}`)).status, 200);
    const { code } = share.status().pairing;
    return (await (await fetch(`${base}/api/pair/confirm?code=${code}`)).json()).key;
  };
  try {
    await share.setEnabled(true);
    const tvKey = await pair("");
    const phoneKey = await pair("&kind=phone");
    assert.deepEqual(share.status().devices.map((d) => d.phone), [false, true]);
    const as = (key) => ({
      get: (p) => fetch(`${base}${p}`, { headers: { Authorization: `Bearer ${key}` } }),
      post: (p, body) => fetch(`${base}${p}`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body: JSON.stringify(body) }),
    });
    const tv = as(tvKey);
    const phone = as(phoneKey);
    assert.equal((await tv.get("/api/sync/library")).status, 403);
    assert.equal((await tv.post("/api/sync/playlist/delete", { id: "p1" })).status, 403);
    assert.equal((await fetch(`${base}/api/sync/library`)).status, 401);

    const listed = (await (await phone.get("/api/sync/library")).json()).tracks;
    assert.equal(listed.length, 2);
    assert.equal(JSON.stringify(listed).includes("Music"), false, "no paths");
    const [first, second] = listed.map((t) => t.id);
    assert.equal(await (await phone.get(`/api/audio/${first}`)).text(), "first song");
    const part = await fetch(`${base}/api/audio/${first}`, { headers: { Authorization: `Bearer ${phoneKey}`, Range: "bytes=0-4" } });
    assert.equal(part.status, 206);
    assert.equal(await part.text(), "first");

    assert.equal((await phone.post("/api/sync/favorite", { id: second, on: true })).status, 200);
    assert.equal((await phone.post("/api/sync/flag", { id: first, on: true })).status, 200);
    const flaggedOnce = marked;
    assert.equal((await phone.post("/api/sync/flag", { id: first, on: true })).status, 200);
    assert.equal(marked, flaggedOnce, "a song already flagged is not written again");
    assert.equal((await phone.post("/api/sync/favorite", { id: "f".repeat(32), on: true })).status, 404);
    let state = await (await phone.get("/api/sync/state")).json();
    assert.deepEqual(state.favorites, [second]);
    assert.deepEqual(state.flagged, [first]);
    assert.deepEqual(state.playlists, [{ id: "p1", name: "Mix", ids: [first] }]);
    assert.deepEqual(state.unavailable, []);
    // A list holding a song that cannot be named is marked, and not changed from a phone.
    const mix = lists;
    lists = [{ id: "p1", name: "Mix", paths: [one, path.join(root, "Gone", "lost.mp3")] }];
    assert.equal((await (await phone.get("/api/sync/state")).json()).playlists[0].partial, true);
    assert.equal((await phone.post("/api/sync/playlist/edit", { id: "p1", add: [second] })).status, 409);
    assert.equal((await phone.post("/api/sync/playlist/create", { name: "Mix", ids: [second] })).status, 409);
    assert.equal(lists[0].paths.length, 2);
    // A list kept from before the library moved still means the same songs.
    lists = [{ id: "p1", name: "Mix", paths: [path.join("X:", "Old", path.basename(dir), "Music", "one.mp3")] }];
    assert.deepEqual((await (await phone.get("/api/sync/state")).json()).playlists, [{ id: "p1", name: "Mix", ids: [first] }]);
    lists = mix;
    // A heart on a song the library no longer lists is named as unavailable, not silently dropped.
    favorites.add(path.join(root, "Gone", "lost.mp3"));
    assert.deepEqual((await (await phone.get("/api/sync/state")).json()).unavailable, [syncIdOf(path.join(root, "Gone", "lost.mp3"), root)]);
    favorites.delete(path.join(root, "Gone", "lost.mp3"));
    assert.equal(marked >= 2, true);

    // Two changes at once are both kept.
    await Promise.all([phone.post("/api/sync/playlist/edit", { id: "p1", add: [second] }), phone.post("/api/sync/playlist/edit", { id: "p1", remove: [first] })]);
    assert.deepEqual(lists[0].paths, [two]);
    // A playlist made again under the same name is added to, not doubled.
    await phone.post("/api/sync/playlist/create", { name: "mix", ids: [first] });
    assert.equal(lists.length, 1);
    assert.deepEqual(lists[0].paths, [two, one]);
    await phone.post("/api/sync/playlist/delete", { id: "p1" });
    assert.equal(lists.length, 0);
    const kept = JSON.parse(fs.readFileSync(path.join(dir, "playlists-removed-by-phones.json"), "utf8"));
    assert.equal(kept[0].name, "Mix");

    // New music: refused until the owner allows it.
    const upload = (name, body, key = phoneKey) => fetch(`${base}/api/sync/upload?path=${encodeURIComponent(name)}`, { method: "POST", headers: { Authorization: `Bearer ${key}` }, body });
    assert.equal((await upload("Band/New.mp3", "new")).status, 403);
    share.setUploads(true);
    assert.equal((await upload("Band/New.mp3", "new")).status, 200);
    assert.equal((await upload("../escape.mp3", "x")).status, 400);
    assert.equal((await upload("Band/New.mp3", "x", tvKey)).status, 403);
    assert.equal(fs.readFileSync(path.join(dir, "Incoming", "Band", "New.mp3"), "utf8"), "new");
    // A song cut short on the way leaves nothing behind.
    await new Promise((resolve) => {
      const cut = http.request({ host: "127.0.0.1", port, method: "POST", path: "/api/sync/upload?path=Cut.mp3", headers: { Authorization: `Bearer ${phoneKey}`, "Content-Length": "1000" } });
      cut.on("error", () => {});
      cut.write("only this", () => setTimeout(() => (cut.destroy(), setTimeout(resolve, 150)), 50));
    });
    assert.deepEqual(fs.readdirSync(path.join(dir, "Incoming")), ["Band"]);
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).devices.filter((d) => d.sync).length, 1);
  } finally {
    await share.stop();
  }
});
