// The phone's "Your computer" settings and its round (D214): pair once with MediaVerse Studio on a computer, then keep
// chosen music, favorites, flags and playlists in step over Wi-Fi, with no server. The music, playlist and removal
// rules are the Jellyfin ones (home-sync-ui.ts, a second instance with its own record); pairing and hearts and flags
// are here. Text is set with textContent.

import { el } from "../src/dom.ts";
import { Computer, computerBase, saveComputer, savedComputer, syncMarks, type MarkState } from "./computer.ts";
import { readProfile } from "./device-profile.ts";
import { addFlag, removeFlag, type Flag } from "./flags.ts";
import { createHomeSync, type HomeSync, type HomeSyncDeps } from "./home-sync-ui.ts";
import { cleanManifest } from "./home-sync.ts";
import type { Http, Session } from "./jellyfin-phone.ts";
import type { FromApp } from "./native.ts";
import { createSendMusic } from "./send-ui.ts";

const MARKS = "mediaverse.phone.computer-marks";
/** Which computer the record of fetched songs belongs to. */
const RECORD_OF = "mediaverse.phone.computer-record";
const HOST = "mediaverse.phone.computer-host";
/** The phone's ids of songs already sent to the computer (not offered again while they wait in its incoming folder). */
const SENT = "mediaverse.phone.computer-sent";
const MANIFEST = "mediaverse.phone.home-manifest";
/** Everything remembered about one computer: forgotten when another is paired (the phone's songs stay). */
const RECORD = [`${MANIFEST}.computer`, "mediaverse.phone.home-choices.computer", "mediaverse.phone.home-playlists.computer", "mediaverse.phone.home-last.computer", MARKS, SENT];

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
    /* kept until the app closes */
  }
}

/** The phone's ids of the songs a record holds ("" the Jellyfin one, ".computer" the computer's). */
export function recordedIds(suffix: "" | ".computer"): Set<string> {
  const files = Object.values(cleanManifest(read<unknown>(`${MANIFEST}${suffix}`, null)).files);
  return new Set(files.flatMap((f) => (f.mediaId ? [f.mediaId] : [])));
}

/** A second profile's hearts and playlists are not mixed into the computer's one set (it has no profiles yet). */
const ownProfile = (): boolean => {
  const profile = readProfile();
  return !profile || profile.name === profile.adopted;
};

export type ComputerDeps = Omit<HomeSyncDeps, "jf" | "computer" | "session" | "heldElsewhere" | "playlistsToo" | "runFlagSync"> & {
  http: Http;
  favorites: () => string[];
  /** The phone's hearts have been read (before that, none would look like all removed). */
  favoritesKnown: () => boolean;
  setFavorite: (id: string, on: boolean) => void;
  albumOf: (id: string) => string | null;
  /** Flags the computer's round put on or took off (the Jellyfin flag sync must not undo them). */
  flagsChanged: (raised: Flag[], cleared: Flag[]) => void;
};

export type ComputerLink = {
  sync: HomeSync;
  paired: () => boolean;
  /** Hearts and flags only, shortly after one changed. */
  soon: () => void;
  settings: () => HTMLElement;
  /** The computer's screen: keeping its music, and sending it this phone's new music. */
  renderHome: (into: HTMLElement) => void;
  onNative: (message: FromApp) => void;
};

export function createComputerLink(deps: ComputerDeps): ComputerLink {
  const computer = new Computer(deps.http);
  let session: Session | null = savedComputer();
  /** Pairing under way: the computer asked, and a code is wanted. */
  let asking: { base: string; name: string } | null = null;
  let status = "";
  let busy = false;
  let marking = false;
  let timer: number | undefined;
  let host = read<string>(HOST, "");

  async function marks(): Promise<void> {
    const now = session;
    if (!now || marking || !deps.libraryLoaded() || !deps.tracks().length || !deps.favoritesKnown()) return;
    marking = true;
    try {
      const library = deps.tracks().map((t) => ({ id: t.id, title: t.title, artist: t.artist, album_artist: t.album_artist, album: deps.albumOf(t.id) ?? t.album }));
      const round = await syncMarks({ client: computer, session: now, favorites: deps.favorites(), flags: deps.flags(), library, manifest: cleanManifest(read<unknown>(`${MANIFEST}.computer`, null)), state: read<MarkState>(MARKS, { favorites: null, flags: null }), hearts: ownProfile() });
      if (session !== now) return;
      write(MARKS, round.state);
      for (const id of round.favoritesAdd) deps.setFavorite(id, true);
      for (const id of round.favoritesRemove) deps.setFavorite(id, false);
      if (round.flagsAdd.length || round.flagsRemove.length) {
        const byId = new Map(deps.tracks().map((t) => [t.id, t]));
        let flags = deps.flags();
        for (const id of round.flagsAdd) {
          const track = byId.get(id);
          if (track) flags = addFlag(flags, { id, title: track.title, artist: track.artist, album: deps.albumOf(id) ?? track.album, durationMs: track.duration_ms }, Date.now());
        }
        const cleared = flags.filter((f) => round.flagsRemove.includes(f.id));
        for (const id of round.flagsRemove) flags = removeFlag(flags, id);
        deps.flagsChanged(flags.filter((f) => round.flagsAdd.includes(f.id)), cleared);
        deps.setFlags(flags);
      }
    } finally {
      marking = false;
    }
  }

  const sync = createHomeSync({
    ...deps,
    jf: computer,
    computer: { songRequest: (s, id) => computer.songRequest(s, id) },
    session: () => session,
    heldElsewhere: () => recordedIds(""),
    playlistsToo: ownProfile,
    runFlagSync: marks,
  });

  function soon(): void {
    if (!session) return;
    clearTimeout(timer);
    // Not while a sync is swapping files (a song fetched again has a new id before the page knows it): afterwards.
    timer = window.setTimeout(() => (sync.running() || deps.otherRunning?.() ? soon() : void marks().catch(() => {})), 4_000);
  }

  // ---- New music from the phone to the computer ----
  const sender = createSendMusic(deps, {
    place: "computer",
    session: () => session,
    library: async (to) => {
      const songs = await computer.list(to, true);
      return computer.takesUploads() ? { songs } : { refused: "To send music, first tick “Let paired phones send new music to this computer” in Settings > TV & Phone Pairing on the computer." };
    },
    request: (to, path) => ({ url: `${to.base}/api/sync/upload?path=${encodeURIComponent(path)}`, headers: { Authorization: `Bearer ${to.token}` } }),
    hint: "Send music bought or copied onto this phone to the computer. It waits there in the folder “MediaVerse Incoming” for you to look over; nothing is taken off the phone.",
    folder: "the computer's “MediaVerse Incoming” folder",
    sentKey: () => SENT,
    skip: () => recordedIds(".computer"),
  });

  function onNative(message: FromApp): void {
    sync.onNative(message);
    sender.onNative(message);
  }

  function renderHome(into: HTMLElement): void {
    sync.renderHome(into);
    sender.render(into);
  }

  async function step(work: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    // The page is redrawn as this goes along, which it will not do under a box being typed in.
    (document.activeElement as HTMLElement | null)?.blur();
    deps.changed();
    try {
      await work();
    } catch (thrown) {
      status = thrown instanceof Error ? thrown.message : "That did not work.";
    } finally {
      busy = false;
      deps.changed();
    }
  }

  const ask = (typed: string): Promise<void> =>
    step(async () => {
      host = typed.trim();
      write(HOST, host);
      const base = computerBase(host);
      status = "Looking for the computer…";
      deps.changed();
      const found = base ? await computer.hello(base) : null;
      if (!found) {
        status = "No computer answered at that address. Check that MediaVerse Studio is open there with sharing on, that the phone is on the same Wi-Fi, and that Android lets this app use the local network (Android's Settings > Apps > MediaVerse Studio > Permissions).";
        return;
      }
      await computer.startPairing(found.base, deps.deviceLabel);
      asking = found;
      status = `${found.name} is showing a 6-digit code. Type it here.`;
    });

  const confirm = (code: string): Promise<void> =>
    step(async () => {
      if (!asking) return;
      const paired = await computer.confirmPairing(asking.base, asking.name, code);
      const before = read<string>(RECORD_OF, "");
      saveComputer(paired);
      write(RECORD_OF, paired.name);
      asking = null;
      status = `Paired with ${paired.name}.`;
      if (before && before !== paired.name) {
        // What was remembered belongs to the other computer: start afresh (a reload, so nothing old is held).
        for (const key of RECORD) localStorage.removeItem(key);
        location.reload();
        return;
      }
      // Paired afresh: the computer may have been set up anew, so nothing it lacks counts as removed there.
      localStorage.removeItem(MARKS);
      sync.forgetAgreements();
      session = paired;
      soon();
    });

  function row(title: string, sub: string, action: () => void, chevron = false): HTMLElement {
    const button = el("button", "switch-row");
    button.type = "button";
    const text = el("span", "row-text");
    text.append(el("span", "row-title", title), el("span", "row-sub", sub));
    button.append(text);
    if (chevron) button.append(el("span", "chevron", "›"));
    button.addEventListener("click", action);
    return button;
  }

  function field(label: string, value: string, numbers: boolean): HTMLInputElement {
    const input = el("input", "tv-name");
    input.type = "text";
    input.placeholder = label;
    input.value = value;
    input.setAttribute("aria-label", label);
    input.setAttribute("autocomplete", "off");
    input.setAttribute("autocapitalize", "off");
    if (numbers) input.inputMode = "numeric";
    return input;
  }

  function settings(): HTMLElement {
    const box = el("div");
    box.append(el("h2", undefined, "Your computer"));
    if (session) {
      box.append(el("p", "hint", `Paired with ${session.name} (${session.base.replace("http://", "")}). Music, favorites, flags and playlists are kept in step while this phone and the computer are on your Wi-Fi and MediaVerse Studio is open there.`));
      if (!ownProfile()) box.append(el("p", "hint", "Favorites and playlists go to the computer only for this phone's first profile; music and flags for everyone."));
      box.append(row("Keep music from the computer on this phone", sync.summary(), deps.openHome, true));
      box.append(row("Forget this computer", "Nothing is taken off the phone.", () =>
        deps.confirm(`Stop keeping in step with ${session?.name ?? "the computer"}?`, "Forget it", () => {
          session = null;
          saveComputer(null);
          status = "";
          sender.forget();
          deps.changed();
        }),
      ));
      return box;
    }
    box.append(el("p", "hint", "No server needed: keep music, favorites, flags and playlists in step with MediaVerse Studio on your computer over Wi-Fi. On the computer open Settings > TV & Phone Pairing, switch sharing on and press Pair a TV or phone, then enter the address shown there."));
    if (asking) {
      const code = field("6-digit code", "", true);
      box.append(code, row(busy ? "Pairing…" : "Pair", "", () => void confirm(code.value)), row("Cancel", "", () => {
        asking = null;
        status = "";
        deps.changed();
      }));
    } else {
      const address = field("Computer's address, for example 192.168.1.20", host, false);
      box.append(address, row(busy ? "Looking…" : "Connect", "", () => void ask(address.value)));
    }
    if (status) box.append(el("p", "hint", status));
    return box;
  }

  return { sync, paired: () => session !== null, soon, settings, renderHome, onNative };
}
