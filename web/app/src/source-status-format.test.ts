import assert from "node:assert/strict";
import test from "node:test";
import { describeSource, describeSources, sourceName, type SourceRow } from "./source-status-format.ts";

const row = (over: Partial<SourceRow>): SourceRow => ({ source: "musicbrainz", state: "ok", refusals: 0, retry_in_seconds: 0, waiting: 0, last_ok_seconds_ago: 3, last_request_seconds_ago: 3, ...over });

test("a working source says ok, with its queue when requests are waiting", () => {
  assert.deepEqual(describeSource(row({})), { text: "MusicBrainz ok", level: "ok" });
  assert.equal(describeSource(row({ waiting: 3 })).text, "MusicBrainz ok (3 waiting)");
});

test("a refusing source is busy, and one that keeps refusing is not answering, with the time to the next try", () => {
  assert.deepEqual(describeSource(row({ state: "slowed", refusals: 1, retry_in_seconds: 1 })), { text: "MusicBrainz is busy; waiting 1 second", level: "warn" });
  assert.deepEqual(describeSource(row({ state: "down", refusals: 4, retry_in_seconds: 45 })), { text: "MusicBrainz is not answering; next try in 45 seconds", level: "bad" });
  assert.equal(describeSource(row({ state: "down", retry_in_seconds: 300 })).text, "MusicBrainz is not answering; next try in 5 minutes");
  assert.equal(describeSource(row({ state: "down", retry_in_seconds: 0 })).text, "MusicBrainz is not answering");
});

test("worst first, and unknown sources keep their own name", () => {
  const lines = describeSources([row({ source: "coverart" }), row({ source: "mystery", state: "down" }), row({ source: "discogs", state: "slowed" })]);
  assert.deepEqual(lines.map((l) => l.level), ["bad", "warn", "ok"]);
  assert.equal(lines[0].text, "mystery is not answering");
  assert.equal(sourceName("wikimedia"), "Wikimedia");
});