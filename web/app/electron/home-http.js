// Lets the page talk to servers on the home network (a Jellyfin server, D96). The page's security rules allow only
// this computer's own addresses, so the request is made here instead, and only to addresses on the home network
// (private ranges, this computer, link-local): the page can never use this to reach the internet.

const dns = require("node:dns").promises;
const net = require("node:net");

const MAX_BODY = 16 * 1024 * 1024;
const METHODS = new Set(["GET", "POST", "DELETE", "PUT"]);

/** Whether an IP address (v4 or v6 text) belongs to the home network or this computer. */
function isHomeAddress(address) {
  const kind = net.isIP(address);
  if (kind === 4) {
    const [a, b] = address.split(".").map(Number);
    return a === 10 || a === 127 || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 169 && b === 254);
  }
  if (kind === 6) {
    const lower = address.toLowerCase();
    if (lower === "::1") return true;
    if (lower.startsWith("::ffff:")) return isHomeAddress(lower.slice(7));
    const first = Number.parseInt(lower.split(":")[0] || "0", 16);
    return (first & 0xfe00) === 0xfc00 || (first & 0xffc0) === 0xfe80; // unique local fc00::/7, link-local fe80::/10
  }
  return false;
}

/**
 * `{url, method?, headers?, body?, timeout?}` to `{status, body}`. Status -1: no answer; -2: refused (not a home address).
 * `resolve` and `fetchImpl` can be replaced in tests.
 */
async function homeHttp(request, { resolve = (host) => dns.lookup(host, { all: true }), fetchImpl = fetch } = {}) {
  try {
    const url = new URL(String(request?.url ?? ""));
    if (url.protocol !== "http:" && url.protocol !== "https:") return { status: -2, body: "Only http and https addresses are used." };
    const host = url.hostname.replace(/^\[|\]$/g, "");
    const addresses = net.isIP(host) ? [{ address: host }] : await resolve(host);
    if (!addresses.length || !addresses.every((a) => isHomeAddress(a.address))) return { status: -2, body: "Only addresses on the home network can be reached." };
    const method = METHODS.has(String(request.method ?? "GET").toUpperCase()) ? String(request.method ?? "GET").toUpperCase() : "GET";
    const headers = {};
    for (const [key, value] of Object.entries(request.headers ?? {})) if (typeof value === "string") headers[key] = value;
    const controller = new AbortController();
    const timeout = Math.min(Math.max(Number(request.timeout) || 15_000, 500), 60_000);
    const timer = setTimeout(() => controller.abort(), timeout);
    try {
      const reply = await fetchImpl(url, { method, headers, body: typeof request.body === "string" && request.body ? request.body : undefined, signal: controller.signal, redirect: "manual" });
      const bytes = Buffer.from(await reply.arrayBuffer()).subarray(0, MAX_BODY);
      return { status: reply.status, body: request.binary === true ? bytes.toString("base64") : bytes.toString("utf8") };
    } finally {
      clearTimeout(timer);
    }
  } catch (error) {
    return { status: -1, body: String(error?.message ?? error) };
  }
}

module.exports = { isHomeAddress, homeHttp };
