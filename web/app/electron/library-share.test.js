const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { createLibraryShare, isHomeNetworkAddress, codeMatches, newPairingCode, parseRange, publicTrack, cleanDeviceName, MAX_WRONG_CODES } = require("./library-share");

test("only home-network addresses are accepted", () => {
  for (const ok of ["192.168.1.50", "10.0.0.5", "172.16.0.1", "172.31.255.255", "127.0.0.1", "169.254.1.1", "::1", "::ffff:192.168.1.2", "fe80::1", "fd12:3456::1"]) {
    assert.equal(isHomeNetworkAddress(ok), true, ok);
  }
  for (const bad of ["8.8.8.8", "172.32.0.1", "192.169.0.1", "2001:db8::1", "::ffff:8.8.8.8", "", "999.1.1.1", undefined]) {
    assert.equal(isHomeNetworkAddress(bad), false, String(bad));
  }
});

test("pairing codes are 6 digits and compared exactly, ignoring spaces", () => {
  assert.match(newPairingCode(), /^\d{6}$/);
  assert.equal(codeMatches("123 456", "123456"), true);
  assert.equal(codeMatches("123457", "123456"), false);
  assert.equal(codeMatches("12345", "123456"), false);
  assert.equal(codeMatches(null, "123456"), false);
  assert.equal(cleanDeviceName("  Living <b>room\u0000 "), "Living broom");
  assert.equal(cleanDeviceName(""), null);
});

test("Range headers", () => {
  assert.equal(parseRange(undefined, 100), null);
  assert.deepEqual(parseRange("bytes=0-", 100), { start: 0, end: 99 });
  assert.deepEqual(parseRange("bytes=10-19", 100), { start: 10, end: 19 });
  assert.deepEqual(parseRange("bytes=90-500", 100), { start: 90, end: 99 });
  assert.deepEqual(parseRange("bytes=-10", 100), { start: 90, end: 99 });
  assert.equal(parseRange("bytes=100-", 100), "invalid");
  assert.equal(parseRange("bytes=20-10", 100), "invalid");
  assert.equal(parseRange("bytes=0-1,5-6", 100), null);
});

test("tracks are shared without their file paths", () => {
  const shared = publicTrack({ id: "t1", title: "Song", artist: "A", album: "B", album_artist: null, genre: null, release_year: 1999, track_number: 3, source_uri: "C:\\Music\\A\\B\\03.mp3", suggestions: [] });
  assert.equal(JSON.stringify(shared).includes("Music"), false);
  assert.equal(shared.year, 1999);
  assert.match(shared.cover_key, /^[0-9a-f]{16}$/);
});

test("a running share answers on the loopback address", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mv-share-run-"));
  const settingsFile = path.join(dir, "library-share.json");
  const port = 47100 + Math.floor(Math.random() * 500);
  fs.writeFileSync(settingsFile, JSON.stringify({ enabled: false, port }));
  const root = path.join(dir, "Music");
  fs.mkdirSync(root);
  const song = path.join(root, "01 Song.mp3");
  fs.writeFileSync(song, Buffer.from(Array.from({ length: 1000 }, (_, i) => i % 256)));
  const secret = path.join(dir, "secret.mp3");
  fs.writeFileSync(secret, "private");
  const tracks = [
    { id: "t1", title: "Song", artist: "Artist", album: "Album", source_uri: song },
    { id: "t2", title: "Outside", source_uri: secret },
  ];
  let changes = 0;
  let marked = 0;
  const favorites = [];
  const flags = [];
  const share = createLibraryShare({
    settingsFile,
    onChange: () => changes++,
    onMarks: () => marked++,
    source: {
      favorites: async () => favorites.map((path) => ({ path })),
      flags: async () => flags.map((f) => ({ path: f.path })),
      setFavorite: async (path, args) => {
        const at = favorites.indexOf(path);
        if (args.favorite && at < 0) favorites.push(path);
        if (!args.favorite && at >= 0) favorites.splice(at, 1);
      },
      setFlag: async (path, args) => {
        flags.splice(0, flags.length, ...flags.filter((f) => f.path !== path));
        if (args.flagged) flags.push({ path, ...args });
      },
      playlists: async () => [{ id: "p1", name: "Mix", updated_at: 5, paths: [song, path.join(root, "gone.mp3")] }],
      snapshot: async () => ({ tracks }),
      root: async () => root,
      cover: async () => ({ mime: "image/png", data_base64: Buffer.from("png!").toString("base64"), from: "folder" }),
      lyrics: async () => ({ plain: "la la", synced: false, lines: [], source: "tag" }),
      shrink: async (_bytes, size) => Buffer.from(`small${size}`),
    },
  });
  const base = `http://127.0.0.1:${port}`;
  try {
    assert.equal((await share.setEnabled(true)).running, true);
    assert.equal(JSON.parse(fs.readFileSync(settingsFile, "utf8")).enabled, true);

    const hello = await (await fetch(`${base}/api/hello`)).json();
    assert.equal(hello.app, "MediaVerse Studio");

    assert.equal((await fetch(`${base}/api/library`)).status, 401);
    assert.equal((await fetch(`${base}/api/library?key=${"0".repeat(64)}`)).status, 401);

    // Pairing starts only after someone on the computer presses Pair a TV.
    assert.equal((await fetch(`${base}/api/pair/confirm?code=123456`)).status, 410, "no pairing started");
    assert.equal((await fetch(`${base}/api/pair?name=Living%20room`)).status, 403, "not armed");
    share.armPairing();
    assert.equal(share.status().pairing_armed, true);
    assert.equal((await fetch(`${base}/api/pair?name=Living%20room`)).status, 200);
    assert.equal(changes > 0, true, "Settings told");
    const pairing = share.status().pairing;
    assert.equal(pairing.name, "Living room (127.0.0.1)");
    assert.match(pairing.code, /^\d{6}$/);
    const wrong = pairing.code === "000000" ? "000001" : "000000";
    assert.equal((await fetch(`${base}/api/pair/confirm?code=${wrong}`)).status, 401);
    const confirmed = await fetch(`${base}/api/pair/confirm?code=${pairing.code}`);
    assert.equal(confirmed.status, 200);
    const { key } = await confirmed.json();
    assert.match(key, /^[0-9a-f]{64}$/);
    assert.equal(share.status().pairing, null, "a code works once");
    assert.equal((await fetch(`${base}/api/pair/confirm?code=${pairing.code}`)).status, 410);
    assert.equal(share.status().devices.length, 1);
    const saved = fs.readFileSync(settingsFile, "utf8");
    assert.equal(saved.includes(key), false, "only the key's hash is kept");
    const auth = { Authorization: `Bearer ${key}` };
    assert.equal((await fetch(`${base}/api/library?key=${key}`)).status, 401, "the key is not accepted in the address");

    const library = await fetch(`${base}/api/library`, { headers: auth });
    assert.equal(library.status, 200);
    assert.equal(library.headers.get("access-control-allow-origin"), "*");
    const body = await library.json();
    assert.deepEqual(body.tracks.map((t) => t.id), ["t1", "t2"]);
    // The list goes out packed to whoever accepts that (every browser, so every TV), plain otherwise.
    assert.equal(library.headers.get("content-encoding"), "gzip");
    const ticket = library.headers.get("x-mediaverse-ticket");
    assert.match(ticket, /^[0-9a-f]{48}$/);
    const again = await fetch(`${base}/api/library`, { headers: auth });
    assert.equal(again.headers.get("x-mediaverse-ticket"), ticket, "the same ticket is reused so a playing song keeps working");
    const unpacked = await fetch(`${base}/api/library`, { headers: { ...auth, "Accept-Encoding": "identity" } });
    assert.equal(unpacked.headers.get("content-encoding"), null);
    assert.deepEqual(await unpacked.json(), body);
    assert.equal(JSON.stringify(body).includes(root.replace(/\\/g, "\\\\")), false, "no paths");

    const whole = await fetch(`${base}/api/audio/t1?ticket=${ticket}`);
    assert.equal(whole.status, 200);
    assert.equal(whole.headers.get("content-type"), "audio/mpeg");
    assert.equal((await whole.arrayBuffer()).byteLength, 1000);

    const part = await fetch(`${base}/api/audio/t1?ticket=${ticket}`, { headers: { Range: "bytes=10-19" } });
    assert.equal(part.status, 206);
    assert.equal(part.headers.get("content-range"), "bytes 10-19/1000");
    assert.deepEqual([...new Uint8Array(await part.arrayBuffer())], [10, 11, 12, 13, 14, 15, 16, 17, 18, 19]);

    assert.equal((await fetch(`${base}/api/audio/t1?ticket=${ticket}`, { headers: { Range: "bytes=5000-" } })).status, 416);

    // A track whose file is outside the library folder is refused, as in the app's own player.
    assert.equal((await fetch(`${base}/api/audio/t2?ticket=${ticket}`)).status, 403);
    assert.equal((await fetch(`${base}/api/audio/nope?ticket=${ticket}`)).status, 404);

    // "Play on the TV" (D76): the TV waits for commands; the computer sends the queue as track IDs.
    assert.equal((await fetch(`${base}/api/remote?after=0`)).status, 401, "paired TVs only");
    const first = await (await fetch(`${base}/api/remote?after=-1`, { headers: auth })).json();
    assert.deepEqual(first, { seq: 0, commands: [] }, "the first ask only learns where the list is");
    const listening = share.remoteDevices();
    assert.equal(listening.length, 1);
    const waiting = fetch(`${base}/api/remote?after=0`, { headers: auth }).then((r) => r.json());
    await new Promise((resolve) => setTimeout(resolve, 50));
    await share.sendRemote(listening[0].id, { action: "play", paths: [song, path.join(root, "gone.mp3")], index: 0, position_ms: 1500 });
    const got = await waiting;
    assert.equal(got.seq, 1);
    assert.deepEqual(got.commands, [{ seq: 1, action: "play", ids: ["t1"], index: 0, position_ms: 1500, shuffle: false }], "paths become IDs; unknown ones are left out");
    await assert.rejects(share.sendRemote(listening[0].id, { action: "explode" }));
    const stated = await fetch(`${base}/api/remote/state`, { method: "POST", headers: { ...auth, "Content-Type": "text/plain" }, body: JSON.stringify({ id: "t1", playing: true, position_ms: 2000, duration_ms: 9000 }) });
    assert.equal(stated.status, 204);
    assert.equal(share.remoteDevices()[0].state.path, song, "the TV's song is known by its file on the computer");
    assert.equal(share.remoteDevices()[0].state.playing, true);

    // Playlists for the TV (D82): IDs in order, songs not in the library left out.
    const lists = await (await fetch(`${base}/api/playlists`, { headers: auth })).json();
    assert.deepEqual(lists, { playlists: [{ id: "p1", name: "Mix", updated_at: 5, ids: ["t1"] }] });

    // DLNA links (D77): a token instead of a key, home network only, songs in the library only.
    const link = await share.castLink(song, "127.0.0.1");
    if (link) {
      const local = link.audio.replace(/^http:\/\/[^/]+/, base);
      const cast = await fetch(local);
      assert.equal(cast.status, 200);
      assert.equal(cast.headers.get("transfermode.dlna.org"), "Streaming");
      assert.equal((await cast.arrayBuffer()).byteLength, 1000);
      assert.equal((await fetch(local.replace(/\/cast\/[0-9a-f]{48}/, `/cast/${"0".repeat(48)}`))).status, 404, "a made-up token gets nothing");
      assert.equal((await fetch(link.cover.replace(/^http:\/\/[^/]+/, base))).status, 200);
      assert.equal(await share.castLink(path.join(root, "nope.mp3"), "127.0.0.1"), null);
    }

    const cover = await fetch(`${base}/api/cover/t1?ticket=${ticket}`);
    assert.equal(cover.headers.get("content-type"), "image/png");
    assert.equal(Buffer.from(await cover.arrayBuffer()).toString(), "png!");

    const small = await fetch(`${base}/api/cover/t1?ticket=${ticket}&size=200`);
    assert.equal(small.headers.get("content-type"), "image/jpeg");
    assert.equal(Buffer.from(await small.arrayBuffer()).toString(), "small200");
    assert.equal(Buffer.from(await (await fetch(`${base}/api/cover/t1?ticket=${ticket}&size=5`)).arrayBuffer()).toString(), "png!", "silly sizes get the full cover");

    assert.equal((await (await fetch(`${base}/api/lyrics/t1`, { headers: auth })).json()).plain, "la la");

    assert.equal((await fetch(`${base}/api/library`, { method: "POST", headers: auth })).status, 405);

    // Flags and favorites: the only changes a paired TV can make, by track ID.
    assert.deepEqual(await (await fetch(`${base}/api/marks`, { headers: auth })).json(), { favorites: [], flagged: [] });
    assert.equal((await fetch(`${base}/api/favorite/t1`, { method: "POST", body: "{}" })).status, 401, "not without the key");
    const fav = await fetch(`${base}/api/favorite/t1`, { method: "POST", headers: auth, body: JSON.stringify({ favorite: true }) });
    assert.deepEqual(await fav.json(), { favorites: ["t1"], flagged: [] });
    assert.deepEqual(favorites, [song], "saved by file on the computer");
    const flag = await fetch(`${base}/api/flag/t1`, { method: "POST", headers: auth, body: JSON.stringify({ reasons: ["audio"], position_ms: 4200 }) });
    assert.deepEqual((await flag.json()).flagged, ["t1"]);
    assert.deepEqual([flags[0].reasons, flags[0].position_ms, flags[0].title], [["audio"], 4200, "Song"]);
    await fetch(`${base}/api/favorite/t1`, { method: "POST", headers: auth, body: JSON.stringify({ favorite: false }) });
    assert.deepEqual(favorites, []);
    assert.equal(marked, 3, "the computer's page is told each time");
    assert.equal((await fetch(`${base}/api/favorite/nope`, { method: "POST", headers: auth, body: "{}" })).status, 404);
    assert.equal((await fetch(`${base}/api/flag/t1`, { method: "POST", headers: auth, body: "not json" })).status, 400);
    assert.equal((await fetch(`${base}/api/flag/t1`, { method: "POST", headers: auth, body: "x".repeat(10_000) }).catch(() => ({ status: 0 }))).status !== 200, true, "big bodies are refused");
    assert.equal((await fetch(`${base}/api/audio/t1`, { method: "POST", headers: auth })).status, 405);

    // Removing the TV in Settings stops it; a restart keeps it removed.
    share.forgetDevice(share.status().devices[0].id);
    assert.equal((await fetch(`${base}/api/library`, { headers: auth })).status, 401);

    assert.equal((await share.setEnabled(false)).running, false);
    await assert.rejects(fetch(`${base}/api/hello`));
  } finally {
    await share.stop();
  }
});

test("five wrong pairing codes from one address are refused for 10 minutes", async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mv-share-lock-"));
  const settingsFile = path.join(dir, "library-share.json");
  const port = 47650 + Math.floor(Math.random() * 300);
  fs.writeFileSync(settingsFile, JSON.stringify({ enabled: true, port }));
  const share = createLibraryShare({ settingsFile, source: { snapshot: async () => ({ tracks: [] }), root: async () => dir, cover: async () => null, lyrics: async () => null } });
  try {
    await share.start();
    const base = `http://127.0.0.1:${port}`;
    share.armPairing();
    assert.equal((await fetch(`${base}/api/pair?name=TV`)).status, 200);
    const right = share.status().pairing.code;
    const wrongCodes = ["000000", "111111", "222222", "333333", "444444", "555555"].filter((c) => c !== right).slice(0, MAX_WRONG_CODES);
    for (const wrong of wrongCodes) assert.equal((await fetch(`${base}/api/pair/confirm?code=${wrong}`)).status, 401);
    assert.equal(MAX_WRONG_CODES, 5);
    assert.equal(share.status().pairing, null, "the pairing is cancelled");
    assert.equal((await fetch(`${base}/api/pair/confirm?code=${right}`)).status, 429);
    assert.equal((await fetch(`${base}/api/pair?name=TV`)).status, 429);
    // hello always answers, so the TV can still list this computer.
    assert.equal((await fetch(`${base}/api/hello`)).status, 200);
  } finally {
    await share.stop();
  }
});
