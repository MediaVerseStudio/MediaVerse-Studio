// Puts the planned pictures into one album's songs. The bridge and the picture work are passed in, so it is unit tested.

import { type AlbumPlan, type ArtKind, type KindPlan, PICTURE_KIND, type PictureSource, writeGroups } from "./artwork-plan.ts";
import { type FileResult, type PictureKindName, picturesRequest } from "./media-request.ts";

export type StoredPicture = { mime: string; data_base64: string };
export type FillIo = {
  invoke: <T>(command: string, args: Record<string, unknown>) => Promise<T>;
  /** The picture as it goes into songs: a JPEG of at most 1000 pixels (image-prep). */
  prepare: (picture: StoredPicture) => Promise<string>;
  /** The full-size copy for the album folder. */
  fullSize: (picture: StoredPicture) => Promise<string>;
};
export type FillProblem = { path: string; message: string };

/** Songs written in one request: small, so progress moves and Stop answers soon. */
const PER_CALL = 10;

export const sourceArgs = (kind: ArtKind, source: PictureSource): Record<string, unknown> => ({ kind, path: source.path, ...(source.file ? { file: source.file, up: !!source.up } : {}) });

const message = (thrown: unknown): string => (thrown as { message?: string })?.message ?? String(thrown);

/**
 * Writes an album's planned pictures, journalled as `batch`. Every song that could not be written is reported; one
 * failure never stops the others. Returns how many songs were changed. `stop` is asked between requests.
 */
export async function fillAlbum(album: AlbumPlan, batch: string, io: FillIo, written: (songs: number) => void = () => {}, stop: () => boolean = () => false): Promise<{ songs: number; problems: FillProblem[] }> {
  // Every picture is read and prepared before anything is written: a picture that cannot be used changes no song.
  const ready = new Map<KindPlan, string>();
  const folder: { kind: PictureKindName; base64: string }[] = [];
  const problems: FillProblem[] = [];
  for (const plan of album.kinds) {
    const { kind, target, keepFullSize } = plan;
    try {
      const picture = await io.invoke<StoredPicture>("art_source", sourceArgs(kind, target.source));
      ready.set(plan, target.ok ? picture.data_base64 : await io.prepare(picture));
      if (keepFullSize) folder.push({ kind: PICTURE_KIND[kind], base64: await io.fullSize(picture) });
    } catch (thrown) {
      problems.push({ path: album.gap.folder, message: `${album.gap.album}: ${message(thrown)}` });
    }
  }
  let songs = 0;
  let folderPending = folder;
  for (const group of writeGroups(album)) {
    const pictures = group.kinds.filter((k) => ready.has(k)).map((k) => ({ kind: PICTURE_KIND[k.kind], base64: ready.get(k)! }));
    if (pictures.length === 0) continue;
    for (let at = 0; at < group.paths.length; at += PER_CALL) {
      if (stop()) return { songs, problems };
      const paths = group.paths.slice(at, at + PER_CALL);
      try {
        const reply = await io.invoke<{ results: FileResult[]; folder?: { ok: boolean; error?: string }[] }>("update_track_media", picturesRequest(paths, pictures, folderPending, batch));
        folderPending = [];
        for (const result of reply.results) {
          if (result.ok) songs += 1;
          else problems.push({ path: result.path, message: result.error ?? "it failed" });
        }
        for (const failed of reply.folder?.filter((f) => !f.ok) ?? []) problems.push({ path: album.gap.folder, message: failed.error ?? "the folder copy was not saved" });
      } catch (thrown) {
        for (const path of paths) problems.push({ path, message: message(thrown) });
      }
      written(paths.length);
    }
  }
  return { songs, problems };
}
