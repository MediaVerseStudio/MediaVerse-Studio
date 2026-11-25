import assert from "node:assert/strict";
import { test } from "node:test";
import { addSongs, changeAt, freeName, resolvePlaylist, type PhonePlaylist } from "./phone-playlists.ts";

const song = (id: string, title: string, artist: string, album: string, ms: number) => ({ id, title, artist, album_artist: null, album, duration_ms: ms });
const library = [song("1", "Ocean Avenue", "Yellowcard", "Ocean Avenue", 199_000), song("2", "Ode to My Car", "Adam Sandler", "What the Hell", 235_000), song("3", "Way Away", "Yellowcard", "Ocean Avenue", 202_000)];
const byId = new Map(library.map((s) => [s.id, s]));

test("songs are added once, moved and taken out", () => {
  const list: PhonePlaylist = { id: "p", name: "Mix", entries: [], updated: 0 };
  assert.equal(addSongs(list, [library[0], library[1], library[0]], 5), 2);
  assert.equal(list.updated, 5);
  changeAt(list, 1, "up");
  assert.deepEqual(list.entries.map((e) => e.id), ["2", "1"]);
  changeAt(list, 0, "up");
  assert.deepEqual(list.entries.map((e) => e.id), ["2", "1"], "already first");
  changeAt(list, 0, "remove");
  assert.deepEqual(list.entries.map((e) => e.id), ["1"]);
});

test("a playlist still finds its songs after Android numbers the music again", () => {
  const list: PhonePlaylist = { id: "p", name: "Mix", entries: [], updated: 0 };
  addSongs(list, [library[2], library[1]]);
  assert.deepEqual(resolvePlaylist(list, library, byId).map((s) => s.title), ["Way Away", "Ode to My Car"]);
  // After a re-scan the IDs differ (and one now points at another song); titles and artists still match.
  const renumbered = [song("70", "Ode to My Car", "Adam Sandler", "What the Hell", 235_000), song("71", "Way Away", "Yellowcard", "Ocean Avenue", 202_000), song("2", "Something Else", "Nobody", "X", 1)];
  const found = resolvePlaylist(list, renumbered, new Map(renumbered.map((s) => [s.id, s])));
  assert.deepEqual(found.map((s) => s.id), ["71", "70"]);
  assert.deepEqual(resolvePlaylist(list, [], new Map()), [], "songs no longer on the phone are skipped");
});

test("names stay unique", () => {
  const lists: PhonePlaylist[] = [{ id: "a", name: "Mix", entries: [], updated: 0 }];
  assert.equal(freeName("mix", lists), "mix 2");
  assert.equal(freeName("Mix", lists, "a"), "Mix", "renaming to its own name");
  assert.equal(freeName("  ", []), "New playlist");
});
