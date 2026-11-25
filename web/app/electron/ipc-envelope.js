// Electron's IPC turns anything a handler throws into a string, which loses the `{code, message}`
// the sidecar reports. So handlers return an envelope instead, and the renderer re-raises the
// structured error (web/app/src/desktop-bridge.ts).

/** Runs `work` and wraps the outcome: `{ ok: true, result }` or `{ ok: false, error: {code, message} }`. */
async function toEnvelope(work) {
  try {
    return { ok: true, result: await work() };
  } catch (thrown) {
    return { ok: false, error: toError(thrown) };
  }
}

function toError(thrown) {
  if (thrown && typeof thrown === "object" && typeof thrown.code === "string") {
    return { code: thrown.code, message: String(thrown.message ?? "") };
  }
  if (thrown instanceof Error) {
    return { code: "error", message: thrown.message };
  }
  return { code: "error", message: String(thrown) };
}

module.exports = { toEnvelope, toError };
