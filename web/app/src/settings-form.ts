// Pure logic for the Settings page: the shape of the settings the sidecar shows, and how an edited
// form becomes an update (docs/architecture/0006-disc-metadata-lookup.md). No DOM access, so it is
// unit tested with `npm run test:unit`.
//
// Credentials are never shown. The sidecar sends `{ set: true|false }` in their place, and the form
// only sends a credential when the user typed a new one (a string) or asked to remove it (null).

export type SecretView = { set: boolean };

export type CddbServer = {
  name: string;
  enabled: boolean;
  transport: "http" | "https" | "cddbp";
  host: string;
  port: number;
  path: string;
  protocol_level: number;
  client_name: string;
  client_version: string;
  min_interval_ms: number;
  timeout_seconds: number;
};

export type MetadataView = {
  identity: { contact: string };
  musicbrainz: { enabled: boolean; base_url: string; min_interval_ms: number; timeout_seconds: number };
  cddb_servers: CddbServer[];
  gracenote: { enabled: boolean; base_url: string; client_id: SecretView; user_id: SecretView };
  acoustid: { enabled: boolean; base_url: string; api_key: SecretView; min_interval_ms: number };
  discogs: { enabled: boolean; base_url: string; token: SecretView; min_interval_ms: number };
  photos: { audiodb_key: SecretView; fanart_key: SecretView };
  cover_art: { enabled: boolean; base_url: string };
  setup_needed: { source: string; message: string }[];
};

/** Where each credential lives, so edits can be applied by name. */
export const SECRET_FIELDS = [
  { id: "acoustid.api_key", group: "acoustid", key: "api_key" },
  { id: "discogs.token", group: "discogs", key: "token" },
  { id: "photos.audiodb_key", group: "photos", key: "audiodb_key" },
  { id: "photos.fanart_key", group: "photos", key: "fanart_key" },
  { id: "gracenote.client_id", group: "gracenote", key: "client_id" },
  { id: "gracenote.user_id", group: "gracenote", key: "user_id" },
] as const;

export type SecretId = (typeof SECRET_FIELDS)[number]["id"];

/** Pending credential changes: a string replaces, `null` removes, and absent keeps what is stored. */
export type SecretEdits = Partial<Record<SecretId, string | null>>;

/**
 * The update to send: every setting from the working copy, with credentials included only where
 * they were edited. `setup_needed` is informational and is dropped.
 */
export function buildUpdate(draft: MetadataView, edits: SecretEdits): Record<string, unknown> {
  const update = JSON.parse(JSON.stringify(draft)) as Record<string, any>;
  delete update.setup_needed;
  for (const field of SECRET_FIELDS) {
    const edit = edits[field.id];
    if (edit === undefined) {
      delete update[field.group][field.key];
    } else {
      update[field.group][field.key] = edit === null ? null : edit.trim();
    }
  }
  return update;
}

/** True when saving would change a credential. */
export function hasSecretEdits(edits: SecretEdits): boolean {
  return Object.values(edits).some((value) => value !== undefined);
}

/** A new CDDB server entry with sensible defaults and a name that is not already used. */
export function newServer(existing: CddbServer[]): CddbServer {
  const names = new Set(existing.map((server) => server.name.trim().toLowerCase()));
  let number = existing.length + 1;
  while (names.has(`server ${number}`)) {
    number += 1;
  }
  return {
    name: `server ${number}`,
    enabled: false,
    transport: "https",
    host: "",
    port: 443,
    path: "/~cddb/cddb.cgi",
    protocol_level: 6,
    client_name: "MediaVerseStudio",
    client_version: "0.1",
    min_interval_ms: 1000,
    timeout_seconds: 20,
  };
}

/** Switching transport also switches to that transport's usual port, unless the user changed it. */
export function withTransport(server: CddbServer, transport: CddbServer["transport"]): CddbServer {
  const usual = { http: 80, https: 443, cddbp: 8880 };
  const keepPort = server.port !== usual[server.transport];
  return {
    ...server,
    transport,
    port: keepPort ? server.port : usual[transport],
    path: transport !== "cddbp" && server.path === "" ? "/~cddb/cddb.cgi" : server.path,
  };
}

/** Parses a number field; an empty or invalid field yields `fallback` so the sidecar can explain. */
export function parseNumber(text: string, fallback: number): number {
  const value = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(value) ? Math.trunc(value) : fallback;
}

/** The sidecar joins its problems with newlines; split them into separate messages. */
export function splitProblems(message: string): string[] {
  return message
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0);
}

export function secretIsSet(view: SecretView, pendingEdit: string | null | undefined): boolean {
  return typeof pendingEdit === "string" ? pendingEdit.trim() !== "" : pendingEdit === null ? false : view.set;
}

export function describeSecret(view: SecretView, pendingEdit: string | null | undefined): string {
  if (pendingEdit === null) {
    return "Will be removed when you save";
  }
  if (typeof pendingEdit === "string") {
    return "New value will be saved";
  }
  return view.set ? "Saved" : "Not set";
}
