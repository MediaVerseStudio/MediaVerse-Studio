// Settings > Jellyfin > Shared problem tracks (D96): signs this computer in to the Jellyfin server (Quick Connect, nothing
// to type), then keeps the Review page and the server's "Problem tracks" playlist in step: flags from phones and TVs
// appear on the Review page, flags made here go to the shared list, and "Done" removes a song from it. The sync logic is
// in problem-sync.ts. Text is set with textContent.

import { JellyfinProblem, type Session } from "../phone/jellyfin-phone.ts";
import { songKey } from "../phone/flags.ts";
import { el } from "./dom";
import type { Flag } from "./flag-format";
import type { FlagStore } from "./flags";
import { chooseServer, chosenServer, desktopJellyfin, onChosenServerChange, readSaved as read, SESSION_STORE, writeSaved as write } from "./jellyfin-desktop";
import { describeProblemSync, syncProblemTracks, type SongLike } from "./problem-sync.ts";
import { describePlaylistSync, syncPlaylists, type PcPlaylist, type PlaylistSyncState } from "./playlist-sync.ts";
import { serverLibrary, serverSongId } from "./library-mode";

const DONE_STORE = "mediaverse.desktop.problem-done";
const PLAYLIST_STATE = "mediaverse.desktop.playlist-sync";
const RESCAN_STORE = "mediaverse.desktop.jellyfin-rescan";

export type ProblemSyncDeps = {
  store: FlagStore;
  library: () => SongLike[];
  /** The computer's playlists, kept on the server too. */
  playlists: () => PcPlaylist[];
  /** Saves a playlist here (new when `id` is missing) and returns its id. */
  savePlaylist: (playlist: { id?: string; name: string; paths: string[] }) => Promise<string>;
};

/** What the last playlist round left (anything of another shape is forgotten, which only makes the next round add, never remove). */
function savedPlaylistState(): PlaylistSyncState {
  const saved = read<Record<string, { name?: unknown; ids?: unknown }>>(PLAYLIST_STATE, {});
  const state: PlaylistSyncState = {};
  for (const [id, entry] of Object.entries(saved ?? {})) {
    if (entry && typeof entry.name === "string" && Array.isArray(entry.ids)) state[id] = { name: entry.name, ids: entry.ids.filter((x): x is string => typeof x === "string") };
  }
  return state;
}

const button = (text: string, className = "secondary"): HTMLButtonElement => {
  const b = el("button", className, text);
  b.type = "button";
  return b;
};

/**
 * The sign-in and sync block of the default Jellyfin server (chosen above it on Settings > Jellyfin). It is drawn inside the Jellyfin page, not as
 * a box of its own (owner, 2026-11-22: choosing one server as the default is enough).
 */
export function renderProblemSync(root: HTMLElement, deps: ProblemSyncDeps): { sync: () => void; scheduleSync: () => void; rescanSoon: () => void } {
  root.className = "problem-sync";
  const jf = desktopJellyfin();
  /**
   * The client the playlists are synced with. With the server alone as the library (D173) this computer names a song by its server id (`jellyfin:<album>/<song>`), not by a
   * path, so the server's songs are listed under those names and the two sides match exactly.
   */
  function playlistClient(): typeof jf {
    if (!serverLibrary()) return jf;
    const byId = new Map<string, string>();
    for (const song of deps.library()) {
      const id = serverSongId(song.source_uri);
      if (id) byId.set(id, song.source_uri);
    }
    return Object.create(jf, {
      serverSongs: { value: async (s: Session) => (await jf.serverSongs(s)).map((song) => ({ id: song.id, path: byId.get(song.id.toLowerCase()) ?? `jellyfin:loose-${song.id.toLowerCase()}/${song.id.toLowerCase()}` })) },
    }) as typeof jf;
  }
  let session = read<Session | null>(SESSION_STORE, null);
  let status = "";
  let code = "";
  let syncing = false;
  let connecting: { stopped: boolean } | null = null;
  let timer: number | undefined;
  let rescanTimer: number | undefined;
  /** Whether the server is asked to look for changed files after this program saves something (it needs an administrator's account on the server). */
  let rescanOn = read<boolean>(RESCAN_STORE, true);

  /** The server is asked to rescan its library a little after the last save, so the TV and phone see new tags, lyrics and covers. */
  function rescanSoon(): void {
    if (!session || !rescanOn) return;
    clearTimeout(rescanTimer);
    rescanTimer = window.setTimeout(async () => {
      if (!session) return;
      try {
        await jf.refreshLibrary(session);
        status = "Jellyfin was asked to look for the changes you saved.";
      } catch (error) {
        status =
          error instanceof JellyfinProblem && error.kind === "other"
            ? "Jellyfin would not rescan: only an administrator's account may ask it to. Sign in with an administrator, or scan from Jellyfin's Dashboard."
            : "Jellyfin could not be asked to rescan its library.";
      }
      draw();
    }, 30_000);
  }

  // Already signed in to a server before a default could be chosen: that one is the default.
  if (session && !chosenServer()) chooseServer({ id: session.serverId, name: session.name, base: session.base });

  // The default server changed: signed in to another one means signing in again.
  onChosenServerChange((server) => {
    if (session && (!server || session.serverId !== server.id)) {
      session = null;
      write(SESSION_STORE, null);
      status = server ? `The default server is now ${server.name}. Sign in to it to share flags and playlists.` : "No default server is chosen.";
    }
    draw();
  });

  const dueDone = (): string[] => read<string[]>(DONE_STORE, []);

  /** Marked Done here: the song leaves the shared list at the next sync (kept until then, even offline). */
  deps.store.onRemoved((flag: Flag) => {
    const keys = new Set(dueDone());
    keys.add(songKey(flag));
    write(DONE_STORE, [...keys]);
    scheduleSync();
  });

  // A flag made or changed here goes to the shared list soon after.
  deps.store.onChange(() => scheduleSync());

  /** A change came in (or a playlist was postponed) while a round ran: another round follows it. */
  let again = false;

  function scheduleSync(): void {
    if (!session) return;
    if (syncing) {
      again = true;
      return;
    }
    clearTimeout(timer);
    timer = window.setTimeout(() => void sync(), 3_000);
  }

  async function sync(): Promise<void> {
    if (!session || syncing) return;
    syncing = true;
    status = "Syncing…";
    draw();
    try {
      const flags = deps.store.index.all();
      const report = await syncProblemTracks(jf, session, { flags, library: deps.library(), done: dueDone() });
      write(DONE_STORE, []);
      for (const song of report.newFlags) {
        await deps.store.set({
          path: song.source_uri,
          flagged: true,
          reasons: ["other"],
          note: "Flagged on a phone or TV (shared problem list)",
          title: song.title,
          artist: song.artist ?? undefined,
          album: song.album ?? undefined,
        });
      }
      status = describeProblemSync(report);
      // The computer's playlists and the server's are kept in step too, so the TV and phone see them. A problem here must not hide the result above,
      // and one playlist failing (a name this computer refuses, say) does not stop the others; only the server being away or signing out ends the round.
      try {
        const mirrored = await syncPlaylists(
          { client: playlistClient(), session, playlists: deps.playlists(), libraryPaths: deps.library().map((song) => song.source_uri), savePlaylist: deps.savePlaylist, latest: (id) => deps.playlists().find((p) => p.id === id) },
          savedPlaylistState(),
        );
        write(PLAYLIST_STATE, mirrored.state);
        const playlistNote = describePlaylistSync(mirrored.report);
        if (playlistNote) status = `${status} ${playlistNote}`;
        if (mirrored.report.postponed) again = true; // changed here during the round: once more
      } catch (error) {
        if (error instanceof JellyfinProblem) throw error;
        status = `${status} Playlists: ${error instanceof Error ? error.message : "syncing them did not work."}`;
      }
    } catch (error) {
      if (error instanceof JellyfinProblem && error.kind === "signed_out") {
        session = null;
        write(SESSION_STORE, null);
        status = "Jellyfin no longer accepts this computer. Sign in again.";
      } else if (error instanceof JellyfinProblem && error.kind === "unreachable") {
        status = "The server did not answer. It is tried again in a few minutes.";
      } else {
        status = error instanceof Error ? error.message : "Syncing did not work.";
      }
    } finally {
      syncing = false;
      draw();
      if (again) {
        again = false;
        scheduleSync();
      }
    }
  }

  async function connect(host: string): Promise<void> {
    connecting = { stopped: false };
    const mine = connecting;
    status = "Looking for the server…";
    code = "";
    draw();
    try {
      const server = await jf.probe(host);
      if (!server) {
        status = "No Jellyfin server answered at that address.";
        return;
      }
      status = `Found ${server.name}. In Jellyfin (in a browser or on a phone) open your profile menu, choose Quick Connect and enter this code:`;
      const signedIn = await jf.quickConnect(server, (shown) => { code = shown; draw(); }, mine);
      if (!signedIn) {
        status = mine.stopped ? "Cancelled." : "The code was not approved in time.";
        return;
      }
      session = signedIn;
      write(SESSION_STORE, signedIn);
      status = `Signed in to ${signedIn.name}.`;
      code = "";
      draw();
      void sync();
    } catch (error) {
      status = error instanceof Error ? error.message : "Signing in did not work.";
    } finally {
      code = "";
      if (connecting === mine) connecting = null;
      draw();
    }
  }

  const message = el("p", "field-hint");
  message.setAttribute("role", "status");
  const codeBox = el("p", "jellyfin-code");
  const actions = el("div", "dialog-actions");

  function draw(): void {
    message.textContent = status;
    codeBox.textContent = code;
    codeBox.hidden = !code;
    actions.replaceChildren();
    const chosen = chosenServer();
    if (!chosen) {
      actions.append(el("p", "field-hint", "Choose your default server above (Use this server), then sign in to it here."));
      return;
    }
    if (session) {
      const now = button(syncing ? "Syncing…" : "Sync now", "");
      now.disabled = syncing;
      now.addEventListener("click", () => void sync());
      const out = button("Sign out");
      out.addEventListener("click", () => {
        session = null;
        write(SESSION_STORE, null);
        status = "Signed out. Flags stay as they are.";
        draw();
      });
      actions.append(now, out);
    } else {
      const go = button(connecting ? "Cancel" : `Sign in to ${chosen.name}`, "");
      go.addEventListener("click", () => {
        if (connecting) {
          connecting.stopped = true;
          return;
        }
        void connect(chosen.base.replace(/^https?:\/\//, ""));
      });
      actions.append(go);
    }
  }

  const rescanBox = el("input");
  rescanBox.type = "checkbox";
  rescanBox.checked = rescanOn;
  rescanBox.addEventListener("change", () => {
    rescanOn = rescanBox.checked;
    write(RESCAN_STORE, rescanOn);
  });
  const rescanLabel = el("label", "check");
  rescanLabel.append(rescanBox, el("span", undefined, "After I save tags, lyrics or covers here, ask the server to rescan its library so TVs and phones show the changes"));

  root.replaceChildren(
    el("h4", undefined, "Sign in, flags and playlists"),
    el("p", "field-hint", "Signed in to the default server, this program shares your flags and playlists with your TVs and phones. Songs they flag arrive on the Review page (even if this program was closed), and \"Done\" there clears them everywhere. Playlists you make here are copied to the server, and playlists made on a TV, a phone or in Jellyfin come here. Only songs are shared, not flag reasons or notes."),
    codeBox,
    message,
    actions,
    rescanLabel,
    el("p", "field-hint", "Editing songs here works because this program changes the files in your music folder directly (for a server's shared folder, through the share); Jellyfin only needs telling to look again. The rescan needs an administrator's account on the server."),
  );
  draw();

  // Sync at start and every few minutes while signed in (the server may have been away).
  if (session) setTimeout(() => void sync(), 5_000);
  window.setInterval(() => void sync(), 5 * 60_000);

  return { sync: () => void sync(), scheduleSync, rescanSoon };
}
