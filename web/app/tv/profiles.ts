// "Who's listening?" (D45): the people who use this TV, each with their own favorites. Owner decisions: profiles
// live on each TV (not on the computer), no PINs, and flags stay the household's (with the flagger's name).
// Kept in the TV app's page storage; favorites are kept per person and per music source, because the same
// song has a different ID on the computer, in Jellyfin and on a USB drive.

export type Profile = { id: string; name: string; colour: number };

/** Avatar colours, picked in turn for new people. */
export const PROFILE_COLOURS = ["#e88647", "#4fa3e0", "#6cc070", "#d65db1", "#f0c24b", "#8f7ae5", "#e05d5d", "#3fbfb0"];

const PROFILES = "mediaverse.tv.profiles";
const LAST = "mediaverse.tv.profile.last";
const MAX_PROFILES = 8;

type Storage = Pick<globalThis.Storage, "getItem" | "setItem" | "removeItem">;

function store(): Storage | null {
  try {
    return globalThis.localStorage ?? null;
  } catch {
    return null;
  }
}

export function cleanName(name: string): string {
  return name.replace(/[\u0000-\u001f\u007f]/g, "").replace(/\s+/g, " ").trim().slice(0, 20);
}

export function listProfiles(storage: Storage | null = store()): Profile[] {
  try {
    const saved = JSON.parse(storage?.getItem(PROFILES) ?? "[]");
    return Array.isArray(saved) ? saved.filter((p) => p && typeof p.id === "string" && typeof p.name === "string").slice(0, MAX_PROFILES) : [];
  } catch {
    return [];
  }
}

function save(profiles: Profile[], storage: Storage | null): void {
  try {
    storage?.setItem(PROFILES, JSON.stringify(profiles));
  } catch {
    // storage full: the change lasts until the app closes
  }
}

export function canAddProfile(storage: Storage | null = store()): boolean {
  return listProfiles(storage).length < MAX_PROFILES;
}

/** Adds a person; null if the name is empty, already used (ignoring case) or there are already eight. */
export function addProfile(name: string, storage: Storage | null = store()): Profile | null {
  const clean = cleanName(name);
  const profiles = listProfiles(storage);
  if (!clean || profiles.length >= MAX_PROFILES || profiles.some((p) => p.name.toLowerCase() === clean.toLowerCase())) return null;
  const used = new Set(profiles.map((p) => p.colour));
  const colour = PROFILE_COLOURS.findIndex((_, i) => !used.has(i));
  const profile = { id: `p${Date.now().toString(36)}${Math.random().toString(36).slice(2, 6)}`, name: clean, colour: colour < 0 ? profiles.length % PROFILE_COLOURS.length : colour };
  save([...profiles, profile], storage);
  return profile;
}

export function renameProfile(id: string, name: string, storage: Storage | null = store()): boolean {
  const clean = cleanName(name);
  const profiles = listProfiles(storage);
  if (!clean || profiles.some((p) => p.id !== id && p.name.toLowerCase() === clean.toLowerCase())) return false;
  save(profiles.map((p) => (p.id === id ? { ...p, name: clean } : p)), storage);
  return true;
}

/** Removes a person and their favorites on this TV. */
export function removeProfile(id: string, storage: Storage | null = store()): void {
  save(listProfiles(storage).filter((p) => p.id !== id), storage);
  try {
    const prefix = `mediaverse.tv.favorites:${id}:`;
    const keys: string[] = [];
    const all = storage as unknown as { length?: number; key?: (i: number) => string | null };
    for (let i = 0; i < (all.length ?? 0); i++) {
      const key = all.key?.(i);
      if (key?.startsWith(prefix)) keys.push(key);
    }
    for (const key of keys) storage?.removeItem(key);
    if (storage?.getItem(LAST) === id) storage.removeItem(LAST);
  } catch {
    // left behind: harmless
  }
}

export function lastProfile(storage: Storage | null = store()): string | null {
  try {
    return storage?.getItem(LAST) ?? null;
  } catch {
    return null;
  }
}

export function rememberProfile(id: string, storage: Storage | null = store()): void {
  try {
    storage?.setItem(LAST, id);
  } catch {
    // asked again next time anyway
  }
}

/** A person's favorite song IDs from one music source ("computer:Home-PC", "jellyfin:<id>", "drive:<label>"). */
export function profileFavorites(profileId: string, source: string, storage: Storage | null = store()): string[] {
  try {
    const saved = JSON.parse(storage?.getItem(`mediaverse.tv.favorites:${profileId}:${source}`) ?? "[]");
    return Array.isArray(saved) ? saved.filter((id) => typeof id === "string") : [];
  } catch {
    return [];
  }
}

export function setProfileFavorite(profileId: string, source: string, id: string, on: boolean, storage: Storage | null = store()): void {
  const favorites = profileFavorites(profileId, source, storage).filter((entry) => entry !== id);
  if (on) favorites.push(id);
  try {
    storage?.setItem(`mediaverse.tv.favorites:${profileId}:${source}`, JSON.stringify(favorites));
  } catch {
    // storage full
  }
}
