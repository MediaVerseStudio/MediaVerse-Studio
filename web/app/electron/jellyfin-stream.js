// Playing and casting songs of a Jellyfin server when the server alone is the library (D173). The page may not fetch a server on the home network itself
// (its security rules allow only this computer's own addresses), and an audio element cannot send the sign-in header, so the program fetches the song:
// the player asks for `mediaverse-media://jellyfin/<song id>`, this file asks the server (with the saved sign-in, forwarding the byte range so the seek
// bar works) and hands the bytes back. The sign-in is told to the program once by the page and stays in memory here; it is never put in an address the page can read.
//
// Only the song id comes from the page's request. The server address is the one the page signed in to, and it must be a home-network address
// (the same rule as `home-http.js`), so this can never be used to reach the internet.

const dns = require("node:dns").promises;
const net = require("node:net");
const { isHomeAddress } = require("./home-http");

const SONG_ID = /^[0-9a-f]{32}$/i;
const MIME_BY_CONTAINER = { mp3: "audio/mpeg", flac: "audio/flac", wav: "audio/wav", m4a: "audio/mp4", mp4: "audio/mp4", aac: "audio/aac", ogg: "audio/ogg", oga: "audio/ogg", opus: "audio/ogg" };

/** `jellyfin:<album>/<song>` to the song's id, or null. */
function songIdOf(sourceUri) {
  const match = /^jellyfin:([A-Za-z0-9_-]{1,64})\/([0-9a-f]{32})$/i.exec(String(sourceUri));
  return match ? match[2].toLowerCase() : null;
}

/** Jellyfin's lyrics answer to what the cast receiver and the player take: `{synced, lines: [{ms, text}], plain}`, or null when there are none. */
function lyricsFromJellyfin(reply) {
  const rows = Array.isArray(reply?.Lyrics) ? reply.Lyrics : [];
  const lines = rows
    .map((row) => ({ ms: typeof row?.Start === "number" ? Math.round(row.Start / 10_000) : null, text: String(row?.Text ?? "") }))
    .filter((row) => row.text.trim() !== "");
  if (lines.length === 0) return null;
  const synced = lines.every((row) => row.ms !== null);
  return { synced, lines: synced ? lines.map((row) => ({ ms: row.ms, text: row.text })) : [], plain: lines.map((row) => row.text).join("\n") };
}

function createJellyfinStream({ fetchImpl = fetch, resolve = (host) => dns.lookup(host, { all: true }) } = {}) {
  /** What the page signed in with: `{base, token, userId, deviceId}`. */
  let signedIn = null;

  function setSession(next) {
    if (next === null || next === undefined) {
      signedIn = null;
      return;
    }
    const url = new URL(String(next.base));
    if (!/^https?:$/.test(url.protocol) || url.username || url.password) throw new Error("That is not a server address.");
    if (typeof next.token !== "string" || !next.token || typeof next.userId !== "string" || !next.userId) throw new Error("The sign-in is incomplete.");
    signedIn = { base: `${url.protocol}//${url.host}`, token: next.token, userId: next.userId, deviceId: String(next.deviceId ?? "mediaverse-desktop").replace(/[^A-Za-z0-9_-]/g, "").slice(0, 64) || "mediaverse-desktop" };
  }

  const authorization = () => `MediaBrowser Client="MediaVerse Studio", Device="Computer", DeviceId="${signedIn.deviceId}", Version="1", Token="${signedIn.token}"`;

  /** The server's address once it is known to be on the home network. */
  async function homeBase() {
    if (!signedIn) throw new Error("Sign in to the Jellyfin server first (Settings > Jellyfin).");
    const host = new URL(signedIn.base).hostname.replace(/^\[|\]$/g, "");
    const addresses = net.isIP(host) ? [{ address: host }] : await resolve(host);
    if (!addresses.length || !addresses.every((a) => isHomeAddress(a.address))) throw new Error("Only a server on the home network can be used.");
    return signedIn.base;
  }

  /** The reply to a `mediaverse-media://jellyfin/<id>` request (an audio element's), with byte ranges forwarded. */
  async function serve(request) {
    try {
      const id = new URL(request.url).pathname.replace(/^\/+/, "").split("/")[0] ?? "";
      if (!SONG_ID.test(id)) return new Response("Not a song of the server.", { status: 400 });
      const base = await homeBase();
      const headers = { Authorization: authorization() };
      const range = request.headers.get("range");
      if (range) headers.Range = range;
      const reply = await fetchImpl(`${base}/Audio/${id.toLowerCase()}/stream?static=true`, { headers, redirect: "manual" });
      if (reply.status === 401 || reply.status === 403) return new Response("The server no longer accepts this sign-in. Sign in again under Settings > Jellyfin.", { status: 403 });
      if (reply.status !== 200 && reply.status !== 206 && reply.status !== 416) return new Response("The server could not give that song.", { status: 502 });
      const out = { "Accept-Ranges": "bytes", "Access-Control-Allow-Origin": "*", "Cache-Control": "no-store" };
      for (const name of ["content-type", "content-length", "content-range"]) {
        const value = reply.headers.get(name);
        if (value) out[name] = value;
      }
      return new Response(reply.status === 416 ? null : reply.body, { status: reply.status, headers: out });
    } catch (error) {
      return new Response(String(error?.message ?? error), { status: 502 });
    }
  }

  async function getJson(base, path) {
    const reply = await fetchImpl(`${base}${path}`, { headers: { Authorization: authorization(), Accept: "application/json" }, redirect: "manual", signal: AbortSignal.timeout(15_000) });
    if (!reply.ok) throw Object.assign(new Error(`The server answered ${reply.status}.`), { status: reply.status });
    return reply.json();
  }

  /**
   * A song as a cast device needs it (the same shape as `library-share.castLink` plus the song's facts): a link the device can fetch itself, with the sign-in in
   * the link, because a TV or speaker cannot send a header. The link is only given to a device on the home network (that is the only place the device can be found).
   */
  async function castInfo(songId) {
    const id = String(songId ?? "").toLowerCase();
    if (!SONG_ID.test(id)) throw new Error("That is not a song of the server.");
    const base = await homeBase();
    const item = await getJson(base, `/Users/${encodeURIComponent(signedIn.userId)}/Items/${id}`);
    const container = String(item?.Container ?? item?.MediaSources?.[0]?.Container ?? "").toLowerCase().split(",")[0];
    const key = encodeURIComponent(signedIn.token);
    const lyrics = lyricsFromJellyfin(await getJson(base, `/Audio/${id}/Lyrics`).catch(() => null));
    return {
      url: `${base}/Audio/${id}/stream?static=true&api_key=${key}`,
      mime: MIME_BY_CONTAINER[container] ?? "audio/mpeg",
      title: String(item?.Name ?? ""),
      artist: String(item?.Artists?.[0] ?? item?.AlbumArtist ?? "") || null,
      album: String(item?.Album ?? "") || null,
      cover: `${base}/Items/${encodeURIComponent(item?.AlbumId ?? id)}/Images/Primary?maxWidth=800&api_key=${key}`,
      seconds: Math.round((item?.RunTimeTicks ?? 0) / 10_000_000),
      lyrics,
    };
  }

  return { setSession, serve, castInfo };
}

module.exports = { createJellyfinStream, songIdOf, lyricsFromJellyfin, MIME_BY_CONTAINER };
