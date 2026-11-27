// Which profile this phone is being used as (D213), and each profile's own things kept apart on the phone. What the
// page stores under a plain key is always the current profile's; switching puts it away under the profile's name and
// brings the other's out. The first profile chosen on a phone takes over what the phone already had. Pure, with the
// storage passed in, so it is unit tested.

/** `adopted`: the profile that took over what the phone had before profiles (the app itself needs to know it too). */
export type DeviceProfile = { name: string; adopted: string; askAtStart: boolean };

const STORE = "mediaverse.phone.profile";
const SESSIONS = "mediaverse.phone.profile-sessions";

/** The page's keys that belong to a person, not to the phone. (Flags, downloads and the server stay shared.) */
export const PROFILE_KEYS = [
  "mediaverse.phone.playlists",
  "mediaverse.phone.home-playlists",
  "mediaverse.phone.queues",
  "mediaverse.phone.bookmarks",
  "mediaverse.phone.favorite-held",
  "mediaverse.phone.plays-sent",
];

/** What the last rounds with an account agreed on: never carried into a profile, or its first round could delete things. */
const AGREEMENTS = ["mediaverse.phone.home-playlists", "mediaverse.phone.favorite-held", "mediaverse.phone.plays-sent"];

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

const read = <T>(storage: Storage, key: string, fallback: T): T => {
  try {
    const text = storage.getItem(key);
    return text ? (JSON.parse(text) as T) : fallback;
  } catch {
    return fallback;
  }
};

export function readProfile(storage: Storage = localStorage): DeviceProfile | null {
  const saved = read<DeviceProfile | null>(storage, STORE, null);
  return saved && typeof saved.name === "string" && saved.name && typeof saved.adopted === "string" ? { name: saved.name, adopted: saved.adopted, askAtStart: saved.askAtStart === true } : null;
}

const DECLINED = "mediaverse.phone.profile-not-now";

/** "Not now" to the first question on this server: it is not asked again at start (Settings still offers it). */
export function declineSetup(serverId: string, storage: Storage = localStorage): void {
  storage.setItem(DECLINED, JSON.stringify(serverId));
}

export function setupDeclined(serverId: string, storage: Storage = localStorage): boolean {
  return read<string>(storage, DECLINED, "") === serverId;
}

export function setAskAtStart(on: boolean, storage: Storage = localStorage): void {
  const profile = readProfile(storage);
  if (profile) storage.setItem(STORE, JSON.stringify({ ...profile, askAtStart: on }));
}

const aside = (key: string, name: string): string => `${key}@${name.toLocaleLowerCase()}`;

/** Makes `name` the phone's profile, moving each person's things out of the way and in. */
export function switchProfile(name: string, storage: Storage = localStorage): DeviceProfile {
  const current = readProfile(storage);
  if (!current) {
    for (const key of AGREEMENTS) storage.removeItem(key);
    const first = { name, adopted: name, askAtStart: false };
    storage.setItem(STORE, JSON.stringify(first));
    return first;
  }
  if (current.name.toLocaleLowerCase() === name.toLocaleLowerCase()) return current;
  for (const key of PROFILE_KEYS) {
    const mine = storage.getItem(key);
    const theirs = storage.getItem(aside(key, name));
    // The new person's copy is written before the old one's is removed, so an interrupted switch loses nothing.
    if (mine !== null) storage.setItem(aside(key, current.name), mine);
    else storage.removeItem(aside(key, current.name));
    if (theirs !== null) storage.setItem(key, theirs);
    else storage.removeItem(key);
    storage.removeItem(aside(key, name));
  }
  const next = { ...current, name };
  storage.setItem(STORE, JSON.stringify(next));
  return next;
}

/** A profile's sign-in, kept so it can be switched to away from home. */
export function savedProfileSession<S>(name: string, serverId: string, storage: Storage = localStorage): S | null {
  return read<Record<string, S>>(storage, SESSIONS, {})[`${serverId}:${name.toLocaleLowerCase()}`] ?? null;
}

export function keepProfileSession<S>(name: string, serverId: string, session: S | null, storage: Storage = localStorage): void {
  const all = read<Record<string, S>>(storage, SESSIONS, {});
  const key = `${serverId}:${name.toLocaleLowerCase()}`;
  if (session) all[key] = session;
  else delete all[key];
  storage.setItem(SESSIONS, JSON.stringify(all));
}
