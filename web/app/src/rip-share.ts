// Sharing a disc the databases did not know (D107): the details the person confirmed become a MusicBrainz "attach disc ID"
// link, a pre-filled MusicBrainz Add Release form, or a gnudb submission. No DOM, so it is unit tested.

import type { Candidate, LookupResult } from "./rip-format.ts";
import { manualTitles } from "./rip-format.ts";

export type Toc = { track_starts: number[]; leadout: number };

/** What the person confirmed about the album, ready to hand to MusicBrainz or gnudb. */
export type ShareDetails = {
  artist: string;
  album: string;
  year: number | null;
  genre: string;
  compilation: boolean;
  tracks: { title: string; artist: string | null }[];
  date: string;
  country: string;
  label: string;
  catalog_number: string;
  barcode: string;
};

/** MusicBrainz counts sectors from the start of the disc including the 2-second lead-in: 150 more than our sector numbers. */
export function attachUrl(toc: Toc): string {
  const offsets = [...toc.track_starts, toc.leadout].map((n) => n + 150);
  const [leadout, ...starts] = [offsets[offsets.length - 1], ...offsets.slice(0, -1)];
  return `https://musicbrainz.org/cdtoc/attach?toc=${["1", String(toc.track_starts.length), String(leadout), ...starts.map(String)].join("+")}`;
}

/** Each track's length in milliseconds, from the table of contents (75 sectors a second). */
export function trackLengthsMs(toc: Toc): number[] {
  const ends = [...toc.track_starts.slice(1), toc.leadout];
  return toc.track_starts.map((start, index) => Math.round(((ends[index] - start) * 1000) / 75));
}

export function detailsFromCandidate(album: Candidate): ShareDetails {
  return {
    artist: album.album_artist,
    album: album.album,
    year: album.year ?? null,
    genre: album.genre ?? "",
    compilation: album.compilation === true,
    tracks: album.tracks.map((t) => ({ title: t.title, artist: t.artist ?? null })),
    date: album.release?.date ?? "",
    country: album.release?.country ?? "",
    label: album.release?.label ?? "",
    catalog_number: album.release?.catalog_number ?? "",
    barcode: album.release?.barcode ?? "",
  };
}

export type ManualDetails = { album: string; artist: string; year?: string; genre?: string; titles?: string };

/** The hand-typed album as details, or why it cannot be shared yet (every track needs a typed title). */
export function detailsFromManual(manual: ManualDetails, trackCount: number): ShareDetails | string {
  const titles = manualTitles(manual.titles ?? "");
  if (manual.album.trim() === "" || manual.artist.trim() === "") return "Type the album and the artist first.";
  if (titles.length !== trackCount) return `Type all ${trackCount} track titles first (one per line).`;
  const year = Number.parseInt((manual.year ?? "").trim(), 10);
  return {
    artist: manual.artist.trim(),
    album: manual.album.trim(),
    year: year >= 1000 && year <= 2999 ? year : null,
    genre: (manual.genre ?? "").trim(),
    compilation: false,
    tracks: titles.map((title) => ({ title, artist: null })),
    date: "",
    country: "",
    label: "",
    catalog_number: "",
    barcode: "",
  };
}

/** The MusicBrainz Add Release seed, with each track's length taken from the disc itself. */
export function musicbrainzRelease(details: ShareDetails, toc: Toc) {
  const lengths = trackLengthsMs(toc);
  return {
    album: details.album,
    artist: details.compilation ? "Various Artists" : details.artist,
    year: details.year,
    date: details.date,
    country: details.country,
    label: details.label,
    catalog_number: details.catalog_number,
    barcode: details.barcode,
    tracks: details.tracks.map((t, index) => ({ title: t.title, artist: t.artist, length_ms: lengths[index] })),
  };
}

/** The `submit_gnudb` arguments. An empty category lets the program pick one from the genre. */
export function gnudbArgs(details: ShareDetails, toc: Toc, email: string, category: string): Record<string, unknown> {
  return {
    toc,
    artist: details.artist,
    album: details.album,
    year: details.year,
    genre: details.genre,
    compilation: details.compilation,
    tracks: details.tracks,
    category,
    email: email.trim(),
  };
}

/** What can be shared for this lookup: a disc one of the databases already lists exactly is not offered again. */
export function shareOptions(lookup: LookupResult | null): { toc: Toc | null; musicbrainz: boolean; gnudb: boolean } {
  const toc = lookup?.toc ?? null;
  if (!lookup || !toc || toc.track_starts.length === 0) return { toc: null, musicbrainz: false, gnudb: false };
  const exact = (source: string) => lookup.candidates.some((c) => c.album.quality === "exact" && c.sources.includes(source));
  const listedElsewhere = lookup.candidates.some((c) => c.sources.includes("gnudb"));
  return { toc, musicbrainz: !exact("musicbrainz"), gnudb: !listedElsewhere };
}
