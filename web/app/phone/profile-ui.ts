// "Who's listening?" on the phone (D213): asked when the server is first connected (choose a profile or make one, and
// whether to ask at every start), at start when wanted, and from Settings. Text is set with textContent.

import { createProfile, listProfiles, profileNameProblem } from "../src/jellyfin-profiles.ts";
import { declineSetup, readProfile } from "./device-profile.ts";
import type { Jellyfin, ServerUser, Session } from "./jellyfin-phone.ts";

/** `setup`: the first choice for this phone; `start`: just who it is now; `switch`: from Settings. */
export type ProfileAsk = "setup" | "start" | "switch";

export type ProfileUiDeps = {
  root: HTMLElement;
  jf: Jellyfin;
  session: () => Session | null;
  /** Makes this the phone's profile; throws, with words to show, when it cannot. */
  choose: (name: string, askAtStart: boolean) => Promise<void>;
};

const NAMES = "mediaverse.phone.profile-names";
const COLOURS = ["#e88647", "#4fa3e0", "#6cc070", "#d65db1", "#f0c24b", "#8f7ae5", "#e05d5d", "#3fbfb0"];

const make = <K extends keyof HTMLElementTagNameMap>(tag: K, className?: string, text?: string): HTMLElementTagNameMap[K] => {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
};
const said = (thrown: unknown): string => (thrown instanceof Error ? thrown.message : "That did not work.");

export function createProfileUi(deps: ProfileUiDeps): { open: (ask: ProfileAsk) => Promise<boolean>; close: () => void; isOpen: () => boolean } {
  const close = (): void => {
    deps.root.hidden = true;
    deps.root.replaceChildren();
  };

  /** The server's profiles, or the ones seen last when it cannot be asked (away from home). */
  async function profiles(base: string): Promise<{ users: ServerUser[]; remembered: boolean }> {
    try {
      const users = await listProfiles(deps.jf, base);
      localStorage.setItem(NAMES, JSON.stringify(users));
      return { users, remembered: false };
    } catch {
      let users: ServerUser[] = [];
      try {
        users = JSON.parse(localStorage.getItem(NAMES) ?? "[]") as ServerUser[];
      } catch {
        /* none remembered */
      }
      return { users, remembered: true };
    }
  }

  /** Shows the picker. False when there is nothing to ask (not signed in, or at start with no profiles). */
  async function open(ask: ProfileAsk): Promise<boolean> {
    const session = deps.session();
    if (!session) return false;
    const found = await profiles(session.base);
    if (!found.users.length && (ask === "start" || found.remembered)) return false;
    const current = readProfile();
    let busy = false;

    const status = make("p", "hint");
    status.setAttribute("role", "status");
    if (found.remembered) status.textContent = "The home server did not answer: a profile used on this phone before can still be chosen.";
    const box = make("div", "who-box");
    box.append(make("h1", undefined, ask === "setup" ? "Who uses this phone?" : "Who's listening?"));
    const list = make("div", "who-list");

    const asking = make("input");
    asking.type = "checkbox";
    asking.checked = current?.askAtStart === true;

    const pick = async (name: string): Promise<void> => {
      if (busy) return;
      busy = true;
      status.textContent = `Opening ${name}…`;
      try {
        await deps.choose(name, asking.checked);
      } catch (thrown) {
        status.textContent = said(thrown);
        busy = false;
      }
    };

    found.users.forEach((user, index) => {
      const tile = make("button", current?.name === user.name ? "who-tile is-current" : "who-tile");
      tile.type = "button";
      tile.dataset.profile = user.name;
      const avatar = make("span", "who-avatar", user.name.trim().charAt(0).toUpperCase() || "?");
      avatar.style.background = COLOURS[index % COLOURS.length] as string;
      tile.append(avatar, make("span", "who-name", user.name));
      tile.addEventListener("click", () => void pick(user.name));
      list.append(tile);
    });
    box.append(list);

    if (ask !== "start") {
      if (!found.remembered) box.append(newProfile(session, found.users, status, pick));
      const row = make("label", "who-ask");
      row.append(asking, make("span", undefined, "Ask who's listening when the app starts"));
      box.append(row);
      if (ask === "setup" && !current) box.append(make("p", "hint", "The favorites, playlists and play history already on this phone become the chosen profile's."));
    }
    box.append(status);
    if (ask !== "start" || current) {
      const leave = make("button", "secondary", ask === "setup" ? "Not now" : "Close");
      leave.type = "button";
      leave.addEventListener("click", () => {
        if (busy) return;
        // Closing keeps whoever is current; the tick box is still taken.
        if (current && ask === "switch") void pick(current.name);
        else {
          if (!current) declineSetup(session.serverId);
          close();
        }
      });
      box.append(leave);
    }
    deps.root.replaceChildren(box);
    deps.root.hidden = false;
    return true;
  }

  function newProfile(session: Session, users: ServerUser[], status: HTMLElement, pick: (name: string) => Promise<void>): HTMLElement {
    const holder = make("div", "who-new");
    const show = make("button", "secondary", "New profile");
    show.type = "button";
    const field = (label: string, type = "text"): HTMLInputElement => {
      const input = make("input", "tv-name");
      input.type = type;
      input.placeholder = label;
      input.setAttribute("aria-label", label);
      input.setAttribute("autocomplete", "off");
      input.setAttribute("autocapitalize", type === "text" ? "words" : "off");
      return input;
    };
    show.addEventListener("click", () => {
      const name = field("New profile's name");
      const admin = field("Jellyfin administrator's name");
      admin.setAttribute("autocapitalize", "off");
      const password = field("Administrator's password", "password");
      const add = make("button", "primary", "Add profile");
      add.type = "button";
      add.addEventListener("click", () => {
        const problem = profileNameProblem(name.value, users.map((u) => u.name));
        if (problem) {
          status.textContent = problem;
          return;
        }
        add.disabled = true;
        status.textContent = "Adding the profile…";
        const secret = password.value;
        password.value = ""; // not kept, whatever comes of it
        createProfile(deps.jf, { base: session.base, name: session.name, id: session.serverId }, { name: admin.value, password: secret }, name.value)
          .then((made) => pick(made.name))
          .catch((thrown) => {
            status.textContent = said(thrown);
            add.disabled = false;
          });
      });
      holder.replaceChildren(make("p", "hint", "A profile has no password. Only the server's administrator can add one: their name and password are used once and not kept."), name, admin, password, add);
      name.focus();
    });
    holder.append(show);
    return holder;
  }

  return { open, close, isOpen: () => !deps.root.hidden };
}
