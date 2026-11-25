// "This song is instrumental" for a song whose lyrics (suggested or already written) are invented (owner, 2026-11-21: the Lyric AI put words and timing on an
// instrumental). The lyrics are taken out of the song, its language is set to "zxx" (no linguistic content, which the Lyric AI and the lookups leave alone from then
// on), and any suggestions waiting for it are dropped. "Not instrumental" in Review > Lyrics > Suspected instrumental puts the song back as it was.

import { invoke } from "./desktop-bridge";
import type { FileResult } from "./media-request";

export const INSTRUMENTAL_QUESTION = (title: string): string =>
  `Mark “${title}” as instrumental?\n\nAny lyrics in the song are removed, its language is set to "zxx" (no linguistic content), and the lyrics suggestions waiting for it are dropped. ` +
  "The Lyric AI and the lyrics lookups leave it alone from then on. Suspected instrumental > Not instrumental puts it back among the songs missing lyrics.";

/** Removes the song's lyrics, confirms it instrumental and drops its suggestions. Throws with the reason when the song could not be changed. */
export async function flagInstrumental(path: string, key: string | null): Promise<void> {
  const cleared = await invoke<{ results: FileResult[] }>("update_track_media", { paths: [path], lyrics: { clear: true } });
  const outcome = cleared.results[0];
  if (!outcome?.ok) throw new Error(outcome?.error ?? "the lyrics could not be removed");
  const confirmed = await invoke<{ confirmed: number; problems: { message: string }[] }>("confirm_lyrics_instrumental", { paths: [path] });
  if (confirmed.confirmed !== 1) throw new Error(confirmed.problems[0]?.message ?? "the song could not be marked");
  if (key) await invoke("remove_lyrics_review", { key }).catch(() => undefined);
  await invoke("lyric_ai_wrong_dismiss", { path }).catch(() => undefined);
}
