// Links the app may open in the person's own web browser (for example from the Getting Started box).
// Only https addresses on the sites of the services the program uses are allowed.

// discogs.com: the "Data provided by Discogs" link its API terms require beside its data (ADR 0009).
const ALLOWED_HOSTS = new Set(["acoustid.org", "gnudb.org", "musicbrainz.org", "lrclib.net", "discogs.com"]);

function isAllowedExternal(address) {
  let url;
  try {
    url = new URL(address);
  } catch {
    return false;
  }
  if (url.protocol !== "https:" || url.username || url.password) return false;
  const host = url.hostname.toLowerCase().replace(/^www\./, "");
  // The web image search for album artwork (owner, 2026-11-05): Google's search page only, nothing else there.
  if (host === "google.com") return url.pathname === "/search";
  return ALLOWED_HOSTS.has(host);
}

module.exports = { isAllowedExternal };
