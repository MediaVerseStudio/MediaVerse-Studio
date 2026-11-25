import assert from "node:assert/strict";
import { test } from "node:test";
import {
  type MetadataView,
  buildUpdate,
  describeSecret,
  hasSecretEdits,
  newServer,
  parseNumber,
  secretIsSet,
  splitProblems,
  withTransport,
} from "./settings-form.ts";

const view = (): MetadataView => ({
  identity: { contact: "me@example.com" },
  musicbrainz: { enabled: true, base_url: "https://musicbrainz.org", min_interval_ms: 1100, timeout_seconds: 20 },
  cddb_servers: [
    {
      name: "gnudb", enabled: true, transport: "https", host: "gnudb.gnudb.org", port: 443, path: "/~cddb/cddb.cgi",
      protocol_level: 6, client_name: "MediaVerseStudio", client_version: "0.1", min_interval_ms: 1000, timeout_seconds: 20,
    },
  ],
  gracenote: { enabled: false, base_url: "", client_id: { set: false }, user_id: { set: true } },
  acoustid: { enabled: true, base_url: "https://api.acoustid.org", api_key: { set: true }, min_interval_ms: 340 },
  discogs: { enabled: false, base_url: "https://api.discogs.com", token: { set: false }, min_interval_ms: 1100 },
  photos: { audiodb_key: { set: false }, fanart_key: { set: false } },
  cover_art: { enabled: true, base_url: "https://coverartarchive.org" },
  setup_needed: [{ source: "musicbrainz", message: "x" }],
});

test("unchanged credentials are left out of the update entirely", () => {
  const update = buildUpdate(view(), {}) as any;
  assert.equal("api_key" in update.acoustid, false);
  assert.equal("client_id" in update.gracenote, false);
  assert.equal("user_id" in update.gracenote, false);
  assert.equal("setup_needed" in update, false);
  assert.equal(update.identity.contact, "me@example.com");
  assert.equal(update.cddb_servers[0].host, "gnudb.gnudb.org");
  assert.equal(update.acoustid.min_interval_ms, 340);
});

test("a typed credential is sent trimmed, and a removal is sent as null", () => {
  const update = buildUpdate(view(), { "acoustid.api_key": "  NEWKEY123  ", "gracenote.user_id": null }) as any;
  assert.equal(update.acoustid.api_key, "NEWKEY123");
  assert.equal(update.gracenote.user_id, null);
  assert.equal("client_id" in update.gracenote, false, "untouched credentials stay out");
});

test("building an update never changes the working copy", () => {
  const draft = view();
  buildUpdate(draft, { "acoustid.api_key": "x" });
  assert.deepEqual(draft, view());
});

test("credential edits are detected", () => {
  assert.equal(hasSecretEdits({}), false);
  assert.equal(hasSecretEdits({ "acoustid.api_key": undefined }), false);
  assert.equal(hasSecretEdits({ "acoustid.api_key": null }), true);
  assert.equal(hasSecretEdits({ "acoustid.api_key": "" }), true);
});

test("credential status text never reveals values", () => {
  assert.equal(describeSecret({ set: true }, undefined), "Saved");
  assert.equal(describeSecret({ set: false }, undefined), "Not set");
  assert.equal(describeSecret({ set: true }, null), "Will be removed when you save");
  assert.equal(describeSecret({ set: false }, "secret-value"), "New value will be saved");
});

test("a new server gets a unique name and usable defaults", () => {
  const servers = view().cddb_servers;
  const first = newServer(servers);
  assert.equal(first.name, "server 2");
  assert.equal(first.enabled, false, "a new server starts switched off until it is filled in");
  assert.equal(first.transport, "https");
  assert.equal(first.port, 443);
  const second = newServer([...servers, first]);
  assert.equal(second.name, "server 3");
  const clash = newServer([{ ...servers[0], name: "Server 2" }]);
  assert.equal(clash.name, "server 3", "names are compared ignoring case");
});

test("changing transport swaps the usual port but keeps a custom one", () => {
  const server = view().cddb_servers[0];
  const cddbp = withTransport(server, "cddbp");
  assert.equal(cddbp.port, 8880);
  assert.equal(withTransport(cddbp, "http").port, 80);
  assert.equal(withTransport(cddbp, "https").port, 443);
  assert.equal(withTransport({ ...server, transport: "https", port: 443 }, "http").port, 80);
  const custom = withTransport({ ...server, port: 8080 }, "cddbp");
  assert.equal(custom.port, 8080, "a port the user chose is respected");
  assert.equal(withTransport({ ...server, transport: "cddbp", path: "" }, "http").path, "/~cddb/cddb.cgi");
});

test("number fields fall back instead of becoming NaN", () => {
  assert.equal(parseNumber("8880", 0), 8880);
  assert.equal(parseNumber(" 12.9 ", 0), 12);
  assert.equal(parseNumber("", 80), 80);
  assert.equal(parseNumber("abc", 80), 80);
});

test("problems from the sidecar become separate messages", () => {
  assert.deepEqual(splitProblems("one\n\n two \nthree"), ["one", "two", "three"]);
  assert.deepEqual(splitProblems(""), []);
});

test("a credential counts as set only if it will exist after saving", () => {
  assert.equal(secretIsSet({ set: true }, undefined), true);
  assert.equal(secretIsSet({ set: false }, undefined), false);
  assert.equal(secretIsSet({ set: true }, null), false);
  assert.equal(secretIsSet({ set: false }, "abc"), true);
  assert.equal(secretIsSet({ set: true }, "   "), false, "a blank replacement leaves nothing");
});
