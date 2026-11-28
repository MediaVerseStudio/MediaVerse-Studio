// DLNA / UPnP casting (D77): finds TVs and speakers on the home network that can play music (UPnP
// MediaRenderers) and tells one to play a song from this computer's library share. Written here with Node's own
// networking (no new component; docs/casting-plan.md): SSDP to find devices, their description XML, and the
// standard AVTransport SOAP actions (SetAVTransportURI, Play, Pause, Stop, Seek, GetPositionInfo,
// GetTransportInfo). Only devices on the home network are spoken to, and only at the address they answered from.
// Searching happens only when the page asks, which it does only with Settings > Cast's switch on.

const dgram = require("node:dgram");
const http = require("node:http");
const os = require("node:os");
const { isHomeNetworkAddress } = require("./library-share");

const SSDP_ADDRESS = "239.255.255.250";
const SSDP_PORT = 1900;
const RENDERER = "urn:schemas-upnp-org:device:MediaRenderer:1";
const AV_TRANSPORT = "urn:schemas-upnp-org:service:AVTransport:1";
const RENDERING_CONTROL = "urn:schemas-upnp-org:service:RenderingControl:1";
const MAX_REPLY = 512 * 1024;

/** The M-SEARCH request asking MediaRenderers to answer. */
function searchMessage(mx = 2) {
  return [
    "M-SEARCH * HTTP/1.1",
    `HOST: ${SSDP_ADDRESS}:${SSDP_PORT}`,
    'MAN: "ssdp:discover"',
    `MX: ${mx}`,
    `ST: ${RENDERER}`,
    "USER-AGENT: MediaVerseStudio/1 UPnP/1.1",
    "",
    "",
  ].join("\r\n");
}

/** Headers of an SSDP answer, lower-cased names; null when it is not an HTTP 200 answer. */
function parseSsdpReply(text) {
  const lines = String(text).split(/\r?\n/);
  if (!/^HTTP\/1\.[01] 200/i.test(lines[0] ?? "")) return null;
  const headers = {};
  for (const line of lines.slice(1)) {
    const at = line.indexOf(":");
    if (at > 0) headers[line.slice(0, at).trim().toLowerCase()] = line.slice(at + 1).trim();
  }
  return headers;
}

const decode = (text) =>
  String(text)
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

const escapeXml = (text) => String(text ?? "").replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]);

/** The first `<tag>…</tag>` in `xml` (any namespace prefix), decoded; null when missing. */
function tag(xml, name) {
  const match = new RegExp(`<(?:[\\w-]+:)?${name}(?:\\s[^>]*)?>([\\s\\S]*?)</(?:[\\w-]+:)?${name}>`, "i").exec(xml);
  return match ? decode(match[1].trim()) : null;
}

/**
 * A device description (the XML at an SSDP answer's LOCATION): its name and the AVTransport control address.
 * Null when it cannot play (no AVTransport), or when the control address is on another host than `location`
 * (a description must not send this computer elsewhere).
 */
function parseDescription(xml, location) {
  const base = new URL(tag(xml, "URLBase") || location);
  const where = new URL(location);
  const services = [...String(xml).matchAll(/<service>([\s\S]*?)<\/service>/gi)].map((m) => m[1]);
  const transport = services.find((s) => (tag(s, "serviceType") ?? "").startsWith("urn:schemas-upnp-org:service:AVTransport:"));
  if (!transport) return null;
  const control = new URL(tag(transport, "controlURL") ?? "", base);
  if (control.hostname !== where.hostname || control.protocol !== "http:") return null;
  // Volume lives in RenderingControl, a second service of the same device (same host rule).
  const volumeService = services.find((s) => (tag(s, "serviceType") ?? "").startsWith("urn:schemas-upnp-org:service:RenderingControl:"));
  let rendering = null;
  if (volumeService) {
    const address = new URL(tag(volumeService, "controlURL") ?? "", base);
    if (address.hostname === where.hostname && address.protocol === "http:") rendering = address.href;
  }
  return {
    id: tag(xml, "UDN") || location,
    name: tag(xml, "friendlyName") || where.hostname,
    model: [tag(xml, "manufacturer"), tag(xml, "modelName")].filter(Boolean).join(" "),
    host: where.hostname,
    control: control.href,
    service: tag(transport, "serviceType") || AV_TRANSPORT,
    rendering,
    renderingService: (volumeService && tag(volumeService, "serviceType")) || RENDERING_CONTROL,
  };
}

/** "0:03:21" for 201.4 seconds (the form UPnP uses for times). */
function upnpTime(seconds) {
  const s = Math.max(0, Math.floor(seconds));
  return `${Math.floor(s / 3600)}:${String(Math.floor((s % 3600) / 60)).padStart(2, "0")}:${String(s % 60).padStart(2, "0")}`;
}

/** Seconds in "0:03:21" or "00:03:21.500"; 0 for "NOT_IMPLEMENTED" and the like. */
function parseUpnpTime(text) {
  const match = /^(\d+):(\d{1,2}):(\d{1,2})(?:\.(\d+))?/.exec(String(text ?? "").trim());
  if (!match) return 0;
  return Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]) + (match[4] ? Number(`0.${match[4]}`) : 0);
}

/** DIDL-Lite describing one song, so the TV can show its title, artist, album and cover. */
function didl({ url, mime, title, artist, album, cover, seconds }) {
  const duration = seconds ? ` duration="${upnpTime(seconds)}.000"` : "";
  const pn = mime === "audio/mpeg" ? "DLNA.ORG_PN=MP3;" : "";
  return (
    '<DIDL-Lite xmlns="urn:schemas-upnp-org:metadata-1-0/DIDL-Lite/" xmlns:dc="http://purl.org/dc/elements/1.1/" xmlns:upnp="urn:schemas-upnp-org:metadata-1-0/upnp/">' +
    '<item id="0" parentID="-1" restricted="1">' +
    `<dc:title>${escapeXml(title)}</dc:title>` +
    (artist ? `<dc:creator>${escapeXml(artist)}</dc:creator><upnp:artist>${escapeXml(artist)}</upnp:artist>` : "") +
    (album ? `<upnp:album>${escapeXml(album)}</upnp:album>` : "") +
    (cover ? `<upnp:albumArtURI>${escapeXml(cover)}</upnp:albumArtURI>` : "") +
    "<upnp:class>object.item.audioItem.musicTrack</upnp:class>" +
    `<res protocolInfo="http-get:*:${escapeXml(mime)}:${pn}DLNA.ORG_OP=01;DLNA.ORG_FLAGS=01700000000000000000000000000000"${duration}>${escapeXml(url)}</res>` +
    "</item></DIDL-Lite>"
  );
}

function soapBody(service, action, args) {
  const inner = Object.entries(args)
    .map(([key, value]) => `<${key}>${escapeXml(value)}</${key}>`)
    .join("");
  return (
    '<?xml version="1.0" encoding="utf-8"?>' +
    '<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/" s:encodingStyle="http://schemas.xmlsoap.org/soap/encoding/">' +
    `<s:Body><u:${action} xmlns:u="${service}">${inner}</u:${action}></s:Body></s:Envelope>`
  );
}

/** A small HTTP request with a time limit and a size limit; resolves {status, body}. */
function request(address, { method = "GET", headers = {}, body, timeoutMs = 4000 } = {}) {
  return new Promise((resolve, reject) => {
    const url = new URL(address);
    if (url.protocol !== "http:" || !isHomeNetworkAddress(url.hostname)) {
      reject(new Error("Only devices on the home network are spoken to."));
      return;
    }
    const req = http.request(url, { method, headers: { ...headers, ...(body ? { "Content-Length": Buffer.byteLength(body) } : {}) }, timeout: timeoutMs }, (res) => {
      const parts = [];
      let size = 0;
      res.on("data", (chunk) => {
        size += chunk.length;
        if (size > MAX_REPLY) req.destroy(new Error("The device's answer was too long."));
        else parts.push(chunk);
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: Buffer.concat(parts).toString("utf8") }));
    });
    req.on("timeout", () => req.destroy(new Error("The device did not answer.")));
    req.on("error", reject);
    if (body) req.write(body);
    req.end();
  });
}

/** Home-network IPv4 addresses of this computer (one search is sent from each). */
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

function createDlna({ log = () => {}, http: send = request, addresses = localAddresses } = {}) {
  /** id -> renderer found by the last search (kept between searches so a session survives one). */
  const renderers = new Map();

  /** Searches for about `seconds`; resolves the renderers found (also remembered for control). */
  async function discover(seconds = 3) {
    const locations = new Map(); // location -> sender address
    await Promise.all(
      addresses().map(
        (local) =>
          new Promise((resolve) => {
            const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
            const finish = () => {
              try {
                socket.close();
              } catch {
                // already closed
              }
              resolve();
            };
            socket.on("error", (error) => {
              log(`dlna: search from ${local} failed: ${error.message}`);
              finish();
            });
            socket.on("message", (message, from) => {
              const headers = parseSsdpReply(message.toString("utf8"));
              if (!headers?.location || !isHomeNetworkAddress(from.address)) return;
              try {
                // Only descriptions served by the device that answered.
                if (new URL(headers.location).hostname === from.address) locations.set(headers.location, from.address);
              } catch {
                // not a URL
              }
            });
            socket.bind(0, local, () => {
              const text = Buffer.from(searchMessage(Math.max(1, Math.min(3, seconds - 1))));
              socket.send(text, SSDP_PORT, SSDP_ADDRESS);
              setTimeout(() => socket.send(text, SSDP_PORT, SSDP_ADDRESS), 400); // UDP may drop one
              setTimeout(finish, seconds * 1000);
            });
          }),
      ),
    );
    const found = await Promise.all(
      [...locations.keys()].map(async (location) => {
        try {
          const reply = await send(location, { timeoutMs: 3000 });
          return reply.status === 200 ? parseDescription(reply.body, location) : null;
        } catch (error) {
          log(`dlna: ${location}: ${error.message}`);
          return null;
        }
      }),
    );
    const list = found.filter(Boolean);
    for (const renderer of list) renderers.set(renderer.id, renderer);
    return list.map(({ id, name, model, host }) => ({ id, name, model, host }));
  }

  async function act(id, action, args = {}, volume = false) {
    const renderer = renderers.get(id);
    if (!renderer) throw new Error("That TV or speaker is no longer found. Search again.");
    // Volume actions go to the RenderingControl service (a device without one has no volume to set).
    const address = volume ? renderer.rendering : renderer.control;
    const service = volume ? renderer.renderingService : renderer.service;
    if (!address) throw new Error(`${renderer.name} has no volume control.`);
    const reply = await send(address, {
      method: "POST",
      headers: { "Content-Type": 'text/xml; charset="utf-8"', SOAPACTION: `"${service}#${action}"` },
      body: soapBody(service, action, { InstanceID: 0, ...args }),
    });
    if (reply.status !== 200) {
      const errorCode = tag(reply.body, "errorCode");
      const why = tag(reply.body, "errorDescription") || tag(reply.body, "faultstring") || `HTTP ${reply.status}`;
      const detail = errorCode ? ` (UPnP ${errorCode})` : "";
      throw new Error(`${renderer.name} refused ${action}: ${why}${detail}`);
    }
    return reply.body;
  }

  /** Reads one device's description directly (a device that does not answer searches; tests). */
  async function addByLocation(location) {
    const reply = await send(location, { timeoutMs: 3000 });
    const renderer = reply.status === 200 ? parseDescription(reply.body, location) : null;
    if (!renderer) throw new Error("That address is not a TV or speaker that can play music.");
    renderers.set(renderer.id, renderer);
    return { id: renderer.id, name: renderer.name, model: renderer.model, host: renderer.host };
  }

  return {
    discover,
    addByLocation,
    host: (id) => renderers.get(id)?.host ?? null,
    name: (id) => renderers.get(id)?.name ?? null,
    /** Plays one song: {url, mime, title, artist, album, cover, seconds} from `startSeconds`. */
    async load(id, song, startSeconds = 0) {
      await act(id, "Stop").catch(() => {}); // some renderers refuse a new song while one plays
      await act(id, "SetAVTransportURI", { CurrentURI: song.url, CurrentURIMetaData: didl(song) });
      await act(id, "Play", { Speed: 1 });
      if (startSeconds > 1) {
        // Seeking works once the TV has started the song.
        await new Promise((resolve) => setTimeout(resolve, 1500));
        await act(id, "Seek", { Unit: "REL_TIME", Target: upnpTime(startSeconds) }).catch((error) => log(`dlna: seek: ${error.message}`));
      }
    },
    play: (id) => act(id, "Play", { Speed: 1 }),
    pause: (id) => act(id, "Pause"),
    stop: (id) => act(id, "Stop"),
    seek: (id, seconds) => act(id, "Seek", { Unit: "REL_TIME", Target: upnpTime(seconds) }),
    /** DLNA devices are given one song at a time (the next is loaded when the end is seen). */
    canPreload: () => false,
    preloadNext: async () => {},
    /** The device volume, 0 to 1 (0 to 100 on the wire); also takes it off mute. */
    async setVolume(id, level) {
      const percent = Math.round(Math.min(1, Math.max(0, level)) * 100);
      await act(id, "SetVolume", { Channel: "Master", DesiredVolume: percent }, true);
      await act(id, "SetMute", { Channel: "Master", DesiredMute: 0 }, true).catch(() => {});
    },
    /** {state: "PLAYING" | "PAUSED_PLAYBACK" | "STOPPED" | "TRANSITIONING" | "NO_MEDIA_PRESENT", position, duration, uri}. */
    async status(id) {
      const [transport, position] = await Promise.all([act(id, "GetTransportInfo"), act(id, "GetPositionInfo")]);
      // The volume is read every fourth time (it is a second request, to another service).
      const renderer = renderers.get(id);
      if (renderer?.rendering && (renderer.polls = (renderer.polls ?? 0) + 1) % 4 === 1) {
        const reading = tag(await act(id, "GetVolume", { Channel: "Master" }, true).catch(() => ""), "CurrentVolume");
        const muted = tag(await act(id, "GetMute", { Channel: "Master" }, true).catch(() => ""), "CurrentMute") === "1";
        if (reading !== null && Number.isFinite(Number(reading))) renderer.volume = muted ? 0 : Number(reading) / 100;
      }
      return {
        volume: renderer?.volume ?? -1,
        state: tag(transport, "CurrentTransportState") ?? "UNKNOWN",
        position: parseUpnpTime(tag(position, "RelTime")),
        duration: parseUpnpTime(tag(position, "TrackDuration")),
        uri: tag(position, "TrackURI") ?? "",
      };
    },
  };
}

module.exports = { createDlna, searchMessage, parseSsdpReply, parseDescription, didl, soapBody, upnpTime, parseUpnpTime, tag };
