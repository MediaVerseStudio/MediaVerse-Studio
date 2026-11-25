import assert from "node:assert/strict";
import { test } from "node:test";
import { blobFromBase64, folderOf } from "./cover-util.ts";

test("the folder of a path works for Windows and POSIX paths", () => {
  assert.equal(folderOf("C:\\Music\\Artist\\Album\\01.mp3"), "C:\\Music\\Artist\\Album");
  assert.equal(folderOf("/home/me/Music/a.mp3"), "/home/me/Music");
  assert.equal(folderOf("song.mp3"), "");
});

test("base64 turns back into the original bytes", async () => {
  const blob = blobFromBase64("Zm9vYmFy", "image/png");
  assert.equal(blob.type, "image/png");
  assert.equal(await blob.text(), "foobar");
});
