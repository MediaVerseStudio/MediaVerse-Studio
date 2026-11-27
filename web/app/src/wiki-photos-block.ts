// Review > Artists > Free photos (D100): artist photos from Wikimedia Commons, found through MusicBrainz and Wikidata, with
// no Jellyfin server needed. "Look up" asks about each artist once (about a second each) and keeps the answers; "Write"
// puts the photos found into the artists' songs as the Artist picture (with Undo). Both run five minutes at a time or
// unattended (D206). Text is set with textContent.

import { libraryArtists, type LibraryArtist } from "./artist-photos";
import { invoke } from "./desktop-bridge";
import { el } from "./dom";
import { runJob } from "./jobs";
import { fitForSong } from "./image-prep";
import { blobFromBase64 } from "./cover-util";
import type { LibrarySong } from "./library-format";
import { describeEnd, history, modeButtons, runView, startRun, undoBar } from "./run-controller";
import { CHUNK_MS, type RunMode } from "./timed-run";

/** `undo`: show the Undo here (the Artwork page has its own). */
export type WikiPhotosDeps = { songs: () => LibrarySong[]; changed: (message: string) => void; stopIfPlaying: (paths: string[]) => void; undo?: boolean };
type Summary = { found: number; none: number; names: string[] };
type Problem = { path?: string; message: string };

const plural = (n: number, word: string): string => `${n.toLocaleString("en-US")} ${word}${n === 1 ? "" : "s"}`;
const errorText = (error: unknown): string => (error as { message?: string })?.message ?? String(error);
const looseKey = (name: string): string => name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and").replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "");
export function initWikiPhotos(deps: WikiPhotosDeps): { element: HTMLElement; show: () => void; redraw: () => void } {
  const block = el("div", "settings-block");
  const note = el("div");
  const replaceBox = el("input");
  replaceBox.type = "checkbox";
  let summary: Summary | null = null;
  const report = (text: string, problems: Problem[] = []): HTMLElement => {
    const box = el("div", problems.length ? "ft-report ft-report-warn" : "ft-report ft-report-good");
    box.append(el("p", undefined, text));
    if (problems.length) {
      const ul = el("ul", "ft-problems");
      for (const p of problems.slice(0, 6)) ul.append(el("li", undefined, `${p.path ? `${p.path.split(/[\\/]/).pop()}: ` : ""}${p.message}`));
      box.append(ul);
    }
    return box;
  };

  /** The library's artists whose photo was found (not yet checked for an existing one). */
  function foundArtists(): LibraryArtist[] {
    const names = new Set((summary?.names ?? []).map(looseKey));
    if (!names.size) return [];
    return libraryArtists(deps.songs()).filter((a) => names.has(looseKey(a.name)));
  }

  async function load(): Promise<void> {
    try {
      summary = await invoke<Summary>("list_wiki_photos", {});
    } catch {
      summary = null;
    }
    draw();
  }

  function draw(): void {
    const parts: HTMLElement[] = [
      el("h3", undefined, "Free photos (Wikimedia)"),
      el("p", "field-hint", "No server needed. For each artist, MusicBrainz names the artist, Wikidata names the photo and Wikimedia Commons supplies it (at most 1000 pixels). Many bands have none, and the answer is kept so nobody is asked twice. Commons photos are free to use but ask for credit; the photo's page and author are kept in the program's data folder. Only the Artist picture in each song changes, and there is an Undo."),
      summary && summary.found + summary.none ? el("p", undefined, `${plural(summary.found, "artist")} with a photo found, ${summary.none.toLocaleString("en-US")} with none on Wikimedia.`) : el("p", "field-hint", "Nothing looked up yet."),
      note,
    ];
    if (deps.undo) parts.push(runView(), undoBar(() => deps.changed("Artist photos were removed again.")));
    // The song list is only read once the cache has answered: this is also drawn while the program is still starting.
    const artists = summary ? libraryArtists(deps.songs()) : [];
    const asked = (summary?.found ?? 0) + (summary?.none ?? 0);
    if (artists.length > asked) parts.push(modeButtons(`Look up ${plural(artists.length - asked, "artist")} (about a second or two each):`, (mode) => startFind(mode)));
    const ready = foundArtists();
    if (ready.length) {
      parts.push(modeButtons(`Write the photos found into the songs (${plural(ready.length, "artist")}):`, (mode) => startWrite(ready, mode)));
      const label = el("label", "artist-replace");
      label.append(replaceBox, el("span", undefined, " Replace photos the songs already have"));
      parts.push(label);
    }
    block.replaceChildren(...parts);
  }

  function startFind(mode: RunMode): void {
    const artists = libraryArtists(deps.songs()).map((a) => ({ name: a.name }));
    let jobId: string | null = null;
    let outcome: { stopped?: boolean; trouble?: number } = {};
    let failure = "";
    const cancel = (): void => {
      if (jobId) void invoke("cancel_job", { job_id: jobId }).catch(() => undefined);
    };
    note.replaceChildren();
    void startRun({
      title: "Looking up artist photos",
      unit: "artists",
      mode,
      items: [artists],
      size: (list) => list.length,
      label: () => "Artists already asked about are skipped.",
      onStop: cancel,
      step: async (list, tools) => {
        let seen = 0;
        const timer = mode === "chunk" ? window.setTimeout(cancel, CHUNK_MS) : null;
        try {
          outcome = await runJob<{ stopped?: boolean; trouble?: number }>("find_wiki_photos", { artists: list }, (p) => {
            jobId = p.job_id ?? jobId;
            if (tools.stopped()) cancel();
            const done = p.done ?? 0;
            tools.advance(done - seen);
            seen = done;
          });
          return "ok";
        } catch (error) {
          failure = errorText(error);
          return "failed";
        } finally {
          if (timer !== null) window.clearTimeout(timer);
        }
      },
    }).then((result) => {
      if (!result) return;
      const text = failure ? `Stopped: ${failure}` : outcome.stopped ? "Paused. Press again to carry on where it left off." : `Done.${outcome.trouble ? ` ${outcome.trouble} could not be asked (network or rate limit); try again later.` : ""}`;
      note.replaceChildren(report(text));
      void load();
    });
  }

  function startWrite(list: LibraryArtist[], mode: RunMode): void {
    const songs = list.reduce((n, a) => n + a.paths.length, 0);
    if (!window.confirm(`Write the Wikimedia photos of up to ${plural(list.length, "artist")} (${plural(songs, "song")}) into the songs as their Artist picture?\n\nOnly the tags of those songs change. You can undo this.`)) return;
    const id = `wikiphotos-${Date.now()}`;
    const replace = replaceBox.checked;
    let written = 0;
    let changedArtists = 0;
    const problems: Problem[] = [];
    note.replaceChildren();
    void startRun({
      title: "Writing artist photos",
      unit: "songs",
      mode,
      items: list.map((artist, index) => ({ artist, batch: `${id}-${index}` })),
      size: ({ artist }) => artist.paths.length,
      label: ({ artist }) => artist.name,
      step: async ({ artist, batch }) => {
        // Artists whose songs already carry an Artist picture are left alone unless asked.
        if (!replace) {
          const first = await invoke<{ from: string } | null>("track_artist_photo", { path: artist.paths[0] }).catch(() => null);
          const last = artist.paths.length > 1 ? await invoke<{ from: string } | null>("track_artist_photo", { path: artist.paths[artist.paths.length - 1] }).catch(() => null) : first;
          if (first?.from === "embedded" && last?.from === "embedded") return "ok";
        }
        deps.stopIfPlaying(artist.paths);
        history.add(id, "Wikimedia artist photos", batch);
        // The cached photo is made to fit a song first (some are PNG, or taller than 1000 pixels).
        const photo = await invoke<{ data_base64: string } | null>("wiki_photo", { name: artist.name });
        if (!photo) return "ok";
        const fitted = await fitForSong(blobFromBase64(photo.data_base64, "image/jpeg"));
        const reply = await runJob<{ songs: number; problems: Problem[] }>("write_wiki_photos", { artists: [{ name: artist.name, paths: artist.paths, data_base64: fitted }], batch });
        written += reply.songs;
        if (reply.songs) changedArtists += 1;
        problems.push(...reply.problems);
        return reply.songs === 0 && reply.problems.length ? "failed" : "ok";
      },
    }).then((result) => {
      if (!result) return;
      note.replaceChildren(report(`Wrote ${plural(changedArtists, "photo")} into ${plural(written, "song")}. ${describeEnd(result, plural(result.left, "artist"))}`, problems));
      if (written) deps.changed("Artist photos were saved.");
      draw();
    });
  }

  draw();
  return { element: block, show: () => void load(), redraw: draw };
}
