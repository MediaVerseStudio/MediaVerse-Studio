# ADR 0006: Disc metadata lookup from several sources

## Status

Accepted (2026-10-31). Implemented: disc identifiers, the CDDB and MusicBrainz parsers, editable
settings, rate limiting, merging, the sidecar `lookup_disc` job, HTTPS, cover art from the Cover Art
Archive, the Settings page, and album choice on the Rip a CD page. Not implemented: Gracenote (no keys
obtainable) and AcoustID fingerprinting.

## What each service requires today (checked 2026-10-31)

| Source | Findings |
|---|---|
| MusicBrainz | Every request needs a User-Agent `Application/version ( contact )`; about 1 request per second per IP, extra requests get HTTP 503 ([rate limiting](https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting)). The disc lookup was tested live and found both test discs, which also proves our disc-id algorithm. Their web service is used over HTTPS. |
| gnudb (CDDB) | Their developer pages (saved by the owner and read 2026-10-31) say: use HTTP or HTTPS at `gnudb.gnudb.org` (port 80 or 443, path `/~cddb/cddb.cgi`); CDDBP on port 8880 is kept only for old programs and is converted to HTTP internally; protocol level 6 (UTF-8) is preferred. **Every request must carry a valid-looking email address**, written into the hello string as `hello=emailname+emailhost.com+applicationname+version`, plus a clear, descriptive application name (generic names such as `MyApp` get blocked). New or unregistered programs are accepted if the hello contains a real email address; developers are asked to email info@gnudb.org with the program name, a short description and a contact address. Reply code 429 means too many requests. A `cddb read` must use the id returned by `cddb query`, not the classic freedb id. Our first live query was answered `500 Unknown application, developer email for ...` because it carried no email address: this was our mistake, not a registration wall. See `docs/gnudb-registration.md`. |
| Gracenote | `developer.gracenote.com` refused our connection, and third-party maintainers report that new Web API keys have not been obtainable since about 2021. We could not read its documentation, and do not invent an API. The provider slot and credential fields exist; lookups report "not available". |

"CDDB1" is taken to mean the classic CDDB protocol family (freedb/gnudb, levels 1-6) and "CDDB2" the
Gracenote service that grew out of it. Please correct this if a different meaning was intended.

## AcoustID (added 2026-10-31)

AcoustID identifies a recording from its audio fingerprint, which helps with discs the databases above
do not know. Facts from [acoustid.org/webservice](https://acoustid.org/webservice): the lookup is
`https://api.acoustid.org/v2/lookup` with the application key as `client`, the track length and a
Chromaprint fingerprint; the application key identifies the program, a separate per-user key is only
for submitting fingerprints; at most **3 requests per second**; free for **non-commercial use only**.

* The application is registered at https://acoustid.org/application/38031. The registration must be
  updated when the version number changes (`docs/release-checklist.md`; a test enforces the reminder).
* **The key is not in the source code or the documentation.** It was entered through the settings and
  is kept in the user's data folder (`%APPDATA%\MediaVerse Studio\metadata-settings.json`). The
  Settings page shows it only as "Saved" with Change and Remove buttons. A repository search confirmed
  it appears in no tracked file.
* Built 2026-11-16 (D113): after a rip, each track is fingerprinted from its WAV (rusty-chromaprint, D35) and
  looked up; the results are compared with the chosen titles and shown on the Rip page as a report
  (`crates/disc-metadata/src/acoustid.rs`, `apps/sidecar/src/fingerprint.rs`, `audio_check.rs`). The lookup is
  a POST so the key is in the body, not the address. Settings and validation (including the 334 ms minimum
  interval for `api.acoustid.org`) are as before.

## Disc identifiers

* MusicBrainz id: SHA-1 of the track layout, base64 with `+ / =` replaced by `. _ -`
  (`discid.rs`, SHA-1 written in-tree and checked against the standard test vectors).
* CDDB id: the classic checksum plus length plus track count. Both test discs agree with the
  AccurateRip crate's independent calculation.

## Settings (all user-editable)

`metadata-settings.json` in the data directory, shown through `get_metadata_settings` and changed
with `set_metadata_settings {settings}` (a partial update, validated as a whole, saved only if
valid):

* **Identity**: a contact (email or web address, required while MusicBrainz is on), a user name
  and host name for CDDB servers.
* **MusicBrainz**: enabled, base URL, minimum interval (at least 1000 ms for musicbrainz.org),
  timeout.
* **CDDB servers**: a list. Each has name, enabled, transport (HTTP or CDDBP), host, port, path,
  protocol level 1-6, client name and version (for servers that register applications), minimum
  interval, timeout. Defaults: gnudb over HTTP (enabled) and gnudb over CDDBP port 8880 (disabled).
  Servers can be changed or added if a service moves or shuts down.
* **Gracenote**: enabled, base URL, client id, user id.
* **Cover art**: enabled, base URL (Cover Art Archive).

Credentials: `Secret` values never appear in debug output or in the settings shown to the
interface (`{"set": true|false}`); sending that placeholder back, or omitting the field, keeps the
stored value; `null` or an empty string clears it. **Open**: the settings file stores credentials
as plain text in the user's data directory. Before any real credential is stored, protect them at
rest (for example with Windows DPAPI) or keep them in the Windows credential store. (Owner decision
D12: database API keys may stay in plain text; the program stores no personal passwords or logins.)

## Invalid versus incomplete settings

Settings with malformed values (a port of 0, an address without `http://`, a duplicate server name)
are refused as a whole, with every problem listed. Settings that are merely incomplete (MusicBrainz
switched on with no contact details, AcoustID on with no key) are saved, shown as "Finish setting up"
on the Settings page, and make that source report `needs_setup` during a lookup instead of being
queried. Before this change the defaults themselves could not be saved without first filling in
unrelated fields.

## Settings page

`web/app/src/settings-page.ts` (logic in `settings-form.ts`, 11 unit tests): identity, MusicBrainz,
a list of CDDB servers (add, remove, change address, port, transport, application name), AcoustID,
Gracenote, cover art, and the Media Library Archive folder. Credentials are shown as Saved or Not set
and sent only when changed. Verified in the real app with `npm run capture:settings`-style runs
(`web/app/scripts/capture-settings.cjs`, throwaway data folder, made-up key).

## Politeness

Each source has its own limiter (`rate.rs`): a minimum gap between requests, exponential back-off
after HTTP 429 or 503 (doubling, capped at one minute), and the server's `Retry-After` honoured
(also capped). A refused source is reported as `rate_limited`; it is not retried within the same
lookup. At most five records are fetched from one CDDB server per lookup.

## Lookup and merging

`lookup_disc {device}` is a job (ADR 0003): read the table of contents, ask each enabled source in
turn (MusicBrainz first), merge. A failing source never hides the others; each failure is returned
with the source name, a code and a plain-language message (`tls_unavailable`, `cddb_500`,
`rate_limited`, `connection_failed`, `not_available`, ...). Answers describing the same album
(artist, title, track count) are grouped; the group keeps every source that agreed, prefers
MusicBrainz's wording, and fills gaps (year, genre, cover art) from the others. `automatic_choice`
is set only when it is safe: one exact answer, or one answer backed by two or more sources with
nothing else comparable. Inexact matches always need confirmation. The test disc "Energy" shows why:
MusicBrainz knows it as the 2007 release "Operation Ivy".

## HTTPS (approved and built 2026-10-31)

The sidecar now makes secure connections through the operating system's own TLS (SChannel on
Windows) via `ureq`'s `native-tls` feature, which adds only `native-tls` and `schannel` (and their
Windows binding crates), all MIT or Apache-2.0; no cryptography library is bundled. A live lookup of
the test disc against musicbrainz.org over HTTPS succeeded (exact match, 27 tracks, cover-art release
id). gnudb now defaults to HTTPS on port 443, so the contact email is not sent in the clear. A failed
secure connection is reported as `tls_failed`. Android will need its own answer later.

## What is sent where (privacy)

The contact email address entered in Settings is sent to MusicBrainz (inside the User-Agent header)
and to gnudb (inside the hello string, split at the `@`), because both operators require it. Nothing
else personal is sent: no name, no library contents. It is never pre-filled, and the settings page
suggests using a separate address. Default lookups send only the disc's table of contents.

## Open

* Send the gnudb registration email (`docs/gnudb-registration.md`) and test a live query with the owner's chosen contact address. The CDDB code has not yet met a live gnudb.
* MusicBrainz genres (need an extra request parameter).
* CDDBP and HTTP code paths are tested against local fake servers only.
* Credentials at rest: API keys stay in plain text in the settings file (owner decision, D12).
