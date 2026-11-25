const test = require("node:test");
const assert = require("node:assert/strict");
const { createJellyfinStream, songIdOf, lyricsFromJellyfin } = require("./jellyfin-stream");

const ID = "0123456789abcdef0123456789abcdef";
const SESSION = { base: "http://192.168.68.13:8096", token: "secret-token", userId: "u1", deviceId: "dev-1" };

function recorder(answer) {
  const calls = [];
  const fetchImpl = async (url, options = {}) => {
    calls.push({ url: String(url), headers: options.headers ?? {} });
    return answer(String(url), options);
  };
  return { fetchImpl, calls };
}

const request = (path, headers = {}) => new Request(`mediaverse-media://jellyfin/${path}`, { headers });

test("a song of the server is told from anything else", () => {
  assert.equal(songIdOf(`jellyfin:${ID}/${ID}`), ID);
  assert.equal(songIdOf(`jellyfin:loose/${ID.toUpperCase()}`), ID);
  for (const bad of ["jellyfin:abc", `jellyfin:a/b`, "C:\\Music\\a.mp3", `jellyfin:../x/${ID}`, `jellyfin:a/${ID}/x`]) assert.equal(songIdOf(bad), null, bad);
});

test("nothing is fetched before a sign-in, for a bad id, or from a server outside the home network", async () => {
  const { fetchImpl, calls } = recorder(() => new Response("x"));
  const stream = createJellyfinStream({ fetchImpl, resolve: async () => [{ address: "192.168.68.13" }] });
  assert.equal((await stream.serve(request(ID))).status, 502, "not signed in");
  stream.setSession(SESSION);
  assert.equal((await stream.serve(request("not-an-id"))).status, 400);
  assert.equal((await stream.serve(request(`${ID}/../../etc`))).status, 400, "a path trick leaves no id");
  assert.equal(calls.length, 0);
  stream.setSession({ ...SESSION, base: "http://8.8.8.8:8096" });
  const outside = await stream.serve(request(ID));
  assert.equal(outside.status, 502);
  assert.match(await outside.text(), /home network/);
  const named = createJellyfinStream({ fetchImpl, resolve: async () => [{ address: "192.168.68.13" }, { address: "93.184.216.34" }] });
  named.setSession({ ...SESSION, base: "http://music.example.com:8096" });
  assert.equal((await named.serve(request(ID))).status, 502, "a name that also points outside is refused");
  assert.ok(calls.every((c) => !c.url.includes("8.8.8.8") && !c.url.includes("example.com")), "no request went out");
});

test("the song is fetched with the sign-in and the byte range, and the answer keeps what seeking needs", async () => {
  const { fetchImpl, calls } = recorder(
    () => new Response("abc", { status: 206, headers: { "Content-Type": "audio/mpeg", "Content-Length": "3", "Content-Range": "bytes 10-12/1000", "Set-Cookie": "x=1" } }),
  );
  const stream = createJellyfinStream({ fetchImpl });
  stream.setSession(SESSION);
  const reply = await stream.serve(request(ID, { Range: "bytes=10-12" }));
  assert.equal(reply.status, 206);
  assert.equal(reply.headers.get("content-range"), "bytes 10-12/1000");
  assert.equal(reply.headers.get("content-type"), "audio/mpeg");
  assert.equal(reply.headers.get("accept-ranges"), "bytes");
  assert.equal(reply.headers.get("access-control-allow-origin"), "*");
  assert.equal(reply.headers.get("set-cookie"), null, "only the headers a player needs are passed on");
  assert.equal(await reply.text(), "abc");
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, `http://192.168.68.13:8096/Audio/${ID}/stream?static=true`);
  assert.equal(calls[0].headers.Range, "bytes=10-12");
  assert.match(calls[0].headers.Authorization, /^MediaBrowser Client="MediaVerse Studio", Device="Computer", DeviceId="dev-1", Version="1", Token="secret-token"$/);
});

test("a refused sign-in and a server error are told apart", async () => {
  let status = 401;
  const { fetchImpl } = recorder(() => new Response("no", { status }));
  const stream = createJellyfinStream({ fetchImpl });
  stream.setSession(SESSION);
  const signedOut = await stream.serve(request(ID));
  assert.equal(signedOut.status, 403);
  assert.match(await signedOut.text(), /Sign in again/);
  status = 500;
  assert.equal((await stream.serve(request(ID))).status, 502);
  status = 404;
  assert.equal((await stream.serve(request(ID))).status, 502);
});

test("a sign-in with an odd address or no token is refused, and null forgets it", async () => {
  const stream = createJellyfinStream({ fetchImpl: async () => new Response("x") });
  assert.throws(() => stream.setSession({ ...SESSION, base: "ftp://192.168.1.2" }));
  assert.throws(() => stream.setSession({ ...SESSION, base: "http://user:pw@192.168.1.2" }));
  assert.throws(() => stream.setSession({ ...SESSION, token: "" }));
  stream.setSession(SESSION);
  stream.setSession(null);
  assert.equal((await stream.serve(request(ID))).status, 502);
});

test("Jellyfin's lyrics become timed lines, or plain words when they have no times", () => {
  assert.equal(lyricsFromJellyfin(null), null);
  assert.equal(lyricsFromJellyfin({ Lyrics: [{ Text: "  " }] }), null);
  assert.deepEqual(lyricsFromJellyfin({ Lyrics: [{ Text: "one", Start: 12_340_000 }, { Text: "two", Start: 50_000_000 }] }), { synced: true, lines: [{ ms: 1234, text: "one" }, { ms: 5000, text: "two" }], plain: "one\ntwo" });
  assert.deepEqual(lyricsFromJellyfin({ Lyrics: [{ Text: "one" }, { Text: "two" }] }), { synced: false, lines: [], plain: "one\ntwo" });
});

test("a cast device is given a link to the server with the song's facts", async () => {
  const { fetchImpl, calls } = recorder((url) => {
    if (url.includes("/Lyrics")) return new Response(JSON.stringify({ Lyrics: [{ Text: "la", Start: 10_000_000 }] }), { status: 200 });
    if (url.includes("/Users/u1/Items/")) {
      return new Response(JSON.stringify({ Name: "Song", Artists: ["Band"], AlbumArtist: "Band", Album: "Record", AlbumId: "abcabcabcabcabcabcabcabcabcabcab", RunTimeTicks: 2_450_000_000, Container: "flac" }), { status: 200 });
    }
    return new Response("?", { status: 404 });
  });
  const stream = createJellyfinStream({ fetchImpl });
  stream.setSession(SESSION);
  const info = await stream.castInfo(ID);
  assert.equal(info.url, `http://192.168.68.13:8096/Audio/${ID}/stream?static=true&api_key=secret-token`);
  assert.equal(info.mime, "audio/flac");
  assert.deepEqual([info.title, info.artist, info.album, info.seconds], ["Song", "Band", "Record", 245]);
  assert.equal(info.cover, "http://192.168.68.13:8096/Items/abcabcabcabcabcabcabcabcabcabcab/Images/Primary?maxWidth=800&api_key=secret-token");
  assert.deepEqual(info.lyrics, { synced: true, lines: [{ ms: 1000, text: "la" }], plain: "la" });
  assert.ok(calls.every((c) => c.headers.Authorization.includes('Token="secret-token"')));
  await assert.rejects(() => stream.castInfo("nope"));
});
