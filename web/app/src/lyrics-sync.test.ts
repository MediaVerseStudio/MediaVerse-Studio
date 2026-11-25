import assert from "node:assert/strict";
import { test } from "node:test";
import { aiRequest, takeAiTimes, candidateKind, carryTimes, clearTimes, lineAt, linesOf, nextUntimed, isSectionLabel, nudge, sameSungWords, shiftAll, stamp, stampText, textToSave, timedCount, withoutLabels } from "./lyrics-sync.ts";

test("time-stamped lyrics become timed lines; header tags are skipped", () => {
  const lines = linesOf("[ar:Band]\n[00:12.50]First line\n[00:15.2]Second\n[01:02.345][01:30.00]Chorus", "ignored");
  assert.deepEqual(lines, [
    { text: "First line", ms: 12_500 },
    { text: "Second", ms: 15_200 },
    { text: "Chorus", ms: 62_345 },
    { text: "Chorus", ms: 90_000 },
  ]);
});

test("plain words become untimed lines with their verse breaks, without blank ends", () => {
  assert.deepEqual(linesOf(null, "\nOne\n\nTwo\n"), [
    { text: "One", ms: null },
    { text: "", ms: null },
    { text: "Two", ms: null },
  ]);
  assert.deepEqual(linesOf("no stamps here", "Words"), [{ text: "Words", ms: null }], "unusable time-stamped text falls back to the words");
});

test("lines move earlier and later, alone or all together, never before the start", () => {
  const lines = [
    { text: "a", ms: 1000 },
    { text: "b", ms: null },
    { text: "c", ms: 5000 },
  ];
  assert.equal(nudge(lines, 0, -250)[0].ms, 750);
  assert.equal(nudge(lines, 0, -5000)[0].ms, 0);
  assert.equal(nudge(lines, 1, 250)[1].ms, null, "a line without a time stays without");
  assert.deepEqual(shiftAll(lines, 500).map((l) => l.ms), [1500, null, 5500]);
  assert.equal(lines[0].ms, 1000, "the original is not changed");
});

test("tapping times the next untimed sung line, skipping verse breaks", () => {
  let lines = linesOf(null, "One\n\nTwo");
  assert.equal(nextUntimed(lines), 0);
  lines = stamp(lines, nextUntimed(lines), 3200.4);
  assert.equal(nextUntimed(lines), 2);
  lines = stamp(lines, 2, 7000);
  assert.equal(nextUntimed(lines), -1);
  assert.deepEqual(timedCount(lines), { timed: 2, total: 2 });
  assert.equal(lineAt(lines, 5000), 0);
  assert.equal(lineAt(lines, 100), -1);
  assert.deepEqual(timedCount(clearTimes(lines)), { timed: 0, total: 2 });
});

test("every line timed: saved as .lrc in time order; otherwise as plain words", () => {
  const timed = [
    { text: "late", ms: 9000 },
    { text: "", ms: null },
    { text: "early", ms: 61_005 - 60_000 },
  ];
  assert.deepEqual(textToSave(timed), { text: "[00:01.01]early\n[00:09.00]late", synced: true });
  const partly = [
    { text: "one", ms: 1000 },
    { text: "", ms: null },
    { text: "two", ms: null },
  ];
  assert.deepEqual(textToSave(partly), { text: "one\n\ntwo", synced: false });
  assert.equal(stampText(62_345), "01:02.35");
});

test("candidates are described by how they relate to the song", () => {
  const base = { track: "S", artist: "A", album: null, duration: null, confidence: 70, synced: false };
  assert.equal(candidateKind({ ...base, other_artist: true }), "same song, another artist");
  assert.equal(candidateKind({ ...base, other_version: true }), "another version");
  assert.equal(candidateKind({ ...base, source: "lyric-ai" }), "AI-checked against the singing", "an AI pick says so, whatever the record it came from was");
  assert.equal(candidateKind({ ...base, source: "whisper-draft" }), "AI draft from listening: check the words");
  assert.equal(candidateKind({ ...base, length_unknown: true }), "length not compared");
  assert.equal(candidateKind(base), "same length");
});

test("the band's words count as unchanged when only times or blank lines differ", () => {
  const original = "Hey ho\nLet's go";
  assert.equal(sameSungWords([{ text: "Hey ho", ms: 100 }, { text: "", ms: null }, { text: " Let's go ", ms: 900 }], original), true);
  assert.equal(sameSungWords([{ text: "Hey ho", ms: 100 }, { text: "Let's go", ms: 900 }, { text: "Let's go", ms: null }], original), false, "a pasted chorus line changes the words");
  assert.equal(sameSungWords([{ text: "Hey ho!", ms: 1 }, { text: "Let's go", ms: 2 }], original), false, "a changed word");
});

test("section labels are told from backing vocals, as in the Lyric AI's timing step", () => {
  for (const label of ["[Chorus]", "  [Verse 2: Sam] ", "(Instrumental)", "Verse 2", "Guitar solo:", "Bridge"]) assert.equal(isSectionLabel(label), true, label);
  for (const sung of ["(Ooh, ooh)", "(Hey!)", "She said (really)", "Hey ho", "Chorus of angels sing"]) assert.equal(isSectionLabel(sung), false, sung);
  assert.equal(withoutLabels("[Chorus]\nHey ho\n\n(Instrumental)\n(Ooh)\nLet's go"), "Hey ho\n\n(Ooh)\nLet's go", "labels go, verse breaks and backing vocals stay");
  assert.equal(withoutLabels(null), "");
});
test("an untimed candidate takes its times from the same words timed as another candidate", () => {
  const photo = linesOf(null, "We can't go back in time\nTo the top, to those first couple days\n\nSo lets get back to packing\nOh oh");
  const timed = linesOf("[00:12.62]We can't go back in time\n[00:14.20]To the top, to those first couple days\n[00:21.86]So let's get back to packing", null);
  const result = carryTimes(photo, timed);
  assert.deepEqual(result.lines.map((l) => l.ms), [12_620, 14_200, null, 21_860, null], "a small spelling difference still matches; a line the donor does not have stays untimed; the blank line has none");
  assert.deepEqual([result.carried, result.total], [3, 4]);
  const chorus = carryTimes(linesOf(null, "La la\nLa la"), linesOf("[00:10.00]La la\n[00:20.00]La la", null));
  assert.deepEqual(chorus.lines.map((l) => l.ms), [10_000, 20_000], "a repeated line takes the next time, in order");
  assert.equal(carryTimes(linesOf(null, "Completely different words here"), timed).carried, 0);
});
test("a hand-timed line is marked, sent to the Lyric AI as fixed, and kept when the answer comes", () => {
  let lines = linesOf(null, "[Chorus]\nfirst line\n\nsecond line\nthird line\nfourth line");
  lines = stamp(lines, 1, 12_000);
  assert.equal(lines[1]!.mine, true);
  const request = aiRequest(lines);
  // The label and the blank line are not sung: they are not sent.
  assert.deepEqual(request.at, [1, 3, 4, 5]);
  assert.deepEqual(request.lines.map((l) => [l.text, l.ms, l.mine]), [["first line", 12_000, true], ["second line", null, false], ["third line", null, false], ["fourth line", null, false]]);
  const answer = [{ ms: 12_000, placed: true }, { ms: 15_000, placed: true }, { ms: 15_000, placed: false }, { ms: 21_000, placed: true }];
  const taken = takeAiTimes(lines, request.at, request.lines, answer);
  assert.deepEqual(taken.lines.map((l) => l.ms), [null, 12_000, null, 15_000, null, 21_000]);
  assert.deepEqual({ taken: taken.taken, kept: taken.kept }, { taken: 2, kept: 1 });
  assert.equal(taken.lines[1]!.mine, true, "the hand-timed line stays the person's");
  assert.equal(taken.lines[3]!.mine, undefined, "an AI-timed line is not marked, so the next run may move it");
});

test("asking the AI to time everything again ignores the hand timing, and the answer replaces it", () => {
  const lines = stamp(linesOf(null, "one one\ntwo two\nthree three"), 0, 1_000);
  assert.equal(aiRequest(lines, true).lines[0]!.mine, false);
  const request = aiRequest(lines, true);
  const taken = takeAiTimes(lines, request.at, request.lines, [{ ms: 2_000, placed: true }, { ms: 4_000, placed: true }, { ms: 6_000, placed: true }], true);
  assert.deepEqual(taken.lines.map((l) => l.ms), [2_000, 4_000, 6_000]);
  assert.equal(taken.lines[0]!.mine, undefined);
});

test("lines edited while the AI listened are left alone; a line timed meanwhile is kept", () => {
  const lines = linesOf(null, "one one\ntwo two\nthree three");
  const request = aiRequest(lines);
  const meanwhile = stamp(lines.map((l, i) => (i === 0 ? { ...l, text: "uno uno" } : l)), 2, 9_000);
  const taken = takeAiTimes(meanwhile, request.at, request.lines, [{ ms: 1_000, placed: true }, { ms: 4_000, placed: true }, { ms: 6_000, placed: true }]);
  assert.deepEqual(taken.lines.map((l) => l.ms), [null, 4_000, 9_000], "the changed words did not take a time; the line timed meanwhile kept its time");
});

test("clearing the times also forgets which lines were timed by hand", () => {
  const cleared = clearTimes(stamp(linesOf(null, "a a\nb b"), 0, 500));
  assert.deepEqual(cleared, [{ text: "a a", ms: null }, { text: "b b", ms: null }]);
});
