// Tracks flagged for review: the list held by the page, the dialog used to flag the current track
// while listening, and the Review page. All text is set with textContent.

import { invoke } from "./desktop-bridge";
import { describeError, toApiError } from "./drive-format";
import { el } from "./dom";
import { isServerSong } from "./library-mode";
import { FLAG_REASONS, type Flag, FlagIndex, type FlagReason, describeFlag, flagRequest, sortFlags } from "./flag-format";
import type { PlayableTrack } from "./play-queue";

export type FlagStore = {
  index: FlagIndex;
  reload: () => Promise<void>;
  onChange: (listener: () => void) => void;
  /** Called with the flag after it was removed here (Done, or unflagged), for the shared problem list (D96). */
  onRemoved: (listener: (flag: Flag) => void) => void;
  set: (request: Record<string, unknown>) => Promise<void>;
  remove: (path: string) => Promise<void>;
};

export function createFlagStore(): FlagStore {
  const index = new FlagIndex();
  const listeners: (() => void)[] = [];
  const removedListeners: ((flag: Flag) => void)[] = [];
  const apply = (reply: { flags: Flag[] }): void => {
    index.replace(reply.flags);
    for (const listener of listeners) listener();
  };
  return {
    index,
    reload: async () => apply(await invoke<{ flags: Flag[] }>("list_flags")),
    onChange: (listener) => listeners.push(listener),
    set: async (request) => apply(await invoke<{ flags: Flag[] }>("set_flag", request)),
    onRemoved: (listener) => removedListeners.push(listener),
    remove: async (path) => {
      const before = index.get(path);
      apply(await invoke<{ flags: Flag[] }>("set_flag", { path, flagged: false }));
      if (before) for (const listener of removedListeners) listener(before);
    },
  };
}

/** The dialog for flagging the track that is playing, remembering where in the song the user was. */
export function initFlagDialog(dialog: HTMLDialogElement, store: FlagStore): { open: (track: PlayableTrack, seconds: number) => void } {
  const heading = dialog.querySelector<HTMLElement>("#flag-title")!;
  const reasonsBox = dialog.querySelector<HTMLElement>("#flag-reasons")!;
  const note = dialog.querySelector<HTMLTextAreaElement>("#flag-note")!;
  const status = dialog.querySelector<HTMLElement>("#flag-status")!;
  const save = dialog.querySelector<HTMLButtonElement>("#flag-save")!;
  const remove = dialog.querySelector<HTMLButtonElement>("#flag-remove")!;
  const cancel = dialog.querySelector<HTMLButtonElement>("#flag-cancel")!;
  let track: PlayableTrack | null = null;
  let seconds = 0;

  for (const reason of FLAG_REASONS) {
    const label = el("label", "check");
    const box = el("input");
    box.type = "checkbox";
    box.value = reason.value;
    label.append(box, el("span", undefined, reason.label));
    reasonsBox.append(label);
  }
  const chosen = (): FlagReason[] => [...reasonsBox.querySelectorAll<HTMLInputElement>("input:checked")].map((b) => b.value as FlagReason);

  save.addEventListener("click", () => {
    if (!track) return;
    status.textContent = "Saving…";
    store.set(flagRequest(track, chosen(), note.value, seconds)).then(
      () => dialog.close(),
      (thrown) => (status.textContent = describeError(toApiError(thrown))),
    );
  });
  remove.addEventListener("click", () => {
    if (!track) return;
    store.remove(track.source_uri).then(
      () => dialog.close(),
      (thrown) => (status.textContent = describeError(toApiError(thrown))),
    );
  });
  cancel.addEventListener("click", () => dialog.close());

  return {
    open(next, at) {
      track = next;
      seconds = at;
      const existing = store.index.get(next.source_uri);
      heading.textContent = `Flag for review: ${next.title}`;
      for (const box of reasonsBox.querySelectorAll<HTMLInputElement>("input")) box.checked = existing?.reasons.includes(box.value as FlagReason) ?? false;
      note.value = existing?.note ?? "";
      status.textContent = existing ? "This track is already flagged; saving updates it." : "";
      remove.hidden = !existing;
      dialog.showModal();
      note.focus();
    },
  };
}

export type ReviewActions = {
  play: (track: PlayableTrack, seconds: number) => void;
  scan: (track: PlayableTrack) => void;
  /** Scan the ticked tracks together. */
  scanMany: (tracks: PlayableTrack[]) => void;
  /** The lyrics editor, with playback and timing. */
  lyrics: (track: PlayableTrack) => void;
  /** The artwork window (pictures only). */
  artwork: (track: PlayableTrack) => void;
};

/** The Review page: every flagged track, newest first, with the actions that help repair it. */
export function initReviewPage(root: HTMLElement, store: FlagStore, actions: ReviewActions): { render: () => void } {
  const list = root.querySelector<HTMLElement>("#review-list")!;
  const count = root.querySelector<HTMLElement>("#review-count")!;
  const ticked = new Set<string>();

  function render(): void {
    const flags = sortFlags(store.index.all());
    for (const path of [...ticked]) if (!flags.some((f) => f.path === path)) ticked.delete(path);
    count.textContent = `${flags.length} track${flags.length === 1 ? "" : "s"} flagged`;
    list.replaceChildren();
    // Only songs with a file can be scanned (not the Jellyfin server's, D173).
    const scannable = flags.filter((f) => !isServerSong(f.path));
    if (scannable.length > 0) {
      const bar = el("div", "row-actions");
      const scanTicked = el("button", undefined, `Scan ${ticked.size} ticked for audio defects`);
      scanTicked.type = "button";
      scanTicked.disabled = ticked.size === 0;
      scanTicked.addEventListener("click", () =>
        actions.scanMany(flags.filter((f) => ticked.has(f.path)).map((f) => ({ title: f.title ?? f.path, artist: f.artist, source_uri: f.path, album: f.album }))),
      );
      const all = el("button", "secondary", ticked.size === scannable.length ? "Untick all" : "Tick all");
      all.type = "button";
      all.addEventListener("click", () => {
        if (ticked.size === scannable.length) ticked.clear();
        else for (const f of scannable) ticked.add(f.path);
        render();
      });
      bar.append(all, scanTicked);
      list.append(bar);
    }
    if (flags.length === 0) {
      list.append(el("p", "empty-note", "Nothing is flagged. While a song plays, use the Flag button in the player to mark it for later."));
      return;
    }
    for (const flag of flags) {
      const track: PlayableTrack = { title: flag.title ?? flag.path, artist: flag.artist, source_uri: flag.path, album: flag.album };
      const card = el("article", "review-card");
      const pickLabel = el("label", "check");
      const pick = el("input");
      pick.type = "checkbox";
      pick.checked = ticked.has(flag.path);
      pick.addEventListener("change", () => {
        if (pick.checked) ticked.add(flag.path);
        else ticked.delete(flag.path);
        render();
      });
      pickLabel.append(pick, el("span", undefined, "Tick to scan for audio defects"));
      card.append(el("h3", undefined, `${flag.title ?? flag.path}${flag.artist ? ` — ${flag.artist}` : ""}`));
      if (!isServerSong(flag.path)) card.append(pickLabel); // a song of the Jellyfin server has no file to scan (D173)
      card.append(el("p", undefined, describeFlag(flag)));
      if (flag.note) card.append(el("p", "field-hint", flag.note));
      const buttons = el("div", "dialog-actions");
      const button = (label: string, run: () => void, secondary = true): void => {
        const b = el("button", secondary ? "secondary" : undefined, label);
        b.type = "button";
        b.addEventListener("click", run);
        buttons.append(b);
      };
      button(flag.position_ms !== null ? "▶ Listen where it was noticed" : "▶ Play", () => actions.play(track, Math.max(0, (flag.position_ms ?? 0) / 1000 - 3)), false);
      if (!isServerSong(flag.path)) button("Scan for defects…", () => actions.scan(track));
      if (/\.mp3$/i.test(flag.path)) {
        button("Lyrics…", () => actions.lyrics(track));
        button("Artwork…", () => actions.artwork(track));
      }
      button("Done: remove flag", () => void store.remove(flag.path).catch(() => {}));
      card.append(buttons);
      if (flag.reasons.includes("audio")) {
        card.append(el("p", "field-hint", "Re-ripping this track from the disc with extra error correction is planned; it will need the original CD."));
      }
      list.append(card);
    }
  }

  store.onChange(render);
  return { render };
}
