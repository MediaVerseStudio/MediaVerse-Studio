const assert = require("node:assert/strict");
const { test } = require("node:test");
const { parseDiscoveryReply, serverBase, isOnThisComputer, isHomeNetworkHost } = require("./jellyfin");

test("a Jellyfin discovery reply gives the server's id, name and address", () => {
  const reply = JSON.stringify({ Address: "http://192.168.68.50:8096", Id: "abc123", Name: "HOME-PC", EndpointAddress: null });
  assert.deepEqual(parseDiscoveryReply(reply), { id: "abc123", name: "HOME-PC", base: "http://192.168.68.50:8096" });
});

test("replies that are not Jellyfin's, or carry odd addresses, are ignored", () => {
  assert.equal(parseDiscoveryReply("not json"), null);
  assert.equal(parseDiscoveryReply(JSON.stringify({ Address: "http://x:8096" })), null);
  assert.equal(parseDiscoveryReply(JSON.stringify({ Id: "a", Address: "file:///C:/Windows" })), null);
  assert.equal(parseDiscoveryReply(JSON.stringify({ Id: "a", Address: "http://user:pw@192.168.1.2:8096" })), null);
  assert.equal(serverBase("http://192.168.1.2:8096/some/path?x=1"), "http://192.168.1.2:8096");
});

test("a server is on this computer when its host is one of this computer's addresses", () => {
  const own = new Set(["127.0.0.1", "192.168.68.20"]);
  assert.equal(isOnThisComputer("http://192.168.68.20:8096", own), true);
  assert.equal(isOnThisComputer("http://127.0.0.1:8096", own), true);
  assert.equal(isOnThisComputer("http://192.168.68.21:8096", own), false);
});

test("only home-network servers can be opened from the helper", () => {
  for (const host of ["localhost", "127.0.0.1", "192.168.68.50", "10.0.0.4", "172.16.0.9", "172.31.255.1"]) assert.equal(isHomeNetworkHost(host), true, host);
  for (const host of ["8.8.8.8", "172.32.0.1", "jellyfin.example.com", "192.168.1"]) assert.equal(isHomeNetworkHost(host), false, host);
});
