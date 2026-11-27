import assert from "node:assert/strict";
import test from "node:test";
import { Jellyfin, type Http, type Session } from "../phone/jellyfin-phone.ts";
import { copyIntoProfile, createProfile, describeCopy, listProfiles, openProfile, profileNameProblem, shareFlagLists, sharesForEveryone } from "./jellyfin-profiles.ts";

type User = { id: string; name: string; password: string; admin: boolean; hidden: boolean; remote: boolean; favorites: Set<string> };
type List = { id: string; name: string; owner: string; open: boolean; shares: Array<{ UserId: string; CanEdit: boolean }>; songs: string[]; path?: string };

/** A pretend Jellyfin that behaves as 12.4.0 was seen to (docs/profiles-plan.md): users hidden when made, lists public unless said, 401 for a refusal. */
function server() {
  const users: User[] = [{ id: "u0", name: "owner", password: "secret", admin: true, hidden: false, remote: true, favorites: new Set(["s1", "s2"]) }];
  const lists: List[] = [];
  const tokens = new Map<string, { user: string; device: string }>();
  let next = 1;
  const dto = (u: User) => ({ Id: u.id, Name: u.name, HasPassword: true, Policy: { IsAdministrator: u.admin, IsDisabled: false, IsHidden: u.hidden, EnableRemoteAccess: u.remote } });
  const sees = (l: List, user: string) => l.open || l.owner === user || l.shares.some((s) => s.UserId === user);
  const edits = (l: List, user: string) => l.owner === user || l.shares.some((s) => s.UserId === user && s.CanEdit);
  const http: Http = async (request) => {
    const url = new URL(request.url);
    const path = url.pathname;
    const method = request.method ?? "GET";
    const auth = request.headers?.Authorization ?? "";
    const device = /DeviceId="([^"]*)"/.exec(auth)?.[1] ?? "";
    const me = users.find((u) => u.id === tokens.get(/Token="([^"]*)"/.exec(auth)?.[1] ?? "")?.user);
    const body = request.body ? JSON.parse(request.body) : null;
    const reply = (value: unknown = null, status = 200) => ({ status, body: value === null ? "" : JSON.stringify(value) });
    if (path === "/Users/Public") return reply(users.filter((u) => !u.hidden).map(dto));
    if (path === "/Users/AuthenticateByName") {
      const user = users.find((u) => u.name.toLowerCase() === String(body.Username).toLowerCase() && u.password === body.Pw);
      if (!user) return reply(null, 401);
      const token = `t${next++}`;
      for (const [old, held] of tokens) if (held.device === device) tokens.delete(old); // one sign-in per device name
      tokens.set(token, { user: user.id, device });
      return reply({ AccessToken: token, User: dto(user) });
    }
    if (!me) return reply(null, 401);
    if (path === "/Users/Me") return reply(dto(me));
    if (path === "/Users" && method === "GET") return reply(users.map(dto));
    if (path === "/Sessions/Logout") {
      tokens.delete(/Token="([^"]*)"/.exec(auth)![1]!);
      return reply();
    }
    if (path === "/Users/New") {
      if (!me.admin) return reply(null, 403);
      const made: User = { id: `u${next++}`, name: body.Name, password: "", admin: false, hidden: true, remote: true, favorites: new Set() };
      users.push(made);
      return reply(dto(made));
    }
    let m = /^\/Users\/([^/]+)\/Policy$/.exec(path);
    if (m) {
      const user = users.find((u) => u.id === m![1])!;
      user.hidden = body.IsHidden;
      user.remote = body.EnableRemoteAccess;
      return reply();
    }
    m = /^\/UserFavoriteItems\/([^/]+)$/.exec(path);
    if (m) {
      if (method === "POST") me.favorites.add(m[1]!);
      else me.favorites.delete(m[1]!);
      return reply({});
    }
    if (/^\/Users\/[^/]+\/Items$/.test(path)) {
      if (url.searchParams.get("IncludeItemTypes") === "Playlist") return reply({ Items: lists.filter((l) => sees(l, me.id)).map((l) => ({ Id: l.id, Name: l.name, Path: l.path ?? `/data/playlists/${l.name}` })) });
      return reply({ Items: [...me.favorites].map((Id) => ({ Id })) });
    }
    if (path === "/Playlists" && method === "POST") {
      const made: List = { id: `l${next++}`, name: body.Name, owner: me.id, open: body.IsPublic !== false, shares: body.Users ?? [], songs: body.Ids };
      lists.push(made);
      return reply({ Id: made.id });
    }
    m = /^\/Playlists\/([^/]+)(\/Items)?$/.exec(path);
    if (m) {
      const list = lists.find((l) => l.id === m![1]);
      if (!list || !sees(list, me.id)) return reply(null, 404);
      if (!m[2]) {
        if (!edits(list, me.id)) return reply(null, 403);
        if (method === "GET") return reply({ OpenAccess: list.open, Shares: list.shares });
        if (body.Users) list.shares = body.Users;
        if (body.IsPublic !== undefined) list.open = body.IsPublic;
        return reply();
      }
      if (method === "GET") return reply({ Items: list.songs.map((id) => ({ Id: id, PlaylistItemId: `e-${id}` })) });
      if (!edits(list, me.id)) return reply(null, 403);
      if (method === "DELETE") list.songs = list.songs.filter((id) => !url.searchParams.get("entryIds")!.split(",").includes(`e-${id}`));
      else list.songs.push(...url.searchParams.get("ids")!.split(","));
      return reply();
    }
    m = /^\/Items\/([^/]+)$/.exec(path);
    if (m && method === "DELETE") {
      const at = lists.findIndex((l) => l.id === m![1]);
      if (lists[at]!.owner !== me.id) return reply(null, 401);
      lists.splice(at, 1);
      return reply();
    }
    return reply(null, 404);
  };
  return { users, lists, tokens, client: new Jellyfin(http, "device1", "Test") };
}

const at = { base: "http://x", name: "x", id: "srv" };
const admin = { name: "owner", password: "secret" };

test("a profile is made with the administrator's password, listed, reachable without one, and the administrator is signed out again", async () => {
  const s = server();
  assert.deepEqual(await listProfiles(s.client, at.base), []);
  await createProfile(s.client, at, admin, "Sam");
  assert.deepEqual((await listProfiles(s.client, at.base)).map((u) => u.name), ["Sam"]);
  const made = s.users.find((u) => u.name === "Sam")!;
  assert.deepEqual([made.hidden, made.remote, made.admin, made.password], [false, false, false, ""]);
  assert.equal(s.tokens.size, 0);
  const session = await openProfile(s.client, at, "Sam");
  assert.equal(session.userId, made.id);
});

test("a wrong password, an account that is not an administrator, and a name in use are refused in words", async () => {
  const s = server();
  await createProfile(s.client, at, admin, "Sam");
  await assert.rejects(createProfile(s.client, at, { name: "owner", password: "no" }, "Alex"), /did not accept/);
  await assert.rejects(createProfile(s.client, at, { name: "Sam", password: "" }, "Alex"), /not an administrator/);
  await assert.rejects(createProfile(s.client, at, admin, "sam"), /already a user/);
  await assert.rejects(openProfile(s.client, at, "owner"), /has a password/);
  assert.equal(s.users.length, 2);
  assert.equal(profileNameProblem("  ", []), "Type a name for the profile.");
  assert.equal(profileNameProblem("Kid's TV", []), null);
  assert.match(profileNameProblem("a/b", []) ?? "", /Use letters/);
});

test("two profiles on one device stay signed in side by side", async () => {
  const s = server();
  await createProfile(s.client, at, admin, "Sam");
  await createProfile(s.client, at, admin, "Alex");
  const sam = await openProfile(s.client, at, "Sam");
  const alex = await openProfile(s.client, at, "Alex");
  assert.notEqual(sam.deviceId, alex.deviceId);
  assert.equal((await s.client.me(sam)).name, "Sam");
  assert.equal((await s.client.me(alex)).name, "Alex");
});

test("new playlists are private; flag lists are shared with everyone to change", async () => {
  const s = server();
  await createProfile(s.client, at, admin, "Sam");
  await createProfile(s.client, at, admin, "Alex");
  const sam = await openProfile(s.client, at, "Sam");
  await s.client.createPlaylist(sam, "Road trip", ["s1"]);
  await s.client.createPlaylist(sam, "Problem tracks", ["s1"]);
  assert.deepEqual(s.lists.map((l) => l.open), [false, false]);
  assert.deepEqual(s.lists[0]!.shares, []);
  assert.deepEqual(s.lists[1]!.shares.map((u) => u.CanEdit), [true, true]); // the administrator and Alex
  const alex = await openProfile(s.client, at, "Alex");
  assert.deepEqual((await s.client.playlists(alex)).map((l) => l.name), ["Problem tracks"]);
});

test("a profile added later is let into the flag list by anyone who may already change it", async () => {
  const s = server();
  await createProfile(s.client, at, admin, "Sam");
  const sam = await openProfile(s.client, at, "Sam");
  await s.client.createPlaylist(sam, "Problem tracks", ["s1"]);
  await createProfile(s.client, at, admin, "Alex");
  assert.equal(await shareFlagLists(s.client, sam), 1);
  assert.equal(await shareFlagLists(s.client, sam), 0);
  const alex = await openProfile(s.client, at, "Alex");
  assert.equal((await s.client.playlists(alex)).length, 1);
  assert.equal(sharesForEveryone([{ userId: "a", canEdit: true }], [{ id: "a", name: "A", admin: false, disabled: false }]), null);
});

test("a flag list another profile made is emptied, not deleted, and the sign-in is kept", async () => {
  const s = server();
  await createProfile(s.client, at, admin, "Sam");
  await createProfile(s.client, at, admin, "Alex");
  const alex = await openProfile(s.client, at, "Alex");
  const sam = await openProfile(s.client, at, "Sam");
  const inbox = await s.client.createPlaylist(alex, "Problem Playlist 2026-11-26 10:00 (TV)", ["s1", "s2"]);
  await s.client.deletePlaylist(sam, inbox);
  assert.deepEqual(s.lists.map((l) => l.songs), [[]]);
  await s.client.deletePlaylist(alex, inbox);
  assert.equal(s.lists.length, 0);
});

test("favorites and playlists are copied into a profile, the old public lists hidden when asked, and running it again adds nothing", async () => {
  const s = server();
  const owner: Session = await s.client.signInAs(at, "owner", "secret");
  s.lists.push({ id: "old", name: "Old mix", owner: "u0", open: true, shares: [], songs: ["s1", "s2"] });
  s.lists.push({ id: "flags", name: "Problem tracks", owner: "u0", open: true, shares: [], songs: ["s3"] });
  s.lists.push({ id: "file", name: "From a file", owner: "", open: true, shares: [], songs: [], path: "/media/music/Playlists/From a file.m3u8" });
  await createProfile(s.client, at, admin, "Sam");
  const sam = await openProfile(s.client, at, "Sam");
  const report = await copyIntoProfile(s.client, owner, sam, { hideOriginals: true });
  assert.deepEqual(report, { favorites: 2, playlists: 1, already: 0, hidden: 1, files: 1, failed: [] });
  const samUser = s.users.find((u) => u.name === "Sam")!;
  assert.deepEqual([...samUser.favorites], ["s1", "s2"]);
  assert.deepEqual((await s.client.playlists(sam)).map((l) => l.name).sort(), ["From a file", "Old mix", "Problem tracks"]); // the file once, not twice
  assert.deepEqual(s.lists.find((l) => l.id === "old")!.songs, ["s1", "s2"]); // the original is kept
  assert.equal(s.lists.find((l) => l.id === "flags")!.open, true); // flags are not the copy's business
  const again = await copyIntoProfile(s.client, owner, sam, { hideOriginals: true });
  assert.deepEqual([again.favorites, again.playlists, again.already], [0, 0, 1]);
  assert.equal(describeCopy(report, "Sam"), "2 favorites and 1 playlist copied to Sam. 1 old playlist now shows only to the old account. 1 playlist file in the music folder was left: every profile sees it already.");
});

test("a real playlist is synced rather than a playlist file of the same name", async () => {
  const { syncPlaylists } = await import("./playlist-sync.ts");
  const read: string[] = [];
  const client = {
    serverSongs: async () => [{ id: "s1", path: "/media/music/A/B/one.mp3" }],
    playlists: async () => [{ id: "real", name: "Mix" }, { id: "file", name: "Mix", file: true }],
    playlistSongs: async (_s: Session, id: string) => (read.push(id), [{ id: "s1", title: "one", artist: "A", album: "B", artists: ["A"], durationMs: 1, entryId: "e1" }]),
    createPlaylist: async () => "new",
    addToPlaylist: async () => undefined,
    removeFromPlaylist: async () => undefined,
    deletePlaylist: async () => undefined,
  };
  const session: Session = { base: "http://x", name: "x", serverId: "s", userId: "u", token: "t" };
  await syncPlaylists({ client, session, playlists: [], libraryPaths: ["M:\\A\\B\\one.mp3"], savePlaylist: async () => "p", latest: () => undefined }, {});
  assert.deepEqual(read, ["real"]);
});
