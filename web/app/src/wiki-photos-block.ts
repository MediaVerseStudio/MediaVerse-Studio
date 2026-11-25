// Review > Artists > Free photos (D100): artist photos from Wikimedia Commons, found through MusicBrainz and Wikidata, with
// no Jellyfin server needed. "Find" asks about each artist once (about a second each) and keeps the answers; "Write"
// puts the photos found into the artists' songs as the Artist picture (with Undo). Text is set with textContent.

import { chunk, libraryArtists, type LibraryArtist } from "./artist-photos";
import { invoke, listen } from "./desktop-bridge";
import { el } from "./dom";
import type { LibrarySong } from "./library-format";

export type WikiPhotosDeps = { songs: () => LibrarySong[]; changed: (message: string) => void; stopIfPlaying: (paths: string[]) => void };
type Summary = { found: number; none: number; names: string[] };
type Problem = { path?: string; message: string };

const button = (text: string, className = "secondary"): HTMLButtonElement => {
  const b = el("button", className, text);
  b.type = "button";
  return b;
};
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const errorText = (error: unknown): string => (error as { message?: string })?.message ?? String(error);
const looseKey = (name: string): string => name.toLowerCase().normalize("NFD").replace(/[̀-ͯ]/g, "").replace(/&/g, "and").replace(/^the\s+/, "").replace(/[^a-z0-9]/g, "");
/** Artists are sent to the sidecar in groups this size, so one call never holds a huge list. */
const PER_CALL = 200;

export function initWikiPhotos(deps: WikiPhotosDeps): { element: HTMLElement; show: () => void } {
  const block = el("div", "settings-block");
  const note = el("div");
  const actions = el("div", "dialog-actions");
  const status = el("p", "field-hint");
  status.setAttribute("role", "status");
  const replaceBox = el("input");
  replaceBox.type = "checkbox";
  let summary: Summary | null = null;
  let findJob: string | null = null;
  let writeJob: string | null = null;
  let lastBatch: string | null = null;

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
    actions.replaceChildren();
    const busy = findJob !== null || writeJob !== null;
    if (findJob) {
      const stop = button("Stop");
      stop.addEventListener("click", () => void invoke("cancel_job", { job_id: findJob }).catch(() => undefined));
      actions.append(stop);
    } else {
      const find = button(summary && summary.found + summary.none ? "Look for more" : "Find free photos", "");
      find.disabled = busy;
      find.addEventListener("click", () => void startFind());
      actions.append(find);
    }
    const ready = foundArtists().length;
    if (ready) {
      const write = button(`Write ${plural(ready, "photo")} into the songs`, "");
      write.disabled = busy;
      write.addEventListener("click", () => void startWrite());
      actions.append(write);
    }
    if (lastBatch) {
      const undo = button("Undo the last write");
      undo.disabled = busy;
      undo.addEventListener("click", () => void undoLast());
      actions.append(undo);
    }
    const label = el("label", "artist-replace");
    label.append(replaceBox, el("span", undefined, " Replace photos the songs already have"));
    block.replaceChildren(
      el("h3", undefined, "Free photos (Wikimedia)"),
      el("p", "field-hint", "No server needed. For each artist, MusicBrainz names the artist, Wikidata names the photo and Wikimedia Commons supplies it (at most 1000 pixels). Many bands have none, and the answer is kept so nobody is asked twice. Commons photos are free to use but ask for credit; the photo's page and author are kept in the program's data folder. Only the Artist picture in each song changes, and there is an Undo."),
      summary && summary.found + summary.none ? el("p", undefined, `${plural(summary.found, "artist")} with a photo found, ${summary.none} with none on Wikimedia.`) : el("p", "field-hint", "Nothing looked up yet."),
      note,
      actions,
      label,
      status,
    );
  }

  async function startFind(): Promise<void> {
    const artists = libraryArtists(deps.songs()).map((a) => ({ name: a.name }));
    try {
      const started = await invoke<{ job_id: string }>("find_wiki_photos", { artists });
      findJob = started.job_id;
      note.replaceChildren(report("Looking up your artists. It asks about one a second, so a large library takes a while; you can stop and carry on later."));
      draw();
    } catch (error) {
      note.replaceChildren(report(`Could not start: ${errorText(error)}`));
    }
  }

  async function startWrite(): Promise<void> {
    const candidates = foundArtists();
    // Artists whose songs already carry an Artist picture are left alone unless asked.
    const list: LibraryArtist[] = [];
    let already = 0;
    for (const artist of candidates) {
      if (!replaceBox.checked) {
        const first = await invoke<{ from: string } | null>("track_artist_photo", { path: artist.paths[0] }).catch(() => null);
        const last = artist.paths.length > 1 ? await invoke<{ from: string } | null>("track_artist_photo", { path: artist.paths[artist.paths.length - 1] }).catch(() => null) : first;
        if (first?.from === "embedded" && last?.from === "embedded") {
          already++;
          continue;
        }
      }
      list.push(artist);
    }
    if (!list.length) {
      note.replaceChildren(report(already ? `All ${plural(already, "artist")} found already have a photo in their songs.` : "Nothing to write."));
      return;
    }
    const songs = list.reduce((n, a) => n + a.paths.length, 0);
    if (!confirm(`Write the Wikimedia photo of ${plural(list.length, "artist")} into ${plural(songs, "song")} as their Artist picture?\n\nOnly the tags of those songs change. You can undo this from here.`)) return;
    deps.stopIfPlaying(list.flatMap((a) => a.paths));
    const batch = `wikiphotos-${Date.now()}`;
    lastBatch = batch;
    try {
      const calls = chunk(list, PER_CALL);
      // One job per group; the first starts now, the rest as each finishes.
      pending = calls.slice(1).map((c) => ({ artists: c.map((a) => ({ name: a.name, paths: a.paths })), batch }));
      totals = { artists: 0, songs: 0, problems: [] };
      const started = await invoke<{ job_id: string }>("write_wiki_photos", { artists: calls[0].map((a) => ({ name: a.name, paths: a.paths })), batch });
      writeJob = started.job_id;
      note.replaceChildren(report(`Writing ${plural(list.length, "photo")}…`));
      draw();
    } catch (error) {
      lastBatch = null;
      note.replaceChildren(report(`Could not start: ${errorText(error)}`));
    }
  }

  let pending: Record<string, unknown>[] = [];
  let totals = { artists: 0, songs: 0, problems: [] as Problem[] };

  async function undoLast(): Promise<void> {
    if (!lastBatch || writeJob) return;
    const batch = lastBatch;
    try {
      const reply = await invoke<{ songs: number; problems: Problem[] }>("undo_picture_batch", { batch });
      lastBatch = null;
      note.replaceChildren(report(`Took the photos back out of ${plural(reply.songs, "song")}.`, reply.problems));
      deps.changed("Artist photos were removed again.");
    } catch (error) {
      note.replaceChildren(report(`Could not undo: ${errorText(error)}`));
    }
    draw();
  }

  listen<{ kind?: string; done?: number; total?: number; current?: string }>("job-progress", (event) => {
    const p = event.payload;
    if (p.kind === "wiki_photos") status.textContent = `Looked up ${p.done ?? 0} of ${p.total ?? 0}${p.current ? ` · ${p.current}` : ""}`;
    if (p.kind === "wiki_photos_write") status.textContent = `Written ${p.done ?? 0} of ${p.total ?? 0}`;
  }).catch(() => undefined);

  listen<{ job_id: string; ok: boolean; result?: { stopped?: boolean; artists?: number; songs?: number; problems?: Problem[]; trouble?: number }; error?: { message: string } }>("job-finished", (event) => {
    const { job_id, ok, result, error } = event.payload;
    if (job_id === findJob) {
      findJob = null;
      status.textContent = "";
      note.replaceChildren(report(ok ? (result?.stopped ? "Stopped. Press “Look for more” to carry on." : `Done.${result?.trouble ? ` ${result.trouble} could not be asked (network or rate limit); try again later.` : ""}`) : `Stopped: ${error?.message ?? "unknown error"}`));
      void load();
    } else if (job_id === writeJob) {
      writeJob = null;
      status.textContent = "";
      if (ok && result) {
        totals.artists += result.artists ?? 0;
        totals.songs += result.songs ?? 0;
        totals.problems.push(...(result.problems ?? []));
      } else {
        totals.problems.push({ message: error?.message ?? "writing stopped" });
      }
      const next = pending.shift();
      if (next) {
        void invoke<{ job_id: string }>("write_wiki_photos", next).then((s) => (writeJob = s.job_id)).catch((e) => note.replaceChildren(report(`Stopped: ${errorText(e)}`)));
      } else {
        note.replaceChildren(report(`Wrote ${plural(totals.artists, "photo")} into ${plural(totals.songs, "song")}.`, totals.problems));
        if (totals.songs) deps.changed("Artist photos were saved.");
        else lastBatch = null;
      }
    }
    draw();
  }).catch(() => undefined);

  draw();
  return { element: block, show: () => void load() };
}
