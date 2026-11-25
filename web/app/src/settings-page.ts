// The Settings page: where the user enters their own information for the lookup services (who
// they are, which servers and ports to use, credentials), and chooses the Media Library Archive
// folder. See docs/architecture/0006-disc-metadata-lookup.md.
//
// Credentials are never displayed. Each shows "Saved" or "Not set" with Change and Remove buttons;
// a new value is typed into a password field and is sent only when the user saves.
// All text is set with textContent; nothing from the sidecar is inserted as HTML.

import { invoke, open } from "./desktop-bridge";
import { toApiError } from "./drive-format";
import {
  type CddbServer,
  type MetadataView,
  type SecretEdits,
  type SecretId,
  SECRET_FIELDS,
  buildUpdate,
  secretIsSet,
  describeSecret,
  newServer,
  parseNumber,
  splitProblems,
  withTransport,
} from "./settings-form";

import { el } from "./dom";
import type { ArchiveView } from "./rip-format";

let idCounter = 0;
const nextId = (prefix: string): string => `${prefix}-${(idCounter += 1)}`;

function labelled(label: string, control: HTMLElement, hint?: string): HTMLElement {
  const wrapper = el("div", "field");
  const id = nextId("f");
  control.id = id;
  const text = el("label", undefined, label);
  text.htmlFor = id;
  wrapper.append(text, control);
  if (hint) {
    const note = el("p", "field-hint", hint);
    note.id = `${id}-hint`;
    control.setAttribute("aria-describedby", note.id);
    wrapper.append(note);
  }
  return wrapper;
}

function textInput(value: string, onChange: (value: string) => void, type = "text"): HTMLInputElement {
  const input = el("input");
  input.type = type;
  input.value = value;
  input.addEventListener("input", () => onChange(input.value));
  return input;
}

function numberInput(value: number, onChange: (value: number) => void, fallback: number): HTMLInputElement {
  const input = el("input");
  input.type = "number";
  input.value = String(value);
  input.addEventListener("input", () => onChange(parseNumber(input.value, fallback)));
  return input;
}

function checkbox(label: string, value: boolean, onChange: (value: boolean) => void): HTMLElement {
  const wrapper = el("label", "check");
  const input = el("input");
  input.type = "checkbox";
  input.checked = value;
  input.addEventListener("change", () => onChange(input.checked));
  wrapper.append(input, el("span", undefined, label));
  return wrapper;
}

export function initSettingsPage(root: HTMLElement): { refresh: () => Promise<void> } {
  const statusLine = root.querySelector<HTMLElement>("#settings-status")!;
  const problemsBox = root.querySelector<HTMLElement>("#settings-problems")!;
  const archiveBox = root.querySelector<HTMLElement>("#settings-archive")!;
  const historyBox = root.querySelector<HTMLElement>("#settings-history")!;
  const lyricsBox = root.querySelector<HTMLElement>("#settings-lyrics")!;
  const listenBox = root.querySelector<HTMLElement>("#settings-listen")!;
  const formBox = root.querySelector<HTMLElement>("#settings-form-body")!;
  const saveButton = root.querySelector<HTMLButtonElement>("#settings-save")!;
  const reloadButton = root.querySelector<HTMLButtonElement>("#settings-reload")!;

  let draft: MetadataView | null = null;
  let edits: SecretEdits = {};
  let editing = new Set<SecretId>(); // credentials whose input box is open

  const say = (message: string): void => {
    statusLine.textContent = message;
  };

  function showProblems(lines: string[]): void {
    problemsBox.replaceChildren();
    problemsBox.hidden = lines.length === 0;
    if (lines.length === 0) return;
    problemsBox.append(el("p", "problem-title", "These settings need attention before they can be saved:"));
    const list = el("ul");
    for (const line of lines) list.append(el("li", undefined, line));
    problemsBox.append(list);
    problemsBox.scrollIntoView({ block: "nearest" });
  }

  function secretField(id: SecretId, label: string, hint: string): HTMLElement {
    const field = SECRET_FIELDS.find((entry) => entry.id === id)!;
    const view = (draft as any)[field.group][field.key] as { set: boolean };
    const wrapper = el("div", "field secret-field");
    const heading = el("span", "field-label", label);
    const status = el("span", secretIsSet(view, edits[id]) ? "secret-status" : "secret-status unset", describeSecret(view, edits[id]));
    status.setAttribute("role", "status");
    const row = el("div", "secret-row");

    if (editing.has(id)) {
      const input = textInput(typeof edits[id] === "string" ? (edits[id] as string) : "", (value) => {
        edits[id] = value;
        status.textContent = describeSecret(view, edits[id]);
        status.className = secretIsSet(view, edits[id]) ? "secret-status" : "secret-status unset";
      }, "password");
      input.autocomplete = "off";
      input.setAttribute("aria-label", `${label}: type the new value`);
      const cancel = el("button", "secondary", "Cancel change");
      cancel.type = "button";
      cancel.addEventListener("click", () => {
        delete edits[id];
        editing.delete(id);
        render();
      });
      row.append(input, cancel);
    } else {
      const change = el("button", "secondary", view.set ? "Change" : "Enter");
      change.type = "button";
      change.addEventListener("click", () => {
        editing.add(id);
        render();
        formBox.querySelector<HTMLInputElement>(`input[aria-label^="${label}"]`)?.focus();
      });
      row.append(change);
      if (view.set && edits[id] !== null) {
        const remove = el("button", "secondary", "Remove");
        remove.type = "button";
        remove.addEventListener("click", () => {
          edits[id] = null;
          render();
        });
        row.append(remove);
      }
      if (edits[id] === null) {
        const undo = el("button", "secondary", "Keep it");
        undo.type = "button";
        undo.addEventListener("click", () => {
          delete edits[id];
          render();
        });
        row.append(undo);
      }
    }
    wrapper.append(heading, status, row, el("p", "field-hint", hint));
    return wrapper;
  }

  function group(title: string, intro?: string): { box: HTMLFieldSetElement; add: (...nodes: HTMLElement[]) => void } {
    const box = el("fieldset", "settings-group");
    box.append(el("legend", undefined, title));
    if (intro) box.append(el("p", "group-intro", intro));
    return { box, add: (...nodes) => box.append(...nodes) };
  }

  function serverCard(server: CddbServer, index: number): HTMLElement {
    const servers = draft!.cddb_servers;
    const update = (change: Partial<CddbServer>): void => {
      servers[index] = { ...servers[index], ...change };
    };
    const card = el("div", "server-card");
    card.append(el("h4", undefined, server.name || `Server ${index + 1}`));
    card.append(checkbox("Use this server", server.enabled, (value) => update({ enabled: value })));
    card.append(labelled("Name", textInput(server.name, (value) => update({ name: value }))));

    const transport = el("select");
    for (const [value, text] of [["https", "HTTPS (secure web, recommended)"], ["http", "HTTP (web)"], ["cddbp", "CDDBP (older direct connection)"]] as const) {
      const option = el("option", undefined, text);
      option.value = value;
      option.selected = server.transport === value;
      transport.append(option);
    }
    transport.addEventListener("change", () => {
      servers[index] = withTransport(servers[index], transport.value as CddbServer["transport"]);
      render();
    });
    card.append(labelled("Connection type", transport));
    card.append(labelled("Server address", textInput(server.host, (value) => update({ host: value.trim() })), "Just the host name, such as gnudb.gnudb.org"));
    card.append(labelled("Port", numberInput(server.port, (value) => update({ port: value }), 0)));
    if (server.transport !== "cddbp") {
      card.append(labelled("Path", textInput(server.path, (value) => update({ path: value.trim() })), "Usually /~cddb/cddb.cgi"));
    }
    card.append(labelled("Protocol level (1–6)", numberInput(server.protocol_level, (value) => update({ protocol_level: value }), 0), "Level 6 uses UTF-8 text; lower levels use older Latin-1 text."));
    card.append(
      labelled("Application name sent to the server", textInput(server.client_name, (value) => update({ client_name: value.trim() })), "gnudb asks for a clear, descriptive program name, not a generic one, and for programs to be registered with them (see docs/gnudb-registration.md). Change this only if you have registered a different name."),
      labelled("Application version sent", textInput(server.client_version, (value) => update({ client_version: value.trim() }))),
      labelled("Minimum time between requests (ms)", numberInput(server.min_interval_ms, (value) => update({ min_interval_ms: value }), 1000)),
      labelled("Give up after (seconds)", numberInput(server.timeout_seconds, (value) => update({ timeout_seconds: value }), 20)),
    );
    const remove = el("button", "secondary", "Remove this server");
    remove.type = "button";
    remove.addEventListener("click", () => {
      servers.splice(index, 1);
      render();
    });
    card.append(remove);
    return card;
  }

  function render(): void {
    formBox.replaceChildren();
    if (!draft) return;
    const d = draft;

    if (d.setup_needed.length > 0) {
      const notice = el("div", "setup-needed");
      notice.append(el("p", "problem-title", "Finish setting up:"));
      const list = el("ul");
      for (const gap of d.setup_needed) list.append(el("li", undefined, gap.message));
      notice.append(list);
      formBox.append(notice);
    }

    const identity = group("Your contact email address", "MusicBrainz and gnudb ask every program to say who is using it, so their operators can contact someone if something goes wrong. gnudb requires an email address in every request. Your address is sent, readable, to those services and to nobody else. Consider a separate address made for this, not your main one. It is never filled in for you.");
    identity.add(
      labelled("Email address", textInput(d.identity.contact, (v) => (d.identity.contact = v.trim())), "Used by MusicBrainz (as contact) and gnudb (as your identification). A web address also satisfies MusicBrainz, but gnudb needs an email address."),
    );

    const mb = group("MusicBrainz", "The main source for album, artist and track names.");
    mb.add(
      checkbox("Use MusicBrainz", d.musicbrainz.enabled, (v) => (d.musicbrainz.enabled = v)),
      labelled("Server address", textInput(d.musicbrainz.base_url, (v) => (d.musicbrainz.base_url = v.trim())), "Change this only if MusicBrainz moves or you run your own copy."),
      labelled("Minimum time between requests (ms)", numberInput(d.musicbrainz.min_interval_ms, (v) => (d.musicbrainz.min_interval_ms = v), 1100), "MusicBrainz allows about one request per second."),
      labelled("Give up after (seconds)", numberInput(d.musicbrainz.timeout_seconds, (v) => (d.musicbrainz.timeout_seconds = v), 20)),
    );

    const cddb = group("CDDB servers (gnudb and similar)", "Older track-name databases. Add your own server or change the address and port if a service moves.");
    d.cddb_servers.forEach((server, index) => cddb.add(serverCard(server, index)));
    const add = el("button", "secondary", "Add a server");
    add.type = "button";
    add.addEventListener("click", () => {
      d.cddb_servers.push(newServer(d.cddb_servers));
      render();
    });
    cddb.add(add);

    const acoustid = group("AcoustID", "Identifies a track from how it sounds, for discs the databases above do not know. The key below is this program’s application key from your AcoustID registration. Lookups by sound are not built yet; the key is stored ready for them.");
    acoustid.add(
      checkbox("Use AcoustID", d.acoustid.enabled, (v) => (d.acoustid.enabled = v)),
      secretField("acoustid.api_key", "Application key", "Shown as Saved or Not set; the key itself is never displayed."),
      labelled("Server address", textInput(d.acoustid.base_url, (v) => (d.acoustid.base_url = v.trim()))),
      labelled("Minimum time between requests (ms)", numberInput(d.acoustid.min_interval_ms, (v) => (d.acoustid.min_interval_ms = v), 340), "AcoustID allows at most 3 requests per second."),
    );

    const discogs = group("Discogs", "Used by Review > Fix tags for albums MusicBrainz does not know: track lists, editions, genres and styles. It needs your own personal access token: on discogs.com go to Settings > Developers and choose Generate new token. Only Discogs' freely licensed catalogue data is used, never its pictures, and its suggestions are shown with a link to Discogs.");
    discogs.add(
      checkbox("Use Discogs", d.discogs.enabled, (v) => (d.discogs.enabled = v)),
      secretField("discogs.token", "Personal access token", "Shown as Saved or Not set; the token itself is never displayed."),
      labelled("Server address", textInput(d.discogs.base_url, (v) => (d.discogs.base_url = v.trim()))),
      labelled("Minimum time between requests (ms)", numberInput(d.discogs.min_interval_ms, (v) => (d.discogs.min_interval_ms = v), 1000), "Discogs allows 60 requests a minute."),
      el("p", "field-hint", "This application uses Discogs’ API but is not affiliated with, sponsored or endorsed by Discogs. ‘Discogs’ is a trademark of Zink Media, LLC."),
    );

    const photos = group("Artist photos: more sources", "Review > Artists first looks for a free photo on Wikimedia. For artists it has none for, these two can be asked as well. Each needs your own key from that service (TheAudioDB: theaudiodb.com, Fanart.tv: fanart.tv, in your account settings), so you accept their terms yourself. Leave them empty to use Wikimedia only. The photo's source is kept in the program's data folder, never written into your songs.");
    photos.add(
      secretField("photos.audiodb_key", "TheAudioDB key", "Shown as Saved or Not set; the key itself is never displayed."),
      secretField("photos.fanart_key", "Fanart.tv personal key", "Shown as Saved or Not set; the key itself is never displayed."),
    );

    const gracenote = group("Gracenote", "Not available in this version. Gracenote does not currently issue new keys to independent developers, so these fields are stored for when access is possible.");
    gracenote.add(
      checkbox("Use Gracenote", d.gracenote.enabled, (v) => (d.gracenote.enabled = v)),
      labelled("Server address", textInput(d.gracenote.base_url, (v) => (d.gracenote.base_url = v.trim()))),
      secretField("gracenote.client_id", "Client ID", "Stored but not used yet."),
      secretField("gracenote.user_id", "User ID", "Stored but not used yet."),
    );

    const art = group("Cover art");
    art.add(
      checkbox("Look up cover art", d.cover_art.enabled, (v) => (d.cover_art.enabled = v)),
      labelled("Server address", textInput(d.cover_art.base_url, (v) => (d.cover_art.base_url = v.trim()))),
    );

    formBox.append(identity.box, mb.box, cddb.box, acoustid.box, discogs.box, photos.box, gracenote.box, art.box);
  }

  function renderArchive(view: ArchiveView): void {
    archiveBox.replaceChildren();
    const box = group("Media Library Archive", "A separate folder where lossless FLAC copies of your CDs are kept. It is write-only: it never appears in your library or playback, and it must be a different folder from your music library, not inside it and not containing it.");
    box.add(
      checkbox("Keep a lossless FLAC archive of each CD I rip", view.archive_enabled, (on) => void setArchiveEnabled(on)),
      el("p", "field-hint", view.archive_enabled ? "On: each rip also saves a verified FLAC master to the archive folder." : "Off: rips make only the MP3 copies for your library. Your archive folder is remembered."),
      el("p", undefined, view.archive_dir ? `Archive folder: ${view.archive_dir}` : "No archive folder chosen."),
      el("p", "field-hint", view.library_dir ? `Music library: ${view.library_dir}` : "No music library folder chosen yet."),
    );
    const choose = el("button", undefined, view.archive_dir ? "Choose a different folder…" : "Choose archive folder…");
    choose.type = "button";
    choose.addEventListener("click", () => void chooseArchive());
    box.add(choose);
    if (view.archive_dir) {
      const clear = el("button", "secondary", "Stop keeping FLAC copies");
      clear.type = "button";
      clear.addEventListener("click", () => void setArchive(null));
      box.add(clear);
    }
    archiveBox.append(box.box);
  }

  type ListenView = { seconds: number; min: number; max: number; recommended_min: number; recommended_max: number };

  function renderListen(view: ListenView): void {
    listenBox.replaceChildren();
    const box = group("Listening to audio defects", `When you press Listen next to an audio defect, a short sample plays with the defect in the middle. Recommended length: ${view.recommended_min} to ${view.recommended_max} seconds (any whole number from ${view.min} to ${view.max} is accepted).`);
    const input = el("input");
    input.type = "number";
    input.min = String(view.min);
    input.max = String(view.max);
    input.step = "1";
    input.value = String(view.seconds);
    input.setAttribute("aria-label", "Sample length in seconds");
    const save = el("button", undefined, "Save");
    save.type = "button";
    save.addEventListener("click", () => void saveListen(input.value));
    box.add(labelled("Sample length (seconds)", input), save);
    listenBox.append(box.box);
  }

  async function loadListen(): Promise<void> {
    try {
      renderListen(await invoke<ListenView>("get_listen_settings"));
    } catch (thrown) {
      showProblems(splitProblems(toApiError(thrown).message));
    }
  }

  async function saveListen(text: string): Promise<void> {
    try {
      await invoke("set_listen_settings", { seconds: Number(text) });
      showProblems([]);
      say("Sample length saved.");
    } catch (thrown) {
      showProblems(splitProblems(toApiError(thrown).message));
    }
    await loadListen();
    root.dispatchEvent(new CustomEvent("listen-seconds-changed", { bubbles: true }));
  }

  type LyricsView = { enabled: boolean; base_url: string };

  function renderLyrics(view: LyricsView): void {
    lyricsBox.replaceChildren();
    const box = group("Online lyrics (LRCLIB)", "Finds lyrics for a song when you press Find lyrics online in the library. Only that song's title, artist, album and length are sent, to the address below, and only when you press the button. Nothing is saved until you look at the lyrics and press Save.");
    box.add(
      checkbox("Allow looking up lyrics online", view.enabled, (on) => void setLyricsLookup(on)),
      el("p", "field-hint", `Server: ${view.base_url}`),
    );
    lyricsBox.append(box.box);
  }

  async function loadLyricsSettings(): Promise<void> {
    try {
      renderLyrics(await invoke<LyricsView>("get_lyrics_settings"));
    } catch (thrown) {
      showProblems(splitProblems(toApiError(thrown).message));
    }
  }

  async function setLyricsLookup(enabled: boolean): Promise<void> {
    try {
      renderLyrics(await invoke<LyricsView>("set_lyrics_settings", { enabled }));
      say(enabled ? "Online lyrics lookup is allowed." : "Online lyrics lookup is switched off.");
    } catch (thrown) {
      showProblems(splitProblems(toApiError(thrown).message));
    }
  }

  type HistoryView = { enabled: boolean; entries: unknown[] };

  function renderHistory(view: HistoryView): void {
    historyBox.replaceChildren();
    const box = group("Listening history", "Remembers which of your songs you played and how often, only on this computer, to fill the Home page (Recently played) and to make the I'm feeling lucky spin prefer albums you have not played lately. It is never sent anywhere. While it is off nothing is recorded.");
    box.add(
      checkbox("Keep a listening history", view.enabled, (on) => void setHistory(on)),
      el("p", "field-hint", `${view.entries.length} song${view.entries.length === 1 ? "" : "s"} remembered.`),
    );
    const clear = el("button", "secondary", "Clear the history now");
    clear.type = "button";
    clear.disabled = view.entries.length === 0;
    clear.addEventListener("click", () => {
      if (window.confirm("Forget everything you have played so far?")) void clearHistory();
    });
    box.add(clear);
    historyBox.append(box.box);
  }

  async function loadHistory(): Promise<void> {
    try {
      renderHistory(await invoke<HistoryView>("list_history"));
    } catch (thrown) {
      showProblems(splitProblems(toApiError(thrown).message));
    }
  }

  async function setHistory(enabled: boolean): Promise<void> {
    try {
      await invoke("set_history_enabled", { enabled });
      say(enabled ? "Listening history is on." : "Listening history is off. Nothing new will be recorded.");
    } catch (thrown) {
      showProblems(splitProblems(toApiError(thrown).message));
    }
    await loadHistory();
  }

  async function clearHistory(): Promise<void> {
    try {
      renderHistory(await invoke<HistoryView>("clear_history"));
      say("Listening history cleared.");
    } catch (thrown) {
      showProblems(splitProblems(toApiError(thrown).message));
    }
  }

  async function setArchiveEnabled(enabled: boolean): Promise<void> {
    try {
      renderArchive(await invoke<ArchiveView>("set_archive_enabled", { enabled }));
      showProblems([]);
      say(enabled ? "FLAC archive copies will be kept." : "FLAC archive copies will not be kept.");
    } catch (thrown) {
      showProblems(splitProblems(toApiError(thrown).message));
      renderArchive(await invoke<ArchiveView>("get_archive_settings"));
    }
  }

  async function setArchive(path: string | null): Promise<void> {
    try {
      renderArchive(await invoke<ArchiveView>("set_archive_dir", { path }));
      showProblems([]);
      say(path ? "Archive folder saved." : "FLAC copies will no longer be kept.");
    } catch (thrown) {
      showProblems(splitProblems(toApiError(thrown).message));
    }
  }

  async function chooseArchive(): Promise<void> {
    const chosen = await open({ directory: true, title: "Choose the Media Library Archive folder" });
    if (typeof chosen === "string") await setArchive(chosen);
  }

  async function save(): Promise<void> {
    if (!draft) return;
    saveButton.disabled = true;
    try {
      draft = await invoke<MetadataView>("set_metadata_settings", { settings: buildUpdate(draft, edits) });
      edits = {};
      editing = new Set();
      showProblems([]);
      render();
      say(draft.setup_needed.length > 0 ? "Settings saved. Some services still need setting up." : "Settings saved.");
    } catch (thrown) {
      const error = toApiError(thrown);
      showProblems(error.code === "invalid_settings" ? splitProblems(error.message) : [error.message]);
      say("The settings were not saved.");
    } finally {
      saveButton.disabled = false;
    }
  }

  async function refresh(): Promise<void> {
    say("Loading settings…");
    try {
      draft = await invoke<MetadataView>("get_metadata_settings");
      edits = {};
      editing = new Set();
      showProblems([]);
      render();
      renderArchive(await invoke<ArchiveView>("get_archive_settings"));
      await loadHistory();
      await loadLyricsSettings();
      await loadListen();
      say("");
    } catch (thrown) {
      draft = null;
      formBox.replaceChildren();
      const error = toApiError(thrown);
      say(error.code === "unknown_command" ? "Settings are not available in this version of the app." : error.message);
    }
  }

  saveButton.addEventListener("click", () => void save());
  reloadButton.addEventListener("click", () => void refresh());
  return { refresh };
}
