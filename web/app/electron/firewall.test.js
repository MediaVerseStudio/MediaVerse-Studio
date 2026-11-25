const assert = require("node:assert/strict");
const { test } = require("node:test");
const { isBlocked } = require("./firewall");

test("TVs are turned away when the network's category has no allowing rule", () => {
  // The owner's PC on 2026-11-05: a private home network, the program allowed on public networks only.
  assert.equal(isBlocked(["Private"], ["Public", "Public"]), true);
  assert.equal(isBlocked(["Private"], ["Public", "Private"]), false);
  assert.equal(isBlocked(["Private"], ["Public, Private"]), false);
  assert.equal(isBlocked(["Public"], ["Any"]), false);
  assert.equal(isBlocked(["DomainAuthenticated"], ["Domain"]), false);
  assert.equal(isBlocked(["Private", "Public"], ["Private"]), true, "every connected network counts");
  assert.equal(isBlocked([], []), false, "no network: nothing to say");
});
