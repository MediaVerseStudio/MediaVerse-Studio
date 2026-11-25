import assert from "node:assert/strict";
import test from "node:test";
import { compilePattern, detectPattern, editsFromNames, fitPattern, parseName } from "./filename-pattern.ts";

const parse = (pattern: string, stem: string) => {
  const compiled = compilePattern(pattern);
  assert.ok(!("error" in compiled), JSON.stringify(compiled));
  return parseName(compiled, stem);
};

test("a pattern reads the fields out of a file name", () => {
  assert.deepEqual(parse("%track% - %title%", "07 - Girl's Not Grey"), { track: "7", title: "Girl's Not Grey" });
  assert.deepEqual(parse("%disc%-%track% %title%", "2-03 Leaving Song"), { disc: "2", track: "3", title: "Leaving Song" });
  assert.deepEqual(parse("%artist% - %title%", "AFI - Bleed Black"), { artist: "AFI", title: "Bleed Black" });
  assert.equal(parse("%track% - %title%", "Bleed Black"), null, "a name that does not fit gives nothing");
  assert.deepEqual(parse("%track%_%title%", "01_Bleed_Black"), { track: "1", title: "Bleed Black" }, "underscores read as spaces");
});

test("a pattern with a mistake says what is wrong", () => {
  assert.ok("error" in compilePattern(""));
  assert.match((compilePattern("%track% - %titel%") as { error: string }).error, /titel/);
  assert.match((compilePattern("%title% %title%") as { error: string }).error, /twice/);
  assert.match((compilePattern("just text") as { error: string }).error, /at least one field/);
});

test("the usual form of numbered names is recognised without asking", () => {
  assert.equal(detectPattern(["01 - Intro", "02 - Bleed Black", "03 - Leaving Song"]).obvious, "%track% - %title%");
  assert.equal(detectPattern(["01 Intro", "02 Bleed Black"]).obvious, "%track% %title%");
  assert.equal(detectPattern(["01. Intro", "02. Bleed Black"]).obvious, "%track%. %title%");
  assert.equal(detectPattern(["AFI - Intro", "AFI - Bleed Black"]).obvious, "%artist% - %title%");
  assert.equal(detectPattern(["1-01 Intro", "2-01 Bleed Black"]).obvious, "%disc%-%track% %title%");
});

test("when two readings fit, the person is asked", () => {
  const detection = detectPattern(["01 - AFI - Intro", "02 - AFI - Bleed Black"]);
  assert.equal(detection.obvious, null);
  assert.deepEqual(detection.choices.map((c) => c.pattern), ["%track% - %artist% - %title%", "%track% - %title%"]);
});

test("names that follow no usual pattern leave nothing obvious, and a repeated track number is not a fit", () => {
  assert.equal(detectPattern(["Intro", "Bleed Black"]).obvious, null);
  assert.deepEqual(detectPattern(["Intro", "Bleed Black"]).choices, []);
  assert.equal(fitPattern("%track% - %title%", ["01 - A", "01 - B"])?.sane, false);
  assert.equal(detectPattern([]).obvious, null);
});

test("a pattern that fits most files is offered, with the count", () => {
  const stems = ["01 - A", "02 - B", "03 - C", "04 - D", "bonus"];
  const detection = detectPattern(stems);
  assert.equal(detection.obvious, null);
  assert.equal(detection.choices[0].pattern, "%track% - %title%");
  assert.equal(detection.choices[0].matched, 4);
  assert.equal(detection.choices[0].total, 5);
});

test("the edits hold only what the names say, and skip files that do not fit", () => {
  const files = [{ path: "a.mp3", stem: "01 - Intro" }, { path: "b.mp3", stem: "bonus" }];
  assert.deepEqual(editsFromNames(files, "%track% - %title%"), { "a.mp3": { track: "1", title: "Intro" } });
  assert.deepEqual(editsFromNames(files, "%nonsense%"), {});
});
