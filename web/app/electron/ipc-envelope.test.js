const test = require("node:test");
const assert = require("node:assert/strict");
const { toEnvelope } = require("./ipc-envelope");

test("a successful result is wrapped", async () => {
  assert.deepEqual(await toEnvelope(async () => ({ root: null })), { ok: true, result: { root: null } });
});

test("a structured sidecar error keeps its code and message", async () => {
  const reply = await toEnvelope(async () => {
    throw { code: "invalid_settings", message: "line one\nline two", extra: "dropped" };
  });
  assert.deepEqual(reply, { ok: false, error: { code: "invalid_settings", message: "line one\nline two" } });
});

test("ordinary errors and odd values become a generic error with their text", async () => {
  assert.deepEqual(await toEnvelope(async () => { throw new Error("boom"); }), { ok: false, error: { code: "error", message: "boom" } });
  assert.deepEqual(await toEnvelope(async () => { throw "text"; }), { ok: false, error: { code: "error", message: "text" } });
  assert.deepEqual(await toEnvelope(async () => { throw { code: 5 }; }), { ok: false, error: { code: "error", message: "[object Object]" } });
});

test("a synchronous throw inside the work is caught too", async () => {
  const reply = await toEnvelope(() => { throw new Error("sync"); });
  assert.equal(reply.ok, false);
  assert.equal(reply.error.message, "sync");
});
