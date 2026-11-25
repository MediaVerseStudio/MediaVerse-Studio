// One round of syncing the phone's flags with a Jellyfin server (D96). Order: upload the new flags as an inbox
// playlist, read the master list and the inboxes, drop flags the computer has cleared, and adopt songs the master
// list names that this phone also has.

import { addFlag, clearedOnServer, inboxName, isInbox, localMatches, markSent, MASTER_NAME, pendingFlags, pickServerSong, type Flag, type Named } from "./flags.ts";
import { perArtist, type Jellyfin, type ServerSong, type Session } from "./jellyfin-phone.ts";

export type SyncReport = {
  flags: Flag[];
  /** Flags put into a new inbox playlist, the playlist's name (or null), and flags the server has no song for (kept to try again). */
  uploaded: number;
  inbox: string | null;
  notOnServer: number;
  /** Flags dropped because the computer cleared them, and songs adopted from the master list. */
  cleared: number;
  adopted: number;
};

type Client = Pick<Jellyfin, "searchSongs" | "playlists" | "playlistSongs" | "createPlaylist">;
type LibrarySong = { id: string } & Named;

export async function syncFlags(client: Client, session: Session, flags: Flag[], library: LibrarySong[], device: string, now: Date): Promise<SyncReport> {
  let current = flags;
  let uploaded = 0;
  let inbox: string | null = null;
  let notOnServer = 0;

  // 1. New flags go up as their own playlist.
  const pending = pendingFlags(current);
  if (pending.length) {
    const found: Array<{ flag: Flag; song: ServerSong }> = [];
    for (const flag of pending) {
      const candidates = perArtist(await client.searchSongs(session, flag.title));
      const song = pickServerSong(flag, candidates);
      if (song) found.push({ flag, song });
      else notOnServer++;
    }
    if (found.length) {
      const name = inboxName(now, device);
      await client.createPlaylist(session, name, [...new Set(found.map((f) => f.song.id))]);
      current = markSent(current, found.map((f) => f.flag.id), now.getTime());
      uploaded = found.length;
      inbox = name;
    }
  }

  // 2. What the server holds now: the master list and every inbox.
  const lists = await client.playlists(session);
  const master: Named[] = [];
  const inboxes: Named[] = [];
  for (const list of lists) {
    const isMaster = list.name === MASTER_NAME;
    if (!isMaster && !isInbox(list.name)) continue;
    const songs = perArtist(await client.playlistSongs(session, list.id));
    (isMaster ? master : inboxes).push(...songs);
  }

  // 3. Flags the computer cleared go; songs it flagged that this phone has come in.
  const gone = clearedOnServer(current, master, inboxes);
  if (gone.length) {
    const ids = new Set(gone.map((flag) => flag.id));
    current = current.filter((flag) => !ids.has(flag.id));
  }
  const adopt = localMatches(master, library, current);
  for (const song of adopt) current = markSent(addFlag(current, { id: song.id, title: song.title ?? "", artist: song.artist, album: song.album }, now.getTime()), [song.id], now.getTime());

  return { flags: current, uploaded, inbox, notOnServer, cleared: gone.length, adopted: adopt.length };
}
