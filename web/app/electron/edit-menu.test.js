const test = require("node:test");
const assert = require("node:assert/strict");
const { template } = require("./edit-menu");

test("a misspelled word gets its suggestions first, then Add to dictionary, then the editing items", () => {
  const done = [];
  const items = template(
    { misspelledWord: "teh", dictionarySuggestions: ["the", "tea", "ten", "tech", "tell", "tent", "teeth", "tenth"], editFlags: { canCut: true, canCopy: true, canPaste: true } },
    { replace: (w) => done.push(["replace", w]), addToDictionary: (w) => done.push(["add", w]) },
  );
  const labels = items.filter((i) => i.label).map((i) => i.label);
  assert.deepEqual(labels.slice(0, 6), ["the", "tea", "ten", "tech", "tell", "tent"], "at most six suggestions");
  assert.equal(labels[6], "Add “teh” to the dictionary");
  items[0].click();
  items.find((i) => i.label?.startsWith("Add")).click();
  assert.deepEqual(done, [["replace", "the"], ["add", "teh"]]);
  assert.ok(items.some((i) => i.role === "paste"));
});

test("a word with no suggestions says so, and a correct word gets only the editing items", () => {
  const none = template({ misspelledWord: "zzxq", dictionarySuggestions: [] }, {});
  assert.equal(none[0].label, "No spelling suggestions");
  assert.equal(none[0].enabled, false);
  const plain = template({ misspelledWord: "", editFlags: { canCopy: false } }, {});
  assert.equal(plain.some((i) => i.label), false);
  assert.equal(plain.find((i) => i.role === "copy").enabled, false);
  assert.deepEqual(plain.map((i) => i.role).filter(Boolean), ["undo", "redo", "cut", "copy", "paste", "selectAll"]);
});
