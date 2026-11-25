// Pure logic for the TV app's library: albums, artists and song order from the tracks the computer shares.
// No DOM, so it is unit tested.

export type ServerTrack = {
  id: string;
  title: string;
  artist: string | null;
  album: string | null;
  album_artist: string | null;
  genre: string | null;
  year: number | null;
  track_number: number | null;
  cover_key: string;
  /** The name of the song's own folder (not its path), used to name compilations. */
  folder?: string | null;
};

export type Album = {
  key: string;
  title: string;
  artist: string;
  year: number | null;
  /** In track order. */
  tracks: ServerTrack[];
};

/** An artist with every album they appear on, and only their own songs (for Play all). */
/**
 * An artist with the albums of their own (`albums`, `tracks`) and, below them, the compilations they are on (`also`,
 * `alsoTracks`; owner, 2026-11-10: "<artist> also appears in:"). A band that is on compilations only has none of its
 * own and is not on the artists list, but a search finds it.
 */
export type Artist = { name: string; albums: Album[]; tracks: ServerTrack[]; also: Album[]; alsoTracks: ServerTrack[] };

export const UNKNOWN_ARTIST = "Unknown artist";
export const UNKNOWN_ALBUM = "Unknown album";

/** The name an album is filed under: its album artist, else the most common track artist. */
function albumArtist(tracks: ServerTrack[]): string {
  const named = tracks.find((t) => t.album_artist?.trim())?.album_artist?.trim();
  if (named) return named;
  const counts = new Map<string, number>();
  for (const t of tracks) {
    const a = t.artist?.trim();
    if (a) counts.set(a, (counts.get(a) ?? 0) + 1);
  }
  let best = "";
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount) {
      best = name;
      bestCount = count;
    }
  }
  if (counts.size > 1 && bestCount <= tracks.length / 2) return "Various artists";
  return best || UNKNOWN_ARTIST;
}

/** Sort key that ignores case, accents and a leading "The ". */
export function sortKey(text: string): string {
  return text
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/^the\s+/, "")
    .trim();
}

function byTrackOrder(a: ServerTrack, b: ServerTrack): number {
  const na = a.track_number ?? Number.MAX_SAFE_INTEGER;
  const nb = b.track_number ?? Number.MAX_SAFE_INTEGER;
  return na - nb || sortKey(a.title).localeCompare(sortKey(b.title));
}

/** Songs that share an album name in one folder before they count as an album of their own there. */
const MIN_ALBUM_IN_FOLDER = 3;

function mostCommon(values: (string | null)[]): { value: string; count: number } | null {
  const counts = new Map<string, { value: string; count: number }>();
  for (const raw of values) {
    const value = raw?.trim();
    if (!value) continue;
    const key = value.toLowerCase();
    const entry = counts.get(key) ?? { value, count: 0 };
    entry.count += 1;
    counts.set(key, entry);
  }
  let best: { value: string; count: number } | null = null;
  for (const entry of counts.values()) if (!best || entry.count > best.count) best = entry;
  return best;
}

/**
 * Albums, one per folder, sorted by artist then year then title. A folder holding several real albums (each with
 * at least a few songs under its own name) is split by album name; a compilation whose songs carry their
 * original albums' names stays one album, named after the folder.
 */
export function buildAlbums(tracks: ServerTrack[]): Album[] {
  const folders = new Map<string, ServerTrack[]>();
  for (const track of tracks) {
    let group = folders.get(track.cover_key);
    if (!group) folders.set(track.cover_key, (group = []));
    group.push(track);
  }
  const groups: [string, ServerTrack[]][] = [];
  for (const [folder, folderTracks] of folders) {
    const byName = new Map<string, ServerTrack[]>();
    for (const track of folderTracks) {
      const name = (track.album ?? "").trim().toLowerCase();
      let group = byName.get(name);
      if (!group) byName.set(name, (group = []));
      group.push(track);
    }
    const parts = [...byName.entries()];
    if (parts.length > 1 && parts.every(([, group]) => group.length >= MIN_ALBUM_IN_FOLDER)) {
      for (const [name, group] of parts) groups.push([`${folder}\u0000${name}`, group]);
    } else {
      groups.push([folder, folderTracks]);
    }
  }
  const albums: Album[] = [];
  for (const [key, group] of groups) {
    group.sort(byTrackOrder);
    const common = mostCommon(group.map((t) => t.album));
    const folderName = group[0].folder?.trim();
    const title = common && (common.count > group.length / 2 || !folderName) ? common.value : folderName || UNKNOWN_ALBUM;
    albums.push({
      key,
      title,
      artist: albumArtist(group),
      year: group.find((t) => t.year)?.year ?? null,
      tracks: group,
    });
  }
  return albums.sort(
    (a, b) => sortKey(a.artist).localeCompare(sortKey(b.artist)) || (a.year ?? 9999) - (b.year ?? 9999) || sortKey(a.title).localeCompare(sortKey(b.title)),
  );
}

/**
 * Artists by each song's own artist (so the artists on a compilation are listed too), each with the albums they
 * appear on in album order and their own songs.
 */
/** A credit without its guests: "Band feat. Singer", "Band (ft. Singer)", "Band featuring Singer" are "Band". "&",
 * "and" and "with" stay: they are often part of a band's name (Me First & The Gimme Gimmes). */
export function withoutFeatured(credit: string): string {
  const cut = credit.replace(/\s*[([]\s*(feat\.?|ft\.?|featuring)\s[^)\]]*[)\]]\s*$/i, "").replace(/\s+(feat\.?|ft\.?|featuring)\s.*$/i, "");
  return cut.trim() || credit.trim();
}

const isVarious = (name: string): boolean => /^(various( artists)?|va)$/i.test(name.trim());

/**
 * Whom a song is listed under on the artists page (owner, 2026-11-05: each Postmodern Jukebox singer showed up as
 * an artist of their own). On an album with an album artist, that artist, as Zune did; on a Various Artists
 * compilation, the song's own artist without the guests it features.
 */
export function listedArtist(track: ServerTrack): string {
  const albumArtist = track.album_artist?.trim();
  if (albumArtist && !isVarious(albumArtist)) return albumArtist;
  const own = track.artist?.trim();
  return (own && withoutFeatured(own)) || albumArtist || UNKNOWN_ARTIST;
}

/**
 * The artist a song is filed under on the artists list: its album artist, as Zune did, or, on an album with no album
 * artist, its own artist. Null on a Various Artists compilation: those songs are filed under their album, and their
 * artists only appear on the compilation as guests (owner, 2026-11-10: the TV listed 904 artists, the PC 369).
 */
export function filedArtist(track: ServerTrack): string | null {
  const albumArtist = track.album_artist?.trim();
  return albumArtist && isVarious(albumArtist) ? null : listedArtist(track);
}

/** The artist a compilation song credits (without guests), or null when it names none. */
function guestOf(track: ServerTrack): string | null {
  const own = track.artist?.trim();
  return (own && withoutFeatured(own)) || null;
}

type Built = { own: Artist[]; guestOnly: Artist[] };

function buildBoth(albums: Album[]): Built {
  const byName = new Map<string, Artist>();
  const guests = new Map<string, Artist>();
  const bucket = (map: Map<string, Artist>, name: string): Artist => {
    const id = sortKey(name);
    let artist = map.get(id);
    if (!artist) map.set(id, (artist = { name, albums: [], tracks: [], also: [], alsoTracks: [] }));
    return artist;
  };
  for (const album of albums) {
    for (const track of album.tracks) {
      const filed = filedArtist(track);
      if (filed) {
        const artist = bucket(byName, filed);
        if (artist.albums[artist.albums.length - 1] !== album) artist.albums.push(album);
        artist.tracks.push(track);
        continue;
      }
      const guest = guestOf(track);
      if (!guest) continue;
      const artist = bucket(guests, guest);
      if (artist.also[artist.also.length - 1] !== album) artist.also.push(album);
      artist.alsoTracks.push(track);
    }
  }
  const guestOnly: Artist[] = [];
  for (const [id, guest] of guests) {
    const own = byName.get(id);
    if (own) {
      own.also = guest.also;
      own.alsoTracks = guest.alsoTracks;
    } else guestOnly.push(guest);
  }
  const byNameOrder = (a: Artist, b: Artist): number => sortKey(a.name).localeCompare(sortKey(b.name));
  return { own: [...byName.values()].sort(byNameOrder), guestOnly: guestOnly.sort(byNameOrder) };
}

/** The artists list: artists with an album of their own, each with the compilations they are also on. */
export function buildArtists(albums: Album[]): Artist[] {
  return buildBoth(albums).own;
}

/** Artists who are only on compilations: not on the list, but found by a search. */
export function buildGuestArtists(albums: Album[]): Artist[] {
  return buildBoth(albums).guestOnly;
}
/** Every song, in album order (artist, album, track). */
export function allSongs(albums: Album[]): ServerTrack[] {
  return albums.flatMap((album) => album.tracks);
}

/** The first letter shown for jumping through a long list ("#" for digits and symbols). */
export function indexLetter(name: string): string {
  const first = sortKey(name).charAt(0).toUpperCase();
  return first >= "A" && first <= "Z" ? first : "#";
}

/** "3:07" from seconds; "" when unknown. */
export function clock(seconds: number): string {
  if (!Number.isFinite(seconds) || seconds < 0) return "";
  const whole = Math.floor(seconds);
  const h = Math.floor(whole / 3600);
  const m = Math.floor((whole % 3600) / 60);
  const s = String(whole % 60).padStart(2, "0");
  return h ? `${h}:${String(m).padStart(2, "0")}:${s}` : `${m}:${s}`;
}

/** A random order of 0..n-1 that starts with `first` (when given), for shuffle. */
export function shuffledOrder(n: number, first: number | null, random: () => number = Math.random): number[] {
  const order = Array.from({ length: n }, (_, i) => i).filter((i) => i !== first);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(random() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  return first === null || first < 0 || first >= n ? order : [first, ...order];
}

/** A genre with its songs and the albums they are on (D44). */
export type Genre = { name: string; tracks: ServerTrack[]; albums: Album[] };

/**
 * Genres from the songs' genre tags. A tag naming several ("Punk; Ska", "Punk/Ska", "Punk, Ska") counts for
 * each; spelling and case differences ("ska punk", "Ska Punk") are one genre, named as most songs spell it.
 * Songs without a genre are left out. Sorted by name.
 */
export function buildGenres(albums: Album[]): Genre[] {
  const groups = new Map<string, { names: Map<string, number>; tracks: ServerTrack[]; albums: Set<Album> }>();
  for (const album of albums) {
    for (const track of album.tracks) {
      const parts = (track.genre ?? "").split(/\s*[;/,|]\s*|\u0000/).map((part) => part.trim()).filter((part) => part && !/^\(?\d+\)?$/.test(part));
      for (const name of new Set(parts)) {
        const key = sortKey(name).replace(/[\s-]+/g, " ");
        let group = groups.get(key);
        if (!group) groups.set(key, (group = { names: new Map(), tracks: [], albums: new Set() }));
        group.names.set(name, (group.names.get(name) ?? 0) + 1);
        group.tracks.push(track);
        group.albums.add(album);
      }
    }
  }
  return [...groups.values()]
    .map((group) => ({
      name: [...group.names].sort((a, b) => b[1] - a[1])[0][0],
      tracks: group.tracks,
      albums: [...group.albums],
    }))
    .sort((a, b) => sortKey(a.name).localeCompare(sortKey(b.name)));
}

export type SearchResults = { artists: Artist[]; albums: Album[]; songs: ServerTrack[] };

function words(text: string): string[] {
  return sortKey(text).split(/[^a-z0-9]+/).filter(Boolean);
}

/**
 * Finds artists, albums and songs whose names contain every word typed (ignoring case and accents, "the" and
 * punctuation). Names starting with the first word come first. At most `limit` of each.
 */
export function searchLibrary(query: string, artists: Artist[], albums: Album[], songs: ServerTrack[], limit = 30): SearchResults {
  const wanted = words(query);
  if (!wanted.length) return { artists: [], albums: [], songs: [] };
  const rank = (name: string): number => {
    const have = words(name);
    if (!wanted.every((word) => have.some((h) => h.includes(word)))) return -1;
    if (have[0]?.startsWith(wanted[0])) return 0;
    return have.some((h) => h.startsWith(wanted[0])) ? 1 : 2;
  };
  const best = <T>(items: T[], name: (item: T) => string): T[] =>
    items
      .map((item) => ({ item, score: rank(name(item)) }))
      .filter((entry) => entry.score >= 0)
      .sort((a, b) => a.score - b.score)
      .slice(0, limit)
      .map((entry) => entry.item);
  return {
    artists: best(artists, (artist) => artist.name),
    albums: best(albums, (album) => `${album.title} ${album.artist}`),
    songs: best(songs, (song) => `${song.title} ${song.artist ?? ""}`),
  };
}
