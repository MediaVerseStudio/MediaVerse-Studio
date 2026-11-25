const assert = require("node:assert/strict");
const test = require("node:test");
const { homeHttp, isHomeAddress } = require("./home-http");

test("home-network addresses are allowed, the internet is not", () => {
  for (const ok of ["192.168.68.76", "10.1.2.3", "172.16.0.1", "172.31.255.1", "127.0.0.1", "169.254.1.1", "::1", "fd12:3456::1", "fe80::1", "::ffff:192.168.1.5"]) assert.ok(isHomeAddress(ok), ok);
  for (const no of ["8.8.8.8", "172.32.0.1", "172.15.0.1", "2001:4860:4860::8888", "not an address", ""]) assert.ok(!isHomeAddress(no), no);
});

test("a request to a home address is made and answered", async () => {
  let seen;
  const fetchImpl = async (url, options) => { seen = { url: String(url), options }; return { status: 200, arrayBuffer: async () => Buffer.from('{"ok":true}') }; };
  const reply = await homeHttp({ url: "http://192.168.68.76:8096/System/Info/Public", headers: { Authorization: "x", Bad: 5 } }, { fetchImpl });
  assert.deepEqual(reply, { status: 200, body: '{"ok":true}' });
  assert.equal(seen.options.method, "GET");
  assert.deepEqual(seen.options.headers, { Authorization: "x" });
});

test("a picture is returned as base64 when binary is asked for", async () => {
  const jpeg = Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0x00, 0x10, 0x80, 0xfe]);
  const fetchImpl = async () => ({ status: 200, arrayBuffer: async () => jpeg });
  const reply = await homeHttp({ url: "http://192.168.68.13:8096/Items/1/Images/Primary", binary: true }, { fetchImpl });
  assert.equal(reply.status, 200);
  assert.deepEqual(Buffer.from(reply.body, "base64"), jpeg, "the bytes survive, which text would not");
});

test("a name that points to the internet is refused without any request", async () => {
  let asked = false;
  const reply = await homeHttp({ url: "http://example.test/x" }, { resolve: async () => [{ address: "93.184.216.34" }], fetchImpl: async () => { asked = true; } });
  assert.equal(reply.status, -2);
  assert.ok(!asked);
});

test("a name that points home is allowed, one with mixed answers is not", async () => {
  const fetchImpl = async () => ({ status: 204, arrayBuffer: async () => Buffer.alloc(0) });
  assert.equal((await homeHttp({ url: "http://nas.local/x" }, { resolve: async () => [{ address: "192.168.1.9" }], fetchImpl })).status, 204);
  assert.equal((await homeHttp({ url: "http://nas.local/x" }, { resolve: async () => [{ address: "192.168.1.9" }, { address: "8.8.8.8" }], fetchImpl })).status, -2);
});

test("other schemes and failures are reported, not thrown", async () => {
  assert.equal((await homeHttp({ url: "file:///C:/secret.txt" })).status, -2);
  assert.equal((await homeHttp({ url: "http://192.168.1.2/" }, { fetchImpl: async () => { throw new Error("connect refused"); } })).status, -1);
  assert.equal((await homeHttp({})).status, -1);
});
