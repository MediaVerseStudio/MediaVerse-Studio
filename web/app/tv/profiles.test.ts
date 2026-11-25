import assert from "node:assert/strict";
import test from "node:test";
import { addProfile, cleanName, lastProfile, listProfiles, profileFavorites, rememberProfile, removeProfile, renameProfile, setProfileFavorite } from "./profiles.ts";

function memory() {
  const map = new Map<string, string>();
  return {
    getItem: (k: string) => map.get(k) ?? null,
    setItem: (k: string, v: string) => void map.set(k, v),
    removeItem: (k: string) => void map.delete(k),
    key: (i: number) => [...map.keys()][i] ?? null,
    get length() {
      return map.size;
    },
  };
}

test("people are added once each, renamed and removed with their favorites", () => {
  const s = memory();
  const alex = addProfile("  Alex  ", s)!;
  const sam = addProfile("Sam", s)!;
  assert.equal(addProfile("alex", s), null, "names are unique, ignoring case");
  assert.equal(addProfile("   ", s), null);
  assert.deepEqual(listProfiles(s).map((p) => p.name), ["Alex", "Sam"]);
  assert.notEqual(alex.colour, sam.colour, "each gets their own colour");
  assert.equal(renameProfile(sam.id, "ALEX", s), false);
  assert.equal(renameProfile(sam.id, "Samantha", s), true);
  setProfileFavorite(alex.id, "computer:PC", "t1", true, s);
  setProfileFavorite(alex.id, "computer:PC", "t2", true, s);
  setProfileFavorite(alex.id, "computer:PC", "t1", false, s);
  setProfileFavorite(sam.id, "computer:PC", "t9", true, s);
  assert.deepEqual(profileFavorites(alex.id, "computer:PC", s), ["t2"]);
  assert.deepEqual(profileFavorites(alex.id, "drive:usb", s), [], "per source");
  rememberProfile(alex.id, s);
  removeProfile(alex.id, s);
  assert.deepEqual(listProfiles(s).map((p) => p.name), ["Samantha"]);
  assert.deepEqual(profileFavorites(alex.id, "computer:PC", s), []);
  assert.deepEqual(profileFavorites(sam.id, "computer:PC", s), ["t9"], "others keep theirs");
  assert.equal(lastProfile(s), null);
});

test("at most eight people; names are tidied", () => {
  const s = memory();
  for (let i = 0; i < 8; i++) assert.ok(addProfile(`P${i}`, s));
  assert.equal(addProfile("Ninth", s), null);
  assert.equal(cleanName("A\u0000 very   long name that goes on and on"), "A very long name tha");
});
