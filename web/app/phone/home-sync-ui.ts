// The phone's "Home server" screens and the round that keeps chosen music in step with the home Jellyfin server (owner, 2026-11-23, D177): choose artists, albums or
// playlists (or everything) to keep, press Sync now (or let it happen when the phone is home on Wi-Fi), and the music is fetched into the phone's Music folder, edits made on
// the server come down, songs no longer chosen go, flags and playlists are kept in step both ways, and playback is always from the phone's own files. The rules are in
// home-sync.ts and phone-playlist-sync.ts (tested); this file is the screens and the talking to the app.

import { el } from "../src/dom.ts";
import { authHeader, JellyfinProblem, type Jellyfin, type ServerAlbum, type Session } from "./jellyfin-phone.ts";
import { choiceKey, choiceLabel, cleanManifest, describeOutcome, emptyManifest, runHomeSync, sizeText, useServerVersions, type Choice, type Manifest, type SyncIo, type SyncSong } from "./home-sync.ts";
import { findAdoptions, type LocalSong } from "./adopt.ts";
import { describePlaylistReport, syncPhonePlaylists, type PhonePlaylistState } from "./phone-playlist-sync.ts";
import { isInbox, MASTER_NAME, type Flag } from "./flags.ts";
import type { Bridge, FromApp, PhoneTrack } from "./native.ts";
import type { PhonePlaylist } from "./phone-playlists.ts";

const CHOICES = "mediaverse.phone.home-choices";
const MANIFEST = "mediaverse.phone.home-manifest";
const AUTO = "mediaverse.phone.home-auto";
const PLAYLIST_STATE = "mediaverse.phone.home-playlists";
const LAST = "mediaverse.phone.home-last";
const GUESTS = "mediaverse.phone.home-guest-artists";
/** A round on its own (the app coming to the front, the phone getting Wi-Fi) is at most this often. */
const AUTO_EVERY_MS = 15 * 60_000;

function read<T>(key: string, fallback: T): T {
  try {
    const text = localStorage.getItem(key);
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
}
function write(key: string, value: unknown): void {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    // kept until the app closes
  }
}

export type PickLevel = "artists" | "albums" | "playlists";

export type HomeSyncDeps = {
  bridge: Bridge;
  jf: Jellyfin;
  deviceId: string;
  deviceLabel: string;
  session: () => Session | null;
  tracks: () => PhoneTrack[];
  libraryLoaded: () => boolean;
  /** Reads the phone's music again and resolves when the page has it. */
  reloadLibrary: () => Promise<void>;
  playlists: () => PhonePlaylist[];
  setPlaylists: (playlists: PhonePlaylist[]) => void;
  flags: () => Flag[];
  setFlags: (flags: Flag[]) => void;
  /** The flag sync (sends new flags, brings back the computer's changes). */
  runFlagSync: () => Promise<void>;
  /** Redraws the page on show (after something changed that it displays). */
  changed: () => void;
  openHome: () => void;
  openPick: (level: PickLevel, artist?: { id: string; name: string }) => void;
  openSettings: () => void;
  confirm: (title: string, yes: string, action: () => void) => void;
  toast: (text: string) => void;
};

export type HomeSync = {
  onNative: (message: FromApp) => void;
  renderHome: (into: HTMLElement) => void;
  renderPick: (into: HTMLElement, level: PickLevel, artist?: { id: string; name: string }) => void;
  /** The line under the settings row: what is kept, or that nothing is. */
  summary: () => string;
  /** Called when the app comes to the front or the phone gets a network: a round when it is due. */
  autoSoon: () => void;
  run: () => Promise<void>;
  running: () => boolean;
};

export function createHomeSync(deps: HomeSyncDeps): HomeSync {
  let choices: Choice[] = (read<unknown[]>(CHOICES, []) as Choice[]).filter((c) => c && typeof c === "object" && ["all", "artist", "appears", "album", "playlist"].includes((c as Choice).kind));
  let manifest: Manifest = cleanManifest(read<unknown>(MANIFEST, null));
  let auto = read<boolean>(AUTO, true);
  let playlistState: PhonePlaylistState = read<PhonePlaylistState>(PLAYLIST_STATE, {});
  let status = read<string>(LAST, "");
  let running = false;
  let cancelled = false;
  let lastRun = 0;
  let statusLine: HTMLElement | null = null;
  let counter = 0;
  const waiting = new Map<string, { resolve: (value: { mediaId: string; bytes: number }) => void; reject: (error: Error) => void; progress: (fraction: number) => void }>();
  const waitingDelete = new Map<string, (ids: string[]) => void>();
  let networkAnswer: ((message: { wifi: boolean; metered: boolean }) => void) | null = null;
  const waitingFingerprint = new Map<string, (same: boolean | null) => void>();
  const waitingWrite = new Map<string, (ok: boolean) => void>();

  const saveChoices = (): void => write(CHOICES, choices);
  const setStatus = (text: string, remember = false): void => {
    status = text;
    if (remember) write(LAST, text);
    if (statusLine?.isConnected) statusLine.textContent = text;
  };
  const chosen = (choice: Choice): boolean => choices.some((c) => choiceKey(c) === choiceKey(choice));

  function toggle(choice: Choice): boolean {
    if (chosen(choice)) choices = choices.filter((c) => choiceKey(c) !== choiceKey(choice));
    else choices = [...choices, choice];
    saveChoices();
    return chosen(choice);
  }

  function onNative(message: FromApp): void {
    if (message.type === "network") {
      networkAnswer?.(message);
      networkAnswer = null;
    } else if (message.type === "downloaded") {
      const w = waiting.get(message.id);
      waiting.delete(message.id);
      if (!w) return;
      if (message.ok && message.mediaId) w.resolve({ mediaId: message.mediaId, bytes: message.bytes ?? 0 });
      else w.reject(new Error(message.error ?? "The song could not be fetched."));
    } else if (message.type === "downloadProgress") {
      const w = waiting.get(message.id);
      if (w && message.total > 0) w.progress(message.bytes / message.total);
    } else if (message.type === "deletedLocal") {
      waitingDelete.get(message.id)?.(message.ids);
      waitingDelete.delete(message.id);
    } else if (message.type === "fingerprint") {
      waitingFingerprint.get(message.id)?.(message.same);
      waitingFingerprint.delete(message.id);
    } else if (message.type === "writeGranted") {
      waitingWrite.get(message.id)?.(message.ok);
      waitingWrite.delete(message.id);
    }
  }

  function askNetwork(): Promise<{ wifi: boolean; metered: boolean }> {
    return new Promise((resolve) => {
      networkAnswer = resolve;
      deps.bridge.send({ type: "network" });
      window.setTimeout(() => {
        if (networkAnswer === resolve) {
          networkAnswer = null;
          resolve({ wifi: true, metered: false }); // the app did not say (a browser): go on and let the server answer
        }
      }, 2_500);
    });
  }

  /** Whether the phone's copy of a song is the same file as the server's, by a fingerprint of the head and tail of both; null when it could not be told. */
  function sameFile(session: Session, song: SyncSong, localId: string): Promise<boolean | null> {
    return new Promise((resolve) => {
      const id = `fp${++counter}`;
      const timer = window.setTimeout(() => {
        if (waitingFingerprint.delete(id)) resolve(null);
      }, 45_000);
      waitingFingerprint.set(id, (same) => (window.clearTimeout(timer), resolve(same)));
      deps.bridge.send({ type: "fingerprint", id, url: `${session.base}/Audio/${song.id}/stream?static=true`, headers: { Authorization: authHeader(deps.deviceId, deps.deviceLabel, session.token) }, localId, size: song.size });
    });
  }

  /** Android's one-time permission to update these songs in place (one prompt per 200 songs); the ids it was given for. */
  async function grantWrite(ids: string[]): Promise<Set<string>> {
    const granted = new Set<string>();
    for (let i = 0; i < ids.length; i += 200) {
      const part = ids.slice(i, i + 200);
      const ok = await new Promise<boolean>((resolve) => {
        const id = `gw${++counter}`;
        waitingWrite.set(id, resolve);
        deps.bridge.send({ type: "grantWrite", id, ids: part });
        window.setTimeout(() => {
          if (waitingWrite.delete(id)) resolve(false);
        }, 5 * 60_000);
      });
      if (ok) for (const id of part) granted.add(id);
    }
    return granted;
  }

  function download(session: Session, song: SyncSong, path: string, replace: string | null, inPlace: boolean, label: (fraction: number) => void): Promise<{ mediaId: string; bytes: number }> {
    return new Promise((resolve, reject) => {
      const id = `dl${++counter}`;
      const timer = window.setTimeout(() => {
        if (waiting.delete(id)) reject(new Error("The song took too long."));
      }, 10 * 60_000);
      waiting.set(id, { resolve: (v) => (window.clearTimeout(timer), resolve(v)), reject: (e) => (window.clearTimeout(timer), reject(e)), progress: label });
      deps.bridge.send({ type: "download", id, url: `${session.base}/Audio/${song.id}/stream?static=true`, headers: { Authorization: authHeader(deps.deviceId, deps.deviceLabel, session.token) }, path, replace, inPlace });
    });
  }

  function removeLocal(ids: string[]): Promise<string[]> {
    return new Promise((resolve) => {
      const id = `rm${++counter}`;
      waitingDelete.set(id, resolve);
      deps.bridge.send({ type: "deleteLocal", id, ids });
      window.setTimeout(() => {
        if (waitingDelete.delete(id)) resolve([]);
      }, 60_000);
    });
  }

  const sourceOf = (choice: Choice): { kind: "all" | "artist" | "appears" | "album" | "playlist"; id?: string } => (choice.kind === "all" ? { kind: "all" } : { kind: choice.kind, id: choice.id });

  async function run(): Promise<void> {
    const session = deps.session();
    if (!session || running) return;
    running = true;
    cancelled = false;
    lastRun = Date.now();
    setStatus("Looking for the home server…");
    deps.changed();
    try {
      const net = await askNetwork();
      if (!net.wifi) {
        setStatus("Not on Wi-Fi. Music is kept in step when the phone is on your home Wi-Fi.", true);
        return;
      }
      if (!(await deps.jf.probe(session.base, 3_000))) {
        setStatus("The home server did not answer. Music is kept in step when the phone is home.", true);
        return;
      }
      let message = "";
      if (choices.length) {
        await deps.reloadLibrary(); // what is really on the phone now (a song the person deleted is fetched again)
        const io: SyncIo = {
          fetchSongs: (choice) => deps.jf.songsFor(session, sourceOf(choice)),
          manifest,
          saveManifest: (m) => {
            manifest = m;
            write(MANIFEST, m);
          },
          present: () => (deps.libraryLoaded() ? new Set(deps.tracks().map((t) => t.id)) : null),
          download: (song, path, replace, inPlace) => download(session, song, path, replace, inPlace, (fraction) => setStatus(`${status.replace(/ \(\d+%\)$/, "")} (${Math.round(fraction * 100)}%)`)),
          grantWrite,
          adopt: async (songs) => {
            // Songs on the phone are matched to the server's by name, album, length and size; those the same size are confirmed by comparing a fingerprint of the file.
            const locals: LocalSong[] = deps.tracks().map((t) => ({ id: t.id, title: t.title, artist: t.artist ?? "", albumArtist: t.album_artist ?? "", album: t.album ?? "", folder: t.cover_key ?? "", file: t.file ?? "", size: t.size ?? 0, durationMs: t.duration_ms }));
            const taken = new Set(Object.values(manifest.files).flatMap((f) => (f.mediaId ? [f.mediaId] : [])));
            const found = findAdoptions(songs, locals, taken);
            let checked = 0;
            for (const pair of found) {
              if (cancelled || checked >= 800) break;
              if (pair.level !== "exact") continue;
              checked += 1;
              setStatus(`Comparing songs already on the phone with the server's (${checked} of ${found.length})`);
              if ((await sameFile(session, pair.song, pair.local.id)) === false) pair.level = "differs";
            }
            return found.map((pair) => ({ song: pair.song, local: pair.local, level: pair.level }));
          },
          removeLocal,
          progress: (text) => setStatus(text),
          cancelled: () => cancelled,
          now: () => Date.now(),
        };
        const outcome = await runHomeSync(choices, io);
        if (Object.keys(outcome.moved).length) {
          // A song fetched again has a new id on the phone: flags and playlists follow it.
          deps.setFlags(deps.flags().map((f) => (outcome.moved[f.id] ? { ...f, id: outcome.moved[f.id]! } : f)));
          deps.setPlaylists(deps.playlists().map((p) => ({ ...p, entries: p.entries.map((e) => (outcome.moved[e.id] ? { ...e, id: outcome.moved[e.id]! } : e)) })));
        }
        message = describeOutcome(outcome);
        if (outcome.downloaded || outcome.updated || outcome.removed) await deps.reloadLibrary();
        if (outcome.cancelled) {
          setStatus(message, true);
          return;
        }
      } else message = "Nothing is chosen to keep yet.";
      setStatus(`${message} Syncing flags and playlists…`);
      await deps.runFlagSync();
      const library = deps.tracks().map((t) => ({ id: t.id, title: t.title, artist: t.artist, album_artist: t.album_artist, album: t.album, duration_ms: t.duration_ms }));
      const result = await syncPhonePlaylists({ client: deps.jf, session, playlists: deps.playlists(), library, manifest, state: playlistState, now: Date.now(), newId: () => `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 5)}` });
      playlistState = result.state;
      write(PLAYLIST_STATE, playlistState);
      deps.setPlaylists(result.playlists);
      const playlistText = describePlaylistReport(result.report);
      setStatus(`${message}${playlistText ? ` ${playlistText}` : ""}`, true);
    } catch (error) {
      if (error instanceof JellyfinProblem && error.kind === "signed_out") setStatus("The server no longer accepts this phone. Sign in again under Settings.", true);
      else if (error instanceof JellyfinProblem && error.kind === "unreachable") setStatus("The server stopped answering. What was done is kept; the rest follows next time.", true);
      else setStatus(error instanceof Error ? error.message : "Syncing did not work.", true);
    } finally {
      running = false;
      deps.changed();
    }
  }

  function autoSoon(): void {
    if (!auto || !choices.length || running || !deps.session() || Date.now() - lastRun < AUTO_EVERY_MS) return;
    lastRun = Date.now();
    window.setTimeout(() => void run(), 4_000);
  }

  const kept = (): { songs: number; bytes: number } => {
    const files = Object.values(manifest.files);
    return { songs: files.length, bytes: files.reduce((sum, f) => sum + f.size, 0) };
  };

  function summary(): string {
    if (!deps.session()) return "Sign in to your Jellyfin server first.";
    if (!choices.length) return "Choose artists, albums or playlists to keep on this phone.";
    const k = kept();
    return `${choices.length} chosen · ${k.songs} song${k.songs === 1 ? "" : "s"} fetched${k.bytes ? ` (${sizeText(k.bytes)})` : ""}`;
  }

  function switchRow(title: string, sub: string, on: boolean, action: () => void): HTMLElement {
    const row = el("button", "switch-row");
    row.type = "button";
    const text = el("span", "row-text");
    text.append(el("span", "row-title", title), el("span", "row-sub", sub));
    row.append(text, el("span", on ? "switch is-on" : "switch"));
    row.setAttribute("role", "switch");
    row.setAttribute("aria-checked", String(on));
    row.addEventListener("click", action);
    return row;
  }

  function linkRow(title: string, sub: string, action: () => void): HTMLElement {
    const row = el("button", "switch-row");
    row.type = "button";
    const text = el("span", "row-text");
    text.append(el("span", "row-title", title), el("span", "row-sub", sub));
    row.append(text, el("span", "chevron", "›"));
    row.addEventListener("click", action);
    return row;
  }

  function renderHome(into: HTMLElement): void {
    const box = el("div", "settings home-sync");
    box.append(el("h2", "section", "Music from your home server"));
    if (!deps.session()) {
      box.append(el("p", "hint", "Keep chosen music from your Jellyfin server on this phone, much as a cloud-storage app keeps chosen folders on a computer. Songs play from the phone's own files, so they work anywhere; when you are home on Wi-Fi, new and edited songs come down and your flags and playlists go up."));
      box.append(el("p", "hint", "Sign in to your Jellyfin server first (Settings, under Jellyfin server)."));
      const go = el("button", "primary", "Open Settings");
      go.type = "button";
      go.addEventListener("click", deps.openSettings);
      box.append(go);
      into.append(box);
      return;
    }
    const session = deps.session()!;
    box.append(el("p", "hint", `Connected to ${session.name}. Chosen music is kept on this phone and played from here; edits made on the server (tags, covers, lyrics) come down at the next sync, and songs you stop keeping are taken off. Playlists and flags are kept in step both ways.`));
    statusLine = el("p", "hint", status || "Ready.");
    statusLine.setAttribute("role", "status");
    const sync = el("button", "primary", running ? "Stop" : "Sync now");
    sync.type = "button";
    sync.addEventListener("click", () => {
      if (running) {
        cancelled = true;
        sync.disabled = true;
        setStatus("Stopping after this song…");
      } else void run();
    });
    box.append(sync, statusLine);
    box.append(switchRow("Sync when I get home", "When the app opens or the phone joins Wi-Fi, at most every 15 minutes. Only on Wi-Fi, only with the home server.", auto, () => {
      auto = !auto;
      write(AUTO, auto);
      deps.changed();
    }));

    box.append(el("h2", "section", "Kept on this phone"));
    if (!choices.length) box.append(el("p", "hint", "Nothing chosen yet."));
    for (const choice of choices) {
      const line = el("div", "device-row");
      const words = el("span", "row-text");
      words.append(el("span", "row-title", choiceLabel(choice)), el("span", "row-sub", subtitle(choice)));
      const remove = el("button", "icon-button");
      remove.type = "button";
      remove.textContent = "✕";
      remove.setAttribute("aria-label", `Stop keeping ${choiceLabel(choice)}`);
      remove.addEventListener("click", () =>
        deps.confirm(`Stop keeping “${choiceLabel(choice)}”? Songs the program fetched are taken off this phone at the next sync; songs you already had on the phone stay (a song another choice keeps stays too).`, "Stop keeping", () => {
          toggle(choice);
          deps.changed();
        }),
      );
      line.append(words, remove);
      box.append(line);
    }
    const k = kept();
    const mine = Object.values(manifest.files).filter((f) => f.adopted).length;
    if (k.songs) box.append(el("p", "hint", `${k.songs} song${k.songs === 1 ? "" : "s"} kept in step with the server (${sizeText(k.bytes)})${mine ? `: ${mine} you already had on the phone, the rest fetched into Music/MediaVerse Home` : ", in Music/MediaVerse Home"}.`));
    const held = Object.values(manifest.files).filter((f) => f.hold);
    if (held.length) {
      box.append(el("h2", "section", "Different from the server"));
      box.append(el("p", "hint", `${held.length} song${held.length === 1 ? " on the phone is" : "s on the phone are"} the same song as on the server but not the same file (another tag, bitrate or rip), so ${held.length === 1 ? "it was" : "they were"} left as ${held.length === 1 ? "it is" : "they are"}: ${held.slice(0, 3).map((f) => f.title).join(", ")}${held.length > 3 ? ", …" : ""}.`));
      const use = el("button", "secondary", "Use the server's versions");
      use.type = "button";
      use.addEventListener("click", () =>
        deps.confirm(`Replace ${held.length} song${held.length === 1 ? "" : "s"} on the phone with the server's version? Android asks for permission once; the songs keep their hearts and playlists.`, "Replace them", () => {
          useServerVersions(manifest);
          write(MANIFEST, manifest);
          void run();
        }),
      );
      box.append(use);
    }

    box.append(el("h2", "section", "Choose what to keep"));
    box.append(linkRow("Artists", "Every album and song by the artists you tick", () => deps.openPick("artists")));
    box.append(linkRow("Albums", "Pick single albums", () => deps.openPick("albums")));
    box.append(linkRow("Playlists", "A playlist's songs, kept in step with it", () => deps.openPick("playlists")));
    box.append(
      switchRow("The whole library", "Everything on the server. Check there is room on the phone first.", chosen({ kind: "all" }), () => {
        if (chosen({ kind: "all" })) {
          toggle({ kind: "all" });
          deps.changed();
        } else deps.confirm("Keep the whole library on this phone? It can be many gigabytes; the first sync may take a long time.", "Keep everything", () => {
          toggle({ kind: "all" });
          deps.changed();
        });
      }),
    );
    into.append(box);
  }

  function subtitle(choice: Choice): string {
    const files = Object.values(manifest.files).filter((f) => f.via.includes(choiceKey(choice)));
    return files.length ? `${files.length} song${files.length === 1 ? "" : "s"} on the phone (${sizeText(files.reduce((s, f) => s + f.size, 0))})` : "Not fetched yet";
  }

  function renderPick(into: HTMLElement, level: PickLevel, artist?: { id: string; name: string }): void {
    const session = deps.session();
    const box = el("div", "settings home-pick");
    const title = level === "artists" ? "Choose artists" : level === "playlists" ? "Choose playlists" : artist ? `Albums by ${artist.name}` : "Choose albums";
    box.append(el("h2", "section", title));
    if (!session) {
      box.append(el("p", "hint", "Sign in to your Jellyfin server first."));
      into.append(box);
      return;
    }
    box.append(el("p", "hint", level === "artists" ? "Tick an artist to keep all of their albums; the arrow opens their albums to pick some." : level === "playlists" ? "Tick a playlist to keep its songs. Songs added to it later come with the next sync." : "Tick the albums to keep."));
    const search = el("input", "tv-name");
    search.type = "search";
    search.placeholder = "Search";
    search.setAttribute("aria-label", "Search the list");
    // Artists who only appear on other artists' albums (compilations, guest spots) are left out unless this is ticked.
    let guests = read<boolean>(GUESTS, false);
    let guestBox: HTMLElement | null = null;
    if (level === "artists") {
      guestBox = el("label", "pick-option");
      const tick = el("input");
      tick.type = "checkbox";
      tick.checked = guests;
      tick.addEventListener("change", () => {
        guests = tick.checked;
        write(GUESTS, guests);
        void load();
      });
      guestBox.append(tick, el("span", "", "Also list artists who only appear on other artists' albums (compilations, guest spots)"));
    }
    const list = el("div", "pick-list");
    const note = el("p", "hint", "Asking the server…");
    box.append(search);
    if (guestBox) box.append(guestBox);
    box.append(note, list);
    into.append(box);
    type Item = { choice: Choice; label: string; sub: string; drill?: { id: string; name: string }; impliedBy?: Choice };
    let items: Item[] = [];
    const draw = (): void => {
      const words = search.value.toLowerCase().split(/\s+/).filter(Boolean);
      const shown = items.filter((i) => words.every((w) => `${i.label} ${i.sub}`.toLowerCase().includes(w)));
      list.replaceChildren();
      const addRow = (item: Item): void => {
        const implied = item.impliedBy ? chosen(item.impliedBy) : false;
        const row = el("div", "row pick-row");
        const mark = el("span", chosen(item.choice) || implied ? "check is-on" : "check", chosen(item.choice) || implied ? "✓" : "");
        const text = el("span", "row-text");
        text.append(el("span", "row-title", item.label), el("span", "row-sub", implied && !chosen(item.choice) ? `${item.sub ? `${item.sub} · ` : ""}kept with the artist` : item.sub));
        row.append(mark, text);
        row.addEventListener("click", () => {
          if (implied && !chosen(item.choice)) return deps.toast("Already kept with the whole artist");
          const on = toggle(item.choice);
          mark.className = on ? "check is-on" : "check";
          mark.textContent = on ? "✓" : "";
        });
        if (item.drill) {
          const open = el("button", "icon-button", "›");
          open.type = "button";
          open.setAttribute("aria-label", `Albums by ${item.drill.name}`);
          open.addEventListener("click", (event) => {
            event.stopPropagation();
            deps.openPick("albums", item.drill);
          });
          row.append(open);
        }
        list.append(row);
      };
      // Every artist is listed, a screenful at a time as the list is scrolled (a long library has thousands).
      let at = 0;
      const more = el("button", "secondary", "");
      more.type = "button";
      const next = (): void => {
        more.remove();
        for (const item of shown.slice(at, at + 200)) addRow(item);
        at = Math.min(shown.length, at + 200);
        if (at < shown.length) {
          more.textContent = `Show more (${shown.length - at} left)`;
          list.append(more);
          watch?.disconnect();
          watch = typeof IntersectionObserver === "function" ? new IntersectionObserver((entries) => entries.some((e) => e.isIntersecting) && next(), { rootMargin: "600px" }) : null;
          watch?.observe(more);
        }
      };
      more.addEventListener("click", next);
      next();
      note.textContent = shown.length ? `${shown.length} ${level === "artists" ? "artists" : level === "playlists" ? "playlists" : "albums"}` : items.length ? "Nothing matches." : "Nothing here.";
    };
    let watch: IntersectionObserver | null = null;
    search.addEventListener("input", draw);
    const load = async (): Promise<void> => {
      try {
        note.textContent = "Asking the server…";
        if (level === "artists") {
          const found = await deps.jf.albumArtists(session);
          items = found.map((a) => ({ choice: { kind: "artist", id: a.id, name: a.name } as Choice, label: a.name, sub: "", drill: { id: a.id, name: a.name } }));
          if (guests) {
            const others = await deps.jf.guestArtists(session, found);
            items.push(...others.map((a) => ({ choice: { kind: "appears", id: a.id, name: a.name } as Choice, label: a.name, sub: "Only on other artists' albums" })));
            items.sort((a, b) => a.label.localeCompare(b.label, undefined, { sensitivity: "base" }));
          }
        } else if (level === "playlists") {
          const found = await deps.jf.playlists(session);
          items = found.filter((p) => p.name !== MASTER_NAME && !isInbox(p.name)).map((p) => ({ choice: { kind: "playlist", id: p.id, name: p.name } as Choice, label: p.name, sub: "" }));
        } else {
          const found: ServerAlbum[] = await deps.jf.albums(session, artist?.id);
          items = found.map((a) => ({
            choice: { kind: "album", id: a.id, name: a.title, artist: a.artist } as Choice,
            label: a.title,
            sub: [a.artist, a.year, a.songs ? `${a.songs} songs` : ""].filter(Boolean).join(" · "),
            impliedBy: artist ? ({ kind: "artist", id: artist.id, name: artist.name } as Choice) : undefined,
          }));
        }
        draw();
      } catch (error) {
        note.textContent = error instanceof JellyfinProblem ? error.message : "The server did not answer. Connect to your home Wi-Fi and try again.";
      }
    };
    void load();
  }

  return { onNative, renderHome, renderPick, summary, autoSoon, run, running: () => running };
}

export { emptyManifest };
