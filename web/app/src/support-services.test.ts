import assert from "node:assert/strict";
import { test } from "node:test";
import { ISSUE_BOARD, SUPPORT_LINKS } from "./support-services.ts";

test("every supported service has a plain description and an https address on an expected site", () => {
  const hosts = new Set(["gnudb.org", "metabrainz.org", "archive.org", "donate.wikimedia.org", "jellyfin.org", "lrclib.net"]);
  const names = new Set<string>();
  for (const link of SUPPORT_LINKS) {
    assert.ok(link.what.length > 20 && link.label.length > 3, link.name);
    const url = new URL(link.url);
    assert.equal(url.protocol, "https:", link.name);
    assert.ok(hosts.has(url.hostname), `${link.name}: ${url.hostname}`);
    assert.ok(!names.has(link.name), `${link.name} is listed twice`);
    names.add(link.name);
  }
  assert.ok(SUPPORT_LINKS.length >= 4);
});

test("companies and services without a gift page are not listed, and the issue board is on GitHub", () => {
  const text = JSON.stringify(SUPPORT_LINKS).toLowerCase();
  for (const left of ["acoustid", "discogs", "itunes", "deezer", "lame"]) assert.ok(!text.includes(left), left);
  assert.ok(ISSUE_BOARD.startsWith("https://github.com/MediaVerseStudio/MediaVerse-Studio/"));
});
