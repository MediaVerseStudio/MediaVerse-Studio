import assert from "node:assert/strict";
import { test } from "node:test";
import { DEFAULT_DIALECT, DIALECTS, cleanDialect, convertText } from "./dialect.ts";

test("American English is the default and unknown choices fall back to it", () => {
  assert.equal(DEFAULT_DIALECT, "en-US");
  assert.equal(cleanDialect("en-NZ"), "en-NZ");
  assert.equal(cleanDialect("fr-FR"), "en-US");
  assert.equal(cleanDialect(null), "en-US");
  assert.equal(DIALECTS.length, 5);
});

test("British, New Zealand and Australian spellings use -our, -re and -ise", () => {
  for (const d of ["en-GB", "en-NZ", "en-AU"] as const) {
    assert.equal(convertText("Accent color and favorite colors", d), "Accent colour and favourite colours");
    assert.equal(convertText("Organize the library: leveling, centered, canceled", d), "Organise the library: levelling, centred, cancelled");
    assert.equal(convertText("The visualizer analyzes and normalizes", d), "The visualiser analyses and normalises");
    assert.equal(convertText("Licenses and a catalog", d), "Licences and a catalogue");
  }
});

test("Canadian English takes -our, -re and the doubled l, but keeps -ize", () => {
  assert.equal(convertText("Accent color, organize, leveling, center", "en-CA"), "Accent colour, organize, levelling, centre");
  assert.equal(convertText("Organise and customise", "en-CA"), "Organize and customize", "British -ise is brought to -ize for Canada");
  assert.equal(convertText("analyse", "en-CA"), "analyze");
});

test("American English turns the Commonwealth spellings round", () => {
  assert.equal(convertText("Organise the colour of your favourites; levelling and centre", "en-US"), "Organize the color of your favorites; leveling and center");
  assert.equal(convertText("Licence and catalogue", "en-US"), "License and catalog");
});

test("capitals are kept, and words that merely look similar are left alone", () => {
  assert.equal(convertText("COLOR Organize color", "en-GB"), "COLOUR Organise colour");
  assert.equal(convertText("Colorado, advertise, surprise, exercise, organ, colorize", "en-GB"), "Colorado, advertise, surprise, exercise, organ, colorize");
  assert.equal(convertText("Harbor & Pine", "en-GB"), "Harbor & Pine", "only the listed words change");
  assert.equal(convertText("", "en-GB"), "");
  assert.equal(convertText("Nothing to change here", "en-AU"), "Nothing to change here");
});

test("a text already in the chosen spelling is not changed", () => {
  const british = "Organise the colour";
  assert.equal(convertText(british, "en-GB"), british);
  assert.equal(convertText("Organize the color", "en-US"), "Organize the color");
});
