# ADR 0009: Tag repair by identifying albums (Review > Fix tags)

Status: design agreed by the owner (2026-11-03); the read-only scan and the review page are built (testing
mode: Apply is switched off, nothing is written); writing, fingerprints and Discogs are still to come.

## Built so far (2026-11-03, overnight)

- `crates/tag-repair` (pure logic, tested on the owner's eMOTIVe folder with MusicBrainz's real reply):
  placeholder values, file and folder names, MusicBrainz releases with lengths, editions and genres, and the
  matcher (lengths 50%, titles 30%, names 20%; proposals for empty or placeholder fields only; real values that
  disagree with the release are noted, not changed; a two-disc set in one folder matches both discs in order).
- Sidecar `scan_tag_repair` / `tag_repair_status` / `list_tag_repair`: walks the album folders, reads tags and
  exact lengths (lofty, read only), looks each folder up by its disc layout and else by name, keeps results in
  `tag-repair.sqlite` (resumable; unchanged folders skipped; candidates under 50% dropped, since a fuzzy TOC
  search always answers something; `retry` re-checks folders not identified).
- Review > Fix tags: the mockup's page on the real results, 4 albums a page, covers, editions, and the table.

## Problem

Review > Missing or uncertain metadata groups tracks by *which tags are missing* and offers one batch editor
whose filled-in fields replace the value on every selected track. On the owner's 18,000-song library that means
"1,187 tracks missing a genre" in one group, with the same form able to give all of them one artist, album and
year. It suggests nothing useful and makes damage easy.

A typical case (owner's screenshot): `Music\A Perfect Circle\eMOTIVe\01 Annihilation.mp3` … `12 Fiddle And The
Drum.mp3`, ripped from a CD long ago, tagged only with `Track 1`…`Track 12`, Unknown artist, Unknown album,
Unknown genre, no album artist, no year. Everything needed is recoverable: the folders name the artist and album,
the file names give numbers and titles, and the track lengths identify the CD.

## Decision

Identify **albums** (album folders), not tags, and offer the result as a reviewed batch, best matches first.

### 1. Unit of work: the album folder

Group files by folder (a CD rip is one folder). A folder whose tags already agree and are complete is not listed.
A folder holding several albums (tags disagree consistently) is split by those tags.

### 2. Evidence, strongest first (each gives a score component)

1. **Disc layout (TOC from track lengths).** Order the files by track number (tag, else file name), take each
   file's exact length (lofty; LAME/Xing headers give the sample count), build a CD table of contents with the
   standard 2-second pregap, and ask MusicBrainz `GET /ws/2/discid/-?toc=…` (a fuzzy TOC search when the disc ID
   is unknown). Matches give releases and the exact medium. Uses the existing `crates/disc-metadata`
   (TOC, parser, rate limiter, identification header).
2. **Audio fingerprints (AcoustID).** rusty-chromaprint (approved, D35) with the decoders already in the build
   (nanomp3, claxon) → AcoustID lookup (the owner's key, D11) → recording IDs and the releases they appear on.
   Confirms a disc-layout match track by track, and identifies incomplete or jumbled folders on its own. The
   first fingerprints must be checked against AcoustID's own (`fpcalc`) before trusting them (D35).
3. **Names.** Folder and file names parsed with patterns (`Artist\Album\NN Title`, `NN - Artist - Title`, …,
   as TagScanner and Mp3tag do), and any existing tags. Used for MusicBrainz text search when 1 and 2 find
   nothing, and as a cross-check (name similarity).
4. **Discogs (optional, needs the owner's personal access token).** For releases MusicBrainz lacks, for
   edition details (country, label, catalogue number, barcode, format), and for genres and styles, where
   MusicBrainz is thin. See "Discogs" below.

### 3. Confidence

Per candidate release: disc-layout fit (track count, per-track length differences), share of fingerprints that
land on that release, name similarity (artist, album, titles), and agreement between sources. Shown as a
percentage with the evidence written out ("Disc layout matches 12 of 12 tracks", "Fingerprints agree 12 of 12",
"3 editions fit"). Several editions that fit nearly equally (remasters, other countries, compilations) are listed
under **Other editions** with year, label, country and format, best first; the user may pick one.

### 4. The review page (mockup: Fix Tags mockup artifact)

Inspired by Windows Explorer's details view and by Mp3tag (dense grid, tag sources), MusicBrainz Picard (albums
matched to releases, colour by match quality, original beside new values, other versions), MediaMonkey (auto-tag
from web with a checkbox per track) and TagScanner (tags from file names, preview before writing):

- Paged: about 4 albums per page (owner, 2026-11-03: the mockup's amount is right; 25 would be far too many),
  highest confidence first, filters Ready (90%+), Choose an edition, Not identified.
- Each album: cover, proposed artist and album, folder, confidence and evidence; expands to a compact table, one
  row per file (Name, #, Title, Contributing artists, Album, Album artist, Genre, Year, match): a changed value
  shows the new value with the old one struck through beneath; unchanged values are plain.
- Checkboxes per album, per file and per field. **The first version only fills missing tags and placeholder
  values** (empty, "Unknown artist", "Unknown album", "Unknown genre", "Track N" and the like); a tag with a
  real value is never changed, and there is no option to do so yet (owner, 2026-11-03). Correcting wrong but
  real values may come later as a separate, deliberate step.
- A sticky bar: Select all on this page, the count, Apply suggested fixes. Albums under 70% are never selected by
  Select all. The aim is that the user usually selects all and applies.
- Identification runs in the background over the whole library (cancellable, resumable, rate-limited per
  source), so the list fills and re-sorts while the user works.

### 5. Writing

All formats lofty writes (MP3 ID3v2.3/2.4, FLAC, M4A, OGG…), each file replaced atomically as now (D22). Before a
batch, the old tags of every file are saved to an undo journal (SQLite in the app's data folder); Undo restores
them. MusicBrainz IDs are written too (as Picard does), so a later run recognises fixed albums at once. Cover art
and lyrics are not part of this step (see "Later").

## Discogs (findings, 2026-11-03)

- **Access:** a personal access token (discogs.com > Settings > Developers > Generate new token) is enough for one
  user's own app; database search needs authentication. Rate limits are per IP: reported 25 requests a minute
  unauthenticated, 60 authenticated (Discogs documentation). A descriptive User-Agent is required.
- **Useful endpoints:** database search (artist, release title, track, barcode, catalogue number, format,
  country, year); release (tracklist with positions and durations, genres, styles, year, country, labels,
  identifiers); master release versions (every edition of an album, which is what Other editions needs).
- **Terms** (API Terms of Use, last updated 27 May 2025, read in full from the owner's saved copy on
  2026-11-03):
  - CC0 Data (CC0 "No Rights Reserved"): release titles, notes, dates, format, track listings, barcodes and
    other identifiers, credits, versions, links; artist names; label, producer, manufacturer and distributor
    names. Restricted Data: Discogs user data, Marketplace data and **all images** (release, artist, label, user);
    not to be transferred to third parties or used commercially.
  - Genres and styles are in neither list (they are in Discogs' CC0 monthly data dumps). Treated as CC0 but used
    only to fill a genre MusicBrainz does not give; the owner may ask Discogs' Help Center to be certain.
  - Content may not be displayed if more than six hours older than discogs.com, nor cached or stored longer than
    necessary to provide a service to the application's users.
  - "Data provided by Discogs." directly next to any Discogs data, hyperlinked to the discogs.com page holding
    it, without `nofollow`.
  - Required notice, prominent in the application and any public-facing use (may be in its documentation):
    "This application uses Discogs’ API but is not affiliated with, sponsored or endorsed by Discogs. ‘Discogs’
    is a trademark of Zink Media, LLC."
  - No extra keys to get around rate limits; users must be 18 or over (US); Discogs may charge for the API or end
    access at any time.
- **Consequences for MediaVerse Studio:** each user adds their own personal access token (so each user accepts
  the terms); Discogs is used only for CC0 text fields written into the user's own files at the user's request
  (that writing is the service; no separate copy of Discogs replies is kept beyond six hours); "Data provided by
  Discogs" with a link beside every Discogs suggestion; the required notice beside the token in Settings and on
  the website; no Discogs images. Covers come from the Cover Art Archive, or from an iTunes or Deezer
  artwork address their own search reply already gave (D133).

## Later (owner: "let's not forget")

Album art, band photos and lyrics, using the identification above: the exact release tells which cover to fetch
(Cover Art Archive), which artist (photos), and which song (LRCLIB lyrics, D29).
