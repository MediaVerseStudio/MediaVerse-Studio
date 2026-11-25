import assert from "node:assert/strict";
import { test } from "node:test";
import { PICTURE_LIMITS, centreSquare, describeSize, lyricsRequest, pictureRequest, picturesRequest, scaleFor, summarizeEdit, wantsFolderCopy, webSearchUrl } from "./media-request.ts";

test("requests have the shape the sidecar expects", () => {
  assert.deepEqual(pictureRequest(["a.mp3", "b.mp3"], "back_cover", "QUJD"), { paths: ["a.mp3", "b.mp3"], pictures: [{ kind: "back_cover", data_base64: "QUJD" }] });
  assert.deepEqual(pictureRequest(["a.mp3"], "artist_photo", null).pictures, [{ kind: "artist_photo", data_base64: null }]);
  assert.deepEqual(lyricsRequest("a.mp3", "[00:01.00]Hi"), { paths: ["a.mp3"], lyrics: { text: "[00:01.00]Hi" } });
  assert.deepEqual(lyricsRequest("a.mp3", null), { paths: ["a.mp3"], lyrics: { clear: true } });
});

test("results are summarised honestly", () => {
  assert.deepEqual(summarizeEdit([{ path: "a", ok: true }], "The picture"), { ok: true, message: "The picture saved." });
  assert.match(summarizeEdit([{ path: "a", ok: true }, { path: "b", ok: true }], "The picture").message, /saved on 2 tracks/);
  const mixed = summarizeEdit([{ path: "a", ok: true }, { path: "b", ok: false, error: "is playing" }], "The picture");
  assert.equal(mixed.ok, false);
  assert.match(mixed.message, /1 of 2 tracks.*is playing/);
  assert.match(summarizeEdit([{ path: "a", ok: false, error: "no tag" }], "The lyrics").message, /not saved: no tag/);
});

test("large pictures are scaled down and small ones left alone", () => {
  assert.equal(scaleFor(2400, 1200, 1200), 0.5);
  assert.equal(scaleFor(800, 600, 1200), 1);
  assert.equal(scaleFor(1200, 1200, 1200), 1);
});

test("pictures for several kinds go in one request; sizes, crops and the web search address", () => {
  assert.deepEqual(picturesRequest(["a.mp3"], [{ kind: "front_cover", base64: "QUJD" }, { kind: "artist_photo", base64: null }]), {
    paths: ["a.mp3"],
    pictures: [{ kind: "front_cover", data_base64: "QUJD" }, { kind: "artist_photo", data_base64: null }],
  });
  assert.equal(PICTURE_LIMITS.maxSide, 1000);
  assert.equal(scaleFor(2000, 1000, PICTURE_LIMITS.maxSide), 0.5);
  assert.deepEqual(centreSquare(1400, 1200), { x: 100, y: 0, side: 1200 });
  assert.deepEqual(centreSquare(500, 501), { x: 0, y: 0, side: 500 });
  assert.equal(describeSize(500, 500), "500 × 500");
  assert.equal(describeSize(1200, 1200), "1200 × 1200 (over 1000)");
  assert.equal(webSearchUrl("Dude Ranch", "blink-182", 1997), "https://www.google.com/search?tbm=isch&tbs=isz:l&q=blink-182%20Dude%20Ranch%201997%20album%20artwork");
  assert.equal(webSearchUrl("Live & Loud", null, null), "https://www.google.com/search?tbm=isch&tbs=isz:l&q=Live%20%26%20Loud%20album%20artwork");
});

test("a full-size copy goes to the album folder unless one at least as big is there", () => {
  assert.equal(wantsFolderCopy("new", 300, { width: 1200, height: 1200 }), true, "a picture the person chose replaces the folder's");
  assert.equal(wantsFolderCopy("folder", 3000, null), false, "the folder's own picture is not written again");
  assert.equal(wantsFolderCopy("embedded", 1400, null), true);
  assert.equal(wantsFolderCopy("embedded", 1400, { width: 1400, height: 1400 }), false);
  assert.equal(wantsFolderCopy("embedded", 1400, { width: 500, height: 500 }), true);
  assert.deepEqual(picturesRequest(["a.mp3"], [{ kind: "front_cover", base64: "QQ" }], [{ kind: "front_cover", base64: "Qg" }], "fix-1"), {
    paths: ["a.mp3"], pictures: [{ kind: "front_cover", data_base64: "QQ" }], folder_pictures: [{ kind: "front_cover", data_base64: "Qg" }], batch: "fix-1",
  });
});
