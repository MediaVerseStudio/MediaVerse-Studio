// Google Cast (D80): plays a song from this computer's library share on a Chromecast, Google TV or Cast speaker.
// Written here with Node's own TLS and UDP (no new component; the owner approved `castv2` and `multicast-dns`,
// but the protocol is small enough that they were not needed, and `castv2` would have brought `protobufjs`):
// - finding devices: one mDNS question for `_googlecast._tcp.local` (DNS packets encoded and read here);
// - talking to one: TLS to port 8009 (the devices use their own self-signed certificates), messages framed by a
//   4-byte length and encoded as the small "CastMessage" protocol buffer (encoded and read here), carrying JSON
//   on the standard namespaces (connection, heartbeat, receiver, media).
// The same interface as dlna.js (discover, load, play, pause, stop, seek, status), so the page treats both alike.
// Only devices on the home network are contacted.

const dgram = require("node:dgram");
const tls = require("node:tls");
const os = require("node:os");
const { isHomeNetworkAddress } = require("./library-share");

/** Google's Default Media Receiver: works on every Cast device without registration. */
const DEFAULT_RECEIVER = "CC1AD845";
/** The MediaVerse Studio receiver (registered 2026-11-06; used once its page is published, see the casting plan). */
const MEDIAVERSE_RECEIVER = "0E81A85C";

const NS = {
  connection: "urn:x-cast:com.google.cast.tp.connection",
  heartbeat: "urn:x-cast:com.google.cast.tp.heartbeat",
  receiver: "urn:x-cast:com.google.cast.receiver",
  media: "urn:x-cast:com.google.cast.media",
};

// ---- The CastMessage protocol buffer (fields 1-7; enums and strings only) ----

function varint(n) {
  const out = [];
  let v = n >>> 0;
  while (v > 0x7f) {
    out.push((v & 0x7f) | 0x80);
    v >>>= 7;
  }
  out.push(v);
  return Buffer.from(out);
}

function field(number, value) {
  if (typeof value === "number") return Buffer.concat([varint(number << 3), varint(value)]);
  const bytes = Buffer.isBuffer(value) ? value : Buffer.from(String(value), "utf8");
  return Buffer.concat([varint((number << 3) | 2), varint(bytes.length), bytes]);
}

/** {source, destination, namespace, data} as a CastMessage; `data` is JSON (or a string). */
function encodeMessage({ source = "sender-0", destination = "receiver-0", namespace, data }) {
  const text = typeof data === "string" ? data : JSON.stringify(data);
  return Buffer.concat([field(1, 0), field(2, source), field(3, destination), field(4, namespace), field(5, 0), field(6, text)]);
}

function readVarint(buffer, at) {
  let value = 0;
  let shift = 0;
  for (;;) {
    if (at >= buffer.length) throw new Error("truncated message");
    const byte = buffer[at++];
    value += (byte & 0x7f) * 2 ** shift;
    if (!(byte & 0x80)) return [value, at];
    shift += 7;
    if (shift > 49) throw new Error("bad number");
  }
}

function decodeMessage(buffer) {
  const out = {};
  let at = 0;
  while (at < buffer.length) {
    let key;
    [key, at] = readVarint(buffer, at);
    const number = Math.floor(key / 8);
    const type = key & 7;
    if (type === 0) {
      let value;
      [value, at] = readVarint(buffer, at);
      if (number === 5) out.binary = value === 1;
    } else if (type === 2) {
      let length;
      [length, at] = readVarint(buffer, at);
      if (at + length > buffer.length) throw new Error("truncated message");
      const bytes = buffer.subarray(at, at + length);
      at += length;
      const names = { 2: "source", 3: "destination", 4: "namespace", 6: "text" };
      if (names[number]) out[names[number]] = bytes.toString("utf8");
    } else {
      throw new Error("unexpected field type");
    }
  }
  return out;
}

/** Splits a stream into 4-byte-length-prefixed messages; returns the complete ones and keeps the rest. */
function createFramer(onMessage) {
  let pending = Buffer.alloc(0);
  return (chunk) => {
    pending = pending.length ? Buffer.concat([pending, chunk]) : chunk;
    while (pending.length >= 4) {
      const size = pending.readUInt32BE(0);
      if (size > 1024 * 1024) throw new Error("message too large");
      if (pending.length < 4 + size) break;
      onMessage(pending.subarray(4, 4 + size));
      pending = pending.subarray(4 + size);
    }
  };
}

const frame = (message) => {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(message.length);
  return Buffer.concat([head, message]);
};

// ---- mDNS: one question, and the answers' PTR, SRV, TXT and A records ----

function encodeName(name) {
  return Buffer.concat([...name.split(".").filter(Boolean).map((label) => Buffer.concat([Buffer.from([Buffer.byteLength(label)]), Buffer.from(label)])), Buffer.from([0])]);
}

/** A DNS query for PTR `_googlecast._tcp.local`, asking for unicast answers (the QU bit). */
function castQuery() {
  const header = Buffer.from([0, 0, 0, 0, 0, 1, 0, 0, 0, 0, 0, 0]); // id 0, 1 question
  return Buffer.concat([header, encodeName("_googlecast._tcp.local"), Buffer.from([0, 12, 0x80, 1])]);
}

function readName(buffer, at, depth = 0) {
  const labels = [];
  let end = null;
  for (;;) {
    if (at >= buffer.length || depth > 20) throw new Error("bad name");
    const length = buffer[at];
    if (length === 0) {
      at += 1;
      break;
    }
    if ((length & 0xc0) === 0xc0) {
      const pointer = ((length & 0x3f) << 8) | buffer[at + 1];
      if (end === null) end = at + 2;
      const [rest] = readName(buffer, pointer, depth + 1);
      if (rest) labels.push(rest);
      at = end;
      return [labels.join("."), end];
    }
    labels.push(buffer.toString("utf8", at + 1, at + 1 + length));
    at += 1 + length;
  }
  return [labels.join("."), end ?? at];
}

/** The records in an mDNS answer: [{name, type, data}] for PTR (12), TXT (16), SRV (33) and A (1). */
function parseAnswer(buffer) {
  if (buffer.length < 12) return [];
  const count = (o) => buffer.readUInt16BE(o);
  let at = 12;
  for (let q = 0; q < count(4); q++) {
    [, at] = readName(buffer, at);
    at += 4;
  }
  const records = [];
  const total = count(6) + count(8) + count(10);
  for (let r = 0; r < total && at < buffer.length; r++) {
    let name;
    [name, at] = readName(buffer, at);
    const type = buffer.readUInt16BE(at);
    const length = buffer.readUInt16BE(at + 8);
    const start = at + 10;
    at = start + length;
    if (type === 12) records.push({ name, type: "PTR", data: readName(buffer, start)[0] });
    else if (type === 33) records.push({ name, type: "SRV", data: { port: buffer.readUInt16BE(start + 4), target: readName(buffer, start + 6)[0] } });
    else if (type === 1 && length === 4) records.push({ name, type: "A", data: [...buffer.subarray(start, start + 4)].join(".") });
    else if (type === 16) {
      const txt = {};
      let t = start;
      while (t < start + length) {
        const size = buffer[t];
        const entry = buffer.toString("utf8", t + 1, t + 1 + size);
        const eq = entry.indexOf("=");
        if (eq > 0) txt[entry.slice(0, eq)] = entry.slice(eq + 1);
        t += 1 + size;
      }
      records.push({ name, type: "TXT", data: txt });
    }
  }
  return records;
}

/** Cast devices described by a set of records: {id, name, model, host, port}. */
function devicesFrom(records, fromAddress) {
  const devices = [];
  for (const ptr of records.filter((r) => r.type === "PTR" && r.name === "_googlecast._tcp.local")) {
    const instance = ptr.data;
    const srv = records.find((r) => r.type === "SRV" && r.name === instance)?.data;
    const txt = records.find((r) => r.type === "TXT" && r.name === instance)?.data ?? {};
    const address = (srv && records.find((r) => r.type === "A" && r.name === srv.target)?.data) || fromAddress;
    if (!address || !isHomeNetworkAddress(address)) continue;
    devices.push({ id: `cast:${txt.id || instance}`, name: txt.fn || instance.split(".")[0], model: txt.md || "Google Cast", host: address, port: srv?.port ?? 8009 });
  }
  return devices;
}

function localAddresses() {
  const found = [];
  for (const [name, entries] of Object.entries(os.networkInterfaces())) {
    if (/vEthernet|VirtualBox|VMware|WSL|Hyper-V/i.test(name)) continue;
    for (const entry of entries ?? []) {
      if (entry.family === "IPv4" && !entry.internal && isHomeNetworkAddress(entry.address) && !entry.address.startsWith("169.254.")) found.push(entry.address);
    }
  }
  return found;
}

// ---- One connection to a device ----

class CastConnection {
  constructor(host, port, log) {
    this.host = host;
    this.port = port;
    this.log = log;
    this.requestId = 1;
    this.waiting = new Map(); // requestId -> {resolve, reject, timer}
    this.connectedTo = new Set();
    this.listeners = new Set();
    this.closed = false;
  }

  open() {
    if (!isHomeNetworkAddress(this.host)) return Promise.reject(new Error("Only devices on the home network are spoken to."));
    return new Promise((resolve, reject) => {
      // Cast devices present certificates signed by Google's device CA, not a public one: the connection is
      // encrypted, and only home-network addresses are used.
      const socket = tls.connect({ host: this.host, port: this.port, rejectUnauthorized: false, timeout: 8000 }, () => {
        socket.setTimeout(0);
        this.socket = socket;
        this.sendTo("receiver-0", NS.connection, { type: "CONNECT" });
        this.connectedTo.add("receiver-0");
        this.heartbeat = setInterval(() => this.sendTo("receiver-0", NS.heartbeat, { type: "PING" }), 5000);
        resolve(this);
      });
      const feed = createFramer((bytes) => this.receive(bytes));
      socket.on("data", (chunk) => {
        try {
          feed(chunk);
        } catch (error) {
          this.log(`cast: ${error.message}`);
          socket.destroy();
        }
      });
      socket.on("timeout", () => socket.destroy(new Error("The device did not answer.")));
      socket.on("error", (error) => {
        reject(error);
        this.close();
      });
      socket.on("close", () => this.close());
    });
  }

  sendTo(destination, namespace, data) {
    if (!this.socket || this.closed) throw new Error("Not connected to the device.");
    this.socket.write(frame(encodeMessage({ destination, namespace, data })));
  }

  /** Sends a request and waits for the answer carrying the same requestId. */
  request(destination, namespace, data, timeoutMs = 10_000) {
    const requestId = this.requestId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiting.delete(requestId);
        reject(new Error("The device did not answer in time."));
      }, timeoutMs);
      this.waiting.set(requestId, { resolve, reject, timer });
      try {
        this.sendTo(destination, namespace, { ...data, requestId });
      } catch (error) {
        clearTimeout(timer);
        this.waiting.delete(requestId);
        reject(error);
      }
    });
  }

  receive(bytes) {
    const message = decodeMessage(bytes);
    if (message.binary || !message.text) return;
    let data;
    try {
      data = JSON.parse(message.text);
    } catch {
      return;
    }
    if (message.namespace === NS.heartbeat && data.type === "PING") {
      this.sendTo(message.source, NS.heartbeat, { type: "PONG" });
      return;
    }
    if (message.namespace === NS.connection && data.type === "CLOSE") {
      this.connectedTo.delete(message.source);
    }
    const waiter = this.waiting.get(data.requestId);
    if (waiter && data.requestId) {
      this.waiting.delete(data.requestId);
      clearTimeout(waiter.timer);
      if (/^(LAUNCH_ERROR|LOAD_FAILED|LOAD_CANCELLED|INVALID_REQUEST|INVALID_PLAYER_STATE)$/.test(data.type)) waiter.reject(new Error(`The device refused: ${data.reason || data.type}`));
      else waiter.resolve(data);
    }
    for (const listener of this.listeners) listener(message.namespace, data);
  }

  close() {
    if (this.closed) return;
    this.closed = true;
    clearInterval(this.heartbeat);
    for (const waiter of this.waiting.values()) {
      clearTimeout(waiter.timer);
      waiter.reject(new Error("The connection to the device closed."));
    }
    this.waiting.clear();
    this.socket?.destroy();
  }
}

function createGoogleCast({ log = () => {}, addresses = localAddresses, appId = MEDIAVERSE_RECEIVER } = {}) {
  /** id -> {device, connection, transportId, mediaSessionId} */
  const devices = new Map();

  async function discover(seconds = 3) {
    const found = new Map();
    await Promise.all(
      addresses().map(
        (local) =>
          new Promise((resolve) => {
            const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
            const finish = () => {
              try {
                socket.close();
              } catch {
                // closed
              }
              resolve();
            };
            socket.on("error", (error) => {
              log(`cast: search from ${local} failed: ${error.message}`);
              finish();
            });
            socket.on("message", (message, from) => {
              try {
                for (const device of devicesFrom(parseAnswer(message), from.address)) found.set(device.id, device);
              } catch {
                // not an answer we can read
              }
            });
            socket.bind(0, local, () => {
              try {
                socket.setMulticastInterface(local);
              } catch {
                // the default interface
              }
              const query = castQuery();
              socket.send(query, 5353, "224.0.0.251");
              setTimeout(() => socket.send(query, 5353, "224.0.0.251"), 500);
              setTimeout(finish, seconds * 1000);
            });
          }),
      ),
    );
    for (const device of found.values()) {
      const known = devices.get(device.id);
      if (known && known.device.host !== device.host) {
        known.connection?.close();
        devices.set(device.id, { device });
      } else if (!known) devices.set(device.id, { device });
    }
    return [...found.values()].map(({ id, name, model, host }) => ({ id, name, model, host }));
  }

  function entryFor(id) {
    const entry = devices.get(id);
    if (!entry) throw new Error("That Cast device is no longer found. Search again.");
    return entry;
  }

  async function connected(entry) {
    if (!entry.connection || entry.connection.closed) {
      entry.connection = await new CastConnection(entry.device.host, entry.device.port, log).open();
      entry.transportId = null;
      entry.mediaSessionId = null;
      entry.connection.listeners.add((namespace, data) => {
        if (namespace === NS.media && data.type === "MEDIA_STATUS" && data.status?.[0]?.mediaSessionId) entry.mediaSessionId = data.status[0].mediaSessionId;
      });
    }
    return entry.connection;
  }

  /**
   * Makes sure the receiver app runs, and returns its transport id (the address of its media channel). The
   * MediaVerse receiver is tried first; a device that cannot load it (not registered while it is unpublished, or
   * offline from the website) gets Google's Default Media Receiver, remembered for that device.
   */
  async function launched(entry) {
    const connection = await connected(entry);
    const wanted = entry.appId ?? appId;
    const statusOf = (reply, id) => reply.status?.applications?.find((a) => a.appId === id);
    let app = statusOf(await connection.request("receiver-0", NS.receiver, { type: "GET_STATUS" }), wanted);
    if (!app) {
      try {
        app = statusOf(await connection.request("receiver-0", NS.receiver, { type: "LAUNCH", appId: wanted }, 20_000), wanted);
        entry.appId = wanted;
      } catch (error) {
        if (wanted === DEFAULT_RECEIVER) throw error;
        log(`cast: ${entry.device.name} cannot open the MediaVerse player (${error.message}); using Google's`);
        entry.appId = DEFAULT_RECEIVER;
        app = statusOf(await connection.request("receiver-0", NS.receiver, { type: "LAUNCH", appId: DEFAULT_RECEIVER }, 20_000), DEFAULT_RECEIVER);
      }
    }
    if (!app?.transportId) throw new Error("The music player did not start on the device.");
    if (!connection.connectedTo.has(app.transportId)) {
      connection.sendTo(app.transportId, NS.connection, { type: "CONNECT" });
      connection.connectedTo.add(app.transportId);
    }
    entry.transportId = app.transportId;
    entry.sessionId = app.sessionId;
    return app.transportId;
  }

  async function media(id, command) {
    const entry = entryFor(id);
    const connection = await connected(entry);
    const transportId = entry.transportId ?? (await launched(entry));
    if (!entry.mediaSessionId) throw new Error("Nothing is playing on the device.");
    return connection.request(transportId, NS.media, { ...command, mediaSessionId: entry.mediaSessionId });
  }

  /** What a song looks like to the device (the MediaVerse receiver also gets the lyrics; Google's ignores them). */
  function mediaJson(song) {
    return {
      contentId: song.url,
      contentType: song.mime,
      streamType: "BUFFERED",
      ...(song.seconds ? { duration: song.seconds } : {}),
      ...(song.lyrics ? { customData: { lyrics: song.lyrics } } : {}),
      metadata: {
        metadataType: 3, // a music track
        title: song.title,
        ...(song.artist ? { artist: song.artist } : {}),
        ...(song.album ? { albumName: song.album } : {}),
        ...(song.cover ? { images: [{ url: song.cover }] } : {}),
      },
    };
  }
  /** A queue entry: the device fetches the next song ahead of time (`preloadTime` seconds before the end). */
  const queueItem = (song) => ({ media: mediaJson(song), autoplay: true, preloadTime: 20, startTime: 0 });

  return {
    discover,
    host: (id) => devices.get(id)?.device.host ?? null,
    name: (id) => devices.get(id)?.device.name ?? null,
    /**
     * Plays one song: {url, mime, title, artist, album, cover, seconds, lyrics} from `startSeconds`. It is loaded as a
     * one-song queue so that the next song can be put behind it (`preloadNext`): the device then starts it by itself, with
     * no gap. A device that refuses a queue gets a plain load (and the next song is loaded when the end is seen).
     */
    async load(id, song, startSeconds = 0) {
      const entry = entryFor(id);
      const connection = await connected(entry);
      const transportId = await launched(entry);
      entry.queueActive = false;
      if (entry.queueSupported !== false) {
        try {
          const reply = await connection.request(
            transportId,
            NS.media,
            { type: "QUEUE_LOAD", items: [queueItem(song)], startIndex: 0, repeatMode: "REPEAT_OFF", currentTime: Math.max(0, startSeconds || 0) },
            30_000,
          );
          entry.mediaSessionId = reply.status?.[0]?.mediaSessionId ?? entry.mediaSessionId;
          entry.queueActive = true;
          return;
        } catch (error) {
          // Only a refusal means "no queues here"; a lost connection or a slow device is the caller's to handle.
          if (!/refused/i.test(String(error?.message))) throw error;
          log(`cast: ${entry.device.name} does not take a queue (${error.message}); loading one song at a time`);
          entry.queueSupported = false;
        }
      }
      const reply = await connection.request(
        transportId,
        NS.media,
        { type: "LOAD", autoplay: true, currentTime: Math.max(0, startSeconds || 0), media: mediaJson(song) },
        30_000,
      );
      entry.mediaSessionId = reply.status?.[0]?.mediaSessionId ?? entry.mediaSessionId;
    },
    /** True when the device can be told which song follows (then it starts that song by itself). */
    canPreload: (id) => entryFor(id).queueActive === true,
    /** Puts the song that follows the current one behind it on the device. */
    async preloadNext(id, song) {
      if (!entryFor(id).queueActive) return;
      // Right after a load the device may not have announced the new media session yet: look again a few times.
      for (let attempt = 0; ; attempt++) {
        try {
          await media(id, { type: "QUEUE_INSERT", items: [queueItem(song)] });
          return;
        } catch (error) {
          if (attempt >= 4 || !/INVALID_MEDIA_SESSION_ID/.test(String(error?.message))) throw error;
          await new Promise((resolve) => setTimeout(resolve, 600));
        }
      }
    },
    /** The device's own volume, 0 to 1 (also takes it off mute: a muted receiver plays silently). */
    async setVolume(id, level) {
      const entry = entryFor(id);
      const connection = await connected(entry);
      await launched(entry);
      await connection.request("receiver-0", NS.receiver, { type: "SET_VOLUME", volume: { level: Math.min(1, Math.max(0, level)), muted: false } });
    },    play: (id) => media(id, { type: "PLAY" }),
    pause: (id) => media(id, { type: "PAUSE" }),
    /** Stops the song and closes the player, so the TV goes back to what it showed before. */
    async stop(id) {
      const entry = entryFor(id);
      await media(id, { type: "STOP" }).catch(() => {});
      const connection = await connected(entry);
      const reply = await connection.request("receiver-0", NS.receiver, { type: "GET_STATUS" });
      const app = reply.status?.applications?.find((a) => a.appId === (entry.appId ?? appId));
      if (app?.sessionId) await connection.request("receiver-0", NS.receiver, { type: "STOP", sessionId: app.sessionId }).catch(() => {});
      entry.transportId = null;
      entry.mediaSessionId = null;
      entry.sessionId = null;
    },
    seek: (id, seconds) => media(id, { type: "SEEK", currentTime: Math.max(0, seconds) }),
    /** Same shape as dlna.js: {state: "PLAYING" | "PAUSED_PLAYBACK" | "STOPPED" | "TRANSITIONING", position, duration, uri, itemId, volume}. */
    async status(id) {
      const entry = entryFor(id);
      const connection = await connected(entry);
      const transportId = entry.transportId ?? (await launched(entry));
      const reply = await connection.request(transportId, NS.media, { type: "GET_STATUS" });
      const now = reply.status?.[0];
      const state = !now ? "STOPPED" : now.playerState === "PLAYING" ? "PLAYING" : now.playerState === "PAUSED" ? "PAUSED_PLAYBACK" : now.playerState === "BUFFERING" ? "TRANSITIONING" : "STOPPED";
      // The device volume (not the media stream volume, which TVs leave at 1) is read every fourth time.
      if ((entry.polls = (entry.polls ?? 0) + 1) % 4 === 1) {
        const volume = (await connection.request("receiver-0", NS.receiver, { type: "GET_STATUS" }).catch(() => null))?.status?.volume;
        if (volume) entry.volume = volume.muted ? 0 : (volume.level ?? -1);
      }
      return { state, position: now?.currentTime ?? 0, duration: now?.media?.duration ?? 0, uri: now?.media?.contentId ?? "", itemId: now?.currentItemId ?? 0, volume: entry.volume ?? -1 };
    },
    close() {
      for (const entry of devices.values()) entry.connection?.close();
    },
  };
}

module.exports = { createGoogleCast, encodeMessage, decodeMessage, createFramer, frame, castQuery, parseAnswer, devicesFrom, encodeName, DEFAULT_RECEIVER, MEDIAVERSE_RECEIVER, NS };
