// Shares the music library with the MediaVerse Studio TV app on the home network (D38). Read only, except that a
// paired TV may flag a song for review or mark it a favorite (D44); nothing else can be changed from a TV.
//
// Off until the owner switches it on in Settings > TV. When on, a small web server answers GET requests from
// devices on the home network only (private and link-local addresses). A TV pairs once: it asks to pair, this
// computer shows a one-time 6-digit code, and the code typed on the TV earns it a long random key that every
// later request carries (the computer keeps only a hash of it). Paired TVs are listed in Settings and can be
// removed there. Wrong codes or keys lock that address out for a while. It can list the library, stream songs (with seeking), and return
// covers and lyrics. It never changes, lists folders, or reveals where files are stored: tracks are named by
// their library ID, and each file served is checked against the library folder like the app's own player.
// Built on Node's own http module; no extra component.

const crypto = require("node:crypto");
const fs = require("node:fs");
const http = require("node:http");
const os = require("node:os");
const path = require("node:path");
const { promisify } = require("node:util");
const gzip = promisify(require("node:zlib").gzip);
const { resolveAllowedAudio, mimeTypeFor } = require("./media-access");

const DEFAULT_PORT = 47700;
const API_VERSION = 2;
/** Wrong codes allowed from one address before it is refused for a while. */
const MAX_WRONG_CODES = 5;
const LOCKOUT_MS = 10 * 60_000;
/** How long a pairing code shown on the computer stays usable. */
const PAIRING_MS = 5 * 60_000;
/** How long Settings > TV leaves pairing open after "Pair a TV". A TV cannot start pairing on its own. */
const ARM_MS = 5 * 60_000;
/** A media ticket (audio and cover URLs only) lasts a listening session. It is not the device key. */
const TICKET_MS = 12 * 60 * 60_000;
const MAX_TICKETS = 40;
const MAX_DEVICES = 20;
/** Shrunk covers kept in memory (a few tens of kilobytes each). */
const MAX_THUMBNAILS = 600;

/** True for addresses that can only be on the home network: private IPv4, link-local and loopback. */
function isHomeNetworkAddress(address) {
  if (typeof address !== "string" || address === "") return false;
  let ip = address.toLowerCase();
  if (ip.startsWith("::ffff:") && ip.includes(".")) ip = ip.slice(7); // IPv4 written as IPv6
  if (ip.includes(".")) {
    const parts = ip.split(".").map(Number);
    if (parts.length !== 4 || parts.some((p) => !Number.isInteger(p) || p < 0 || p > 255)) return false;
    const [a, b] = parts;
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (ip === "::1") return true;
  return /^fe[89ab][0-9a-f]:/.test(ip) || /^f[cd][0-9a-f]{2}:/.test(ip); // link-local fe80::/10, unique-local fc00::/7
}

/** A one-time 6-digit pairing code, easy to type with a TV remote's number pad. */
function newPairingCode() {
  return String(crypto.randomInt(0, 1_000_000)).padStart(6, "0");
}

/** The long-lived key a paired TV sends with every request; only its hash is kept. */
function newDeviceKey() {
  return crypto.randomBytes(32).toString("hex");
}

function keyHash(key) {
  return crypto.createHash("sha256").update(String(key)).digest("hex");
}

/** A short printable device name from the TV, or null. */
function cleanDeviceName(name) {
  if (typeof name !== "string") return null;
  const clean = name.replace(/[\u0000-\u001f\u007f<>]/g, "").trim().slice(0, 40);
  return clean || null;
}

function plainAddress(address) {
  return address.startsWith("::ffff:") && address.includes(".") ? address.slice(7) : address;
}

function codeMatches(given, expected) {
  if (typeof given !== "string" || typeof expected !== "string") return false;
  const a = Buffer.from(given.replace(/\s/g, ""));
  const b = Buffer.from(expected);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}

/**
 * The byte range asked for by a Range header, for a file of `size` bytes.
 * Returns null for no (or an ignorable) header, "invalid" when it cannot be met, otherwise { start, end }.
 */
function parseRange(header, size) {
  if (typeof header !== "string" || header === "") return null;
  const match = /^bytes=(\d*)-(\d*)$/.exec(header.trim());
  if (!match || header.includes(",")) return null; // several ranges: send the whole file instead
  const [, from, to] = match;
  if (from === "" && to === "") return "invalid";
  let start;
  let end;
  if (from === "") {
    const suffix = Number(to);
    if (suffix === 0) return "invalid";
    start = Math.max(0, size - suffix);
    end = size - 1;
  } else {
    start = Number(from);
    end = to === "" ? size - 1 : Math.min(Number(to), size - 1);
  }
  if (start >= size || start > end) return "invalid";
  return { start, end };
}

/** What a TV is told about a track: no file paths. */
function publicTrack(track) {
  return {
    id: track.id,
    title: track.title,
    artist: track.artist ?? null,
    album: track.album ?? null,
    album_artist: track.album_artist ?? null,
    genre: track.genre ?? null,
    year: track.release_year ?? null,
    track_number: track.track_number ?? null,
    // Tracks in one folder share a cover; the TV asks for each album's cover once.
    // Only the album folder's own name (to name a compilation), never the path to it.
    folder: path.basename(path.dirname(track.source_uri)),
    cover_key: crypto.createHash("sha1").update(path.dirname(track.source_uri).toLowerCase()).digest("hex").slice(0, 16),
  };
}

/** This computer's IPv4 addresses on its home network, for showing in Settings. */
function homeAddresses() {
  const found = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|VirtualBox|VMware|WSL|Hyper-V/i.test(name)) continue; // virtual adapters, not the home network
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && isHomeNetworkAddress(entry.address) && !entry.address.startsWith("169.254.")) {
        found.push(entry.address);
      }
    }
  }
  return found;
}

function readSettings(file) {
  try {
    const saved = JSON.parse(fs.readFileSync(file, "utf8"));
    const devices = Array.isArray(saved.devices)
      ? saved.devices.filter(
          (device) =>
            device && typeof device.id === "string" && typeof device.name === "string" && typeof device.key_hash === "string" && /^[0-9a-f]{64}$/.test(device.key_hash),
        )
      : [];
    return {
      enabled: saved.enabled === true,
      port: Number.isInteger(saved.port) && saved.port > 1023 && saved.port < 65536 ? saved.port : DEFAULT_PORT,
      devices: devices.slice(0, MAX_DEVICES).map(({ id, name, key_hash, paired }) => ({ id, name, key_hash, paired: typeof paired === "string" ? paired : null })),
    };
  } catch {
    return { enabled: false, port: DEFAULT_PORT, devices: [] };
  }
}

function writeSettings(file, settings) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, JSON.stringify(settings, null, 2));
}

/**
 * @param {object} options
 * @param {string} options.settingsFile where the on/off choice, port and paired TVs are kept
 * @param {{ snapshot(): Promise<{tracks: any[]}>, root(): Promise<string|null>, cover(path: string): Promise<any>, lyrics(path: string): Promise<any>, shrink?(bytes: Buffer, size: number): Promise<Buffer> }} options.source
 *   optional `favorites()`/`flags()` list `{path}` entries and `setFavorite(path, args)`/`setFlag(path, args)` change them (D44)
 *   `shrink` makes a JPEG at most `size` pixels on its longer side (optional; without it covers come full size)
 * @param {() => void} [options.onChange] called when something Settings shows changes (a TV asks to pair, pairs)
 * @param {() => void} [options.onMarks] called when a TV flags a song or changes a favorite
 */
function createLibraryShare({ settingsFile, source, log = () => {}, onChange = () => {}, onMarks = () => {}, onRemote = () => {} }) {
  let settings = readSettings(settingsFile);
  let server = null;
  let problem = null; // why the server is not running although switched on
  let library = null; // { tracks, byId } built from the snapshot, dropped when the library changes
  const wrongCodes = new Map(); // address -> { count, until }
  /** Shrunk covers, oldest first: "<cover_key>:<size>" -> { mime, bytes }. */
  const thumbnails = new Map();
  /** Covers being read and shrunk right now: the same key -> a promise of { mime, bytes } or null. */
  const coversBeingMade = new Map();
  /** The pairing in progress: { code, name, address, expires }, or null. One at a time. */
  let pairing = null;
  let pairingTimer = null;

  // ---- "Play on the TV" (D76): the TV app's remote, the same protocol the phone uses (D58) ----
  // Each paired TV that has the app open waits here (GET /api/remote, a long poll) for commands from the
  // computer, and reports what it plays (POST /api/remote/state). Kept in memory only.
  /** device id -> { seq, commands, waiters, seen, state } */
  const remotes = new Map();
  const REMOTE_WAIT_MS = 20_000;
  /** A TV counts as listening while it asked within this long (its long poll is renewed every 20 s or so). */
  const LISTENING_MS = 45_000;

  function remoteOf(device) {
    let remote = remotes.get(device.id);
    if (!remote) {
      remote = { seq: 0, commands: [], waiters: new Set(), seen: 0, state: null };
      remotes.set(device.id, remote);
    }
    return remote;
  }

  function answerWaiters(remote) {
    for (const waiter of remote.waiters) waiter();
  }

  async function waitForRemote(request, response, device, url) {
    const remote = remoteOf(device);
    const wasListening = Date.now() - remote.seen < LISTENING_MS;
    remote.seen = Date.now();
    if (!wasListening) onRemote();
    const after = Number(url.searchParams.get("after"));
    const pending = () => remote.commands.filter((command) => command.seq > after);
    if (!Number.isInteger(after) || after < 0) {
      send(response, 200, { seq: remote.seq, commands: [] }); // the first ask only learns where the list is
      return;
    }
    if (pending().length) {
      send(response, 200, { seq: remote.seq, commands: pending() });
      return;
    }
    await new Promise((resolve) => {
      const done = () => {
        clearTimeout(timer);
        remote.waiters.delete(done);
        resolve();
      };
      const timer = setTimeout(done, REMOTE_WAIT_MS);
      remote.waiters.add(done);
      request.on("close", done);
    });
    remote.seen = Date.now();
    if (!response.writableEnded && !response.destroyed) send(response, 200, { seq: remote.seq, commands: pending() });
  }

  async function takeRemoteState(request, response, device) {
    let body;
    try {
      body = JSON.parse((await readBody(request)) || "{}");
    } catch {
      send(response, 400, "The request was not understood.");
      return;
    }
    const remote = remoteOf(device);
    remote.seen = Date.now();
    const { byId } = await currentLibrary();
    const track = typeof body.id === "string" ? byId.get(body.id) : null;
    const number = (n) => (Number.isFinite(n) && n >= 0 ? Math.round(n) : 0);
    remote.state = { path: track?.source_uri ?? null, playing: body.playing === true, position_ms: number(body.position_ms), duration_ms: number(body.duration_ms), at: Date.now() };
    onRemote();
    send(response, 204, "");
  }

  /** Paired TVs with the app open now, and what each last said it was playing. */
  function remoteDevices() {
    const now = Date.now();
    return settings.devices
      .map((device) => ({ device, remote: remotes.get(device.id) }))
      .filter(({ remote }) => remote && now - remote.seen < LISTENING_MS)
      .map(({ device, remote }) => ({ id: device.id, name: device.name, state: remote.state }));
  }

  /**
   * Sends a command to a TV: {action: "play", paths, index, position_ms, shuffle} (paths become the TV's track
   * IDs), or {action: "toggle" | "pause" | "next" | "previous"}, or {action: "seek", ms}.
   */
  async function sendRemote(deviceId, command) {
    const device = settings.devices.find((d) => d.id === deviceId);
    if (!device) throw new Error("That TV is no longer paired.");
    const remote = remoteOf(device);
    let out;
    if (command?.action === "play") {
      const { byPath } = await currentLibrary();
      const ids = (Array.isArray(command.paths) ? command.paths : []).map((p) => byPath.get(p)).filter(Boolean).slice(0, 20_000);
      if (!ids.length) throw new Error("None of those songs are in the library the TV can see.");
      const index = Number.isInteger(command.index) ? Math.min(Math.max(0, command.index), ids.length - 1) : 0;
      const position = Number.isFinite(command.position_ms) && command.position_ms > 0 ? Math.round(command.position_ms) : 0;
      out = { action: "play", ids, index, position_ms: position, shuffle: command.shuffle === true };
    } else if (["toggle", "pause", "next", "previous"].includes(command?.action)) {
      out = { action: command.action };
    } else if (command?.action === "seek" && Number.isFinite(command.ms) && command.ms >= 0) {
      out = { action: "seek", ms: Math.round(command.ms) };
    } else {
      throw new Error("Unknown command.");
    }
    remote.seq += 1;
    remote.commands = [...remote.commands, { seq: remote.seq, ...out }].slice(-20);
    answerWaiters(remote);
    return { sent: true };
  }

  function save() {
    try {
      writeSettings(settingsFile, settings);
    } catch (error) {
      log(`library share: settings not saved: ${error?.message ?? error}`);
    }
  }

  function endPairing() {
    clearTimeout(pairingTimer);
    pairingTimer = null;
    if (pairing) {
      pairing = null;
      onChange();
    }
  }

  function currentPairing() {
    if (pairing && pairing.expires < Date.now()) endPairing();
    return pairing;
  }

  function deviceForKey(key) {
    if (typeof key !== "string" || !/^[0-9a-f]{64}$/.test(key)) return null;
    const hash = Buffer.from(keyHash(key), "hex");
    return settings.devices.find((device) => crypto.timingSafeEqual(Buffer.from(device.key_hash, "hex"), hash)) ?? null;
  }

  let pairingArmedUntil = 0;
  const mediaTickets = new Map();

  function pairingArmed() {
    return pairingArmedUntil > Date.now();
  }

  function armPairing() {
    pairingArmedUntil = Date.now() + ARM_MS;
    onChange();
    return status();
  }

  function keyFromRequest(request) {
    const auth = request.headers.authorization;
    if (typeof auth === "string") {
      const bearer = /^Bearer\s+([0-9a-f]{64})$/i.exec(auth.trim());
      if (bearer) return bearer[1];
    }
    const header = request.headers["x-mediaverse-key"];
    if (typeof header === "string" && /^[0-9a-f]{64}$/.test(header.trim())) return header.trim();
    return null;
  }

  function newMediaTicket(device) {
    const ticket = crypto.randomBytes(24).toString("hex");
    mediaTickets.set(ticket, { id: device.id, expires: Date.now() + TICKET_MS });
    while (mediaTickets.size > MAX_TICKETS) {
      const oldest = mediaTickets.keys().next().value;
      mediaTickets.delete(oldest);
    }
    return ticket;
  }

  // One live ticket per device. A new one on every request would push the ticket already
  // sitting in an <audio> address out of the list (only 40 are kept).
  function ticketForDevice(device) {
    const now = Date.now();
    for (const [ticket, entry] of mediaTickets) {
      if (entry.id === device.id && entry.expires > now) {
        entry.expires = now + TICKET_MS;
        return ticket;
      }
    }
    return newMediaTicket(device);
  }

  function deviceForTicket(ticket) {
    if (typeof ticket !== "string" || !/^[0-9a-f]{48}$/.test(ticket)) return null;
    const entry = mediaTickets.get(ticket);
    if (!entry || entry.expires < Date.now()) {
      if (entry) mediaTickets.delete(ticket);
      return null;
    }
    entry.expires = Date.now() + TICKET_MS;
    return settings.devices.find((device) => device.id === entry.id) ?? null;
  }

  function deviceForRequest(request, url) {
    const byKey = deviceForKey(keyFromRequest(request));
    if (byKey) return byKey;
    if (/^\/api\/(audio|cover)\//.test(url.pathname)) return deviceForTicket(url.searchParams.get("ticket"));
    return null;
  }

  function issueTicket(response, device) {
    response.setHeader("X-MediaVerse-Ticket", ticketForDevice(device));
    response.setHeader("Access-Control-Expose-Headers", "X-MediaVerse-Ticket");
  }

  async function currentLibrary() {
    if (!library) {
      library = (async () => {
        const snapshot = await source.snapshot();
        const tracks = snapshot?.tracks ?? [];
        const byId = new Map(tracks.map((track) => [track.id, track]));
        const byPath = new Map(tracks.map((track) => [track.source_uri, track.id]));
        // The list a TV asks for is made once per library, and packed: it is megabytes of very repetitive
        // text (measured at 13,476 songs: 3.3 MB plain, 0.7 MB packed) fetched over Wi-Fi at every start.
        const plain = Buffer.from(JSON.stringify({ api: API_VERSION, tracks: tracks.map(publicTrack) }));
        const packed = await gzip(plain);
        return { listBody: { plain, packed }, byId, byPath };
      })().catch((error) => {
        library = null;
        throw error;
      });
    }
    return library;
  }

  function send(response, status, body, headers = {}) {
    const text = typeof body === "string" ? body : JSON.stringify(body);
    response.writeHead(status, {
      "Content-Type": typeof body === "string" ? "text/plain; charset=utf-8" : "application/json; charset=utf-8",
      "Cache-Control": "no-store",
      ...headers,
    });
    response.end(text);
  }

  function lockedOut(address) {
    const entry = wrongCodes.get(address);
    if (!entry) return false;
    if (entry.until && entry.until < Date.now()) {
      wrongCodes.delete(address);
      return false;
    }
    return entry.count >= MAX_WRONG_CODES;
  }

  function noteWrongCode(address) {
    const entry = wrongCodes.get(address) ?? { count: 0, until: 0 };
    entry.count += 1;
    entry.until = Date.now() + LOCKOUT_MS;
    wrongCodes.set(address, entry);
  }

  /** Which songs are favorites and which are flagged, as track IDs (the files stay on the computer). */
  async function currentMarks() {
    const { byPath } = await currentLibrary();
    const ids = (entries) => (entries ?? []).map((entry) => byPath.get(entry.path)).filter(Boolean);
    const [favorites, flags] = await Promise.all([source.favorites?.() ?? [], source.flags?.() ?? []]);
    return { favorites: ids(favorites), flagged: ids(flags) };
  }

  function readBody(request) {
    return new Promise((resolve, reject) => {
      let size = 0;
      const parts = [];
      request.on("data", (chunk) => {
        size += chunk.length;
        if (size > 4096) {
          reject(new Error("too big"));
          request.destroy();
        } else parts.push(chunk);
      });
      request.on("end", () => resolve(Buffer.concat(parts).toString("utf8")));
      request.on("error", reject);
    });
  }

  async function changeMark(request, response, url) {
    const [, kind, rawId] = /^\/api\/(flag|favorite)\/([^/]+)$/.exec(url.pathname);
    const track = await trackFor(decodeURIComponent(rawId));
    if (!track) {
      send(response, 404, "No such track.");
      return;
    }
    let body;
    try {
      body = JSON.parse((await readBody(request)) || "{}");
    } catch {
      send(response, 400, "The request was not understood.");
      return;
    }
    if (kind === "favorite") {
      if (!source.setFavorite) return send(response, 501, "Favorites are not available.");
      await source.setFavorite(track.source_uri, { favorite: body.favorite !== false });
    } else {
      if (!source.setFlag) return send(response, 501, "Flags are not available.");
      const reasons = Array.isArray(body.reasons) ? body.reasons.filter((r) => typeof r === "string").slice(0, 5) : [];
      await source.setFlag(track.source_uri, {
        flagged: body.flagged !== false,
        reasons,
        note: typeof body.note === "string" ? body.note.slice(0, 500) : "From the TV",
        position_ms: Number.isInteger(body.position_ms) && body.position_ms >= 0 ? body.position_ms : undefined,
        title: track.title ?? undefined,
        artist: track.artist ?? undefined,
        album: track.album ?? undefined,
      });
    }
    onMarks();
    send(response, 200, await currentMarks());
  }

  async function trackFor(id) {
    const { byId } = await currentLibrary();
    return byId.get(id) ?? null;
  }

  // ---- Links for DLNA renderers (D77) ----
  // A TV or speaker told to play a song fetches it itself and cannot pair with a code, so each casting session
  // gets a random token; links carry it, work only from the home network, and stop working when it expires.
  const castTokens = new Map(); // token -> expires (ms)
  const CAST_TOKEN_MS = 12 * 60 * 60_000;

  function liveCastToken() {
    const now = Date.now();
    for (const [token, expires] of castTokens) if (expires < now) castTokens.delete(token);
    for (const [token, expires] of castTokens) if (expires - now > CAST_TOKEN_MS / 2) return token;
    const token = crypto.randomBytes(24).toString("hex");
    castTokens.set(token, now + CAST_TOKEN_MS);
    return token;
  }

  /** This computer's address that a device at `deviceIp` can reach (the one sharing the most of its address). */
  function addressFor(deviceIp) {
    const mine = homeAddresses();
    const shared = (a) => {
      const x = a.split(".");
      const y = String(deviceIp).split(".");
      let n = 0;
      while (n < 4 && x[n] === y[n]) n += 1;
      return n;
    };
    return mine.sort((a, b) => shared(b) - shared(a))[0] ?? null;
  }

  /**
   * Links a renderer at `deviceIp` can play: {audio, cover, mime, track} for a library file, or null when it is
   * not in the library. Needs the share running (Settings > TV).
   */
  async function castLink(filePath, deviceIp) {
    if (!server) throw new Error("Turn on “Share my library with TVs” in Settings > TV first: TVs and speakers fetch the music from it.");
    const host = addressFor(deviceIp);
    if (!host) throw new Error("This computer has no address on the home network.");
    const { byPath, byId } = await currentLibrary();
    const id = byPath.get(filePath);
    if (!id) return null;
    const track = byId.get(id);
    const base = `http://${host}:${settings.port}/cast/${liveCastToken()}`;
    const ext = path.extname(track.source_uri).toLowerCase() || ".mp3";
    return { audio: `${base}/audio/${encodeURIComponent(id)}${ext}`, cover: `${base}/cover/${encodeURIComponent(id)}.jpg`, mime: mimeTypeFor(track.source_uri), track };
  }

  async function streamAudio(request, response, track, extraHeaders = {}) {
    let file;
    try {
      file = resolveAllowedAudio(track.source_uri, await source.root());
    } catch (error) {
      send(response, 403, String(error?.message ?? error));
      return;
    }
    // Asked without blocking, and a file moved or deleted since the library was read gets a clear 404 instead of
    // an exception that left the TV waiting for an answer.
    let size;
    try {
      ({ size } = await fs.promises.stat(file));
    } catch {
      send(response, 404, "This song's file is no longer there.");
      return;
    }
    const range = parseRange(request.headers.range, size);
    const headers = { "Content-Type": mimeTypeFor(file), "Accept-Ranges": "bytes", "Cache-Control": "no-store", ...extraHeaders };
    if (range === "invalid") {
      response.writeHead(416, { ...headers, "Content-Range": `bytes */${size}` });
      response.end();
      return;
    }
    const { start, end } = range ?? { start: 0, end: size - 1 };
    response.writeHead(range ? 206 : 200, {
      ...headers,
      "Content-Length": String(end - start + 1),
      ...(range ? { "Content-Range": `bytes ${start}-${end}/${size}` } : {}),
    });
    if (request.method === "HEAD") {
      response.end();
      return;
    }
    const stream = fs.createReadStream(file, { start, end });
    stream.on("error", () => response.destroy());
    response.on("close", () => stream.destroy());
    stream.pipe(response);
  }

  async function sendCover(request, response, track, size) {
    const wanted = size && source.shrink ? size : 0;
    const cacheKey = `${publicTrack(track).cover_key}:${wanted}`;
    // Requests for the same album's cover that arrive together (songs of one album have different addresses
    // but one cover) share one reading and shrinking instead of each doing its own.
    let making = thumbnails.get(cacheKey) ?? coversBeingMade.get(cacheKey);
    if (!making) {
      making = (async () => {
        const cover = await source.cover(track.source_uri);
        if (!cover || (cover.mime !== "image/jpeg" && cover.mime !== "image/png")) return null;
        let made = { mime: cover.mime, bytes: Buffer.from(cover.data_base64, "base64") };
        if (wanted) {
          try {
            made = { mime: "image/jpeg", bytes: await source.shrink(made.bytes, wanted) };
          } catch (error) {
            log(`library share: cover not shrunk: ${error?.message ?? error}`);
          }
          // Not kept if the library changed while this was made (the cover may be the change).
          if (coversBeingMade.get(cacheKey) === making) {
            thumbnails.set(cacheKey, made);
            if (thumbnails.size > MAX_THUMBNAILS) thumbnails.delete(thumbnails.keys().next().value);
          }
        }
        return made;
      })().finally(() => {
        if (coversBeingMade.get(cacheKey) === making) coversBeingMade.delete(cacheKey);
      });
      coversBeingMade.set(cacheKey, making);
    }
    const picture = await making;
    if (!picture) {
      send(response, 404, "No cover.");
      return;
    }
    response.writeHead(200, { "Content-Type": picture.mime, "Content-Length": String(picture.bytes.length), "Cache-Control": "private, max-age=3600" });
    response.end(request.method === "HEAD" ? undefined : picture.bytes);
  }

  /** A renderer fetching a song or cover with a casting token (D77). */
  async function serveCast(request, response, url) {
    const match = /^\/cast\/([0-9a-f]{48})\/(audio|cover)\/([^/.]+)(\.[a-z0-9]{1,5})?$/.exec(url.pathname);
    const expires = match ? castTokens.get(match[1]) : undefined;
    if (!match || !expires || expires < Date.now()) {
      send(response, 404, "Not found.");
      return;
    }
    const track = await trackFor(decodeURIComponent(match[3]));
    if (!track) {
      send(response, 404, "No such track.");
      return;
    }
    if (match[2] === "audio") {
      // DLNA renderers (Samsung TVs among them) want these to stream and seek.
      await streamAudio(request, response, track, { "transferMode.dlna.org": "Streaming", "contentFeatures.dlna.org": "DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000" });
    } else {
      await sendCover(request, response, track, 600);
    }
  }

  async function handle(request, response) {
    const address = request.socket.remoteAddress ?? "";
    response.setHeader("Access-Control-Allow-Origin", "*"); // the TV app's page has no web origin of its own
    response.setHeader("X-Content-Type-Options", "nosniff");
    if (!isHomeNetworkAddress(address)) {
      send(response, 403, "Only devices on the home network can use this.");
      return;
    }
    if (request.method === "OPTIONS") {
      response.writeHead(204, { "Access-Control-Allow-Methods": "GET, HEAD, POST", "Access-Control-Allow-Headers": "Range, Content-Type, Authorization, X-MediaVerse-Key", "Access-Control-Expose-Headers": "X-MediaVerse-Ticket", "Access-Control-Max-Age": "600" });
      response.end();
      return;
    }
    const url = new URL(request.url ?? "/", "http://share.invalid");
    // The only changes a TV can make: flag a song for review, or mark it a favorite (D44); and it can say what it
    // is playing when the computer sent it music (D76).
    const writing = request.method === "POST" && (/^\/api\/(flag|favorite)\/[^/]+$/.test(url.pathname) || url.pathname === "/api/remote/state");
    if (request.method !== "GET" && request.method !== "HEAD" && !writing) {
      send(response, 405, "Only flags and favorites can be changed.", { Allow: "GET, HEAD" });
      return;
    }
    if (url.pathname.startsWith("/cast/") && (request.method === "GET" || request.method === "HEAD")) {
      await serveCast(request, response, url);
      return;
    }
    if (url.pathname === "/api/hello") {
      send(response, 200, { app: "MediaVerse Studio", api: API_VERSION, computer: os.hostname() });
      return;
    }
    if (lockedOut(address)) {
      send(response, 429, { error: "locked", message: "Too many wrong codes. Try again in 10 minutes." });
      return;
    }
    if (url.pathname === "/api/pair") {
      // A TV asks to pair only after someone on the computer pressed Pair a TV.
      const current = currentPairing();
      if (!pairingArmed() && !(current && current.address === address)) {
        send(response, 403, { error: "not_armed", message: "On the computer, open Settings > TV and press Pair a TV, then try again." });
        return;
      }
      if (current && current.address !== address) {
        send(response, 409, { error: "busy", message: "Another device is pairing with this computer. Try again in a few minutes." });
        return;
      }
      clearTimeout(pairingTimer);
      const ip = plainAddress(address);
      const name = cleanDeviceName(url.searchParams.get("name")) ?? "TV";
      pairing = { code: newPairingCode(), name: `${name} (${ip})`, address, expires: Date.now() + PAIRING_MS };
      pairingTimer = setTimeout(endPairing, PAIRING_MS);
      pairingTimer.unref?.();
      onChange();
      send(response, 200, { api: API_VERSION, computer: os.hostname(), expires_in: PAIRING_MS / 1000 });
      return;
    }
    if (url.pathname === "/api/pair/confirm") {
      const current = currentPairing();
      if (!current || current.address !== address) {
        send(response, 410, { error: "no_pairing", message: "The pairing code has expired. Start again." });
        return;
      }
      if (!codeMatches(url.searchParams.get("code"), current.code)) {
        noteWrongCode(address);
        if (lockedOut(address)) endPairing();
        send(response, 401, { error: "wrong_code", message: "That is not the code shown on the computer." });
        return;
      }
      wrongCodes.delete(address);
      const key = newDeviceKey();
      const device = { id: crypto.randomUUID(), name: current.name, key_hash: keyHash(key), paired: new Date().toISOString() };
      settings = { ...settings, devices: [...settings.devices, device].slice(-MAX_DEVICES) };
      save();
      endPairing();
      onChange();
      send(response, 200, { api: API_VERSION, key, computer: os.hostname() });
      return;
    }
    // Keys are 64 random hex digits, too many to guess, so a wrong key (a TV removed in Settings, still
    // asking for covers) does not count towards the lockout; only wrong pairing codes do.
    const device = deviceForRequest(request, url);
    if (!device) {
      send(response, 401, { error: "not_paired", message: "This TV is not paired with the computer (or was removed in Settings > TV). Pair it again." });
      return;
    }
    issueTicket(response, device);
    if (url.pathname === "/api/remote" && request.method === "GET") {
      await waitForRemote(request, response, device, url);
      return;
    }
    if (url.pathname === "/api/remote/state") {
      await takeRemoteState(request, response, device);
      return;
    }

    if (url.pathname === "/api/library") {
      const { listBody } = await currentLibrary();
      const packed = /\bgzip\b/.test(String(request.headers["accept-encoding"] ?? ""));
      const body = packed ? listBody.packed : listBody.plain;
      response.writeHead(200, {
        "Content-Type": "application/json; charset=utf-8",
        "Cache-Control": "no-store",
        "Content-Length": String(body.length),
        Vary: "Accept-Encoding",
        ...(packed ? { "Content-Encoding": "gzip" } : {}),
      });
      response.end(request.method === "HEAD" ? undefined : body);
      return;
    }
    if (url.pathname === "/api/marks") {
      send(response, 200, await currentMarks());
      return;
    }
    if (url.pathname === "/api/playlists") {
      // The computer's playlists (D82), as track IDs in play order; songs no longer in the library are left out.
      const { byPath } = await currentLibrary();
      const lists = (await source.playlists?.()) ?? [];
      send(response, 200, {
        playlists: lists.map((p) => ({ id: p.id, name: p.name, updated_at: p.updated_at ?? 0, ids: (p.paths ?? []).map((file) => byPath.get(file)).filter(Boolean) })),
      });
      return;
    }
    if (writing) {
      await changeMark(request, response, url);
      return;
    }
    const match = /^\/api\/(audio|cover|lyrics)\/([^/]+)$/.exec(url.pathname);
    if (!match) {
      send(response, 404, "Not found.");
      return;
    }
    const [, kind, rawId] = match;
    const track = await trackFor(decodeURIComponent(rawId));
    if (!track) {
      send(response, 404, "No such track.");
      return;
    }
    if (kind === "audio") {
      await streamAudio(request, response, track);
    } else if (kind === "cover") {
      // ?size=N (64 to 1024) asks for a smaller copy: a TV showing dozens of covers cannot hold them full size.
      const size = Number(url.searchParams.get("size"));
      await sendCover(request, response, track, Number.isInteger(size) && size >= 64 && size <= 1024 ? size : 0);
    } else {
      const lyrics = await source.lyrics(track.source_uri);
      send(response, 200, lyrics ?? { plain: null, synced: false, lines: [], source: null });
    }
  }

  function start() {
    if (server || !settings.enabled) return Promise.resolve();
    problem = null;
    return new Promise((resolve) => {
      const created = http.createServer((request, response) => {
        handle(request, response).catch((error) => {
          log(`library share: ${error?.message ?? error}`);
          if (!response.headersSent) send(response, 500, "Something went wrong on the computer.");
          else response.destroy();
        });
      });
      created.on("error", (error) => {
        problem = error.code === "EADDRINUSE" ? `Port ${settings.port} is already used by another program.` : String(error.message ?? error);
        log(`library share: ${problem}`);
        server = null;
        resolve();
      });
      created.listen(settings.port, "0.0.0.0", () => {
        server = created;
        resolve();
      });
    });
  }

  function stop() {
    endPairing();
    const running = server;
    server = null;
    if (!running) return Promise.resolve();
    return new Promise((resolve) => {
      running.close(() => resolve());
      running.closeAllConnections?.();
    });
  }

  function status() {
    return {
      enabled: settings.enabled,
      running: server !== null,
      problem: settings.enabled ? problem : null,
      port: settings.port,
      addresses: homeAddresses(),
      devices: settings.devices.map(({ id, name, paired }) => ({ id, name, paired })),
      pairing: currentPairing() ? { name: pairing.name, code: pairing.code, expires: pairing.expires } : null,
      pairing_armed: pairingArmed(),
    };
  }

  async function setEnabled(enabled) {
    settings = { ...settings, enabled: enabled === true };
    writeSettings(settingsFile, settings);
    if (settings.enabled) await start();
    else await stop();
    return status();
  }

  function forgetDevice(id) {
    settings = { ...settings, devices: settings.devices.filter((device) => device.id !== id) };
    writeSettings(settingsFile, settings);
    return status();
  }

  function cancelPairing() {
    endPairing();
    return status();
  }

  return {
    start,
    stop,
    status,
    setEnabled,
    forgetDevice,
    cancelPairing,
    armPairing,
    remoteDevices,
    sendRemote,
    castLink,
    /** The library changed: the next request reads it again. */
    invalidate() {
      library = null;
      thumbnails.clear();
      coversBeingMade.clear();
    },
  };
}

module.exports = { createLibraryShare, isHomeNetworkAddress, newPairingCode, codeMatches, parseRange, publicTrack, cleanDeviceName, DEFAULT_PORT, MAX_WRONG_CODES };
