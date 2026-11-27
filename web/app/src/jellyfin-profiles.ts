// Profiles on the Jellyfin server (D213, docs/profiles-plan.md): a profile is a user with no password who is not an
// administrator, picked like on a streaming service, with its own favorites, last played and playlists. Used by the
// computer, the phone and the TV. Pure logic with the Jellyfin client passed in, so it is unit tested without a server.

import { isFlagList, JellyfinProblem, type Jellyfin, type ServerUser, type Session, type Share } from "../phone/jellyfin-phone.ts";

export type Server = { base: string; name: string; id: string };

/** The profiles a device offers: the listed users who are not administrators (those have passwords), by name. */
export async function listProfiles(client: Pick<Jellyfin, "publicUsers">, base: string): Promise<ServerUser[]> {
  return (await client.publicUsers(base)).filter((user) => !user.admin && !user.disabled).sort((a, b) => a.name.localeCompare(b.name));
}

/** Signs in to a profile. A user that turns out to have a password is not a profile, and says so. */
export async function openProfile(client: Pick<Jellyfin, "signInAs">, server: Server, name: string): Promise<Session> {
  try {
    return await client.signInAs(server, name);
  } catch (error) {
    if (error instanceof JellyfinProblem && error.kind === "signed_out") throw new JellyfinProblem(`${name} has a password in Jellyfin, so it cannot be used as a profile.`, "other");
    throw error;
  }
}

/** What a new profile's name may not be, as words to show, or null when it will do. */
export function profileNameProblem(name: string, taken: string[]): string | null {
  const clean = name.trim();
  if (!clean) return "Type a name for the profile.";
  if (clean.length > 40) return "That name is too long (40 letters at most).";
  // Jellyfin allows letters, numbers, spaces and a few marks in a user name.
  if (!/^[\p{L}\p{N} ._'@+-]+$/u.test(clean)) return "Use letters, numbers, spaces, and . _ ' - only.";
  if (taken.some((other) => other.trim().toLocaleLowerCase() === clean.toLocaleLowerCase())) return `There is already a user called ${clean} on the server.`;
  return null;
}

type Maker = Pick<Jellyfin, "signInAs" | "signOut" | "me" | "users" | "createUser">;

/**
 * Makes a profile. The administrator's name and password are used for this only: signed in, the user made, signed
 * out again; nothing of them is kept.
 */
export async function createProfile(client: Maker, server: Server, administrator: { name: string; password: string }, name: string): Promise<ServerUser> {
  let admin: Session;
  try {
    admin = await client.signInAs(server, administrator.name.trim(), administrator.password, "mediaverse-profile-setup");
  } catch (error) {
    if (error instanceof JellyfinProblem && error.kind === "signed_out") throw new JellyfinProblem("Jellyfin did not accept that administrator name and password.", "other");
    throw error;
  }
  try {
    if (!(await client.me(admin)).admin) throw new JellyfinProblem(`${administrator.name.trim()} is not an administrator of this server: only an administrator can add a profile.`, "other");
    const problem = profileNameProblem(name, (await client.users(admin)).map((u) => u.name));
    if (problem) throw new JellyfinProblem(problem, "other");
    return await client.createUser(admin, name.trim());
  } finally {
    await client.signOut(admin).catch(() => undefined);
  }
}

/** The shares a list should have so that every user may change it, or null when it already has them all. */
export function sharesForEveryone(current: Share[], users: ServerUser[]): Share[] | null {
  const have = new Map(current.map((share) => [share.userId, share.canEdit]));
  const missing = users.filter((user) => !user.disabled && have.get(user.id) !== true);
  if (!missing.length) return null;
  for (const user of missing) have.set(user.id, true);
  return [...have].map(([userId, canEdit]) => ({ userId, canEdit }));
}

/** What sharing the flag lists needs; `S` is the app's own kind of sign-in (the TV has its own client). */
type Sharer<S> = {
  playlists: (session: S) => Promise<Array<{ id: string; name: string }>>;
  users: (session: S) => Promise<ServerUser[]>;
  playlistAccess: (session: S, id: string) => Promise<{ shares: Share[] }>;
  setPlaylistAccess: (session: S, id: string, access: { shares: Share[] }) => Promise<void>;
};

/**
 * Makes sure every user of the server may check and clear the flags (owner, 2026-11-26): each flag list this user may
 * manage gets the people it is missing. A list this user may only see, or cannot read the shares of, is left for
 * someone who may. Returns how many lists were changed.
 */
export async function shareFlagLists<S>(client: Sharer<S>, session: S): Promise<number> {
  const lists = (await client.playlists(session)).filter((list) => isFlagList(list.name));
  if (!lists.length) return 0;
  const users = await client.users(session);
  let changed = 0;
  for (const list of lists) {
    try {
      const { shares } = await client.playlistAccess(session, list.id);
      const next = sharesForEveryone(shares, users);
      if (!next) continue;
      await client.setPlaylistAccess(session, list.id, { shares: next });
      changed++;
    } catch (error) {
      if (error instanceof JellyfinProblem && error.kind === "unreachable") throw error;
    }
  }
  return changed;
}

type Copier = Pick<Jellyfin, "favoriteIds" | "setFavorite" | "playlists" | "playlistSongs" | "createPlaylist" | "playlistAccess" | "setPlaylistAccess">;

export type CopyReport = { favorites: number; playlists: number; /** Left alone: the profile has one of that name. */ already: number; hidden: number; /** Playlist files in the music folder: every profile sees them already. */ files: number; failed: string[] };

/**
 * Copies one account's favorites and playlists into a profile (moving to a profile of one's own). Nothing is
 * deleted. `hideOriginals`: the old account's playlists that everyone can see are made private, so the profiles do not
 * show each list twice. Safe to run again.
 */
export async function copyIntoProfile(client: Copier, from: Session, to: Session, options: { hideOriginals: boolean }, progress?: (text: string) => void): Promise<CopyReport> {
  const report: CopyReport = { favorites: 0, playlists: 0, already: 0, hidden: 0, files: 0, failed: [] };
  const have = new Set(await client.favoriteIds(to));
  const wanted = (await client.favoriteIds(from)).filter((id) => !have.has(id));
  for (const [n, id] of wanted.entries()) {
    progress?.(`Favorites: ${n + 1} of ${wanted.length}`);
    await client.setFavorite(to, id, true);
    report.favorites++;
  }
  const found = (await client.playlists(from)).filter((list) => !isFlagList(list.name));
  // A copy of a playlist file would only show beside it: found on the owner's server, where two empty ones doubled (2026-11-26).
  const mine = found.filter((list) => !list.file);
  report.files = found.length - mine.length;
  const theirs = (await client.playlists(to)).filter((list) => !list.file);
  const originals = new Set(mine.map((list) => list.id));
  // Names the profile already has of its own (the old account's public lists it can merely see do not count).
  const names = new Set(theirs.filter((list) => !originals.has(list.id)).map((list) => list.name.toLocaleLowerCase()));
  for (const [n, list] of mine.entries()) {
    progress?.(`Playlists: ${n + 1} of ${mine.length}`);
    try {
      if (names.has(list.name.toLocaleLowerCase())) report.already++;
      else {
        const songs = [...new Set((await client.playlistSongs(from, list.id)).map((song) => song.id))];
        await client.createPlaylist(to, list.name, songs, []);
        names.add(list.name.toLocaleLowerCase());
        report.playlists++;
      }
      if (options.hideOriginals && (await client.playlistAccess(from, list.id)).everyone) {
        await client.setPlaylistAccess(from, list.id, { everyone: false });
        report.hidden++;
      }
    } catch (error) {
      if (error instanceof JellyfinProblem && error.kind === "unreachable") throw error;
      report.failed.push(`${list.name}: ${error instanceof Error ? error.message : String(error)}`);
    }
  }
  return report;
}

export function describeCopy(report: CopyReport, profile: string): string {
  const count = (n: number, word: string): string => `${n} ${word}${n === 1 ? "" : "s"}`;
  const parts = [`${count(report.favorites, "favorite")} and ${count(report.playlists, "playlist")} copied to ${profile}.`];
  if (report.already) parts.push(`${count(report.already, "playlist")} ${report.already === 1 ? "was" : "were"} already there.`);
  if (report.hidden) parts.push(`${count(report.hidden, "old playlist")} now ${report.hidden === 1 ? "shows" : "show"} only to the old account.`);
  if (report.files) parts.push(`${count(report.files, "playlist file")} in the music folder ${report.files === 1 ? "was" : "were"} left: every profile sees ${report.files === 1 ? "it" : "them"} already.`);
  if (report.failed.length) parts.push(`${count(report.failed.length, "playlist")} could not be copied (${report.failed[0]}).`);
  return parts.join(" ");
}
