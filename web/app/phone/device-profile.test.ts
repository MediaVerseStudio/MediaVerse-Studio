import assert from "node:assert/strict";
import test from "node:test";
import { declineSetup, setupDeclined, keepProfileSession, readProfile, savedProfileSession, setAskAtStart, switchProfile } from "./device-profile.ts";

function storage(start: Record<string, string> = {}) {
  const map = new Map(Object.entries(start));
  return { map, getItem: (k: string) => map.get(k) ?? null, setItem: (k: string, v: string) => void map.set(k, v), removeItem: (k: string) => void map.delete(k) };
}

test("the first profile takes over what the phone had, but not what was agreed with the old account", () => {
  const s = storage({ "mediaverse.phone.playlists": "mine", "mediaverse.phone.home-playlists": "account round", "mediaverse.phone.flags": "flags" });
  assert.deepEqual(switchProfile("Sam", s), { name: "Sam", adopted: "Sam", askAtStart: false });
  assert.equal(s.getItem("mediaverse.phone.playlists"), "mine");
  assert.equal(s.getItem("mediaverse.phone.home-playlists"), null);
  assert.equal(s.getItem("mediaverse.phone.flags"), "flags");
});

test("each profile gets its own things back, and the flags stay the phone's", () => {
  const s = storage({ "mediaverse.phone.playlists": "sam lists", "mediaverse.phone.flags": "flags" });
  switchProfile("Sam", s);
  switchProfile("Alex", s);
  assert.equal(s.getItem("mediaverse.phone.playlists"), null);
  s.setItem("mediaverse.phone.playlists", "alex lists");
  s.setItem("mediaverse.phone.home-playlists", "alex round");
  switchProfile("Sam", s);
  assert.equal(s.getItem("mediaverse.phone.playlists"), "sam lists");
  assert.equal(s.getItem("mediaverse.phone.home-playlists"), null);
  switchProfile("Alex", s);
  assert.equal(s.getItem("mediaverse.phone.playlists"), "alex lists");
  assert.equal(s.getItem("mediaverse.phone.home-playlists"), "alex round");
  switchProfile("alex", s); // the same person: nothing moves
  assert.equal(s.getItem("mediaverse.phone.playlists"), "alex lists");
  assert.equal(readProfile(s)?.adopted, "Sam");
  assert.equal(s.getItem("mediaverse.phone.flags"), "flags");
});

test("asking at start and the kept sign-ins are remembered per phone", () => {
  const s = storage();
  setAskAtStart(true, s);
  assert.equal(readProfile(s), null);
  switchProfile("Sam", s);
  setAskAtStart(true, s);
  assert.equal(readProfile(s)?.askAtStart, true);
  keepProfileSession("Sam", "srv", { token: "t" }, s);
  assert.deepEqual(savedProfileSession("sam", "srv", s), { token: "t" });
  assert.equal(savedProfileSession("Sam", "other", s), null);
  keepProfileSession("Sam", "srv", null, s);
  assert.equal(savedProfileSession("Sam", "srv", s), null);
});

test("\"Not now\" is remembered for that server only", () => {
  const kept = new Map<string, string>();
  const storage = { getItem: (k: string) => kept.get(k) ?? null, setItem: (k: string, v: string) => void kept.set(k, v), removeItem: (k: string) => void kept.delete(k) };
  assert.equal(setupDeclined("one", storage), false);
  declineSetup("one", storage);
  assert.equal(setupDeclined("one", storage), true);
  assert.equal(setupDeclined("two", storage), false);
});
