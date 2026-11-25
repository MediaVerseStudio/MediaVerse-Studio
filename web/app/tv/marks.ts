// Favorites and flags on the TV (D44), kept where the music lives: on the computer (MediaVerse Studio's own
// favorites and Review list), in Jellyfin (its favorites; flags in its shared "Problem tracks" playlists, D96), or on
// the TV for a USB drive. Each source gets a store with the same three operations.

import { fetchMarks, postMark, type Connection } from "./api.ts";
import { flagInJellyfin, jellyfinFavorites, jellyfinFlagged, setJellyfinFavorite, unflagInJellyfin, type JellyfinSession } from "./jellyfin.ts";
import { profileFavorites, setProfileFavorite, type Profile } from "./profiles.ts";

/** What can be wrong with a song: the same reasons as the desktop app's Flag. */
export const FLAG_REASONS = [
  ["audio", "Sound problem"],
  ["tags", "Wrong song details"],
  ["cover_or_lyrics", "Cover or lyrics"],
  ["wrong_track", "Wrong song"],
  ["other", "Something else"],
] as const;
export type FlagReason = (typeof FLAG_REASONS)[number][0];

export type Marks = { favorites: Set<string>; flagged: Set<string> };

export type MarkStore = {
  /** Where flags end up, for the TV to say ("on Home-PC", "on this TV"). */
  flagsWhere: string;
  load(): Promise<Marks>;
  favorite(id: string, on: boolean): Promise<void>;
  flag(id: string, on: boolean, reason: FlagReason, positionMs: number, by?: string): Promise<void>;
};

type Saved = { favorites: string[]; flagged: Array<{ id: string; reason: FlagReason; position_ms: number; at: number; /** On a Jellyfin source: true once the server holds it. */ sent?: boolean }>; /** On a Jellyfin source: songs unflagged here that the server may still hold (it was away), to be taken off there at the next load. */ unflagging?: string[] };

/** Marks kept on this TV, under `scope` (a drive, or a Jellyfin server's flags). */
function onTv(scope: string): { read(): Saved; write(saved: Saved): void } {
  const key = `mediaverse.tv.marks:${scope}`;
  return {
    read() {
      try {
        const saved = JSON.parse(localStorage.getItem(key) ?? "null");
        return saved && Array.isArray(saved.favorites) && Array.isArray(saved.flagged) ? saved : { favorites: [], flagged: [] };
      } catch {
        return { favorites: [], flagged: [] };
      }
    },
    write(saved) {
      try {
        localStorage.setItem(key, JSON.stringify(saved));
      } catch {
        // storage full: the mark lasts until the app closes
      }
    },
  };
}

function setFlagOnTv(saved: Saved, id: string, on: boolean, reason: FlagReason, positionMs: number): Saved {
  const flagged = saved.flagged.filter((entry) => entry.id !== id);
  if (on) flagged.push({ id, reason, position_ms: Math.max(0, Math.round(positionMs)), at: Date.now() });
  return { ...saved, flagged };
}

export function computerMarks(connection: Connection): MarkStore {
  return {
    flagsWhere: `in MediaVerse Studio on ${connection.computer || "the computer"} (Review)`,
    async load() {
      const marks = await fetchMarks(connection);
      return { favorites: new Set(marks?.favorites ?? []), flagged: new Set(marks?.flagged ?? []) };
    },
    favorite: (id, on) => postMark(connection, "favorite", id, { favorite: on }),
    flag: (id, on, reason, positionMs, by) =>
      postMark(connection, "flag", id, { flagged: on, reasons: [reason], note: by ? `Flagged on the TV by ${by}` : "Flagged on the TV", position_ms: Math.max(0, Math.round(positionMs)) }),
  };
}

/**
 * What to do with the flags kept on the TV once the server's flagged songs are known (D96). A flag the server holds is
 * sent. A flag the server does not hold that was sent before was cleared on the computer (marked Done), so the TV
 * drops it. A flag never sent (made while the server was away, or kept from before flags went to Jellyfin) goes up now.
 * The flagged songs are the server's, plus the ones still waiting to go up.
 */
export function reconcileFlags(local: Saved["flagged"], server: Set<string>, unflagging: string[] = []): { keep: Saved["flagged"]; upload: string[]; unflag: string[]; flagged: Set<string> } {
  const pending = new Set(unflagging); // taken off on the TV while the server was away: still to be taken off there
  const keep: Saved["flagged"] = [];
  const upload: string[] = [];
  for (const entry of local) {
    if (pending.has(entry.id)) continue;
    if (server.has(entry.id)) keep.push({ ...entry, sent: true });
    else if (entry.sent === true) continue;
    else {
      keep.push(entry);
      upload.push(entry.id);
    }
  }
  const unflag = unflagging.filter((id) => server.has(id));
  return { keep, upload, unflag, flagged: new Set([...[...server].filter((id) => !pending.has(id)), ...upload]) };
}

/** This TV's name in the inbox playlist it makes ("Problem Playlist 2026-11-22 21:40 (TV)"). */
const THIS_DEVICE = "TV";

/** Flags live on the Jellyfin server, in the shared "Problem tracks" lists the computer's Review page reads (D96); a copy on the TV covers the server being away. */
export function jellyfinMarks(session: JellyfinSession): MarkStore {
  const local = onTv(`jellyfin:${session.serverId}`);
  return {
    flagsWhere: "in Jellyfin's Problem tracks list (MediaVerse Studio on the computer reviews it)",
    async load() {
      const favorites = await jellyfinFavorites(session).catch(() => []);
      let server: Set<string>;
      try {
        server = await jellyfinFlagged(session);
      } catch {
        const saved = local.read();
        const pending = new Set(saved.unflagging ?? []);
        return { favorites: new Set(favorites), flagged: new Set(saved.flagged.map((entry) => entry.id).filter((id) => !pending.has(id))) }; // server away: what this TV knows
      }
      const saved = local.read(); // read after the server answered, so a flag made meanwhile is not lost
      const { keep, upload, unflag, flagged } = reconcileFlags(saved.flagged, server, saved.unflagging);
      const gone = new Set(saved.flagged.map((entry) => entry.id).filter((id) => !keep.some((entry) => entry.id === id)));
      const sent = new Set<string>();
      const done = new Set<string>((saved.unflagging ?? []).filter((id) => !server.has(id))); // the server no longer holds these: nothing left to take off
      if (upload.length) {
        try {
          await flagInJellyfin(session, upload, THIS_DEVICE);
          for (const id of upload) sent.add(id);
        } catch {
          // tried again at the next load
        }
      }
      if (unflag.length) {
        try {
          await unflagInJellyfin(session, unflag);
          for (const id of unflag) done.add(id);
        } catch {
          // tried again at the next load
        }
      }
      // The copy on the TV may have changed while the server was answered: change that, not the old picture of it.
      const fresh = local.read();
      local.write({
        ...fresh,
        flagged: fresh.flagged.filter((entry) => !gone.has(entry.id)).map((entry) => (sent.has(entry.id) || server.has(entry.id) ? { ...entry, sent: true } : entry)),
        unflagging: (fresh.unflagging ?? []).filter((id) => !done.has(id)),
      });
      return { favorites: new Set(favorites), flagged };
    },
    favorite: (id, on) => setJellyfinFavorite(session, id, on),
    async flag(id, on, reason, positionMs) {
      const saved = setFlagOnTv(local.read(), id, on, reason, positionMs);
      // Flagging again cancels an unflag still waiting for the server; unflagging waits (and is kept) until the server has taken the song off.
      const waiting = (saved.unflagging ?? []).filter((waitingId) => waitingId !== id);
      local.write({ ...saved, unflagging: on ? waiting : [...waiting, id] });
      if (on) {
        try {
          await flagInJellyfin(session, [id], THIS_DEVICE);
          const now = local.read();
          local.write({ ...now, flagged: now.flagged.map((entry) => (entry.id === id ? { ...entry, sent: true } : entry)) });
        } catch {
          // Server away: the flag stays on this TV and goes up at the next load.
        }
      } else {
        try {
          await unflagInJellyfin(session, [id]);
          const now = local.read();
          local.write({ ...now, unflagging: (now.unflagging ?? []).filter((waitingId) => waitingId !== id) });
        } catch {
          // Server away: the flag is off on this TV, and comes off the server at the next load.
        }
      }
    },
  };
}

export function driveMarks(label: string): MarkStore {
  const local = onTv(`drive:${label}`);
  return {
    flagsWhere: "on this TV",
    async load() {
      const saved = local.read();
      return { favorites: new Set(saved.favorites), flagged: new Set(saved.flagged.map((entry) => entry.id)) };
    },
    async favorite(id, on) {
      const saved = local.read();
      const favorites = saved.favorites.filter((entry) => entry !== id);
      if (on) favorites.push(id);
      local.write({ ...saved, favorites });
    },
    async flag(id, on, reason, positionMs) {
      local.write(setFlagOnTv(local.read(), id, on, reason, positionMs));
    },
  };
}

/**
 * The store as one person on this TV sees it (D45): their own favorites, kept on the TV for this music source;
 * flags still go wherever the source keeps them (the household's list), signed with the person's name.
 */
export function forListener(base: MarkStore, profile: Profile | null, source: string): MarkStore {
  if (!profile) return base;
  return {
    flagsWhere: base.flagsWhere,
    async load() {
      const shared = await base.load().catch(() => ({ favorites: new Set<string>(), flagged: new Set<string>() }));
      return { favorites: new Set(profileFavorites(profile.id, source)), flagged: shared.flagged };
    },
    async favorite(id, on) {
      setProfileFavorite(profile.id, source, id, on);
    },
    flag: (id, on, reason, positionMs) => base.flag(id, on, reason, positionMs, profile.name),
  };
}