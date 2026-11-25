import { test } from "node:test";
import assert from "node:assert/strict";
import { chunk, describePlan, libraryArtists, planPhotos } from "./artist-photos.ts";
import type { ServerArtist } from "../phone/jellyfin-phone.ts";
import type { LibrarySong } from "./library-format.ts";

const song = (path: string, artist: string | null, album_artist: string | null = null): LibrarySong => ({
  album: "A", album_artist, artist, genre: null, release_year: null, title: path, source_uri: `C:\\M\\${path}.mp3`, track_number: null,
});
const server = (name: string, imageTag: string | null = "t"): ServerArtist => ({ id: `id-${name}`, name, imageTag, musicBrainzId: null });

test("the wall's artists: album artist first, one entry per spelling the wall merges, no Various Artists", () => {
  const artists = libraryArtists([song("1", "Beyoncé", "Beyoncé"), song("1b", "Beyoncé", "Beyoncé"), song("2", "beyonce"), song("3", "Pink", null), song("4", "X", "Various Artists"), song("5", null)]);
  assert.deepEqual(artists.map((a) => [a.name, a.paths.length]), [["Beyoncé", 3], ["Pink", 1]]);
});

test("a library artist finds the server's artist despite dots, case and spacing", () => {
  const plan = planPhotos(libraryArtists([song("1", "A.F.I."), song("2", "Blink-182"), song("3", "Nobody"), song("4", "Silent")]), [server("AFI"), server("Blink 182"), server("Silent", null)]);
  assert.deepEqual(plan.matches.map((m) => [m.artist.name, m.source.name]), [["A.F.I.", "AFI"], ["Blink-182", "Blink 182"]]);
  assert.deepEqual(plan.noPhoto.map((a) => a.name), ["Silent"]);
  assert.deepEqual(plan.notOnServer.map((a) => a.name), ["Nobody"]);
});

test("when the server lists a name twice, the exact spelling wins, then the one with a photo", () => {
  const exact = planPhotos(libraryArtists([song("1", "AFI")]), [server("A.F.I.", "x"), server("AFI", "y")]);
  assert.equal(exact.matches[0].source.imageTag, "y");
  const withPhoto = planPhotos(libraryArtists([song("1", "afi")]), [server("A.F.I.", null), server("AFI", "y")]);
  assert.equal(withPhoto.matches[0].source.name, "AFI", "no exact spelling here, so the one with a picture");
});

test("lists are chunked and plans described", () => {
  assert.deepEqual(chunk([1, 2, 3, 4, 5], 2), [[1, 2], [3, 4], [5]]);
  assert.deepEqual(chunk([], 3), []);
  const plan = planPhotos(libraryArtists([song("1", "AFI"), song("2", "Nobody")]), [server("AFI")]);
  assert.equal(describePlan(plan, 0), "Jellyfin has photos for 1 artist; 1 artist are not on the server.");
  assert.match(describePlan(plan, 3), /3 already have one/);
});
