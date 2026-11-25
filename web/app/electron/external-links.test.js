const assert = require("node:assert/strict");
const { test } = require("node:test");
const { isAllowedExternal } = require("./external-links");

test("only https links to the services the program uses are allowed", () => {
  assert.equal(isAllowedExternal("https://acoustid.org/webservice"), true);
  assert.equal(isAllowedExternal("https://www.gnudb.org/howto.php"), true);
  assert.equal(isAllowedExternal("https://musicbrainz.org/"), true);
  assert.equal(isAllowedExternal("http://acoustid.org/"), false);
  assert.equal(isAllowedExternal("https://acoustid.org.evil.example/"), false);
  assert.equal(isAllowedExternal("https://evil.example/acoustid.org"), false);
  assert.equal(isAllowedExternal("https://user:pass@acoustid.org/"), false);
  assert.equal(isAllowedExternal("file:///C:/Windows/System32/calc.exe"), false);
  assert.equal(isAllowedExternal("javascript:alert(1)"), false);
  assert.equal(isAllowedExternal("not a url"), false);
});

test("Google is allowed for the artwork image search only", () => {
  assert.equal(isAllowedExternal("https://www.google.com/search?tbm=isch&q=Dude%20Ranch"), true);
  assert.equal(isAllowedExternal("https://www.google.com/url?q=https://evil.example"), false);
  assert.equal(isAllowedExternal("https://google.com.evil.example/search"), false);
  assert.equal(isAllowedExternal("https://www.discogs.com/release/42-x"), true);
});
