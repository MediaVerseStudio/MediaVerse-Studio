// Which pictures each album's songs should carry (owner, 2026-11-26: every song has its album's front cover inside
// it, the same on every song of the album, and the rear cover and artist photo wherever there is one). Works out, from
// what the library check read, what can be done with the pictures already there, what needs the person's choice and
// what no picture exists for. Nothing is read or written here, so it is unit tested.

import type { AlbumGap, GapFile, GapTrack } from "./review-data";
import type { PictureKindName } from "./media-request";

export type ArtKind = "front" | "back" | "artist";
export const ART_KINDS: ArtKind[] = ["front", "back", "artist"];
export const PICTURE_KIND: Record<ArtKind, PictureKindName> = { front: "front_cover", back: "back_cover", artist: "artist_photo" };
export const ART_NAMES: Record<ArtKind, string> = { front: "Front cover", back: "Rear cover", artist: "Artist photo" };

/** A picture as the library check describes it; `ok`: it can be copied into songs as it is (a JPEG within the limits);
 * `relabel`: this song's tag calls it something it is not, so it is written again. */
export type Pic = { hash: string; width: number; height: number; ok: boolean; bytes?: number; relabel?: boolean };
export type SongArt = Record<ArtKind, Pic | null>;
/** A picture file in an album folder (`up`: an artist photo in the folder above). */
export type FolderPic = Pic & { file: string; up?: boolean };
/** `png`: the PNG picture files in the folder (they are to be JPEG too). */
export type FolderArt = Record<ArtKind, FolderPic | null> & { png?: { kind: ArtKind; file: string }[] };

/** Where a picture is read from: inside the song at `path`, or the file `file` in that song's folder. */
export type PictureSource = { path: string; file?: string; up?: boolean };
/** `songs`: how many of the album's songs already carry it (0 for a folder file or another album's picture). */
export type ArtOption = Pic & { source: PictureSource; songs: number; from: "songs" | "folder" | "artist" };

/** One kind of picture to put on `paths`. `keepFullSize`: it will be made smaller and the folder has no copy as large. */
export type KindPlan = { kind: ArtKind; target: ArtOption; paths: string[]; keepFullSize: boolean };
export type AlbumPlan = { key: string; gap: AlbumGap; kinds: KindPlan[] };
export type ArtChoice = { key: string; gap: AlbumGap; kind: ArtKind; reason: string; options: ArtOption[]; without: number };

export type ArtworkPlan = {
  albums: AlbumPlan[];
  choices: ArtChoice[];
  /** Albums with songs lacking this picture, and no picture anywhere to give them. */
  none: Record<ArtKind, AlbumGap[]>;
  songs: number;
  have: Record<ArtKind, number>;
};

/** The person's answer to a choice: the hash of the picture to use, or `LEAVE` to keep the album as it is. */
export type Picks = Record<string, string>;
export const LEAVE = "leave";
export const choiceKey = (albumKey: string, kind: ArtKind): string => `${albumKey}|${kind}`;

/** A cover smaller than this on its shorter side is not copied to other songs without asking when a bigger one is in the folder. */
const SMALL_SIDE = 300;

const side = (p: Pic): number => Math.min(p.width, p.height);
/** A picture inside a song that breaks the rules: over 1000 pixels or the size limit, not a JPEG, or wrongly labelled. */
export const needsRewrite = (p: Pic): boolean => !p.ok || !!p.relabel;
const clean = (text: string | null | undefined): string => (text ?? "").trim();
const various = (name: string): boolean => /^(various( artists)?|va)$/i.test(name);

function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut < 0 ? "" : path.slice(0, cut);
}

type Group = { key: string; folder: string; album: string; files: GapFile[]; tracks: GapTrack[]; artist: string; compilation: boolean };

/** Albums: the songs of one folder with the same album name. */
function groups(files: GapFile[], tracks: GapTrack[]): Group[] {
  const byPath = new Map(tracks.map((t) => [t.source_uri, t]));
  const found = new Map<string, Group>();
  for (const file of files) {
    const track = byPath.get(file.path);
    if (!file.mp3 || !file.art || !track) continue;
    const folder = folderOf(file.path);
    const album = clean(track.album);
    const key = `${folder}|${album.toLowerCase()}`;
    const group = found.get(key) ?? { key, folder, album, files: [], tracks: [], artist: "", compilation: false };
    group.files.push(file);
    group.tracks.push(track);
    found.set(key, group);
  }
  for (const group of found.values()) {
    const albumArtist = group.tracks.map((t) => clean(t.album_artist)).find(Boolean);
    const artists = new Set(group.tracks.map((t) => clean(t.artist).toLowerCase()).filter(Boolean));
    group.compilation = albumArtist ? various(albumArtist) : artists.size > 1;
    group.artist = albumArtist ?? (artists.size > 1 ? "Various Artists" : clean(group.tracks.find((t) => clean(t.artist))?.artist));
  }
  return [...found.values()];
}

const asGap = (group: Group): AlbumGap => {
  const paths = group.files.map((f) => f.path);
  return {
    folder: group.folder,
    album: group.album || "Unknown album",
    artist: group.artist || "Unknown artist",
    albumArtist: group.artist || "Unknown artist",
    year: group.tracks.find((t) => t.release_year)?.release_year ?? null,
    total: paths.length,
    tracks: group.tracks,
    mp3Paths: paths,
    albumMp3Paths: paths,
  };
};

/** The different pictures of one kind inside these songs, the one on most songs first (then the larger). */
function variants(files: GapFile[], kind: ArtKind, from: ArtOption["from"]): ArtOption[] {
  const found = new Map<string, ArtOption>();
  for (const file of files) {
    const picture = file.art?.[kind];
    if (!picture) continue;
    const known = found.get(picture.hash);
    if (known) {
      known.songs += 1;
      known.relabel = known.relabel || picture.relabel;
    } else found.set(picture.hash, { ...picture, source: { path: file.path }, songs: 1, from });
  }
  return [...found.values()].sort((a, b) => b.songs - a.songs || side(b) - side(a) || a.hash.localeCompare(b.hash));
}

export function planArtwork(files: GapFile[], tracks: GapTrack[], folders: Record<string, FolderArt>, picks: Picks = {}): ArtworkPlan {
  const albums = groups(files, tracks);
  const perFolder = new Map<string, number>();
  for (const group of albums) perFolder.set(group.folder, (perFolder.get(group.folder) ?? 0) + 1);

  // Each artist's photos across all their albums, so an album without one can take the artist's.
  const byArtist = new Map<string, GapFile[]>();
  for (const group of albums) {
    if (group.compilation || !group.artist) continue;
    const key = group.artist.toLowerCase();
    byArtist.set(key, [...(byArtist.get(key) ?? []), ...group.files]);
  }
  const artistPhotos = new Map([...byArtist].map(([key, list]) => [key, variants(list, "artist", "artist").map((v) => ({ ...v, songs: 0 }))]));

  const plan: ArtworkPlan = { albums: [], choices: [], none: { front: [], back: [], artist: [] }, songs: 0, have: { front: 0, back: 0, artist: 0 } };
  for (const group of albums) {
    plan.songs += group.files.length;
    const kinds: KindPlan[] = [];
    for (const kind of ART_KINDS) {
      plan.have[kind] += group.files.filter((f) => f.art?.[kind]).length;
      // A compilation's songs are by different artists: there is no one artist photo to give them.
      if (kind === "artist" && (group.compilation || !group.artist)) continue;
      const inside = variants(group.files, kind, "songs");
      const lacking = group.files.filter((f) => !f.art?.[kind]).length;
      if (inside.length === 1 && lacking === 0 && !needsRewrite(inside[0])) continue;

      const file = folders[group.folder]?.[kind] ?? null;
      const fromFolder: ArtOption | null = file ? { ...file, source: { path: group.files[0].path, file: file.file, up: file.up }, songs: 0, from: "folder" } : null;
      let options: ArtOption[] = inside;
      if (fromFolder && !inside.some((o) => o.hash === fromFolder.hash)) options = [...inside, fromFolder];
      let reason = "";
      if (inside.length > 1) {
        reason = "The songs of this album have different pictures.";
      } else if (inside.length === 1) {
        // One picture in some songs: it is the album's, unless it is tiny and the folder has a better one.
        if (lacking > 0 && fromFolder && side(inside[0]) < SMALL_SIDE && side(fromFolder) > side(inside[0])) reason = "The picture in the songs is very small; the folder has a larger one.";
        else options = [inside[0]];
      } else if (fromFolder) {
        // The folder's picture belongs to every song in it only when the folder holds one named album.
        if (kind !== "artist" && (perFolder.get(group.folder) ?? 0) > 1) reason = "The folder holds songs from more than one album.";
        else if (kind !== "artist" && !group.album) reason = "These songs have no album name.";
      } else if (kind === "artist") {
        options = artistPhotos.get(group.artist.toLowerCase()) ?? [];
        if (options.length > 1) reason = "This artist's other albums have different photos.";
      }

      if (options.length === 0) {
        plan.none[kind].push(asGap(group));
        continue;
      }
      const key = choiceKey(group.key, kind);
      const picked = picks[key];
      if (picked === LEAVE) continue;
      const chosen = options.find((o) => o.hash === picked);
      if (reason && !chosen) {
        plan.choices.push({ key, gap: asGap(group), kind, reason, options, without: lacking });
        continue;
      }
      const target = chosen ?? options[0];
      let paths = group.files.filter((f) => f.art?.[kind]?.hash !== target.hash || f.art[kind]!.relabel).map((f) => f.path);
      // A picture that has to be made smaller changes, so every song gets the new one and they stay alike.
      if (!target.ok) paths = group.files.map((f) => f.path);
      if (paths.length === 0) continue;
      kinds.push({ kind, target, paths, keepFullSize: !target.ok && target.from !== "folder" && (!file || side(file) < side(target)) });
    }
    if (kinds.length) plan.albums.push({ key: group.key, gap: asGap(group), kinds });
  }
  const byName = (a: { gap: AlbumGap }, b: { gap: AlbumGap }): number => a.gap.artist.localeCompare(b.gap.artist) || a.gap.album.localeCompare(b.gap.album);
  plan.albums.sort(byName);
  plan.choices.sort(byName);
  for (const kind of ART_KINDS) plan.none[kind].sort((a, b) => a.artist.localeCompare(b.artist) || a.album.localeCompare(b.album));
  return plan;
}

/** The songs an album's plan would change (each once, however many pictures it gets). */
export function songsToWrite(albums: AlbumPlan[]): number {
  return new Set(albums.flatMap((a) => a.kinds.flatMap((k) => k.paths))).size;
}

/** The songs of one album grouped by which pictures they need, so each file is rewritten once. */
export function writeGroups(album: AlbumPlan): { paths: string[]; kinds: KindPlan[] }[] {
  const wanted = new Map<string, number[]>();
  album.kinds.forEach((kind, index) => {
    for (const path of kind.paths) wanted.set(path, [...(wanted.get(path) ?? []), index]);
  });
  const found = new Map<string, { paths: string[]; kinds: KindPlan[] }>();
  for (const [path, indices] of wanted) {
    const key = indices.join(",");
    const group = found.get(key) ?? { paths: [], kinds: indices.map((i) => album.kinds[i]) };
    group.paths.push(path);
    found.set(key, group);
  }
  return [...found.values()];
}

/**
 * Every picture inside a song that breaks the rules, per album: each is stored again, in the songs that have it, as a
 * JPEG of at most 1000 × 1000 (a wrong label alone is corrected without touching the picture). Songs keep their own
 * pictures: this never gives one song another's.
 */
export function planResize(files: GapFile[], tracks: GapTrack[], folders: Record<string, FolderArt>): AlbumPlan[] {
  const found: AlbumPlan[] = [];
  for (const group of groups(files, tracks)) {
    const kinds: KindPlan[] = [];
    for (const kind of ART_KINDS) {
      const wrong = group.files.filter((f) => {
        const picture = f.art?.[kind];
        return !!picture && needsRewrite(picture);
      });
      if (wrong.length === 0) continue;
      const file = folders[group.folder]?.[kind] ?? null;
      variants(wrong, kind, "songs")
        .sort((a, b) => side(b) - side(a))
        .forEach((target, index) => {
          const paths = wrong.filter((f) => f.art![kind]!.hash === target.hash).map((f) => f.path);
          // The largest of them is kept at its own size in the album folder when the folder has nothing as large.
          kinds.push({ kind, target, paths, keepFullSize: index === 0 && !target.ok && (!file || side(file) < side(target)) });
        });
    }
    if (kinds.length) found.push({ key: group.key, gap: asGap(group), kinds });
  }
  return found.sort((a, b) => a.gap.artist.localeCompare(b.gap.artist) || a.gap.album.localeCompare(b.gap.album));
}

/** An album folder with a PNG picture of one kind: `file` is the picture to keep (the folder's best of that kind). */
export type PngFolder = { folder: string; kind: ArtKind; file: string; path: string };

export function pngFolderPictures(files: GapFile[], folders: Record<string, FolderArt>): PngFolder[] {
  const song = new Map<string, string>();
  for (const file of files) if (!song.has(folderOf(file.path))) song.set(folderOf(file.path), file.path);
  return Object.entries(folders)
    .flatMap(([folder, art]) => {
      const path = song.get(folder);
      if (!path) return [];
      return [...new Set((art.png ?? []).map((p) => p.kind))].flatMap((kind) => (art[kind] && !art[kind]!.up ? [{ folder, kind, file: art[kind]!.file, path }] : []));
    })
    .sort((a, b) => a.folder.localeCompare(b.folder));
}
/** Albums where at least one song has no front cover inside it. */
export function albumsLackingFront(plan: ArtworkPlan): number {
  const keys = new Set(plan.none.front.map((g) => `${g.folder}|${g.album}`));
  for (const album of plan.albums) if (album.kinds.some((k) => k.kind === "front")) keys.add(`${album.gap.folder}|${album.gap.album}`);
  for (const choice of plan.choices) if (choice.kind === "front") keys.add(`${choice.gap.folder}|${choice.gap.album}`);
  return keys.size;
}
