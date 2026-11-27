// Review > Artists (D97): two tools for the artists in the library.
//  - Artist names: the same artist spelt more than one way ("AFI" and "A.F.I.") is found; the person picks one
//    spelling and every song's Artist and Album artist tags are changed to it (with Undo).
//  - Artist photos: the photos a Jellyfin server holds for the library's artists are written into their songs as the
//    "Artist" picture (ID3 picture type 8), and shown on top of the artist's stack in the library (with Undo).
// Nothing is changed without the person pressing the button and confirming. Text is set with textContent.

import { JellyfinProblem, type ServerArtist } from "../phone/jellyfin-phone.ts";
import { type Canonical, type NameGroup, type Settled, describeRename, distinctNames, loadSettled, oddities, saveSettled, signatureOf, similarNames, visibleName } from "./artist-names.ts";
import { chunk, describePlan, libraryArtists, planPhotos, type PhotoPlan } from "./artist-photos.ts";
import { invoke, listen } from "./desktop-bridge";
import { el } from "./dom";
import { initWikiPhotos } from "./wiki-photos-block";
import { describeEnd, history, modeButtons, onRunChange, startRun } from "./run-controller";
import type { RunMode } from "./timed-run";
import { desktopJellyfin, savedDesktopSession } from "./jellyfin-desktop";
import type { LibrarySong } from "./library-format";
import { PICTURE_LIMITS, picturesRequest } from "./media-request";
import { fitForSong } from "./image-prep";
import { blobFromBase64 } from "./cover-util";

export type ArtistsPanelDeps = {
  songs: () => LibrarySong[];
  /** Tags or pictures changed on disk: reload the library (and forget remembered covers). Resolves once the library page has the new tags. */
  changed: (message: string) => void | Promise<void>;
  /** A song that is playing cannot be rewritten; stop it first. */
  stopIfPlaying: (paths: string[]) => void;
};

type Problem = { path?: string; message: string };
const button = (text: string, className = "secondary"): HTMLButtonElement => {
  const b = el("button", className, text);
  b.type = "button";
  return b;
};
const plural = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
const errorText = (error: unknown): string => (error as { message?: string })?.message ?? String(error);
const SHOWN_GROUPS = 40;
/** A photo is sent to the songs in groups this size (the sidecar takes at most 1000 files a call). */
const PATHS_PER_CALL = 500;

function report(text: string, problems: Problem[] = []): HTMLElement {
  const box = el("div", problems.length ? "ft-report ft-report-warn" : "ft-report ft-report-good");
  box.append(el("p", undefined, text));
  if (problems.length) {
    const list = el("ul", "ft-problems");
    for (const p of problems.slice(0, 10)) list.append(el("li", undefined, `${p.path ? `${p.path.split(/[\\/]/).pop()}: ` : ""}${p.message}`));
    if (problems.length > 10) list.append(el("li", undefined, `…and ${problems.length - 10} more.`));
    box.append(list);
  }
  return box;
}

export function initArtistsPanel(root: HTMLElement, deps: ArtistsPanelDeps): { show: () => void; refresh: () => void } {
  root.classList.add("artists-panel");

  // ---------------------------------------------------------------- Artist names
  const namesBlock = el("div", "settings-block");
  const namesList = el("div", "artist-names-list");
  const namesNote = el("div");
  const namesStatus = el("p", "field-hint");
  namesStatus.setAttribute("role", "status");
  /** What MusicBrainz said about each spelling in the library (asked once, remembered by the program). */
  let canonical: Canonical = new Map();
  let checking: string | null = null;
  /** Names the person has decided about ("Use this spelling", "Leave as it is"): not listed again until their spellings change. */
  let settled: Settled = loadSettled();
  const settle = (key: string, entry: Settled[string] | undefined): void => {
    settled = { ...settled };
    if (entry) settled[key] = entry;
    else delete settled[key];
    saveSettled(settled);
  };

  async function loadCanonical(): Promise<void> {
    try {
      const reply = await invoke<{ names: Record<string, string> }>("canonical_artist_names", {});
      canonical = new Map(Object.entries(reply.names));
    } catch {
      canonical = new Map();
    }
    drawNames();
  }

  async function startCheck(): Promise<void> {
    try {
      const started = await invoke<{ job_id: string }>("check_artist_names", { names: distinctNames(deps.songs()) });
      checking = started.job_id;
      namesNote.replaceChildren(report("Asking MusicBrainz how each artist is spelt. It takes about a second a name, so a big library takes a while; you can stop and carry on later, and no name is asked twice."));
      drawNames();
    } catch (error) {
      namesNote.replaceChildren(report(`Could not start: ${errorText(error)}`));
    }
  }

  listen<{ kind?: string; done?: number; total?: number; current?: string }>("job-progress", (event) => {
    if (event.payload.kind === "artist_names") namesStatus.textContent = `Asked about ${event.payload.done ?? 0} of ${event.payload.total ?? 0}${event.payload.current ? ` · ${event.payload.current}` : ""}`;
  }).catch(() => undefined);
  listen<{ job_id: string; ok: boolean; error?: { message: string } }>("job-finished", (event) => {
    if (event.payload.job_id !== checking) return;
    checking = null;
    namesStatus.textContent = "";
    if (!event.payload.ok) namesNote.replaceChildren(report(`Stopped: ${event.payload.error?.message ?? "unknown error"}`));
    else namesNote.replaceChildren(report("MusicBrainz has been asked about every name."));
    void loadCanonical();
  }).catch(() => undefined);
  /** The last rename, for Undo. */
  let lastRename: { batch: string; text: string; key: string; before: Settled[string] | undefined } | null = null;
  let renaming = false;

  async function rename(group: NameGroup, to: string): Promise<void> {
    if (renaming) return;
    if (!confirm(`${describeRename(group, to)}\n\nOnly tags that are exactly one of those spellings change. You can undo this from here.`)) return;
    renaming = true;
    const batch = `names-${Date.now()}`;
    try {
      deps.stopIfPlaying(group.paths);
      const from = group.spellings.map((s) => s.name).filter((name) => name !== to);
      const reply = await invoke<{ songs: number; fields: number; unchanged: number; problems: Problem[] }>("rename_artist", { paths: group.paths, from, to, batch });
      const before = settled[group.key];
      lastRename = reply.songs ? { batch, text: `“${to}”: ${plural(reply.songs, "song")} changed.`, key: group.key, before } : null;
      namesNote.replaceChildren(report(reply.songs ? `${plural(reply.songs, "song")} now say “${to}”.` : "Nothing needed changing.", reply.problems));
      // The person chose this spelling: it is settled (even where MusicBrainz spells the name differently), and the list shows it gone.
      if (!reply.problems.length) settle(group.key, { signature: signatureOf([to]), chosen: to });
      // The page reads the library, which learns of the new tags from a background scan: scan now and wait, so the list below is right.
      if (reply.songs) await deps.changed(`Artist name changed to ${to}.`);
    } catch (error) {
      namesNote.replaceChildren(report(`Could not change the name: ${errorText(error)}`, [{ message: "Nothing was changed, or only some songs were; the list below shows what is left." }]));
    } finally {
      renaming = false;
      drawNames();
    }
  }

  async function undoRename(): Promise<void> {
    if (!lastRename || renaming) return;
    const { batch } = lastRename;
    renaming = true;
    try {
      const reply = await invoke<{ songs: number; problems: Problem[] }>("undo_artist_rename", { batch });
      settle(lastRename.key, lastRename.before);
      lastRename = null;
      namesNote.replaceChildren(report(`Put back the old spelling in ${plural(reply.songs, "song")}.`, reply.problems));
      await deps.changed("Artist name change undone.");
    } catch (error) {
      namesNote.replaceChildren(report(`Could not undo: ${errorText(error)}`));
    } finally {
      renaming = false;
      drawNames();
    }
  }

  function groupCard(group: NameGroup): HTMLElement {
    const card = el("div", "artist-name-group");
    const choice = `artist-name-${group.key}`;
    let chosen = group.suggested;
    const custom = el("input");
    custom.type = "text";
    custom.placeholder = "Another spelling";
    custom.setAttribute("aria-label", "Another spelling");
    const apply = button(`Use “${chosen}”`, "");
    const pick = (name: string): void => {
      chosen = name;
      apply.textContent = name ? `Use “${name}”` : "Use…";
      apply.disabled = !name.trim();
    };
    for (const spelling of group.spellings) {
      const row = el("label", "artist-name-choice");
      const radio = el("input");
      radio.type = "radio";
      radio.name = choice;
      radio.checked = spelling.name === group.suggested;
      radio.addEventListener("change", () => {
        custom.value = "";
        pick(spelling.name);
      });
      const notes = [
        spelling.songs ? plural(spelling.songs, "song") : "not used by any song yet",
        ...(group.official === spelling.name ? ["the spelling MusicBrainz uses"] : []),
        ...(spelling.name === group.suggested ? ["suggested"] : []),
        ...oddities(spelling.name),
      ];
      row.append(radio, el("span", "artist-name-spelling", visibleName(spelling.name)), el("span", "field-hint", notes.join(" · ")));
      card.append(row);
    }
    if (group.reason) card.prepend(el("p", "field-hint", group.reason));
    custom.addEventListener("input", () => {
      for (const radio of card.querySelectorAll<HTMLInputElement>("input[type=radio]")) radio.checked = false;
      pick(custom.value.trim());
    });
    apply.addEventListener("click", () => void rename(group, chosen.trim()));
    // "Leave as it is": the spellings are fine (a band spelt a way MusicBrainz does not, two real artists); not listed again unless they change.
    const keep = button("Leave as it is");
    keep.title = "Change nothing, and do not list this name again unless its spellings change";
    keep.addEventListener("click", () => {
      settle(group.key, { signature: signatureOf(group.spellings.filter((s) => s.songs > 0).map((s) => s.name)) });
      namesNote.replaceChildren(report(`Left as it is: ${group.spellings.filter((s) => s.songs > 0).map((s) => `“${visibleName(s.name)}”`).join(", ")}.`));
      drawNames();
    });
    card.append(custom, apply, keep);
    return card;
  }

  function drawNames(): void {
    const groups = similarNames(deps.songs(), canonical, settled);
    const undo = lastRename ? button(`Undo: ${lastRename.text}`) : null;
    undo?.addEventListener("click", () => void undoRename());
    namesList.replaceChildren();
    const check = button(checking ? "Stop checking" : canonical.size ? "Check new names with MusicBrainz" : "Check names with MusicBrainz", "");
    check.addEventListener("click", () => (checking ? void invoke("cancel_job", { job_id: checking }).catch(() => undefined) : void startCheck()));
    namesList.append(check, namesStatus);
    if (!groups.length) {
      namesList.append(el("p", undefined, canonical.size ? "Every artist name is spelt the way MusicBrainz spells it (or MusicBrainz does not know it)." : "No artist is spelt two ways in your tags. Check the names with MusicBrainz to find names that are not spelt the official way."));
    } else {
      namesList.append(el("p", undefined, `${plural(groups.length, "artist name")} to look at.`));
      for (const group of groups.slice(0, SHOWN_GROUPS)) namesList.append(groupCard(group));
      if (groups.length > SHOWN_GROUPS) namesList.append(el("p", "field-hint", `…and ${groups.length - SHOWN_GROUPS} more; they show here as you fix these.`));
    }
    namesBlock.replaceChildren(
      el("h3", undefined, "Artist names"),
      el("p", "field-hint", "The same artist spelt two ways (such as “AFI” and “A.F.I.”, or with a stray space at the end) lists as two artists everywhere. “Check names with MusicBrainz” asks MusicBrainz how each artist is officially spelt, so the suggestion is the official spelling, not just the commoner one, and a name that is spelt unofficially is listed even when it is the only spelling. Pick the right spelling and every song's Artist and Album artist tags are changed to it. Only tags that are exactly one of the spellings change, so “AFI & Friends” is left alone."),
      namesNote,
      ...(undo ? [undo] : []),
      namesList,
    );
  }

  // ---------------------------------------------------------------- Artist photos
  const photosBlock = el("div", "settings-block");
  const photosNote = el("div");
  const photosActions = el("div", "dialog-actions");
  const replaceBox = el("input");
  replaceBox.type = "checkbox";
  let plan: PhotoPlan | null = null;
  let toWrite: PhotoPlan["matches"] = [];
  let already = 0;
  let working: { stopped: boolean } | null = null;

  let status = "";

  function signedIn(): boolean {
    return savedDesktopSession() !== null;
  }

  /** The reasons Jellyfin could not be used, in words. */
  function jellyfinMessage(error: unknown): string {
    if (error instanceof JellyfinProblem) return error.message;
    return errorText(error);
  }

  async function look(): Promise<void> {
    const session = savedDesktopSession();
    if (!session || working) return;
    working = { stopped: false };
    status = "Asking Jellyfin for its artists…";
    drawPhotos();
    try {
      const jf = desktopJellyfin();
      const server = await jf.albumArtists(session);
      plan = planPhotos(libraryArtists(deps.songs()), server);
      // Artists whose songs already carry an Artist picture are left alone unless asked.
      toWrite = [];
      already = 0;
      for (const [index, match] of plan.matches.entries()) {
        if (working.stopped) break;
        status = `Checking which artists already have a photo: ${index + 1} of ${plan.matches.length}`;
        drawPhotos();
        const first = await invoke<{ from: string } | null>("track_artist_photo", { path: match.artist.paths[0] }).catch(() => null);
        const last = match.artist.paths.length > 1 ? await invoke<{ from: string } | null>("track_artist_photo", { path: match.artist.paths[match.artist.paths.length - 1] }).catch(() => null) : first;
        if (first?.from === "embedded" && last?.from === "embedded") already++;
        else toWrite.push(match);
      }
      status = describePlan(plan, already);
    } catch (error) {
      plan = null;
      status = `Could not read Jellyfin's artists: ${jellyfinMessage(error)}`;
    } finally {
      working = null;
      drawPhotos();
    }
  }

  /** The artist's photo from the server, made to fit a song (a JPEG within 1000 pixels and the size limit). */
  async function fetchPhoto(source: ServerArtist): Promise<string | null> {
    const session = savedDesktopSession();
    if (!session) return null;
    const data = await desktopJellyfin().artistPhoto(session, source, PICTURE_LIMITS.maxSide);
    return data ? fitForSong(blobFromBase64(data, "image/jpeg")) : null;
  }
  function write(mode: RunMode): void {
    if (working || !plan) return;
    const list = replaceBox.checked ? plan.matches : toWrite;
    if (!list.length) return;
    const songs = list.reduce((sum, m) => sum + m.artist.paths.length, 0);
    if (!confirm(`Write the Jellyfin photo of ${plural(list.length, "artist")} into ${plural(songs, "song")} as their Artist picture?\n\nOnly the tags of those songs change (the music is untouched, and each file is checked before it replaces the old one). You can undo this.`)) return;
    const id = `artistphotos-${Date.now()}`;
    let done = 0;
    let songsDone = 0;
    const problems: Problem[] = [];
    const skipped: string[] = [];
    status = "";
    void startRun({
      title: "Writing artist photos from Jellyfin",
      unit: "songs",
      mode,
      items: list.map((match, index) => ({ match, batch: `${id}-${index}` })),
      size: ({ match }) => match.artist.paths.length,
      label: ({ match }) => match.artist.name,
      step: async ({ match, batch }, tools) => {
        const photo = await fetchPhoto(match.source);
        if (!photo) {
          skipped.push(match.artist.name);
          return "ok";
        }
        deps.stopIfPlaying(match.artist.paths);
        history.add(id, "Jellyfin artist photos", batch);
        let ok = 0;
        for (const paths of chunk(match.artist.paths, PATHS_PER_CALL)) {
          if (tools.stopped()) break;
          const reply = await invoke<{ results: Array<{ path: string; ok: boolean; error?: string }> }>("update_track_media", picturesRequest(paths, [{ kind: "artist_photo", base64: photo }], [], batch));
          for (const result of reply.results) {
            if (result.ok) ok++;
            else problems.push({ path: result.path, message: result.error ?? "it failed" });
          }
          tools.advance(paths.length);
        }
        songsDone += ok;
        if (ok) done++;
        return ok === 0 && !tools.stopped() ? "failed" : "ok";
      },
    }).then((result) => {
      if (!result) return;
      const text = `Wrote ${plural(done, "artist photo")} into ${plural(songsDone, "song")}. ${describeEnd(result, plural(result.left, "artist"))}${skipped.length ? ` No usable picture for ${skipped.slice(0, 5).join(", ")}${skipped.length > 5 ? "…" : ""}.` : ""}`;
      photosNote.replaceChildren(report(text, problems));
      if (songsDone) deps.changed("Artist photos were saved.");
      plan = null; // look again: what is already written is skipped
      drawPhotos();
    });
  }
  function drawPhotos(): void {
    photosActions.replaceChildren();
    const message = el("p", "field-hint", status);
    message.setAttribute("role", "status");
    const parts: HTMLElement[] = [
      el("h3", undefined, "Artist photos"),
      el("p", "field-hint", "Jellyfin finds a photo for most artists (from TheAudioDB and MusicBrainz) but keeps it in its own database, not in your music folders or the songs. This writes those photos into your songs as the Artist picture, so they show on the artist's stack in the library here, and travel with the files to the phone, the TV and any other player that reads them."),
    ];
    if (!signedIn()) {
      parts.push(el("p", undefined, "Sign this computer in to your Jellyfin server first: Settings › Jellyfin › Shared problem tracks."));
    } else {
      if (working) {
        const stop = button("Stop");
        stop.addEventListener("click", () => {
          if (working) working.stopped = true;
        });
        photosActions.append(stop);
      } else {
        const looking = button(plan ? "Look again" : "Look on Jellyfin", plan ? "secondary" : "");
        looking.addEventListener("click", () => void look());
        photosActions.append(looking);
        if (plan && (toWrite.length || (replaceBox.checked && plan.matches.length))) {
          const count = replaceBox.checked ? plan.matches.length : toWrite.length;
          photosActions.append(modeButtons(`Write ${plural(count, "photo")} into the songs:`, (mode) => write(mode)));
        }
      }
      const label = el("label", "artist-replace");
      label.append(replaceBox, el("span", undefined, " Replace photos the songs already have"));
      replaceBox.onchange = () => drawPhotos();
      parts.push(message, photosActions, label, photosNote);
      if (plan?.notOnServer.length) {
        const names = plan.notOnServer.slice(0, 12).map((a) => a.name).join(", ");
        parts.push(el("p", "field-hint", `Not on the server: ${names}${plan.notOnServer.length > 12 ? `, and ${plan.notOnServer.length - 12} more` : ""}. If the server spells one differently, fix the spelling above first.`));
      }
    }
    photosBlock.replaceChildren(...parts);
  }

  const wiki = initWikiPhotos({ songs: deps.songs, changed: deps.changed, stopIfPlaying: deps.stopIfPlaying, undo: true });
  onRunChange(() => {
    wiki.redraw();
    drawPhotos();
  });
  root.replaceChildren(namesBlock, wiki.element, photosBlock);

  return {
    show: () => {
      void loadCanonical();
      drawNames();
      drawPhotos();
      wiki.show();
    },
    /** The library changed in the background (the folder watcher finished a scan): redraw the names if the panel is on screen. */
    refresh: () => {
      if (root.isConnected && !root.closest("[hidden]")) drawNames();
    },
  };
}
