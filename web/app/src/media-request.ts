// Pure helpers for the "Pictures and lyrics" dialog: the requests sent to the sidecar and the
// plain-language summary of its answer. No DOM or bridge access, so they are unit tested.

export type PictureKindName = "front_cover" | "back_cover" | "artist_photo";

export const PICTURE_KIND_LABELS: Record<PictureKindName, string> = {
  front_cover: "Front cover",
  back_cover: "Back cover",
  artist_photo: "Artist photo",
};

export type FileResult = { path: string; ok: boolean; error?: string };

/** Put a picture on (or, with `null`, take that kind of picture off) every listed file. */
export function pictureRequest(paths: string[], kind: PictureKindName, base64: string | null): Record<string, unknown> {
  return { paths, pictures: [{ kind, data_base64: base64 }] };
}

/** Set the lyrics of one file from typed or pasted text (plain or .lrc), or clear them with `null`. */
export function lyricsRequest(path: string, text: string | null): Record<string, unknown> {
  return { paths: [path], lyrics: text === null ? { clear: true } : { text } };
}

export function summarizeEdit(results: FileResult[], what: string): { ok: boolean; message: string } {
  const failed = results.filter((r) => !r.ok);
  if (failed.length === 0) {
    return { ok: true, message: results.length === 1 ? `${what} saved.` : `${what} saved on ${results.length} tracks.` };
  }
  const first = failed[0].error ?? "it failed";
  if (failed.length === results.length) {
    return { ok: false, message: `${what} was not saved: ${first}` };
  }
  return { ok: false, message: `${what} was saved on ${results.length - failed.length} of ${results.length} tracks. ${failed.length} failed; the first problem: ${first}` };
}

/** Sizes the page aims for when it re-encodes a picture so it fits the MP3 limit (owner, 2026-11-05: at most
 * 1000 × 1000 pixels). */
export const PICTURE_LIMITS = { maxBytes: 450 * 1024, idealBytes: 200 * 1024, maxSide: 1000 } as const;

/** Set (base64) or remove (`null`) several kinds of picture on every listed file, in one request; `folder`: the
 * full-size copies for the album folder; `batch`: journal it for an undo. */
export function picturesRequest(
  paths: string[],
  pictures: { kind: PictureKindName; base64: string | null }[],
  folder: { kind: PictureKindName; base64: string }[] = [],
  batch?: string,
): Record<string, unknown> {
  return {
    paths,
    pictures: pictures.map((p) => ({ kind: p.kind, data_base64: p.base64 })),
    ...(folder.length ? { folder_pictures: folder.map((p) => ({ kind: p.kind, data_base64: p.base64 })) } : {}),
    ...(batch ? { batch } : {}),
  };
}

/**
 * Whether a picture being saved also goes in the album folder at full size (owner, 2026-11-05): a new picture
 * always (the folder's old one is kept aside); one from the folder never; one already in the songs (shrunk or
 * cropped) only when the folder has no picture of that kind at least as large, so its full size is not lost.
 */
export function wantsFolderCopy(origin: "new" | "embedded" | "folder", nativeSide: number, folder: { width: number; height: number } | null): boolean {
  if (origin === "new") return true;
  if (origin === "folder") return false;
  return !folder || Math.min(folder.width, folder.height) < nativeSide;
}

/** The centred square of a picture: the part kept by "Crop to square". */
export function centreSquare(width: number, height: number): { x: number; y: number; side: number } {
  const side = Math.min(width, height);
  return { x: Math.floor((width - side) / 2), y: Math.floor((height - side) / 2), side };
}

/** "500 × 500", with " (over 1000)" when the picture is larger than the limit. */
export function describeSize(width: number, height: number): string {
  return `${width} × ${height}${Math.max(width, height) > PICTURE_LIMITS.maxSide ? " (over 1000)" : ""}`;
}

/** The address of a web image search for an album's artwork, in the person's browser. */
export function webSearchUrl(album: string, artist: string | null, year: number | null): string {
  const words = [artist, album, year ? String(year) : null, "album artwork"].filter((w): w is string => !!w && w.trim() !== "");
  // tbs=isz:l is Google Images' Tools > Size > Large (owner, 2026-11-05: weeds out the small covers).
  return `https://www.google.com/search?tbm=isch&tbs=isz:l&q=${encodeURIComponent(words.join(" "))}`;
}

/** The scale that brings an image of this size within `maxSide` (never above 1). */
export function scaleFor(width: number, height: number, maxSide: number): number {
  const largest = Math.max(width, height);
  return largest > maxSide ? maxSide / largest : 1;
}

/**
 * The JPEG quality for a picture inside the songs (owner, 2026-11-05: under 500 KB, ideally under 200 KB, but not
 * over-compressed: covers are shown near full size on large 4K TVs). The best quality from 92 down to 80 that fits
 * 200 KB; if none does, the best of those that fits the limit; only then lower qualities, down to 50.
 */
export async function pickQuality(encode: (quality: number) => Promise<Blob | null>): Promise<Blob | null> {
  const good = [0.92, 0.9, 0.88, 0.86, 0.84, 0.82, 0.8];
  const tried: Blob[] = [];
  for (const quality of good) {
    const blob = await encode(quality);
    if (!blob) continue;
    if (blob.size <= PICTURE_LIMITS.idealBytes) return blob;
    tried.push(blob);
  }
  const fits = tried.find((b) => b.size <= PICTURE_LIMITS.maxBytes);
  if (fits) return fits;
  for (const quality of [0.75, 0.7, 0.6, 0.5]) {
    const blob = await encode(quality);
    if (blob && blob.size <= PICTURE_LIMITS.maxBytes) return blob;
  }
  return null;
}
