import assert from "node:assert/strict";
import test from "node:test";
import { baseUrl, discover, neighbours } from "./api.ts";

test("the home network's addresses come from one address on it", () => {
  const all = neighbours("192.168.68.37");
  assert.equal(all.length, 254);
  assert.equal(all[0], "192.168.68.1");
  assert.equal(all[253], "192.168.68.254");
  assert.deepEqual(neighbours("not an address"), []);
  assert.deepEqual(neighbours("300.1.1.1"), []);
});

test("a wider home network (a mesh system's 255.255.252.0) is covered, the TV's own part first", () => {
  const all = neighbours("192.168.69.37", "255.255.252.0");
  assert.equal(all.length, 4 * 254);
  assert.equal(all[0], "192.168.69.1"); // the TV's own 254 addresses first
  assert.equal(all[254], "192.168.68.1");
  assert.equal(all.at(-1), "192.168.71.254");
  assert.equal(neighbours("192.168.69.37", "255.255.254.0").length, 2 * 254);
  assert.ok(neighbours("192.168.69.37", "255.255.254.0").includes("192.168.68.20"));
  // An ordinary mask, none, or nonsense: the 254 neighbours as before. Wider than four blocks: only four.
  assert.equal(neighbours("192.168.1.37", "255.255.255.0").length, 254);
  assert.equal(neighbours("192.168.1.37", null).length, 254);
  assert.equal(neighbours("192.168.1.37", "what").length, 254);
  const wide = neighbours("10.0.9.5", "255.0.0.0");
  assert.equal(wide.length, 4 * 254);
  assert.ok(wide.includes("10.0.8.1") && wide.includes("10.0.11.254") && !wide.includes("10.0.12.1"));
});

test("addresses get the sharing port unless one is given", () => {
  assert.equal(baseUrl("192.168.1.20"), "http://192.168.1.20:47700");
  assert.equal(baseUrl("192.168.1.20:47790"), "http://192.168.1.20:47790");
  assert.equal(baseUrl("192.168.1.256"), null);
});

test("discovery lists only computers running MediaVerse Studio", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (async (input: string | URL | Request) => {
    const address = String(input);
    if (address.includes("//10.0.0.5:")) return new Response(JSON.stringify({ app: "MediaVerse Studio", api: 2, computer: "Den PC" }));
    if (address.includes("//10.0.0.6:")) return new Response(JSON.stringify({ app: "Printer", api: 1, computer: "x" }));
    if (address.includes("//10.0.0.7:")) return new Response(JSON.stringify({ app: "MediaVerse Studio", api: 1, computer: "Old PC" }));
    throw new TypeError("refused");
  }) as typeof fetch;
  try {
    const found: string[] = [];
    await discover(neighbours("10.0.0.1"), (computer) => found.push(`${computer.computer}@${computer.host}`));
    assert.deepEqual(found, ["Den PC@10.0.0.5"]);
  } finally {
    globalThis.fetch = original;
  }
});
