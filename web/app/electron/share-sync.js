// Keeping a paired phone in step with this computer over the home network (D214): what the phone needs to keep chosen
// music (the list with sizes and a mark that changes when a file is edited), the favorites, flags and playlists both
// ways, and new music sent from the phone into an "incoming" folder for the owner to look over. Part of the sharing
// server (library-share.js), which decides who may ask: only a device paired as a phone gets here.
//
// A song is named by a hash of its place inside the library folder, so no file path ever leaves the computer and the
// name stays the same after a restart or when the library folder itself moves. Changes are asked for as "add these,
// remove those", never "here is the whole list", so a change made on the computer meanwhile is not written over.

const crypto = require("node:crypto");
const fs = require("node:fs");
const path = require("node:path");
const { pipeline } = require("node:stream/promises");
const { Transform } = require("node:stream");
const { promisify } = require("node:util");
const gzip = promisify(require("node:zlib").gzip);

/** The file types a phone may send. */
const AUDIO = new Set([".mp3", ".flac", ".m4a", ".aac", ".ogg", ".opus", ".wav", ".wma", ".wv"]);
const MAX_UPLOAD = 1.5 * 1024 * 1024 * 1024;
/** A playlist change (20,000 songs at 35 bytes each is under 1 MB). */
const MAX_BODY = 2 * 1024 * 1024;
const MAX_IDS = 20_000;
const STATS_AT_ONCE = 64;
const MAX_REMEMBERED_DELETIONS = 100;

/** A song's name between the phone and the computer: 32 hex digits from its place inside the library folder. */
function syncIdOf(file, root) {
  const inside = root ? path.relative(root, file) : file;
  return crypto.createHash("sha256").update(inside.replace(/\\/g, "/").toLowerCase()).digest("hex").slice(0, 32);
}

/** The last three parts of a path: what a list kept from before the library folder moved still has in common. */
const tailOf = (file) => file.split(/[\\/]+/).filter(Boolean).slice(-3).join("/").toLowerCase();

/**
 * Finds the song a stored list means: by its path, the same in other capitals, or (for a list kept from before the
 * library moved) the one song whose path ends the same way. Null when there is none.
 */
function finder(byPath) {
  const lower = new Map();
  const tails = new Map();
  for (const [file, id] of byPath) {
    lower.set(file.toLowerCase(), id);
    const tail = tailOf(file);
    tails.set(tail, tails.has(tail) ? null : id);
  }
  return (file) => byPath.get(file) ?? lower.get(String(file).toLowerCase()) ?? tails.get(tailOf(String(file))) ?? null;
}

/**
 * The library as a phone keeps it. Throws when it is empty or most of the files cannot be read (a drive that is not
 * connected), so a phone is never told that its music, hearts or playlists are gone. `missing` names the songs whose
 * file cannot be read just now.
 */
async function syncList(tracks, root, stat = fs.promises.stat) {
  const list = [];
  const byId = new Map();
  const byPath = new Map();
  const missingByPath = new Map();
  let missing = 0;
  if (!tracks.length) throw new Error("The library on the computer is empty or cannot be read just now.");
  for (let start = 0; start < tracks.length; start += STATS_AT_ONCE) {
    const part = tracks.slice(start, start + STATS_AT_ONCE);
    const facts = await Promise.all(part.map((track) => stat(track.source_uri).catch(() => null)));
    part.forEach((track, i) => {
      const fact = facts[i];
      if (!fact) {
        missing += 1;
        missingByPath.set(track.source_uri, syncIdOf(track.source_uri, root));
        return;
      }
      const id = syncIdOf(track.source_uri, root);
      if (byId.has(id)) return;
      byId.set(id, track);
      byPath.set(track.source_uri, id);
      list.push({
        id,
        title: track.title ?? "",
        artist: track.artist ?? "",
        album_artist: track.album_artist ?? "",
        album: track.album ?? "",
        track: track.track_number ?? null,
        disc: track.disc_number ?? null,
        year: track.release_year ?? null,
        duration_ms: track.length_ms ?? 0,
        ext: path.extname(track.source_uri).slice(1).toLowerCase(),
        size: fact.size,
        etag: `${fact.size}-${Math.round(fact.mtimeMs)}`,
      });
    });
  }
  if (missing > tracks.length / 2) throw new Error("The music folder on the computer cannot be read just now.");
  return { list, byId, byPath, find: finder(byPath), missingByPath, root };
}

/** The folders and file name for a song a phone sends ("Artist/Album/01 Song.mp3"), or null when it is not a plain song path. */
function cleanUploadPath(text) {
  if (typeof text !== "string") return null;
  const parts = text.split("/");
  if (parts.length < 1 || parts.length > 6) return null;
  for (const part of parts) {
    if (!part || part.length > 120 || /[\u0000-\u001f<>:"\\|?*]/.test(part) || /^\.+$/.test(part) || /[. ]$/.test(part)) return null;
    if (/^(con|prn|aux|nul|com\d|lpt\d)(\.|$)/i.test(part)) return null; // names Windows keeps for itself
  }
  return AUDIO.has(path.extname(parts[parts.length - 1]).toLowerCase()) ? parts : null;
}

async function digest(file) {
  const hash = crypto.createHash("sha256");
  await pipeline(fs.createReadStream(file), hash);
  return hash.digest("hex");
}

/**
 * Puts a received file in its place without ever writing over another: a file already there with the same contents
 * counts as received, and a different one of the same name stays while the new one gets " (2)".
 */
async function placeFile(temp, folder, parts) {
  const directory = path.join(folder, ...parts.slice(0, -1));
  await fs.promises.mkdir(directory, { recursive: true });
  const name = parts[parts.length - 1];
  const extension = path.extname(name);
  const stem = name.slice(0, name.length - extension.length);
  const size = (await fs.promises.stat(temp)).size;
  for (let n = 1; n < 100; n += 1) {
    const target = path.join(directory, n === 1 ? name : `${stem} (${n})${extension}`);
    try {
      await fs.promises.copyFile(temp, target, fs.constants.COPYFILE_EXCL);
      return { saved: target, already: false };
    } catch (error) {
      if (error?.code !== "EEXIST") throw error;
      if ((await fs.promises.stat(target)).size === size && (await digest(target)) === (await digest(temp))) return { saved: target, already: true };
    }
  }
  throw new Error("There are too many files with that name.");
}

/**
 * @param {object} options
 * @param {object} options.source the share's source: also `savePlaylist(args)`, `deletePlaylist(id)` and `incoming()`
 * @param {() => Promise<{list: any[], byId: Map<string, any>, byPath: Map<string, string>}>} options.library
 * @param {() => boolean} options.uploadsAllowed
 */
function createSyncApi({ source, library, uploadsAllowed, deletedFile, send, onMarks, log = () => {} }) {
  // Changes one at a time: each reads the lists and writes them back.
  let queue = Promise.resolve();
  const inTurn = (work) => {
    const next = queue.then(work, work);
    queue = next.catch(() => {});
    return next;
  };

  function readJson(request) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const parts = [];
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_BODY) {
          reject(new Error("too big"));
          request.destroy();
        } else parts.push(chunk);
      });
      request.on("end", () => {
        try {
          resolve(JSON.parse(Buffer.concat(parts).toString("utf8") || "{}"));
        } catch (error) {
          reject(error);
        }
      });
      request.on("error", reject);
    });
  }

  const ids = (value) => (Array.isArray(value) ? value.filter((v) => typeof v === "string").slice(0, MAX_IDS) : []);

  async function state() {
    const { find, missingByPath, root } = await library();
    const unavailable = new Set();
    const known = (entries) => {
      const found = [];
      for (const { path: file } of entries ?? []) {
        const id = find(file);
        if (id) found.push(id);
        // Its file is missing, or the library no longer lists it (a rescan while it was away, another folder chosen).
        else unavailable.add(missingByPath.get(file) ?? syncIdOf(file, root));
      }
      return [...new Set(found)];
    };
    const [favorites, flags, playlists] = await Promise.all([source.favorites?.() ?? [], source.flags?.() ?? [], source.playlists?.() ?? []]);
    const marks = { favorites: known(favorites), flagged: known(flags) };
    return {
      ...marks,
      // Marked songs that cannot be found just now: the phone leaves them out of the round, removing nothing.
      unavailable: [...unavailable],
      playlists: (playlists ?? []).map((p) => {
        const found = (p.paths ?? []).map(find);
        // `partial`: it holds songs that cannot be named to a phone, so the phone must not change it or follow it.
        return { id: p.id, name: p.name, ids: found.filter(Boolean), ...(found.every(Boolean) ? {} : { partial: true }) };
      }),
    };
  }

  const PARTIAL = "Some songs of that playlist cannot be found on the computer just now, so it is left as it is.";

  async function change(action, body) {
    const { byId, find } = await library();
    const paths = (list) => ids(list).map((id) => byId.get(id)?.source_uri).filter(Boolean);
    const whole = (list) => (list.paths ?? []).every((file) => find(file));
    /** A list's paths with songs added (those it does not hold yet) and taken off, whatever form its paths are in. */
    const changed = (list, add, remove) => {
      const drop = new Set(ids(remove));
      const kept = (list.paths ?? []).filter((file) => !drop.has(find(file)));
      const have = new Set(kept.map(find));
      return [...kept, ...paths(add).filter((file) => !have.has(find(file)))];
    };
    if (action === "favorite" || action === "flag") {
      const track = byId.get(body.id);
      if (!track) return [404, { message: "No such song." }];
      const on = body.on !== false;
      // Taken off: every entry that means this song goes, including one kept under an older path.
      const stored = on ? [] : (((await (action === "favorite" ? source.favorites?.() : source.flags?.())) ?? []).map((e) => e.path).filter((file) => find(file) === body.id));
      // Already flagged: left alone, so the reasons and notes written on the computer are not replaced.
      if (on && action === "flag" && ((await source.flags?.()) ?? []).some((e) => find(e.path) === body.id)) return [200, { ok: true }];
      for (const file of new Set(on ? [track.source_uri] : [track.source_uri, ...stored])) {
        if (action === "favorite") await source.setFavorite(file, { favorite: on });
        else await source.setFlag(file, { flagged: on, reasons: [], note: "From the phone", title: track.title ?? undefined, artist: track.artist ?? undefined, album: track.album ?? undefined });
      }
      onMarks();
      return [200, { ok: true }];
    }
    const lists = (await source.playlists?.()) ?? [];
    if (action === "playlist/create") {
      const name = typeof body.name === "string" ? body.name.trim().slice(0, 200) : "";
      if (!name) return [400, { message: "A playlist needs a name." }];
      const same = lists.find((p) => String(p.name).toLowerCase() === name.toLowerCase());
      if (same && !whole(same)) return [409, { message: PARTIAL }];
      const saved = await source.savePlaylist(same ? { id: same.id, name: same.name, paths: changed(same, body.ids, []) } : { name, paths: paths(body.ids) });
      onMarks();
      return [200, { id: saved?.playlist?.id ?? same?.id }];
    }
    const list = lists.find((p) => p.id === body.id);
    if (action === "playlist/edit") {
      if (!list) return [404, { message: "That playlist is no longer on the computer." }];
      if (!whole(list)) return [409, { message: PARTIAL }];
      await source.savePlaylist({ id: list.id, name: list.name, paths: changed(list, body.add, body.remove) });
      onMarks();
      return [200, { ok: true }];
    }
    if (action === "playlist/delete") {
      if (list) {
        // Kept aside first, so a playlist removed from a phone can be got back.
        let old = [];
        try {
          old = JSON.parse(await fs.promises.readFile(deletedFile, "utf8"));
        } catch {
          /* none yet */
        }
        const next = [...(Array.isArray(old) ? old : []), { ...list, deleted_at: new Date().toISOString() }].slice(-MAX_REMEMBERED_DELETIONS);
        await fs.promises.writeFile(deletedFile, JSON.stringify(next, null, 2));
        await source.deletePlaylist(list.id);
        onMarks();
      }
      return [200, { ok: true }];
    }
    return [404, { message: "Not found." }];
  }

  /** Part files left by a program that stopped while receiving, a day old or more. */
  async function clearOldParts(folder) {
    for (const name of await fs.promises.readdir(folder).catch(() => [])) {
      if (!/^\.receiving-[0-9a-f]{16}\.part$/.test(name)) continue;
      const file = path.join(folder, name);
      const fact = await fs.promises.stat(file).catch(() => null);
      if (fact && Date.now() - fact.mtimeMs > 24 * 60 * 60_000) await fs.promises.rm(file, { force: true }).catch(() => {});
    }
  }

  async function receive(request, response, url) {
    // A refusal still takes in what is being sent, so the phone hears the reason instead of a broken connection.
    const refuse = (status, body) => {
      request.resume();
      send(response, status, body);
    };
    if (!uploadsAllowed()) return refuse(403, { error: "uploads_off", message: "On the computer, open Settings > TV & Phone Pairing and allow phones to send new music." });
    const parts = cleanUploadPath(url.searchParams.get("path"));
    if (!parts) return refuse(400, { message: "That is not a song file the computer accepts." });
    const length = Number(request.headers["content-length"]);
    if (!Number.isInteger(length) || length <= 0) return refuse(411, { message: "The size of the song is needed." });
    if (length > MAX_UPLOAD) return refuse(413, { message: "That file is too large." });
    const folder = await source.incoming();
    await fs.promises.mkdir(folder, { recursive: true });
    await clearOldParts(folder);
    const temp = path.join(folder, `.receiving-${crypto.randomBytes(8).toString("hex")}.part`);
    try {
      let got = 0;
      const count = new Transform({
        transform(chunk, _encoding, done) {
          got += chunk.length;
          done(got > length ? new Error("more than announced") : null, chunk);
        },
      });
      await pipeline(request, count, fs.createWriteStream(temp, { flags: "wx" }));
      if (got !== length) return send(response, 400, { message: "The song was cut short on the way." });
      const { already } = await placeFile(temp, folder, parts);
      send(response, 200, { ok: true, already });
    } catch (error) {
      log(`library share: a song from a phone was not saved: ${error?.message ?? error}`);
      if (!response.headersSent && !response.destroyed) send(response, 500, { message: "The computer could not save the song (is the disk full?)." });
    } finally {
      await fs.promises.rm(temp, { force: true }).catch(() => {});
    }
  }

  /** The lists are large and repetitive: packed for a phone that says it can unpack them (Android does by itself). */
  async function sendList(request, response, body) {
    if (!/\bgzip\b/.test(String(request.headers["accept-encoding"] ?? ""))) return send(response, 200, body);
    const packed = await gzip(Buffer.from(JSON.stringify(body)));
    response.writeHead(200, { "Content-Type": "application/json; charset=utf-8", "Content-Encoding": "gzip", "Content-Length": String(packed.length), "Cache-Control": "no-store" });
    response.end(packed);
  }

  /** Answers a request under /api/sync/ from a paired phone. */
  async function handle(request, response, url) {
    // Said plainly, so the phone can show why (and takes nothing for removed).
    if (url.pathname !== "/api/sync/upload") {
      try {
        await library();
      } catch (error) {
        log(`library share: ${error?.message ?? error}`);
        return send(response, 503, { message: String(error?.message ?? "The library on the computer is not ready.") });
      }
    }
    const action = url.pathname.slice("/api/sync/".length);
    if (request.method === "GET" && action === "library") {
      const { list } = await library();
      return sendList(request, response, { tracks: list, uploads: uploadsAllowed() });
    }
    if (request.method === "GET" && action === "state") return sendList(request, response, await state());
    if (request.method === "POST" && action === "upload") return receive(request, response, url);
    if (request.method !== "POST") return send(response, 404, { message: "Not found." });
    let body;
    try {
      body = await readJson(request);
    } catch {
      return send(response, 400, { message: "The request was not understood." });
    }
    const [status, reply] = await inTurn(() => change(action, body ?? {}));
    return send(response, status, reply);
  }

  return { handle };
}

module.exports = { createSyncApi, syncList, syncIdOf, cleanUploadPath, placeFile };
