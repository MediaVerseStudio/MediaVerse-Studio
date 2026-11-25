import assert from "node:assert/strict";
import { test } from "node:test";
import { OPTIONAL_SERVICES, looksLikeEmail, remainingText, setupComplete, setupSteps, type SetupInput } from "./setup-state.ts";

const base: SetupInput = { library_dir: null, archive_enabled: true, archive_decided: false, archive_dir: null, contact: "" };

test("emails are recognised by a plain shape check", () => {
  assert.equal(looksLikeEmail("me@example.com"), true);
  assert.equal(looksLikeEmail(" me@mail.example.co.uk "), true);
  for (const bad of ["", "me", "me@", "@example.com", "me@example", "me @example.com", "https://mediaverse.studio"]) assert.equal(looksLikeEmail(bad), false, bad);
});

test("a fresh install has three things to set up", () => {
  const steps = setupSteps(base);
  assert.deepEqual(steps.map((s) => s.done), [false, false, false]);
  assert.equal(setupComplete(steps), false);
  assert.match(remainingText(steps), /3 things left/);
});

test("the archive step is done by choosing a folder or by saying no, not by the default", () => {
  assert.equal(setupSteps({ ...base, archive_decided: false })[1].done, false);
  assert.equal(setupSteps({ ...base, archive_decided: true, archive_enabled: true, archive_dir: null })[1].done, false, "yes, but no folder yet");
  assert.equal(setupSteps({ ...base, archive_decided: true, archive_enabled: true, archive_dir: "D:\\Archive" })[1].done, true);
  assert.equal(setupSteps({ ...base, archive_decided: true, archive_enabled: false })[1].done, true);
});

test("everything done means the box can go away", () => {
  const steps = setupSteps({ library_dir: "D:\\Music", archive_enabled: false, archive_decided: true, archive_dir: null, contact: "me@example.com" });
  assert.equal(setupComplete(steps), true);
  assert.equal(remainingText(steps), "Everything is set up.");
});

test("optional services say what they are for and link only to https pages", () => {
  assert.ok(OPTIONAL_SERVICES.length >= 3);
  for (const service of OPTIONAL_SERVICES) {
    assert.ok(service.purpose.length > 20);
    if (service.link) assert.ok(service.link.url.startsWith("https://"));
  }
});
