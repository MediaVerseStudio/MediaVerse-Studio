// The "Artwork" dialog for a whole album or one track (the lyrics have their own editor, with playback and timing: lyrics-review.ts). Three squares, front cover, back cover and
// artist photo, show the pictures the songs already have with their size in pixels; each takes a pasted, dropped
// or chosen replacement, can be deleted, shrunk to 1000 pixels or cropped to a square. Changes wait until Save.
// The front cover can also be looked for online: MusicBrainz first, then the album's page on Discogs, then a web
// image search in the person's browser (owner, 2026-11-05).
// Edits go to the sidecar, which only touches MP3 files inside the music library.
// All text is set with textContent; nothing from the files is inserted as HTML.

import { forgetCovers } from "./cover-art";
import { runJob } from "./jobs";
import { invoke, openExternal } from "./desktop-bridge";
import { blobFromBase64 } from "./cover-util";
import type { MediaChange } from "./review-data";
import { describeError, toApiError } from "./drive-format";
import { imageSize, nativeCopy, prepareImage, type PreparedImage } from "./image-prep";
import { PICTURE_KIND_LABELS, PICTURE_LIMITS, type FileResult, type PictureKindName, describeSize, picturesRequest, summarizeEdit, wantsFolderCopy, webSearchUrl } from "./media-request";

export type MediaTarget = {
  label: string;
  paths: string[];
  song?: { title: string; artist: string | null; album: string | null; length_ms?: number | null };
  /** The album to search for when finding a cover online (defaults to the song's album). */
  albumSearch?: { artist: string | null; album: string | null; year?: number | null; tracks?: number };
};

/** What was saved, so the pages showing gaps can update without reading the library again. */
export type MediaSaved = { paths: string[] } & MediaChange;

type ArtCandidate = { release_id: string; release_group_id?: string; title: string; artist: string; date: string; country: string; preview_mime?: string; preview_base64?: string; matched_by_title_only?: boolean; match?: number; image_url?: string; source?: string };
type ArtSearch = { candidates: ArtCandidate[]; best_match: number; sure_match: number; discogs: { url: string; title: string; year: string | number | null } | null; problems: { source: string; message: string }[] };
type StoredPicture = { mime: string; data_base64: string; from: "embedded" | "folder"; tracks: number };
type FolderSize = { width: number; height: number } | null;
type PicturesReply = { total: number; folder?: Record<PictureKindName, FolderSize> } & Record<PictureKindName, StoredPicture | null>;

/** One square: what the songs have now, and the change waiting for Save (a new picture, or removal). */
type Slot = {
  kind: PictureKindName;
  current: { blob: Blob; url: string; width: number; height: number; from: "embedded" | "folder"; tracks: number } | null;
  /** `origin`: a new picture, or the one the songs or the folder already have (shrunk, cropped or put in the songs). */
  pending: { blob: Blob; prepared: PreparedImage; width: number; height: number; square: boolean; origin: "new" | "embedded" | "folder" } | "remove" | null;
};

const KINDS: PictureKindName[] = ["front_cover", "back_cover", "artist_photo"];
const BROWSER_OK = "mediaverse.allow-browser-search";

export function initMediaDialog(dialog: HTMLDialogElement, hooks: { beforeEdit: (paths: string[]) => void; afterEdit: (saved: MediaSaved) => void }): { open: (target: MediaTarget) => void } {
  const q = <T extends HTMLElement>(selector: string): T => dialog.querySelector<T>(selector)!;
  const title = q("#media-title");
  const subtitle = q("#media-subtitle");
  const slotsBox = q("#media-slots");
  const fileInput = q<HTMLInputElement>("#media-file");
  const saveButton = q<HTMLButtonElement>("#media-save-pictures");
  const discardButton = q<HTMLButtonElement>("#media-discard-pictures");
  const statusLine = q("#media-status");
  const findArtBox = q("#media-find-art-box");
  const findArtButton = q<HTMLButtonElement>("#media-find-art");
  const webSearchButton = q<HTMLButtonElement>("#media-web-search");
  const findArtNote = q("#media-find-art-note");
  const artResults = q("#media-art-results");
  const findArtHint = findArtNote.textContent ?? "";

  let target: MediaTarget = { label: "", paths: [] };
  let slots: Slot[] = [];
  let total = 0;
  let chooseFor: PictureKindName = "front_cover";
  let loadToken = 0;
  let exiting = false;
  /** While a save is under way Save & Close is greyed out; it must come back afterwards, also for the next album. */
  let saving = false;
  let folderSizes: Record<PictureKindName, FolderSize> | null = null;

  const say = (message: string, problem = false): void => {
    statusLine.textContent = message;
    statusLine.className = problem ? "result-warning" : "";
  };
  const slotOf = (kind: PictureKindName): Slot => slots.find((s) => s.kind === kind)!;
  const hasChanges = (): boolean => slots.some((s) => s.pending !== null);

  function forgetUrls(): void {
    for (const slot of slots) {
      if (slot.current) URL.revokeObjectURL(slot.current.url);
      if (slot.pending && slot.pending !== "remove") URL.revokeObjectURL(slot.pending.prepared.previewUrl);
    }
  }

  // ---- The three squares ----
  function renderSlots(): void {
    slotsBox.replaceChildren();
    for (const slot of slots) {
      const box = document.createElement("div");
      box.className = "picture-slot";
      box.tabIndex = 0;
      box.dataset.kind = slot.kind;
      box.setAttribute("aria-label", `${PICTURE_KIND_LABELS[slot.kind]}: click, then press Ctrl+V to paste a picture`);
      const frame = document.createElement("div");
      frame.className = "slot-image";
      const shown = slot.pending === "remove" ? null : slot.pending ?? slot.current;
      const url = slot.pending && slot.pending !== "remove" ? slot.pending.prepared.previewUrl : slot.current?.url;
      if (shown && url) {
        const image = document.createElement("img");
        image.alt = PICTURE_KIND_LABELS[slot.kind];
        image.src = url;
        frame.append(image);
      } else {
        frame.textContent = slot.pending === "remove" ? "Will be removed" : "Paste or drop a picture here";
        frame.classList.add("is-empty");
      }
      if (slot.pending) box.classList.add("is-changed");
      const name = document.createElement("strong");
      name.textContent = PICTURE_KIND_LABELS[slot.kind];
      const size = document.createElement("span");
      size.className = "slot-size";
      if (slot.pending === "remove") size.textContent = "Not saved yet";
      else if (slot.pending) size.textContent = `${slot.pending.prepared.width} × ${slot.pending.prepared.height} · not saved yet`;
      else if (slot.current) {
        const where = slot.current.from === "folder" ? "cover file in the folder" : total > 1 ? `on ${slot.current.tracks} of ${total} songs` : "";
        size.textContent = [describeSize(slot.current.width, slot.current.height), where].filter(Boolean).join(" · ");
      } else size.textContent = "None";
      const actions = document.createElement("div");
      actions.className = "slot-actions";
      const action = (label: string, run: () => void, hint?: string): void => {
        const button = document.createElement("button");
        button.type = "button";
        button.className = "secondary";
        button.textContent = label;
        if (hint) button.title = hint;
        button.addEventListener("click", (event) => {
          event.stopPropagation();
          run();
        });
        actions.append(button);
      };
      action("Choose…", () => {
        chooseFor = slot.kind;
        fileInput.value = "";
        fileInput.click();
      });
      // The picture now shown, as the source for shrinking or cropping.
      const source = slot.pending && slot.pending !== "remove" ? slot.pending : slot.current ? { blob: slot.current.blob, width: slot.current.width, height: slot.current.height } : null;
      const origin = slot.pending && slot.pending !== "remove" ? slot.pending.origin : slot.current?.from === "folder" ? "folder" : "embedded";
      if (slot.pending === null && slot.current?.from === "folder") {
        action("Put in the songs", () => void take(slot.kind, slot.current!.blob, false, "folder"), "Store this cover inside the songs too (at most 1000 × 1000); the file in the folder stays as it is");
      } else if (source && slot.pending === null && Math.max(source.width, source.height) > PICTURE_LIMITS.maxSide) {
        action("Shrink to 1000", () => void take(slot.kind, source.blob, false, "embedded"), "Make the copy in the songs fit 1000 × 1000 pixels; the full size is kept in the album folder");
      }
      const cropped = slot.pending && slot.pending !== "remove" && slot.pending.square;
      if (source && source.width !== source.height && !cropped) {
        action("Crop to square", () => void take(slot.kind, slot.pending && slot.pending !== "remove" ? slot.pending.blob : source.blob, true, origin), "Keep the centred square");
      }
      if (slot.pending) action("Undo", () => setPending(slot, null));
      else if (slot.current?.from === "embedded") action("Delete", () => setPending(slot, "remove"));
      box.append(frame, name, size, actions);
      box.addEventListener("click", () => box.focus());
      box.addEventListener("dragover", (event) => event.preventDefault());
      box.addEventListener("drop", (event) => {
        event.preventDefault();
        void take(slot.kind, [...(event.dataTransfer?.files ?? [])].find((f) => f.type.startsWith("image/")));
      });
      slotsBox.append(box);
    }
    // Save & Close and Undo and Exit are always there: with no changes, both simply close.
    saveButton.textContent = hasChanges() ? "Save & Close" : "Close";
    saveButton.disabled = saving;
    discardButton.hidden = !hasChanges();
  }

  function setPending(slot: Slot, pending: Slot["pending"]): void {
    if (slot.pending && slot.pending !== "remove") URL.revokeObjectURL(slot.pending.prepared.previewUrl);
    slot.pending = pending;
    renderSlots();
  }

  /** A new picture for one square: shrunk to 1000 pixels (and cropped when asked), waiting for Save. */
  async function take(kind: PictureKindName, source: Blob | null | undefined, square = false, origin: "new" | "embedded" | "folder" = "new"): Promise<boolean> {
    if (!source) return false;
    say("Preparing the picture…");
    try {
      const original = await imageSize(source);
      const prepared = await prepareImage(source, { square });
      setPending(slotOf(kind), { blob: source, prepared, width: original.width, height: original.height, square, origin });
      const shrunk = Math.max(original.width, original.height) > PICTURE_LIMITS.maxSide || square;
      say(`${PICTURE_KIND_LABELS[kind]}: ${prepared.width} × ${prepared.height} pixels${shrunk ? ` (from ${original.width} × ${original.height})` : ""}. Press Save & Close to keep it.`);
      return true;
    } catch (thrown) {
      say(thrown instanceof Error ? thrown.message : "The picture could not be used.", true);
      return false;
    }
  }

  /** Reads the pictures the songs have now into the squares. */
  async function loadPictures(): Promise<void> {
    const token = ++loadToken;
    forgetUrls();
    slots = KINDS.map((kind) => ({ kind, current: null, pending: null }));
    total = target.paths.length;
    renderSlots();
    if (target.paths.length === 0) return;
    try {
      const reply = await invoke<PicturesReply>("album_pictures", { paths: target.paths });
      if (token !== loadToken) return;
      total = reply.total;
      folderSizes = reply.folder ?? null;
      for (const slot of slots) {
        const stored = reply[slot.kind];
        if (!stored) continue;
        const blob = blobFromBase64(stored.data_base64, stored.mime);
        const size = await imageSize(blob).catch(() => ({ width: 0, height: 0 }));
        if (token !== loadToken) return;
        slot.current = { blob, url: URL.createObjectURL(blob), width: size.width, height: size.height, from: stored.from, tracks: stored.tracks };
      }
      renderSlots();
    } catch (thrown) {
      say(describeError(toApiError(thrown)), true);
    }
  }

  async function savePictures(): Promise<boolean> {
    const changes = slots.filter((s) => s.pending !== null).map((s) => ({ kind: s.kind, base64: s.pending === "remove" ? null : s.pending!.prepared.base64 }));
    if (changes.length === 0) return true;
    hooks.beforeEdit(target.paths);
    saving = true;
    saveButton.disabled = true;
    say("Saving…");
    try {
      // The full-size picture for the album folder (owner, 2026-11-05), when it is not already there.
      const folder: { kind: PictureKindName; base64: string }[] = [];
      for (const slot of slots) {
        const pending = slot.pending;
        if (!pending || pending === "remove") continue;
        if (!wantsFolderCopy(pending.origin, Math.min(pending.width, pending.height), folderSizes?.[slot.kind] ?? null)) continue;
        folder.push({ kind: slot.kind, base64: (await nativeCopy(pending.blob, pending.square)).base64 });
      }
      const reply = await invoke<{ results: FileResult[]; folder?: { kind: string; ok: boolean; error?: string }[] }>("update_track_media", picturesRequest(target.paths, changes, folder));
      const summary = summarizeEdit(reply.results, changes.length === 1 ? `The ${PICTURE_KIND_LABELS[changes[0].kind].toLowerCase()}` : "The pictures");
      const folderProblem = reply.folder?.find((f) => !f.ok);
      if (folderProblem) summary.message += ` The full-size copy for the album folder was not saved: ${folderProblem.error ?? "it failed"}.`;
      else if (folder.length) summary.message += " The full-size picture is in the album folder.";
      const frontPending = slotOf("front_cover").pending;
      const fixedKinds = slots.filter((s) => s.pending !== null).map((s) => s.kind);
      forgetCovers();
      await loadPictures();
      say(summary.message, !summary.ok);
      const front = slotOf("front_cover").current;
      const coverSize: [number, number] | null =
        frontPending && frontPending !== "remove"
          ? frontPending.square
            ? [Math.min(frontPending.width, frontPending.height), Math.min(frontPending.width, frontPending.height)]
            : [frontPending.width, frontPending.height]
          : front
            ? [front.width, front.height]
            : null;
      hooks.afterEdit({ paths: target.paths, frontCover: !!front, coverSize, fixedKinds: summary.ok ? fixedKinds : [] });
      return summary.ok;
    } catch (thrown) {
      say(describeError(toApiError(thrown)), true);
      return false;
    } finally {
      saving = false;
      renderSlots();
    }
  }

  // Ctrl+V anywhere in the dialog (except a text box) goes to the square that has focus, else the front cover.
  dialog.addEventListener("paste", (event) => {
    if (event.target instanceof HTMLTextAreaElement || event.target instanceof HTMLInputElement) return;
    const item = [...(event.clipboardData?.items ?? [])].find((i) => i.type.startsWith("image/"));
    if (!item) {
      say("There is no picture on the clipboard. Copy an image first (in a browser: right-click it, Copy image).", true);
      return;
    }
    event.preventDefault();
    const focused = (document.activeElement as HTMLElement | null)?.closest<HTMLElement>(".picture-slot")?.dataset.kind as PictureKindName | undefined;
    void take(focused ?? "front_cover", item.getAsFile());
  });
  fileInput.addEventListener("change", () => void take(chooseFor, fileInput.files?.[0]));
  // Owner, 2026-11-05: "Save & Close" and, to its left, "Undo and Exit", at the bottom where Close was.
  saveButton.addEventListener("click", async () => {
    if (await savePictures()) {
      exiting = true;
      dialog.close();
    }
  });
  discardButton.addEventListener("click", () => {
    for (const slot of slots) if (slot.pending && slot.pending !== "remove") URL.revokeObjectURL(slot.pending.prepared.previewUrl);
    for (const slot of slots) slot.pending = null;
    exiting = true;
    dialog.close();
  });

  // Escape: like Undo and Exit, but asks first when there are changes.
  dialog.addEventListener("cancel", (event) => {
    if (!exiting && hasChanges() && !window.confirm("Close without saving the picture changes?")) event.preventDefault();
  });

  // ---- Finding the front cover online ----
  const albumToSearch = (): { artist: string | null; album: string; year: number | null; tracks?: number } | null => {
    const wanted = target.albumSearch ?? (target.song ? { artist: target.song.artist, album: target.song.album } : null);
    return wanted?.album ? { artist: wanted.artist, album: wanted.album, year: wanted.year ?? null, tracks: wanted.tracks } : null;
  };

  /** Opens the web image search in the person's browser, after their one-time permission. */
  async function searchTheWeb(): Promise<void> {
    const wanted = albumToSearch();
    if (!wanted) return;
    let allowed = false;
    try {
      allowed = localStorage.getItem(BROWSER_OK) === "1";
    } catch {
      // storage unavailable: ask every time
    }
    if (!allowed) {
      if (!window.confirm("Open your web browser with an image search for this album's artwork?\n\nOnly the artist, album and year are searched for. You will not be asked again.")) return;
      try {
        localStorage.setItem(BROWSER_OK, "1");
      } catch {
        // asked again next time
      }
    }
    const opened = await openExternal(webSearchUrl(wanted.album, wanted.artist, wanted.year));
    if (opened) say("Your browser shows the search. Right-click a cover there, choose Copy image, then click the Front cover square here and press Ctrl+V.");
    else say("The browser could not be opened.", true);
  }
  webSearchButton.addEventListener("click", () => void searchTheWeb());

  /** Fetches a found release's front cover full size into the Front cover square, and its back cover into the
   * Back cover square when the cover database has one; Save & Close keeps them. */
  async function useCandidate(candidate: ArtCandidate): Promise<void> {
    say("Fetching the full-size cover…");
    try {
      type Art = { mime: string; data_base64: string };
      const full = await runJob<Art & { back?: Art | null }>("fetch_album_art", {
        release_id: candidate.release_id,
        release_group_id: candidate.release_group_id,
        image_url: candidate.image_url,
      });
      const front = await take("front_cover", blobFromBase64(full.data_base64, full.mime));
      const back = full.back ? await take("back_cover", blobFromBase64(full.back.data_base64, full.back.mime)) : false;
      if (front) {
        say(`${back ? "The front and back covers are" : "The front cover is"} in the squares above${full.back ? "" : " (the cover database has no back cover for this release)"}. Press Save & Close to keep ${back ? "them" : "it"}.`);
        slotsBox.scrollIntoView({ block: "nearest", behavior: "smooth" });
      }
    } catch (thrown) {
      say(describeError(toApiError(thrown)), true);
    }
  }

  findArtButton.addEventListener("click", async () => {
    const wanted = albumToSearch();
    if (!wanted) return;
    findArtButton.disabled = true;
    for (const img of artResults.querySelectorAll("img")) URL.revokeObjectURL(img.src);
    artResults.replaceChildren();
    findArtNote.textContent = `Looking for “${wanted.album}”${wanted.artist ? ` by ${wanted.artist}` : ""}… (a few seconds: the cover server is asked one cover a second)`;
    try {
      const found = await runJob<ArtSearch>("find_album_art", { artist: wanted.artist ?? "", album: wanted.album, year: wanted.year ?? undefined, tracks: wanted.tracks, paths: target.paths });
      const sure = found.candidates.length > 0 && found.best_match >= found.sure_match;
      const notes: string[] = [];
      for (const problem of found.problems) notes.push(`${problem.source}: ${problem.message}`);
      if (sure) notes.push(`Best match: ${found.best_match}%. Approve it, or choose another.`);
      else if (found.candidates.length > 0) notes.push(`No sure match (the best is ${found.best_match}%). Check the covers below${found.discogs ? ", the album's page on Discogs" : ""} or search the web.`);
      else notes.push(`No cover was found${found.problems.length ? " in time" : " on MusicBrainz"}.`);
      findArtNote.textContent = notes.join(" ");
      for (const [index, candidate] of found.candidates.entries()) {
        if (!candidate.preview_base64 || !candidate.preview_mime) continue;
        const card = document.createElement("div");
        card.className = "art-choice";
        const image = document.createElement("img");
        image.alt = "";
        image.src = URL.createObjectURL(blobFromBase64(candidate.preview_base64, candidate.preview_mime));
        const caption = document.createElement("span");
        caption.textContent = [`${candidate.match ?? 0}% match`, candidate.title, candidate.artist, candidate.date.slice(0, 4), candidate.country].filter(Boolean).join(" · ");
        const use = document.createElement("button");
        use.type = "button";
        const approve = sure && index === 0;
        use.className = approve ? "" : "secondary";
        use.textContent = approve ? "Approve" : "Use this";
        use.addEventListener("click", () => void useCandidate(candidate));
        card.append(image, caption, use);
        artResults.append(card);
      }
      if (!sure && found.discogs) {
        const card = document.createElement("div");
        card.className = "art-choice art-link";
        const what = document.createElement("span");
        what.textContent = [found.discogs.title, found.discogs.year ? String(found.discogs.year) : ""].filter(Boolean).join(" · ");
        const open = document.createElement("button");
        open.type = "button";
        open.className = "secondary";
        open.textContent = "Open on Discogs";
        open.addEventListener("click", () => {
          void openExternal(found.discogs!.url);
          say("Discogs is open in your browser. Copy the cover there (right-click, Copy image), then paste it into the Front cover square.");
        });
        const credit = document.createElement("a");
        credit.href = found.discogs.url;
        credit.textContent = "Data provided by Discogs";
        credit.addEventListener("click", (event) => {
          event.preventDefault();
          void openExternal(found.discogs!.url);
        });
        card.append(what, open, credit);
        artResults.append(card);
      }
      // A service that did not answer in time, or nothing found anywhere: straight to the web search.
      if (!sure && (found.problems.length > 0 || (found.candidates.length === 0 && !found.discogs))) await searchTheWeb();
    } catch (thrown) {
      findArtNote.textContent = `${describeError(toApiError(thrown))} Trying a web search instead.`;
      await searchTheWeb();
    } finally {
      findArtButton.disabled = false;
    }
  });

  return {
    open(next) {
      target = next;
      // Owner, 2026-11-05: the album, its artist and year at the top, not "Artwork: the album …".
      const album = next.albumSearch;
      title.textContent = next.song?.title ?? album?.album ?? next.label;
      subtitle.textContent = next.song
        ? [next.song.artist, next.song.album].filter(Boolean).join(" · ")
        : [album?.artist, album?.year ? String(album.year) : null, `${next.paths.length} song${next.paths.length === 1 ? "" : "s"}`].filter(Boolean).join(" · ");
      say("");
      for (const img of artResults.querySelectorAll("img")) URL.revokeObjectURL(img.src);
      artResults.replaceChildren();
      findArtNote.textContent = findArtHint;
      findArtBox.hidden = albumToSearch() === null;
      exiting = false;
      void loadPictures();
      dialog.showModal();
      slotsBox.querySelector<HTMLElement>(".picture-slot")?.focus();
    },
  };
}
