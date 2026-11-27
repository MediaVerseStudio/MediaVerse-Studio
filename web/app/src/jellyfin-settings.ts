// Settings > Jellyfin (D90): helps set up a Jellyfin server for the music library, so TVs and other devices can play
// it even while this program is closed (the MediaVerse TV app plays from Jellyfin too). It finds servers on this
// computer and the home network, points to Jellyfin's own installer, shows the music folder to add, checks Quick
// Connect (how the TV signs in) and Windows Firewall. It never changes a server itself. Text is set with textContent.

import { copyText, invoke, jellyfinBridge, type JellyfinServerInfo } from "./desktop-bridge";
import { el } from "./dom";
import { chooseServer, chosenServer, hiddenServers, onChosenServerChange, readSaved, setHiddenServers, SESSION_STORE } from "./jellyfin-desktop";
import type { Session } from "../phone/jellyfin-phone.ts";

const button = (text: string, className = "secondary"): HTMLButtonElement => {
  const b = el("button", className, text);
  b.type = "button";
  return b;
};

/** `syncRoot` is where the default server's sign-in and sync block is drawn (main.ts hands it to problem-sync-ui). */
export function renderJellyfinSettings(root: HTMLElement): { refresh: () => void; syncRoot: HTMLElement; profilesRoot: HTMLElement } {
  root.className = "settings-block jellyfin-settings";
  const bridge = jellyfinBridge();
  const status = el("p", "field-hint");
  status.setAttribute("role", "status");
  const servers = el("div", "jellyfin-servers");
  const hiddenNote = el("p", "field-hint");
  const syncRoot = el("div", "jellyfin-sync");
  const profilesRoot = el("div");
  const firewallBox = el("div", "jellyfin-firewall");
  const steps = el("div", "jellyfin-steps");
  const again = button("Search again");
  let searching = false;

  root.replaceChildren(
    el("h3", undefined, "Jellyfin server"),
    el("p", "field-hint", "Jellyfin is a free media server that runs on a computer at home. With it your TVs and other devices can play your music library even when MediaVerse Studio is closed, and the MediaVerse TV app can play from it. Jellyfin is a separate program from its own makers; your music files stay where they are and are not changed."),
    status,
    servers,
    hiddenNote,
    syncRoot,
    profilesRoot,
    firewallBox,
    steps,
    again,
  );
  if (!bridge) {
    status.textContent = "Jellyfin setup works in the desktop program only.";
    again.hidden = true;
    return { refresh: () => {}, syncRoot, profilesRoot };
  }

  async function musicFolder(): Promise<string | null> {
    const collection = await invoke<{ root?: string | null }>("collection_status").catch(() => null);
    return collection?.root ?? null;
  }

  /** The "add your music folder" step, with the path and a Copy button. */
  async function folderStep(): Promise<HTMLElement> {
    const li = el("li");
    const folder = await musicFolder();
    li.append(el("span", undefined, "Add your music: in Jellyfin's setup (or later under Dashboard > Libraries) choose Add Media Library, set Content type to Music, and add this folder: "));
    if (folder) {
      const path = el("code", "jellyfin-path", folder);
      const copy = button("Copy");
      const said = el("span", "field-hint");
      copy.addEventListener("click", async () => {
        said.textContent = (await copyText(folder)) ? " Copied." : " Could not copy; select the text instead.";
      });
      li.append(path, copy, said);
    } else {
      li.append(el("span", undefined, "your music folder (choose it first under Settings > Library)."));
    }
    return li;
  }

  /** Every server the last search found (also the hidden ones), to draw the list again when the default or the hidden ones change. */
  let lastFound: JellyfinServerInfo[] = [];

  function serverRow(server: JellyfinServerInfo): HTMLElement {
    const row = el("div", "jellyfin-server");
    const isDefault = chosenServer()?.id === server.id;
    if (isDefault) row.classList.add("is-default");
    const where = server.onThisComputer ? "on this computer" : `on your network at ${new URL(server.base).hostname}`;
    row.append(el("strong", undefined, server.name), el("span", "field-hint", ` ${where}${server.version ? ` · version ${server.version}` : ""}`));
    const notes = el("ul", "jellyfin-notes");
    if (!server.reachable) notes.append(el("li", undefined, "It answered the search but its web page did not respond. Is it still starting?"));
    if (server.quickConnect === true) notes.append(el("li", undefined, "Quick Connect is on, so the TV app can sign in with a code."));
    else if (server.quickConnect === false) notes.append(el("li", undefined, "Quick Connect is off. The TV app signs in with it: in Jellyfin open Dashboard > General, tick Enable Quick Connect and save."));
    const open = button("Open Jellyfin");
    open.addEventListener("click", () => void bridge!.open(server.id));
    const actions = el("div", "dialog-actions");
    if (isDefault) {
      actions.append(el("strong", undefined, "✔ Your default server"));
    } else {
      const use = button("Use this server", "");
      use.addEventListener("click", () => chooseServer({ id: server.id, name: server.name, base: server.base }));
      actions.append(use);
      const hide = button("Hide");
      hide.title = "Do not list this server (a test server on this computer, say). It can be shown again.";
      hide.addEventListener("click", () => {
        setHiddenServers([...new Set([...hiddenServers(), server.id])]);
        drawServers();
      });
      actions.append(hide);
    }
    actions.append(open);
    row.append(notes, actions);
    return row;
  }

  /** The servers found, minus the hidden ones; a note says how many are hidden and offers to show them. */
  function drawServers(showHidden = false): void {
    const hidden = new Set(hiddenServers());
    const keep = chosenServer()?.id;
    const shown = lastFound.filter((s) => showHidden || !hidden.has(s.id) || s.id === keep);
    servers.replaceChildren(...shown.map(serverRow));
    const count = lastFound.filter((s) => hidden.has(s.id) && s.id !== keep).length;
    hiddenNote.replaceChildren();
    if (count > 0 && !showHidden) {
      const show = button(`Show ${count} hidden server${count === 1 ? "" : "s"}`);
      show.addEventListener("click", () => drawServers(true));
      hiddenNote.append(show);
    } else if (showHidden && lastFound.some((s) => hidden.has(s.id))) {
      const unhide = button("Stop hiding servers");
      unhide.addEventListener("click", () => {
        setHiddenServers([]);
        drawServers();
      });
      hiddenNote.append(unhide);
    }
  }

  onChosenServerChange(() => drawServers());

  async function showFirewall(): Promise<void> {
    firewallBox.replaceChildren();
    const state = await bridge!.firewallCheck().catch(() => null);
    if (!state) return;
    if (!state.blocked) {
      firewallBox.append(el("p", "field-hint", "Windows Firewall lets TVs on this network reach the Jellyfin server on this computer."));
      return;
    }
    const allow = button("Let TVs reach Jellyfin");
    const said = el("span", "field-hint");
    allow.addEventListener("click", async () => {
      allow.disabled = true;
      said.textContent = " Windows will ask for permission…";
      const ok = await bridge!.firewallAllow().catch(() => false);
      said.textContent = ok ? " Done: TVs can reach Jellyfin now." : " Not changed (the permission prompt was declined, or the rule could not be added).";
      allow.disabled = false;
    });
    firewallBox.append(
      el("p", undefined, `Windows Firewall is turning TVs away from the Jellyfin server on this computer (the network is ${state.categories.join(", ").toLowerCase() || "unknown"}). This adds two narrow rules, for Jellyfin's ports on private networks only; Windows asks for an administrator's permission.`),
      allow,
      said,
    );
  }

  async function search(): Promise<void> {
    if (searching) return;
    searching = true;
    again.disabled = true;
    status.textContent = "Looking for Jellyfin on this computer and your network…";
    servers.replaceChildren();
    hiddenNote.replaceChildren();
    firewallBox.replaceChildren();
    steps.replaceChildren();
    try {
      const found = await bridge!.find();
      lastFound = found;
      // No default chosen yet: the one this computer is already signed in to, else the only server there is (not counting hidden ones).
      if (!chosenServer()) {
        const session = readSaved<Session | null>(SESSION_STORE, null);
        const visible = found.filter((s) => !hiddenServers().includes(s.id));
        const pick = found.find((s) => s.id === session?.serverId) ?? (visible.length === 1 ? visible[0] : undefined);
        if (pick) chooseServer({ id: pick.id, name: pick.name, base: pick.base });
      }
      const local = found.find((s) => s.onThisComputer);
      status.textContent = found.length === 0 ? "No Jellyfin server was found on this computer or your network." : `Found ${found.length === 1 ? "a Jellyfin server" : `${found.length} Jellyfin servers`}:`;
      drawServers();
      const list = el("ol", "jellyfin-step-list");
      if (found.length === 0) {
        const download = button("Download Jellyfin for Windows", "");
        download.addEventListener("click", () => void bridge!.downloadPage());
        const first = el("li");
        first.append(el("span", undefined, "Install Jellyfin on the computer that is usually on (this one is fine): "), download, el("span", undefined, " opens jellyfin.org in your browser. Choose the Windows installer (.exe), run it and accept the defaults."));
        list.append(first, el("li", undefined, "When it has installed, Jellyfin opens its setup page in your browser (if not, open http://localhost:8096). Choose your language and make a user name and password for yourself."));
        list.append(await folderStep());
        list.append(el("li", undefined, "Come back here and press Search again: this page then checks that TVs can reach it."));
        steps.append(el("p", "field-label", "Setting up Jellyfin"), list);
      } else {
        if (local) {
          list.append(await folderStep());
          void showFirewall();
        }
        list.append(el("li", undefined, "On the TV: open MediaVerse Studio, choose Jellyfin server, and enter the Quick Connect code it shows in Jellyfin (your profile > Quick Connect)."));
        steps.append(el("p", "field-label", "Next"), list);
      }
    } catch (error) {
      status.textContent = `The search did not finish: ${error instanceof Error ? error.message : String(error)}`;
    } finally {
      searching = false;
      again.disabled = false;
    }
  }

  again.addEventListener("click", () => void search());
  return { refresh: () => void search(), syncRoot, profilesRoot };
}
