// Settings > Jellyfin (D90): finds Jellyfin servers on this computer and the home network, says whether TVs can
// sign in to them (Quick Connect, used by the TV app) and opens a found server's own web page. Nothing is installed or
// changed on a server from here; installing Jellyfin is done with Jellyfin's own installer from jellyfin.org.
//
// Discovery: Jellyfin answers the UDP message "who is JellyfinServer?" on port 7359 with JSON
// {"Address":"http://192.168.1.5:8096","Id":"...","Name":"...","EndpointAddress":null}. A server on this computer
// is also tried directly on the default web port (8096), because some networks drop broadcasts.

const dgram = require("node:dgram");
const os = require("node:os");

const DISCOVERY_PORT = 7359;
const WEB_PORT = 8096;
const DISCOVERY_MESSAGE = "who is JellyfinServer?";

/** One discovery reply, or null if it is not a usable one (only http(s) addresses on a plain host and port). */
function parseDiscoveryReply(text) {
  let reply;
  try {
    reply = JSON.parse(String(text));
  } catch {
    return null;
  }
  if (!reply || typeof reply.Id !== "string" || typeof reply.Address !== "string") return null;
  const base = serverBase(reply.Address);
  if (!base) return null;
  return { id: reply.Id.slice(0, 64), name: String(reply.Name ?? "Jellyfin").slice(0, 120), base };
}

/** "http://host:port" for an http(s) address with no path tricks or credentials, or null. */
function serverBase(address) {
  let url;
  try {
    url = new URL(String(address));
  } catch {
    return null;
  }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return null;
  return `${url.protocol}//${url.host}`;
}

/** The IPv4 addresses of this computer (plus loopback). */
function ownAddresses() {
  const addresses = new Set(["127.0.0.1", "localhost", "::1"]);
  for (const entries of Object.values(os.networkInterfaces())) {
    for (const entry of entries ?? []) addresses.add(entry.address);
  }
  return addresses;
}

function isOnThisComputer(base, own = ownAddresses()) {
  try {
    return own.has(new URL(base).hostname.replace(/^\[|\]$/g, ""));
  } catch {
    return false;
  }
}

/** Private-network addresses only: the helper never opens a server on the internet. */
function isHomeNetworkHost(hostname) {
  const host = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "localhost" || host === "::1") return true;
  const parts = host.split(".").map(Number);
  if (parts.length !== 4 || parts.some((n) => !Number.isInteger(n) || n < 0 || n > 255)) return false;
  const [a, b] = parts;
  return a === 10 || a === 127 || (a === 192 && b === 168) || (a === 172 && b >= 16 && b <= 31) || (a === 169 && b === 254);
}

/** Broadcasts the discovery message and collects replies for timeoutMs. */
function broadcastDiscovery(timeoutMs) {
  return new Promise((resolve) => {
    const found = new Map();
    const socket = dgram.createSocket({ type: "udp4", reuseAddr: true });
    const finish = () => {
      try { socket.close(); } catch { /* already closed */ }
      resolve([...found.values()]);
    };
    socket.on("error", finish);
    socket.on("message", (message) => {
      const server = parseDiscoveryReply(message);
      if (server && !found.has(server.id)) found.set(server.id, server);
    });
    socket.bind(0, () => {
      try {
        socket.setBroadcast(true);
        const payload = Buffer.from(DISCOVERY_MESSAGE);
        socket.send(payload, DISCOVERY_PORT, "255.255.255.255");
        socket.send(payload, DISCOVERY_PORT, "127.0.0.1");
      } catch { /* no network: nothing will answer */ }
      setTimeout(finish, timeoutMs);
    });
  });
}

async function getJson(url, timeoutMs = 2_000) {
  const reply = await fetch(url, { signal: AbortSignal.timeout(timeoutMs), headers: { Accept: "application/json" } });
  if (!reply.ok) throw new Error(`HTTP ${reply.status}`);
  return reply.json();
}

/** Version and Quick Connect for a found server (both public endpoints, no sign-in). */
async function describe(server) {
  const info = await getJson(`${server.base}/System/Info/Public`).catch(() => null);
  const quickConnect = await getJson(`${server.base}/QuickConnect/Enabled`).then((value) => value === true, () => null);
  return {
    ...server,
    name: info?.ServerName ? String(info.ServerName).slice(0, 120) : server.name,
    version: info?.Version ? String(info.Version).slice(0, 40) : null,
    reachable: info !== null,
    quickConnect,
    onThisComputer: isOnThisComputer(server.base),
  };
}

function createJellyfinHelper({ log = () => {} } = {}) {
  /** Servers from the last search, by id: only these can be opened. */
  let known = new Map();

  async function find() {
    const servers = new Map((await broadcastDiscovery(1_500)).map((s) => [s.id, s]));
    // A server on this computer that did not answer the broadcast (some firewalls drop it).
    const local = await getJson(`http://127.0.0.1:${WEB_PORT}/System/Info/Public`, 1_500).catch(() => null);
    if (local?.Id && !servers.has(local.Id)) servers.set(local.Id, { id: String(local.Id), name: String(local.ServerName ?? "Jellyfin"), base: `http://127.0.0.1:${WEB_PORT}` });
    const described = await Promise.all([...servers.values()].map(describe));
    known = new Map(described.map((s) => [s.id, s]));
    log(`jellyfin: found ${described.length} server(s)`);
    return described.sort((a, b) => Number(b.onThisComputer) - Number(a.onThisComputer) || a.name.localeCompare(b.name));
  }

  /** The web address to open for a found server (its own web page), or null. */
  function webAddress(id) {
    const server = known.get(String(id));
    if (!server) return null;
    const url = new URL(server.base);
    if (!isHomeNetworkHost(url.hostname)) return null;
    return `${server.base}/web/`;
  }

  return { find, webAddress };
}

module.exports = { createJellyfinHelper, parseDiscoveryReply, serverBase, isOnThisComputer, isHomeNetworkHost, DISCOVERY_MESSAGE, WEB_PORT, DISCOVERY_PORT };
