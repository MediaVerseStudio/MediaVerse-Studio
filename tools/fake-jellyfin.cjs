// A small stand-in for a Jellyfin server, for trying the Android app's "Music from your home server" (D177) on an emulator or phone without a real server.
// It serves a folder of music laid out as Artist/Album/NN Title.mp3 (artist, album, track and title come from the names; nothing is read from the files),
// signs in at once with Quick Connect, lists artists, albums, songs and playlists the way Jellyfin does, streams the files, and keeps playlists in memory.
//
//   node tools/fake-jellyfin.cjs <music folder> [port=8097]
//
// From an Android emulator the host is 10.0.2.2. Tools for the test: POST /__edit/<song id> changes that song's ETag (as if its file was edited on the server),
// DELETE /__song/<song id> removes it from the listings, GET /__state shows what the server holds. Only for testing; it checks nothing.

const http = require("node:http");
const fs = require("node:fs");
const path = require("node:path");
const crypto = require("node:crypto");

const root = path.resolve(process.argv[2] ?? ".");
const port = Number(process.argv[3] ?? 8097);
const hex = (text) => crypto.createHash("md5").update(text).digest("hex");
const SERVER_ID = hex("server");
const USER_ID = hex("user");

const songs = [];
const walk = (dir, depth) => {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, depth + 1);
    else if (/\.(mp3|flac|m4a|ogg)$/i.test(entry.name)) {
      const parts = path.relative(root, full).split(path.sep);
      if (parts.length < 3) continue;
      const [artist, album] = parts;
      const stem = parts[parts.length - 1].replace(/\.[^.]+$/, "");
      const m = /^(\d{1,2})\s*[-.]?\s*(.+)$/.exec(stem);
      const size = fs.statSync(full).size;
      songs.push({ id: hex(full), file: full, artist, album, albumId: hex(`${artist}/${album}`), artistId: hex(`artist/${artist}`), track: m ? Number(m[1]) : null, title: m ? m[2] : stem, container: path.extname(full).slice(1).toLowerCase(), size, edits: 0, removed: false });
    }
  }
};
walk(root, 0);

const playlists = new Map(); // id -> {id, name, entries: [{entry, song}]}
let counter = 0;

const item = (s) => ({
  Id: s.id, Name: s.title, Album: s.album, AlbumId: s.albumId, AlbumArtist: s.artist, Artists: [s.artist], AlbumArtists: [{ Id: s.artistId, Name: s.artist }],
  IndexNumber: s.track, ParentIndexNumber: 1, ProductionYear: 2020, RunTimeTicks: Math.round((s.size / 20_000) * 10_000_000), DateCreated: "2026-01-01T00:00:00Z", Type: "Audio",
  MediaSources: [{ Size: s.size, ETag: `etag-${s.id.slice(0, 8)}-${s.edits}`, Container: s.container }],
});

const live = () => songs.filter((s) => !s.removed);
const send = (res, status, body, type = "application/json") => {
  res.writeHead(status, { "Content-Type": type });
  res.end(typeof body === "string" ? body : JSON.stringify(body));
};
const page = (list, url) => {
  const start = Number(url.searchParams.get("StartIndex") ?? 0);
  const limit = Number(url.searchParams.get("Limit") ?? 100000);
  return { Items: list.slice(start, start + limit), TotalRecordCount: list.length };
};

const server = http.createServer((req, res) => {
  const url = new URL(req.url, `http://${req.headers.host}`);
  const p = url.pathname;
  console.log(req.method, p + url.search.slice(0, 90));
  if (p === "/System/Info/Public") return send(res, 200, { ServerName: "Fake Jellyfin", Id: SERVER_ID, Version: "12.4.0", ProductName: "Jellyfin Server" });
  if (p === "/QuickConnect/Enabled") return send(res, 200, "true");
  if (p === "/QuickConnect/Initiate") return send(res, 200, { Code: "424242", Secret: "secret" });
  if (p === "/QuickConnect/Connect") return send(res, 200, { Authenticated: true });
  if (p === "/Users/AuthenticateWithQuickConnect") return send(res, 200, { AccessToken: "fake-token", User: { Id: USER_ID } });
  if (p === "/Artists") {
    // every performer: the album artists and one guest who is on no album of their own (for trying the "also list artists who only appear on other artists' albums" option)
    const names = [...new Map(live().map((s) => [s.artistId, s.artist])).entries()].concat([[hex("artist/Guest Star"), "Guest Star"]]).sort((a, b) => a[1].localeCompare(b[1]));
    return send(res, 200, page(names.map(([Id, Name]) => ({ Id, Name, ImageTags: {} })), url));
  }
  if (p === "/Artists/AlbumArtists") {
    const names = [...new Map(live().map((s) => [s.artistId, s.artist])).entries()].sort((a, b) => a[1].localeCompare(b[1]));
    return send(res, 200, page(names.map(([Id, Name]) => ({ Id, Name, ImageTags: {} })), url));
  }
  if (p === `/Users/${USER_ID}/Items`) {
    const types = url.searchParams.get("IncludeItemTypes");
    const artistId = url.searchParams.get("AlbumArtistIds");
    const parent = url.searchParams.get("ParentId");
    if (types === "MusicAlbum") {
      const albums = new Map();
      for (const s of live()) if (!artistId || s.artistId === artistId) albums.set(s.albumId, { Id: s.albumId, Name: s.album, AlbumArtist: s.artist, ProductionYear: 2020, ChildCount: live().filter((x) => x.albumId === s.albumId).length });
      return send(res, 200, page([...albums.values()].sort((a, b) => a.Name.localeCompare(b.Name)), url));
    }
    if (types === "Playlist") return send(res, 200, page([...playlists.values()].map((l) => ({ Id: l.id, Name: l.name })), url));
    let list = live();
    if (artistId) list = list.filter((s) => s.artistId === artistId);
    if (parent) list = list.filter((s) => s.albumId === parent);
    list = list.sort((a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album) || (a.track ?? 0) - (b.track ?? 0));
    return send(res, 200, page(list.map(item), url));
  }
  let m = /^\/Audio\/([0-9a-f]{32})\/stream$/.exec(p);
  if (m) {
    const s = songs.find((x) => x.id === m[1]);
    if (!s) return send(res, 404, "");
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? "");
    if (range) {
      let start = range[1] === "" ? Math.max(0, s.size - Number(range[2])) : Number(range[1]);
      const end = range[1] === "" || range[2] === "" ? s.size - 1 : Math.min(Number(range[2]), s.size - 1);
      res.writeHead(206, { "Content-Type": "audio/mpeg", "Content-Length": end - start + 1, "Content-Range": `bytes ${start}-${end}/${s.size}` });
      return fs.createReadStream(s.file, { start, end }).pipe(res);
    }
    res.writeHead(200, { "Content-Type": "audio/mpeg", "Content-Length": s.size });
    return fs.createReadStream(s.file).pipe(res);
  }
  if (/^\/Audio\/[0-9a-f]{32}\/Lyrics$/.test(p) || /^\/Items\/[0-9a-f]{32}\/Images/.test(p)) return send(res, 404, "");
  m = /^\/Playlists\/([^/]+)\/Items$/.exec(p);
  if (m && req.method === "GET") {
    const l = playlists.get(m[1]);
    return send(res, l ? 200 : 404, l ? { Items: l.entries.map((e) => ({ ...item(e.song), PlaylistItemId: e.entry })), TotalRecordCount: l.entries.length } : "");
  }
  if (m && req.method === "POST") {
    const l = playlists.get(m[1]);
    for (const id of (url.searchParams.get("ids") ?? "").split(",").filter(Boolean)) {
      const song = songs.find((s) => s.id === id);
      if (l && song) l.entries.push({ entry: `e${++counter}`, song });
    }
    return send(res, 204, "");
  }
  if (m && req.method === "DELETE") {
    const l = playlists.get(m[1]);
    const gone = new Set((url.searchParams.get("entryIds") ?? "").split(","));
    if (l) l.entries = l.entries.filter((e) => !gone.has(e.entry));
    return send(res, 204, "");
  }
  if (p === "/Playlists" && req.method === "POST") {
    let body = "";
    req.on("data", (c) => (body += c));
    req.on("end", () => {
      const data = JSON.parse(body || "{}");
      const id = hex(`playlist${++counter}`);
      playlists.set(id, { id, name: data.Name, entries: (data.Ids ?? []).map((i) => ({ entry: `e${++counter}`, song: songs.find((s) => s.id === i) })).filter((e) => e.song) });
      send(res, 200, { Id: id });
    });
    return;
  }
  m = /^\/Items\/([0-9a-f]{32})$/.exec(p);
  if (m && req.method === "DELETE") {
    playlists.delete(m[1]);
    return send(res, 204, "");
  }
  m = /^\/__edit\/([0-9a-f]{32})$/.exec(p);
  if (m) {
    const s = songs.find((x) => x.id === m[1]);
    if (s) s.edits += 1;
    return send(res, 200, { edited: !!s });
  }
  m = /^\/__song\/([0-9a-f]{32})$/.exec(p);
  if (m) {
    const s = songs.find((x) => x.id === m[1]);
    if (s) s.removed = req.method === "DELETE";
    return send(res, 200, { removed: !!s });
  }
  if (p === "/__state") return send(res, 200, { songs: songs.map((s) => ({ id: s.id, artist: s.artist, album: s.album, title: s.title, edits: s.edits, removed: s.removed })), playlists: [...playlists.values()].map((l) => ({ name: l.name, songs: l.entries.map((e) => e.song.title) })) });
  return send(res, 404, "");
});

server.listen(port, "0.0.0.0", () => console.log(`Fake Jellyfin on port ${port}: ${songs.length} songs from ${root}`));
