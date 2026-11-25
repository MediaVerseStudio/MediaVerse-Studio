import assert from "node:assert/strict";
import { test } from "node:test";
import type { LibrarySong } from "./library-format.ts";
import { cleanSmart, evaluate, likeness, pickForAutoDj, ruleMatches, type Facts, type Smart } from "./smart-playlists.ts";

const NOW = 1_800_000_000;
const DAY = 86_400;
let n = 0;
const song = (extra: Partial<LibrarySong> = {}): LibrarySong => ({ album: "Record", album_artist: null, artist: "Band", genre: "Rock", release_year: 1999, title: `Song ${++n}`, source_uri: `M:\\m\\${n}.mp3`, track_number: n, length_ms: 200_000, added_secs: NOW - 400 * DAY, ...extra });
const facts = (extra: Partial<Facts> = {}): Facts => ({ hearts: new Set(), plays: new Map(), now: NOW, ...extra });
const smart = (extra: Partial<Smart>): Smart => ({ id: "s", name: "x", match: "all", rules: [], sort: "title", limit: null, ...extra });

test("text rules ignore case and accents", () => {
  const s = song({ genre: "Électro", artist: "Café Tacvba" });
  assert.equal(ruleMatches({ field: "genre", op: "contains", value: "electro" }, s, facts()), true);
  assert.equal(ruleMatches({ field: "artist", op: "is", value: "cafe tacvba" }, s, facts()), true);
  assert.equal(ruleMatches({ field: "genre", op: "not_contains", value: "rock" }, s, facts()), true);
  assert.equal(ruleMatches({ field: "genre", op: "contains", value: "" }, s, facts()), false);
});

test("number rules: year, days since added, times played, days since last played", () => {
  const fresh = song({ added_secs: NOW - 5 * DAY, release_year: 2021 });
  const f = facts({ plays: new Map([[fresh.source_uri, { count: 7, last: NOW - 40 * DAY }]]) });
  assert.equal(ruleMatches({ field: "year", op: "gt", value: "2020" }, fresh, f), true);
  assert.equal(ruleMatches({ field: "added_days", op: "lt", value: "30" }, fresh, f), true);
  assert.equal(ruleMatches({ field: "plays", op: "gt", value: "5" }, fresh, f), true);
  assert.equal(ruleMatches({ field: "last_played_days", op: "gt", value: "30" }, fresh, f), true);
  const never = song();
  assert.equal(ruleMatches({ field: "last_played_days", op: "gt", value: "365" }, never, facts()), true, "never played counts as long ago");
  assert.equal(ruleMatches({ field: "year", op: "is", value: "1999" }, never, facts()), true);
  assert.equal(ruleMatches({ field: "year", op: "gt", value: "x" }, never, facts()), false);
});

test("a heart rule uses the favourites", () => {
  const loved = song();
  const f = facts({ hearts: new Set([loved.source_uri]) });
  assert.equal(ruleMatches({ field: "heart", op: "is", value: "yes" }, loved, f), true);
  assert.equal(ruleMatches({ field: "heart", op: "is_not", value: "yes" }, loved, f), false);
  assert.equal(ruleMatches({ field: "heart", op: "is", value: "yes" }, song(), f), false);
});

test("a playlist matches all rules or any, sorts, and keeps within its limit", () => {
  const library = [song({ title: "B", genre: "Rock", release_year: 1975 }), song({ title: "A", genre: "Jazz", release_year: 1975 }), song({ title: "C", genre: "Rock", release_year: 1990 })];
  const rules = [{ field: "genre" as const, op: "contains" as const, value: "rock" }, { field: "year" as const, op: "lt" as const, value: "1980" }];
  assert.deepEqual(evaluate(smart({ rules }), library, facts()).map((s) => s.title), ["B"]);
  assert.deepEqual(evaluate(smart({ rules, match: "any" }), library, facts()).map((s) => s.title), ["A", "B", "C"]);
  assert.deepEqual(evaluate(smart({ rules, match: "any", limit: 2 }), library, facts()).map((s) => s.title), ["A", "B"]);
  assert.equal(evaluate(smart({ rules: [] }), library, facts()).length, 3, "no rules: the whole library");
});

test("sorting by plays, newest and year, and a seeded shuffle", () => {
  const a = song({ title: "A", added_secs: NOW - 9 * DAY, release_year: 2000 });
  const b = song({ title: "B", added_secs: NOW - 1 * DAY, release_year: 1980 });
  const f = facts({ plays: new Map([[a.source_uri, { count: 9, last: NOW }]]) });
  assert.deepEqual(evaluate(smart({ sort: "most_played" }), [b, a], f).map((s) => s.title), ["A", "B"]);
  assert.deepEqual(evaluate(smart({ sort: "newest" }), [a, b], f).map((s) => s.title), ["B", "A"]);
  assert.deepEqual(evaluate(smart({ sort: "year" }), [a, b], f).map((s) => s.title), ["B", "A"]);
  let seed = 0.3;
  const random = (): number => (seed = (seed * 9301 + 0.49297) % 1);
  assert.equal(evaluate(smart({ sort: "random" }), [a, b, song()], f, random).length, 3);
});

test("stored playlists are cleaned", () => {
  assert.equal(cleanSmart(null), null);
  assert.equal(cleanSmart({ id: "x", name: "  " }), null);
  const clean = cleanSmart({ id: "x", name: "Mix", match: "any", sort: "bogus", limit: 99999, rules: [{ field: "genre", op: "nonsense", value: 5 }, { field: "bogus", op: "is", value: "x" }] })!;
  assert.deepEqual([clean.match, clean.sort, clean.limit, clean.rules.length], ["any", "random", 5000, 1]);
  assert.deepEqual(clean.rules[0], { field: "genre", op: "contains", value: "" });
});

test("the Auto-DJ likes the same genre, artist and decade, and never repeats what is queued or the band before", () => {
  const now = song({ genre: "Rock", artist: "Band", release_year: 1999 });
  assert.equal(likeness(now, song({ genre: "Rock", artist: "Other", release_year: 1995 })), 4);
  assert.equal(likeness(now, song({ genre: "Jazz", artist: "Other", release_year: 1950 })), 0);
  const library = [now, ...Array.from({ length: 12 }, (_, i) => song({ genre: i % 2 ? "Rock" : "Jazz", artist: `Artist ${i % 4}`, release_year: 1990 + i }))];
  let seed = 0.5;
  const random = (): number => (seed = (seed * 9301 + 0.49297) % 1);
  const avoid = new Set([now.source_uri, library[1]!.source_uri]);
  const picks = pickForAutoDj(now, library, avoid, 5, random);
  assert.equal(picks.length, 5);
  assert.ok(picks.every((p) => !avoid.has(p.source_uri)));
  assert.equal(new Set(picks.map((p) => p.source_uri)).size, 5);
  assert.ok(picks.every((p, i) => (i === 0 ? p.artist !== now.artist : p.artist !== picks[i - 1]!.artist)), "not the same band twice in a row");
  assert.deepEqual(pickForAutoDj(now, [now], new Set([now.source_uri]), 3), []);
});
