import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_RULE, RULES, ruleOf, readChoices } from "./organize-choices.ts";

const store = (value: string | null): Pick<Storage, "getItem"> => ({ getItem: () => value });

test("the first naming rule is the default, and there are several common ones", () => {
  assert.equal(RULES[0]!.rule, DEFAULT_RULE);
  assert.ok(RULES.length >= 5);
  assert.equal(new Set(RULES.map((r) => r.id)).size, RULES.length);
  assert.ok(RULES.every((r) => r.rule.includes("{title}") || r.rule.includes("{file}")));
});

test("choices start with the default rule, compilations kept together", () => {
  const c = readChoices(store(null));
  assert.deepEqual([c.rule, c.compilations], ["dash", true]);
  assert.equal(ruleOf(c), DEFAULT_RULE);
});

test("saved choices are read back, and nonsense falls back", () => {
  const c = readChoices(store(JSON.stringify({ rule: "year-after", compilations: false })));
  assert.deepEqual([c.rule, c.compilations], ["year-after", false]);
  assert.equal(ruleOf(c), "{albumartist}/{album} ({year})/{disc}{track} - {title}");
  const custom = readChoices(store(JSON.stringify({ rule: "custom", custom: "{artist}/{title}" })));
  assert.equal(ruleOf(custom), "{artist}/{title}");
  const bad = readChoices(store(JSON.stringify({ rule: "nope", custom: 5 })));
  assert.deepEqual([bad.rule, bad.custom], ["dash", DEFAULT_RULE]);
  assert.equal(readChoices(store("not json")).rule, "dash");
});
