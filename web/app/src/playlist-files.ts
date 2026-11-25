// Playlists as files (D78), to share between devices and with friends: XSPF (the open "XML Shareable Playlist
// Format"; VLC, Strawberry and others read it) describes each song by artist, title, album and length, so another
// library finds its own copy wherever its files are; M3U8 lists file locations, for other players on this
// computer. Import reads XSPF, JSPF (XSPF as JSON, used by ListenBrainz) and M3U/M3U8, and finds each song in the
// library: by its file, else by artist and title (album and length break ties). Songs that are not found are
// skipped and counted. Pure, so the rules are tested.

import { sortKey, type LibrarySong } from "./library-format.ts";

export type PlaylistEntry = { title?: string; artist?: string; album?: string; durationMs?: number; location?: string };

const escapeXml = (text: string): string => text.replace(/[<>&"']/g, (c) => ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", '"': "&quot;", "'": "&apos;" })[c]!);
const decodeXml = (text: string): string =>
  text
    .replace(/<!\[CDATA\[([\s\S]*?)\]\]>/g, "$1")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&#x([0-9a-f]+);/gi, (_, n) => String.fromCodePoint(Number.parseInt(n, 16)))
    .replace(/&#(\d+);/g, (_, n) => String.fromCodePoint(Number(n)))
    .replace(/&amp;/g, "&");

/** A Windows path as a file:// address (and back), as XSPF and many players write locations. */
export function fileUrl(filePath: string): string {
  const forward = filePath.replace(/\\/g, "/");
  return `file:///${forward.split("/").map((part, i) => (i === 0 && /^[a-z]:$/i.test(part) ? part : encodeURIComponent(part))).join("/")}`;
}
export function pathFromLocation(location: string): string {
  const text = location.trim();
  if (!/^file:/i.test(text)) return text.replace(/\//g, "\\");
  return decodeURIComponent(text.replace(/^file:\/{2,3}/i, "")).replace(/\//g, "\\");
}

const songArtist = (song: LibrarySong): string => song.artist?.trim() || song.album_artist?.trim() || "";

export function toXspf(name: string, songs: LibrarySong[]): string {
  const tracks = songs
    .map((song) => {
      const parts = [
        `      <location>${escapeXml(fileUrl(song.source_uri))}</location>`,
        `      <title>${escapeXml(song.title)}</title>`,
        songArtist(song) ? `      <creator>${escapeXml(songArtist(song))}</creator>` : "",
        song.album ? `      <album>${escapeXml(song.album)}</album>` : "",
        song.track_number ? `      <trackNum>${song.track_number}</trackNum>` : "",
        song.length_ms ? `      <duration>${Math.round(song.length_ms)}</duration>` : "",
      ].filter(Boolean);
      return `    <track>\n${parts.join("\n")}\n    </track>`;
    })
    .join("\n");
  return `<?xml version="1.0" encoding="UTF-8"?>\n<playlist version="1" xmlns="http://xspf.org/ns/0/">\n  <title>${escapeXml(name)}</title>\n  <creator>MediaVerse Studio</creator>\n  <date>${new Date().toISOString()}</date>\n  <trackList>\n${tracks}\n  </trackList>\n</playlist>\n`;
}

export function toM3u8(name: string, songs: LibrarySong[]): string {
  const lines = ["#EXTM3U", `#PLAYLIST:${name}`];
  for (const song of songs) {
    const seconds = song.length_ms ? Math.round(song.length_ms / 1000) : -1;
    lines.push(`#EXTINF:${seconds},${songArtist(song) ? `${songArtist(song)} - ` : ""}${song.title}`, song.source_uri);
  }
  return `${lines.join("\r\n")}\r\n`;
}

function tagIn(xml: string, name: string): string | undefined {
  const match = new RegExp(`<${name}(?:\\s[^>]*)?>([\\s\\S]*?)</${name}>`, "i").exec(xml);
  return match ? decodeXml(match[1].trim()) : undefined;
}

/** The playlist's name and songs from an XSPF, JSPF or M3U/M3U8 file's text. */
export function parsePlaylist(text: string, fileName = ""): { name: string; entries: PlaylistEntry[] } {
  const body = text.replace(/^﻿/, "");
  const base = fileName.replace(/^.*[\\/]/, "").replace(/\.[^.]+$/, "") || "Imported playlist";
  const trimmed = body.trimStart();
  if (trimmed.startsWith("{")) {
    // JSPF: {"playlist": {"title", "track": [{title, creator, album, duration, location: [..]}]}}
    const data = JSON.parse(trimmed) as { playlist?: { title?: unknown; track?: unknown[] } };
    const list = Array.isArray(data.playlist?.track) ? data.playlist!.track : [];
    const text = (v: unknown): string | undefined => (typeof v === "string" && v.trim() ? v.trim() : undefined);
    return {
      name: text(data.playlist?.title) ?? base,
      entries: list.map((raw) => {
        const t = (raw ?? {}) as Record<string, unknown>;
        const location = Array.isArray(t.location) ? text(t.location[0]) : text(t.location);
        return { title: text(t.title), artist: text(t.creator), album: text(t.album), durationMs: typeof t.duration === "number" ? t.duration : undefined, location };
      }),
    };
  }
  if (trimmed.startsWith("<")) {
    const name = tagIn(body.replace(/<trackList>[\s\S]*<\/trackList>/i, ""), "title") ?? base;
    const entries = [...body.matchAll(/<track>([\s\S]*?)<\/track>/gi)].map(([, track]) => {
      const duration = Number(tagIn(track, "duration"));
      return { title: tagIn(track, "title"), artist: tagIn(track, "creator"), album: tagIn(track, "album"), durationMs: Number.isFinite(duration) && duration > 0 ? duration : undefined, location: tagIn(track, "location") };
    });
    return { name, entries };
  }
  // M3U / M3U8: a location per line, each perhaps after "#EXTINF:seconds,Artist - Title".
  let name = base;
  const entries: PlaylistEntry[] = [];
  let pending: PlaylistEntry = {};
  for (const raw of body.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line) continue;
    if (/^#PLAYLIST:/i.test(line)) name = line.slice(10).trim() || name;
    else if (/^#EXTINF:/i.test(line)) {
      const match = /^#EXTINF:(-?\d+)[^,]*,(.*)$/i.exec(line);
      if (match) {
        const seconds = Number(match[1]);
        const words = match[2].trim();
        const split = words.indexOf(" - ");
        pending = { durationMs: seconds > 0 ? seconds * 1000 : undefined, ...(split > 0 ? { artist: words.slice(0, split).trim(), title: words.slice(split + 3).trim() } : { title: words }) };
      }
    } else if (!line.startsWith("#")) {
      entries.push({ ...pending, location: line });
      pending = {};
    }
  }
  return { name, entries };
}

/** A name reduced to what identifies a song: no case, accents, "feat." guests, bracketed notes or punctuation. */
export function matchKey(text: string): string {
  return sortKey(text, false)
    .replace(/\s*[([].*?[)\]]/g, " ") // (Remastered 2012), [Live], (feat. X)
    .replace(/\s+(feat\.?|featuring|ft\.?)\s.*$/i, "")
    .replace(/&/g, " and ")
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .trim();
}

/**
 * The library's songs for a playlist's entries, in order. Each entry is found by its file (if that file is in
 * this library), else by artist and title, preferring the same album, then the closest length (within 10 s).
 */
export function resolveEntries<T extends LibrarySong>(entries: PlaylistEntry[], library: T[]): { songs: T[]; missing: PlaylistEntry[] } {
  const byPath = new Map(library.map((s) => [s.source_uri.toLowerCase(), s]));
  const byKey = new Map<string, T[]>();
  for (const song of library) {
    for (const artist of new Set([song.artist, song.album_artist].filter((a): a is string => !!a?.trim()))) {
      const key = `${matchKey(artist)}\u0000${matchKey(song.title)}`;
      const list = byKey.get(key);
      if (list) list.push(song);
      else byKey.set(key, [song]);
    }
  }
  const songs: T[] = [];
  const missing: PlaylistEntry[] = [];
  for (const entry of entries) {
    const file = entry.location ? byPath.get(pathFromLocation(entry.location).toLowerCase()) : undefined;
    if (file) {
      songs.push(file);
      continue;
    }
    const candidates = entry.title && entry.artist ? byKey.get(`${matchKey(entry.artist)}\u0000${matchKey(entry.title)}`) ?? [] : [];
    const near = candidates.filter((s) => !entry.durationMs || !s.length_ms || Math.abs(s.length_ms - entry.durationMs) <= 10_000);
    const sameAlbum = entry.album ? near.filter((s) => s.album && matchKey(s.album) === matchKey(entry.album!)) : [];
    const pool = sameAlbum.length ? sameAlbum : near;
    const best = [...pool].sort((a, b) => Math.abs((a.length_ms ?? 0) - (entry.durationMs ?? 0)) - Math.abs((b.length_ms ?? 0) - (entry.durationMs ?? 0)))[0];
    if (best) songs.push(best);
    else missing.push(entry);
  }
  return { songs, missing };
}
