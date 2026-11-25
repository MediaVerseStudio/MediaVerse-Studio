# Lyrics: what is built and what comes next

**Page names (2026-11-18, D138):** Review > Missing lyrics now has Step 1 (Automatic lyrics) and Step 2 (Lyric AI) above two tabs, **General review** (every song that still needs lyrics, with
suggestions, AI picks and drafts) and **Suspected instrumental**. The names "Missing", "To review", "Instrumental" and "Track numbers in titles" in the text below describe the same lists
under their earlier names; the track-number tab was removed because the lookups already try the title without the number.

Owner, 2026-11-05: "digging and scraping for song lyrics … we won't need to match specific albums exactly to get the
songwriter's lyrics. There may be multiple albums where the same song has been sung by the same artist, or the song
might be a cover of another song and the lyrics can be found with that original source."

## Built (D66)

`apps/sidecar/src/lyrics_lookup.rs`, LRCLIB only (decision D29), on request for one song:

1. `GET /api/get` with title, artist, album and length: the exact recording (time-stamped lyrics fit it).
2. `GET /api/search` by title and artist, **any length**: the artist's other versions (live, edits, other albums).
   A version within 5 s keeps its time-stamped lyrics. Within 20 s the time stamps are kept and marked
   `needs_alignment` (and `other_version`) so they can be nudged; farther than that, only the plain words
   are offered.
3. The same with the title cleaned of version words (`core_title`: "(Live)", "[Remastered 2011]", "- Radio Edit",
   "feat. …").
4. `GET /api/search` by the cleaned title alone, keeping only answers whose cleaned title is the same: the same song
   by another artist, the original of a cover or a cover of it (`other_artist`, plain words only).

The page labels 2 and 4 ("another version", "the same song by another artist") and nothing is saved until the person
uses the lyrics and saves them. A few spelling variants (straight apostrophe, a leading "The") are tried only when
the first search is empty. Successful non-empty LRCLIB replies are cached for 30 days (`<data>/lrclib-cache`). The
LRCLIB database dump is not downloaded (about 125–250 GB).

**Other artists of the same work (built, one song at a time):** when a lookup from the song dialog finds nothing and
asks with `follow_works`, MusicBrainz is asked for the recording's work and the other artists who recorded it, then
LRCLIB is tried under those names. Automatic lyrics does not do this (it would spend the MusicBrainz allowance on
every missing song).

**Automatic lyrics (built, D67):** Review › Missing lyrics › Automatic lyrics goes through the MP3s without lyrics in
the background and keeps only sure answers: LRCLIB's exact match, or the artist's own version of the same length
(never one whose length could not be compared, never other versions or other artists). Into the tag; each song
asked about once (30 days); a pause of a second between songs; three failures in a row pause it; journalled
(`lyrics_added` in the picture-batch journal) and undone with "Undo the automatic lyrics". It never replaces lyrics
a song already has. Test: `npx electron scripts/capture-auto-lyrics.cjs <out>` (throwaway library, stand-in LRCLIB).

**Lyrics to review (built, D68):** answers that are likely but not sure are kept as their own files for the person
(Review › Lyrics › To review), each with a confidence score, and saved into the song only after they confirm it in the
timing editor (play, nudge lines, Tap to time plain words). Test: `npx electron scripts/capture-lyrics-review.cjs <out>`.

## Next steps (not built)

- Owner, 2026-11-06: adjust untimed lyrics during ordinary playback (Now Playing) to make them time-stamped, and later
  sync lyrics to the song automatically. **Built (D127 to D142):** the Lyric AI times lyrics by listening (`docs/lyric-ai-plan.md`), drafts lyrics for songs nobody has (Whisper), and the
  review editor times by hand (Tap) and corrects words. Adjusting during ordinary playback (Now Playing) is still not built.

- Optionally write `.lrc` beside the song instead of into the tag (a setting).
- **Instrumentals** (built, D67/D131/D138): LRCLIB marks them and the Lyric AI lists songs it heard no singing in under Suspected instrumental; a person confirms with "Confirm instrumental",
  which writes the language "zxx" (no linguistic content) into the song and leaves the genre alone; "Not instrumental" puts the old language back.

## Sources considered and why not (yet)

- **LRCLIB**: community-made, open API, no key, asks only for a User-Agent and a pause. In use.
- **Genius**: the official API gives song pages but not the lyrics; getting them means scraping the web pages,
  which its terms forbid. Not used.
- **Musixmatch**: lyrics only under a paid commercial licence. Not used.
- **AZLyrics, Lyrics.com and similar sites**: no API; their terms forbid automated copying. Not used.
- Lyrics are copyrighted words. A free, non-commercial program fetching them for one person's own library from a
  service that offers them for that use (LRCLIB) is fine; copying them from sites that forbid it is not, however the
  program is built. Ask the owner before adding any other source (AGENTS.md: online services need his approval).

## Syncing lyrics automatically (owner question 2026-11-17; planned, not built)

Home: inside the program (library, tag writing, journal and undo, the To review list already exist). Engine: this PC (RTX 4090,
Ryzen 9 7900, 63 GB). A separate Claude project cannot listen to audio (it can only run tools), so it is only useful as a
throwaway prototype that scores methods; the product feature belongs in the sidecar or a helper.
1. **Check/fine-tune existing timing (first, cheapest):** compare each timed line's start with when singing begins in the audio
   (vocal activity, later vocals only after separation); correct a whole-song offset or a linear stretch when confident.
2. **Time plain lyrics (forced alignment):** vocal separation, then a speech aligner with word timestamps, lines made from words.
3. **Draft lyrics for songs nobody has (transcription):** to Review only, never saved automatically.
**Ground truth:** the library's ~7,146 timed songs score any method (per-line error in ms) before it touches anything.
**Needs the owner's OK first (AGENTS.md):** each model and its licence (Whisper and Demucs are MIT; non-commercial-licence aligners are out),
the 1-3 GB download, and whether results go straight into tags or are staged for review.
