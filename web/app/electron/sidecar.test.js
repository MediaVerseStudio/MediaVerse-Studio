const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const { SidecarClient, resolveSidecarPath } = require("./sidecar");

test("SidecarClient talks to the real sidecar and maps errors", async () => {
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "mv-sidecar-"));
  const client = new SidecarClient({ executable: resolveSidecarPath(), dataDir });

  try {
    assert.deepEqual(await client.invoke("collection_status"), { root: null });
    assert.deepEqual((await client.invoke("library_snapshot")).tracks, []);
    await assert.rejects(client.invoke("rescan_collection"), {
      code: "collection_not_selected",
    });
  } finally {
    await client.stop();
  }
});
