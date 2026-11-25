// Pure logic for Review > Lyrics > "Add lyrics from booklet photos" (owner, 2026-11-20): which songs make an album, which photo
// panel goes to which song (a panel is used once), and the review entry sent for each. No DOM, so it is unit tested.

export type PhotoSong = { path: string; title: string; artist: string | null; album: string | null; number: number | null };

export type PhotoAlbum = { key: string; label: string; songs: PhotoSong[] };

/** The folder of a song path (backslashes or slashes). */
export function folderOf(path: string): string {
  const cut = Math.max(path.lastIndexOf("\\"), path.lastIndexOf("/"));
  return cut < 0 ? "" : path.slice(0, cut);
}

/** Songs grouped into albums by folder, songs in track order, albums by artist then title. */
export function albumsOf(songs: PhotoSong[]): PhotoAlbum[] {
  const byFolder = new Map<string, PhotoSong[]>();
  for (const song of songs) {
    const key = folderOf(song.path);
    byFolder.set(key, [...(byFolder.get(key) ?? []), song]);
  }
  const albums: PhotoAlbum[] = [];
  for (const [key, list] of byFolder) {
    list.sort((a, b) => (a.number ?? 9999) - (b.number ?? 9999) || a.title.localeCompare(b.title));
    const artist = list.find((s) => s.artist)?.artist ?? "Unknown artist";
    const album = list.find((s) => s.album)?.album ?? "Unknown album";
    albums.push({ key, label: `${artist} — ${album} (${list.length} song${list.length === 1 ? "" : "s"})`, songs: list });
  }
  return albums.sort((a, b) => a.label.localeCompare(b.label));
}

/** Albums whose label contains every word typed (capitals ignored); all of them for nothing typed. */
export function findAlbums(albums: PhotoAlbum[], typed: string): PhotoAlbum[] {
  const words = typed.toLowerCase().split(/\s+/).filter(Boolean);
  return albums.filter((album) => words.every((w) => album.label.toLowerCase().includes(w)));
}

/** What the sidecar found in the photos. */
export type ReadPanel = { photo: number; title: string; score: number; lines: string[]; text: string; track: number | null; similarity: number | null; /** The booklet page as base64 JPEG. */ crop_base64?: string };
export type ReadResult = { photos: string[]; /** Each photo as it was read (turned upright), base64 JPEG, shown beside the words when a page has no cut-out of its own. */ pictures?: string[]; reader?: "vision" | "basic"; panels: ReadPanel[]; tracks: { index: number; path: string; title: string; panel: number | null }[]; words_known: number };

/** The picture to show beside a panel's words: its own cut-out, or else the whole photo it was read from. */
export function panelPicture(result: ReadResult, panel: ReadPanel): string | null {
  return panel.crop_base64 || result.pictures?.[panel.photo] || null;
}

/** A photo turned a quarter turn clockwise (`1`) or anticlockwise (`-1`): the turn in degrees, 0, 90, 180 or 270. */
export function turned(current: number, direction: 1 | -1): number {
  return (((current + direction * 90) % 360) + 360) % 360;
}

/** Which panel (index into `panels`) is chosen for each song of the album (null: none). */
export type Assignment = (number | null)[];

/** The start: the panel the sidecar matched to each song. */
export function initialAssignment(result: ReadResult): Assignment {
  return result.tracks.map((t) => t.panel);
}

/** Chooses `panel` for song `track`; a panel is used once, so another song that had it loses it. `null` clears the song. */
export function assign(current: Assignment, track: number, panel: number | null): Assignment {
  return current.map((value, i) => (i === track ? panel : panel !== null && value === panel ? null : value));
}

/** The panels no song uses, for the person to give to a song. */
export function unusedPanels(current: Assignment, panelCount: number): number[] {
  const used = new Set(current.filter((p): p is number => p !== null));
  return Array.from({ length: panelCount }, (_, i) => i).filter((i) => !used.has(i));
}

/** How a panel is named in a list: its heading (or "no heading"), how many lines, and a warning when the reading was doubtful. */
export function panelLabel(panel: ReadPanel, number: number): string {
  const lines = panel.lines.filter((l) => l !== "").length;
  const doubtful = panel.score < 0.8 ? ", doubtful reading" : "";
  return `${number}. ${panel.title || "(no heading)"} — ${lines} lines, photo ${panel.photo + 1}${doubtful}`;
}

/** The entry sent to To review for a song: the words read from the photo, as one candidate the person plays, corrects and confirms. */
export function reviewEntry(song: PhotoSong, words: string) {
  return {
    path: song.path,
    title: song.title,
    artist: song.artist ?? "",
    album: song.album ?? "",
    candidates: [{ track: song.title, artist: song.artist ?? "", album: song.album ?? "", plain: words.trim(), source: "photo", confidence: 90 }],
  };
}

/** The words with the empty lines at the start and end dropped and runs of empty lines made one (a stanza gap). */
export function tidyWords(text: string): string {
  return text
    .replace(/\r\n?/g, "\n")
    .split("\n")
    .map((l) => l.trimEnd())
    .join("\n")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}

/** Progress as words: "Reading page2.jpg (2 of 4)". */
export function stepText(step: string, done: number, total: number): string {
  return step.startsWith("Reading") || step.startsWith("Learning") ? `${step} (${done.toLocaleString()} of ${total.toLocaleString()})` : step;
}

/** A size in bytes as "85 MB". */
export function megabytes(bytes: number): string {
  return `${Math.round(bytes / 1_000_000)} MB`;
}
