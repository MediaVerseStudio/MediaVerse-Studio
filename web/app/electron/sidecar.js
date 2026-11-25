const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const readline = require("node:readline");

const SUPPORTED_PROTOCOL = 1;
const REQUEST_TIMEOUT_MS = 10 * 60 * 1000;

function resolveSidecarPath(resourcesPath) {
  const candidates = [
    process.env.MEDIAVERSE_SIDECAR_PATH,
    resourcesPath && path.join(resourcesPath, "mediaverse_sidecar.exe"),
    path.join(__dirname, "..", "..", "..", "target", "debug", "mediaverse_sidecar.exe"),
  ].filter(Boolean);

  const found = candidates.find((candidate) => fs.existsSync(candidate));
  if (!found) {
    throw new Error(
      "The MediaVerse sidecar was not found. Run 'npm run sidecar:build' or set MEDIAVERSE_SIDECAR_PATH.",
    );
  }
  return found;
}

/** Client for the line-delimited JSON sidecar protocol (docs/architecture/0003-sidecar-protocol.md). */
class SidecarClient {
  constructor({ executable, dataDir, onEvent, onExit }) {
    this.pending = new Map();
    this.nextId = 1;
    this.onEvent = onEvent;
    this.closed = false;
    this.ready = new Promise((resolve, reject) => {
      this.resolveReady = resolve;
      this.rejectReady = reject;
    });

    this.child = spawn(executable, ["--data-dir", dataDir], {
      stdio: ["pipe", "pipe", "inherit"],
      windowsHide: true,
    });
    this.child.on("error", (error) => this.fail(error));
    this.child.on("exit", (code) => {
      this.fail(new Error(`The MediaVerse sidecar exited (code ${code}).`));
      if (onExit) onExit(code);
    });
    this.child.stdin.on("error", () => {});

    readline.createInterface({ input: this.child.stdout }).on("line", (line) => {
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return;
      }
      this.handle(message);
    });
  }

  handle(message) {
    switch (message.type) {
      case "ready":
        if (message.protocol !== SUPPORTED_PROTOCOL) {
          this.fail(
            new Error(
              `Unsupported sidecar protocol ${message.protocol}; expected ${SUPPORTED_PROTOCOL}.`,
            ),
          );
          this.child.kill();
          return;
        }
        this.commands = new Set(message.commands);
        this.resolveReady();
        break;
      case "response": {
        const entry = this.pending.get(message.id);
        if (!entry) return;
        this.pending.delete(message.id);
        clearTimeout(entry.timer);
        if (message.ok) {
          entry.resolve(message.result);
        } else {
          // Reject with the sidecar's structured {code, message} error, which the renderer expects.
          entry.reject(message.error);
        }
        break;
      }
      case "event":
        if (this.onEvent) this.onEvent(message.event, message.payload);
        break;
    }
  }

  fail(error) {
    this.closed = true;
    this.rejectReady(error);
    for (const [id, entry] of this.pending) {
      clearTimeout(entry.timer);
      entry.reject({ code: "sidecar_unavailable", message: error.message });
      this.pending.delete(id);
    }
  }

  async invoke(command, args) {
    await this.ready;
    if (this.closed) {
      throw { code: "sidecar_unavailable", message: "The MediaVerse sidecar is not running." };
    }
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject({ code: "sidecar_timeout", message: `'${command}' timed out.` });
      }, REQUEST_TIMEOUT_MS);
      this.pending.set(id, { resolve, reject, timer });
      this.child.stdin.write(`${JSON.stringify({ id, command, args: args ?? null })}\n`);
    });
  }

  async stop() {
    if (this.closed) return;
    try {
      await Promise.race([
        this.invoke("shutdown"),
        new Promise((resolve) => setTimeout(resolve, 2000)),
      ]);
    } catch {
      // Fall through to kill.
    }
    this.child.kill();
  }
}

module.exports = { SidecarClient, resolveSidecarPath };
