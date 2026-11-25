import assert from "node:assert/strict";
import test from "node:test";
import { flagInJellyfin, jellyfinFlagged, unflagInJellyfin, type JellyfinSession } from "./jellyfin.ts";
import { jellyfinMarks, reconcileFlags } from "./marks.ts";

const entry = (id: string, sent?: boolean) => ({ id, reason: "other" as const, position_ms: 0, at: 1, ...(sent === undefined ? {} : { sent }) });

test("flags kept on the TV: sent ones the server dropped are cleared, never-sent ones go up", () => {
  const { keep, upload, flagged } = reconcileFlags([entry("a", true), entry("b", true), entry("c"), entry("d", false)], new Set(["a", "z"]));
  assert.deepEqual(keep.map((e) => e.id), ["a", "c", "d"], "b was cleared on the computer");
  assert.deepEqual(upload, ["c", "d"], "c was flagged before flags went to Jellyfin, d while the server was away");
  assert.deepEqual([...flagged].sort(), ["a", "c", "d", "z"], "z was flagged on another device");
});

const session: JellyfinSession = { base: "http://jf:8096", name: "Home", serverId: "s", userId: "u", token: "t" };

/** A tiny Jellyfin: playlists by name with their songs; records writes. */
function fakeJellyfin(lists: Record<string, string[]>, down = { value: false }) {
  const ids = new Map(Object.keys(lists).map((name, i) => [name, `pl${i}`]));
  const writes: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    if (down.value) throw new TypeError("refused");
    const url = new URL(String(input));
    const method = init?.method ?? "GET";
    if (method === "GET" && url.pathname === "/Users/u/Items") return new Response(JSON.stringify({ Items: [...ids].map(([name, id]) => ({ Id: id, Name: name })) }));
    const items = url.pathname.match(/^\/Playlists\/(pl\d+)\/Items$/);
    if (items && method === "GET") {
      const name = [...ids].find(([, id]) => id === items[1])![0];
      return new Response(JSON.stringify({ Items: lists[name].map((song, i) => ({ Id: song, PlaylistItemId: `${items[1]}-e${i}` })) }));
    }
    if (items && method === "POST") writes.push(`add ${items[1]} ${url.searchParams.get("ids")}`);
    else if (items && method === "DELETE") {
      writes.push(`remove ${items[1]} ${url.searchParams.get("entryIds")}`);
      const name = [...ids].find(([, id]) => id === items[1])![0];
      const gone = new Set((url.searchParams.get("entryIds") ?? "").split(","));
      lists[name] = lists[name].filter((_, i) => !gone.has(`${items[1]}-e${i}`));
    }
    else if (url.pathname === "/Playlists" && method === "POST") {
      const body = JSON.parse(String(init?.body));
      writes.push(`create ${body.Name} ${body.Ids.join(",")}`);
      return new Response(JSON.stringify({ Id: "new" }));
    } else throw new Error(`unexpected ${method} ${url.pathname}`);
    return new Response(null, { status: 204 });
  }) as typeof fetch;
  return { writes, restore: () => void (globalThis.fetch = original) };
}

test("a flag goes into the computer's master list when there is one, skipping songs already flagged", async () => {
  const jf = fakeJellyfin({ "Problem tracks": ["s1"], "Road trip": ["s9"] });
  try {
    await flagInJellyfin(session, ["s1", "s2"], "TV");
    assert.deepEqual(jf.writes, ["add pl0 s2"]);
  } finally {
    jf.restore();
  }
});

test("with no master list the flag goes into this TV's inbox, made if it is not there", async () => {
  const none = fakeJellyfin({ "Road trip": ["s9"] });
  try {
    await flagInJellyfin(session, ["s2"], "TV", new Date(2026, 10, 22, 21, 5));
    assert.deepEqual(none.writes, ["create Problem Playlist 2026-11-22 21:05 (TV) s2"]);
  } finally {
    none.restore();
  }
  const inbox = fakeJellyfin({ "Problem Playlist 2026-11-22 20:00 (TV)": ["s1"], "Problem Playlist 2026-11-22 20:00 (Phone)": ["s5"] });
  try {
    await flagInJellyfin(session, ["s2"], "TV");
    assert.deepEqual(inbox.writes, ["add pl0 s2"], "this TV's own inbox, not the phone's");
  } finally {
    inbox.restore();
  }
});

test("flagged songs are read from the master list and every inbox; unflagging takes them off each, and other playlists are never touched", async () => {
  const jf = fakeJellyfin({ "Problem tracks": ["s1", "s2"], "Problem Playlist 2026-11-22 20:00 (Phone)": ["s2", "s3"], "Road trip": ["s2"] });
  try {
    assert.deepEqual([...(await jellyfinFlagged(session))].sort(), ["s1", "s2", "s3"]);
    await unflagInJellyfin(session, ["s2"]);
    assert.deepEqual(jf.writes, ["remove pl0 pl0-e1", "remove pl1 pl1-e0"]);
  } finally {
    jf.restore();
  }
});

/** A page's storage, for the flag store (Node has none). */
function withStorage<T>(run: (data: Map<string, string>) => Promise<T>): Promise<T> {
  const data = new Map<string, string>();
  const original = Object.getOwnPropertyDescriptor(globalThis, "localStorage");
  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: { getItem: (k: string) => data.get(k) ?? null, setItem: (k: string, v: string) => void data.set(k, v), removeItem: (k: string) => void data.delete(k) },
  });
  return run(data).finally(() => {
    if (original) Object.defineProperty(globalThis, "localStorage", original);
    else Reflect.deleteProperty(globalThis, "localStorage");
  });
}

test("a flag removed on the TV while the server is away comes off the server at the next load, and does not come back", async () => {
  await withStorage(async () => {
    const down = { value: false };
    const jf = fakeJellyfin({ "Problem tracks": ["s1", "s2"] }, down);
    try {
      const marks = jellyfinMarks(session);
      assert.deepEqual([...(await marks.load()).flagged].sort(), ["s1", "s2"]);
      down.value = true;
      await marks.flag("s2", false, "other", 0); // does not throw: kept for later
      assert.ok(!(await marks.load()).flagged.has("s2"), "off on the TV even with the server away");
      down.value = false;
      const loaded = await marks.load();
      assert.deepEqual([...loaded.flagged], ["s1"], "the server took it off and it did not return");
      assert.ok(jf.writes.some((w) => w.startsWith("remove pl0")), "removed on the server");
      assert.deepEqual([...(await marks.load()).flagged], ["s1"], "and stays off at the load after");
    } finally {
      jf.restore();
    }
  });
});

test("flagging again cancels an unflag still waiting, and a flag made offline goes up at the next load", async () => {
  await withStorage(async () => {
    const down = { value: false };
    const jf = fakeJellyfin({ "Problem tracks": ["s1"] }, down);
    try {
      const marks = jellyfinMarks(session);
      await marks.load();
      down.value = true;
      await marks.flag("s1", false, "other", 0);
      await marks.flag("s1", true, "other", 0); // changed their mind
      await marks.flag("s9", true, "audio", 1000); // made while the server is away
      down.value = false;
      const loaded = await marks.load();
      assert.deepEqual([...loaded.flagged].sort(), ["s1", "s9"]);
      assert.ok(jf.writes.includes("add pl0 s9"), "s9 went up");
      assert.ok(!jf.writes.some((w) => w.startsWith("remove")), "s1 was never taken off");
    } finally {
      jf.restore();
    }
  });
});