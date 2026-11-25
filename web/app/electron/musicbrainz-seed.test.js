const assert = require("node:assert/strict");
const { test } = require("node:test");
const { seedFields, seedPage } = require("./musicbrainz-seed");

const release = {
  album: "Timeless & Dimeless",
  artist: "WitchDoktors",
  date: "2019-03-04",
  country: "gb",
  label: "Tribal Vibes Recordings",
  catalog_number: "TVCD102",
  barcode: "5024545875225",
  tracks: [{ title: "Voodoo Eye", length_ms: 227_000 }, { title: "Guest song", length_ms: 180_500.4, artist: "Someone Else" }],
};

test("the release editor's form fields are built from the confirmed details", () => {
  const fields = Object.fromEntries(seedFields(release));
  assert.equal(fields.name, "Timeless & Dimeless");
  assert.equal(fields["artist_credit.names.0.name"], "WitchDoktors");
  assert.equal(fields["events.0.date.year"], "2019");
  assert.equal(fields["events.0.date.month"], "3");
  assert.equal(fields["events.0.date.day"], "4");
  assert.equal(fields["events.0.country"], "GB");
  assert.equal(fields["labels.0.catalog_number"], "TVCD102");
  assert.equal(fields.barcode, "5024545875225");
  assert.equal(fields["mediums.0.format"], "CD");
  assert.equal(fields["mediums.0.track.1.length"], "180500");
  assert.equal(fields["mediums.0.track.1.artist_credit.names.0.name"], "Someone Else");
  assert.equal(fields["mediums.0.track.0.artist_credit.names.0.name"], undefined, "the album artist is not repeated");
  assert.match(fields.edit_note, /MediaVerse Studio/);
});

test("a year alone, a bad barcode and a bad country are handled", () => {
  const fields = Object.fromEntries(seedFields({ album: "A", artist: "B", year: 2008, country: "Britain", barcode: "12ab", tracks: [{ title: "T" }] }));
  assert.equal(fields["events.0.date.year"], "2008");
  assert.equal(fields["events.0.date.month"], undefined);
  assert.equal(fields["events.0.country"], undefined);
  assert.equal(fields.barcode, undefined);
  assert.equal(fields["mediums.0.track.0.length"], undefined);
});

test("missing details are refused", () => {
  assert.throws(() => seedFields({ album: "", artist: "B", tracks: [{ title: "T" }] }), /title and the artist/);
  assert.throws(() => seedFields({ album: "A", artist: "B", tracks: [] }), /Every track/);
  assert.throws(() => seedFields({ album: "A", artist: "B", tracks: [{ title: " " }] }), /Every track/);
  assert.throws(() => seedFields(null), /title and the artist/);
});

test("the page posts only to musicbrainz.org and escapes everything", () => {
  const html = seedPage({ album: 'Evil "><script>alert(1)</script>', artist: "B", tracks: [{ title: "T" }] });
  assert.match(html, /action="https:\/\/musicbrainz\.org\/release\/add"/);
  assert.match(html, /form-action https:\/\/musicbrainz\.org/);
  assert.ok(!html.includes("<script>alert(1)"), "the title cannot inject markup");
  assert.match(html, /value="Evil &quot;&gt;&lt;script&gt;alert\(1\)&lt;\/script&gt;"/);
});
