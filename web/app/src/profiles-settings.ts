// Settings > Jellyfin > Profiles (D213): makes profiles on the default server (with the administrator's name and password, used once
// and not kept) and copies an existing account's favorites and playlists, and this computer's favorites, into one. Text is set with
// textContent. The logic is in jellyfin-profiles.ts.

import type { ServerUser, Session } from "../phone/jellyfin-phone.ts";
import { el } from "./dom";
import { chosenServer, desktopJellyfin, onChosenServerChange, savedDesktopSession } from "./jellyfin-desktop";
import { copyIntoProfile, createProfile, describeCopy, listProfiles, openProfile, shareFlagLists } from "./jellyfin-profiles.ts";
import { serverSongId } from "./library-mode";
import { tailKey } from "./playlist-sync.ts";

export type ProfilesSettingsDeps = {
  /** This computer's favorite songs (file paths, or server names when the server alone is the library). */
  favorites: () => string[];
};

const button = (text: string, className = "secondary"): HTMLButtonElement => {
  const b = el("button", className, text);
  b.type = "button";
  return b;
};

function field(label: string, type = "text"): { row: HTMLElement; input: HTMLInputElement } {
  const input = el("input");
  input.type = type;
  input.autocomplete = "off";
  input.spellcheck = false;
  const row = el("label", "profile-field");
  row.append(el("span", undefined, label), input);
  return { row, input };
}

const said = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : "That did not work.");

export function renderProfilesSettings(root: HTMLElement, deps: ProfilesSettingsDeps): { refresh: () => void } {
  root.className = "profiles-settings";
  const jf = desktopJellyfin();
  const listed = el("p", "field-hint");
  const status = el("p", "field-hint");
  status.setAttribute("role", "status");

  const name = field("New profile's name");
  const adminName = field("Administrator's name");
  const adminPassword = field("Administrator's password", "password");
  const add = button("Add profile", "");
  const form = el("div", "profile-form");
  form.append(name.row, adminName.row, adminPassword.row, add);

  const into = el("select");
  const intoRow = el("label", "profile-field");
  intoRow.append(el("span", undefined, "Copy into"), into);
  const hide = el("input");
  hide.type = "checkbox";
  hide.checked = true;
  const hideRow = el("label", "check");
  const hideText = el("span");
  hideRow.append(hide, hideText);
  const copy = button("Copy favorites and playlists");
  const copyNote = el("p", "field-hint");
  const copyBox = el("div", "profile-form");
  copyBox.append(el("p", "field-label", "Move your own things into a profile"), copyNote, intoRow, hideRow, copy);

  let profiles: ServerUser[] = [];
  let account = "";
  let busy = false;
  let looking = false;

  function draw(): void {
    const server = chosenServer();
    form.hidden = !server;
    const session = savedDesktopSession();
    copyBox.hidden = !server || !session || profiles.length === 0 || !account;
    listed.textContent = !server
      ? "Choose your default server above (Use this server) to see and add profiles."
      : looking
        ? `Looking for profiles on ${server.name}…`
        : profiles.length
          ? `Profiles on ${server.name}: ${profiles.map((p) => p.name).join(", ")}.`
          : `No profiles on ${server.name} yet.`;
    const chosen = into.value;
    into.replaceChildren(
      ...profiles.map((p) => {
        const option = el("option", undefined, p.name);
        option.value = p.name;
        return option;
      }),
    );
    if (profiles.some((p) => p.name === chosen)) into.value = chosen;
    copyNote.textContent = `Copies the favorites and playlists of the account this computer is signed in with (${account}), and this computer's own favorites. Nothing is deleted.`;
    hideText.textContent = `Hide ${account}'s playlists from the profiles (they stay on ${account}), so no list shows twice`;
    add.disabled = busy;
    copy.disabled = busy;
  }

  async function refresh(): Promise<void> {
    const server = chosenServer();
    looking = !!server;
    draw();
    if (!server) return;
    try {
      profiles = await listProfiles(jf, server.base);
      const session = savedDesktopSession();
      // An account that is itself a profile has nothing to move.
      const me = session && session.serverId === server.id ? await jf.me(session).catch(() => null) : null;
      account = me && !profiles.some((p) => p.id === me.id) ? me.name : "";
    } catch (thrown) {
      status.textContent = said(thrown);
    }
    looking = false;
    draw();
  }

  async function run(work: () => Promise<void>): Promise<void> {
    if (busy) return;
    busy = true;
    draw();
    try {
      await work();
    } catch (thrown) {
      status.textContent = said(thrown);
    } finally {
      busy = false;
      draw();
    }
  }

  /** Everyone on the server may check and clear the flags: this computer's account lets the others in. */
  async function letEveryoneAtTheFlags(session: Session | null): Promise<void> {
    if (session) await shareFlagLists(jf, session).catch(() => 0);
  }

  add.addEventListener("click", () =>
    void run(async () => {
      const server = chosenServer();
      if (!server) return;
      status.textContent = "Adding the profile…";
      const password = adminPassword.input.value;
      adminPassword.input.value = ""; // not kept, whatever comes of it
      const made = await createProfile(jf, server, { name: adminName.input.value, password }, name.input.value);
      name.input.value = "";
      await letEveryoneAtTheFlags(savedDesktopSession());
      await refresh();
      into.value = made.name;
      status.textContent = `${made.name} was added. It can be picked on your devices.`;
    }),
  );

  copy.addEventListener("click", () =>
    void run(async () => {
      const server = chosenServer();
      const from = savedDesktopSession();
      const wanted = into.value;
      if (!server || !from || !wanted) return;
      if (!window.confirm(`Copy ${account}'s favorites and playlists, and this computer's favorites, into the profile ${wanted}?${hide.checked ? `\n\n${account}'s playlists will then show only to ${account}.` : ""}`)) return;
      status.textContent = "Copying…";
      const to = await openProfile(jf, server, wanted);
      try {
        const report = await copyIntoProfile(jf, from, to, { hideOriginals: hide.checked }, (text) => (status.textContent = `Copying… ${text}`));
        const here = deps.favorites();
        let added = 0;
        let missing = 0;
        if (here.length) {
          const songs = await jf.serverSongs(from);
          const byTail = new Map<string, string[]>();
          for (const song of songs) byTail.set(tailKey(song.path), [...(byTail.get(tailKey(song.path)) ?? []), song.id]);
          const have = new Set(await jf.favoriteIds(to));
          for (const path of here) {
            // A file the server holds once under the same folders and name; two alike are left alone rather than guessed.
            const found = serverSongId(path) ? [serverSongId(path)!] : (byTail.get(tailKey(path)) ?? []);
            if (found.length !== 1) missing++;
            else if (!have.has(found[0]!)) {
              await jf.setFavorite(to, found[0]!, true);
              have.add(found[0]!);
              added++;
            }
          }
        }
        await letEveryoneAtTheFlags(from);
        status.textContent = `${describeCopy(report, wanted)}${added ? ` ${added} of this computer's favorites added.` : ""}${missing ? ` ${missing} of this computer's favorites could not be matched to a song on the server.` : ""}`;
      } finally {
        await jf.signOut(to).catch(() => undefined);
      }
    }),
  );

  onChosenServerChange(() => void refresh());
  root.replaceChildren(
    el("h4", undefined, "Profiles"),
    el("p", "field-hint", "A profile has its own favorites, playlists and last played, and no password: pick yours on the TV, the phone or the computer. Profiles are users on your Jellyfin server, so only its administrator's password can add one. Anyone on your home network can open them."),
    listed,
    form,
    copyBox,
    status,
  );
  draw();
  return { refresh: () => void refresh() };
}
