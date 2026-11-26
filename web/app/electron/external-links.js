// Links the app may open in the person's own web browser (for example from the Getting Started box).
// Only https addresses on the sites of the services the program uses are allowed.

// discogs.com: the "Data provided by Discogs" link its API terms require beside its data (ADR 0009).
// Also the pages for supporting the services the program leans on (Settings > About, owner 2026-11-25): their own sites only.
const ALLOWED_HOSTS = new Set(["acoustid.org", "gnudb.org", "musicbrainz.org", "lrclib.net", "discogs.com", "metabrainz.org", "archive.org", "donate.wikimedia.org", "jellyfin.org"]);

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
  // The project's own issue board, and nothing else on GitHub.
  if (host === "github.com") return url.pathname.toLowerCase().startsWith("/mediaversestudio/mediaverse-studio/");
  return ALLOWED_HOSTS.has(host);
}

module.exports = { isAllowedExternal };
