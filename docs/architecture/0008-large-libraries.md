# ADR 0008: Libraries of tens of thousands of songs

Status: accepted 2026-11-02 (feedback round 2, D32 Phase B). Steps 1 and 2 built (D33); measured again at 100,000 songs on 2026-11-03 (below); step 3 and later planned.

## Context

The owner's feedback: libraries of 20,000 songs are common, many fans have 50,000 or more, and Review must cope
with 100,000. Measured with a synthetic library (`tools/make-test-library.ps1`: 20,000 tagged MP3s, 671 MB)
and `web/app/scripts/measure-large-library.cjs`, release build, development PC:

| What | 20,000 songs | Note |
|---|---|---|
| Import (tags read, database written) | 1.3 s | files in the disk cache; a cold disk is slower |
| Unchanged rescan | 1.3 s | |
| One library reply (`library_snapshot`) | 5.7 MB of JSON | about 30 MB at 100,000; sent on start and after every change |
| Start-up until the library is listed | 0.2 to 0.5 s | |
| Review > metadata before step 1 | 2.0 s, 241,000 page elements | every page switch then cost about 220 ms |
| Review > metadata after step 1 | 17 ms, 737 elements | page switches about 10 ms |
| Defect scan | about 3 songs a second, one thread | 50,000 songs about 4.5 hours |
| Defect results store before step 2 | the whole JSON file rewritten for every song | grows with the square of the library |

## Decisions

1. **Draw only what is on screen** (built). Long lists start closed or show a page at a time (50 tracks per
   opened group, 100 groups); a list that changes while it is off screen is drawn when it comes into view.
2. **Defect results in SQLite, scanned in the background** (built in this step):
   - `defect-results.sqlite` in the data folder (one row per file: path, size, modification time, when
     scanned, verdict, findings, reviewed-as-good). The old `defect-results.json` is imported once and
     renamed. SQLite comes from the bundled `rusqlite` already used by the library database.
   - `scan_library_defects` scans every library file that has no current result (new or changed since its
     scan), on several threads (cores minus one, at most four, so the computer stays usable), saving each
     result as soon as it is made. Stopping keeps everything finished; starting again continues with what
     is left, also after a restart. `library_scan_status` lets a page that was closed and reopened show a
     running scan.
   - Review > Audio defects reads one page of results at a time (`list_defect_problems`, worst first) with
     the counts, instead of the whole store.
3. **Planned: library queries in the sidecar.** The page still receives the whole library (decision 2 of
   ADR 0001 keeps it simple). Before 100,000 songs this becomes paged queries (artists, albums of an
   artist, tracks of an album, tag issues by group) answered from SQLite, and change events that name what
   changed instead of resending everything. Do this when measurements at 50,000 to 100,000 show the
   whole-library reply is the bottleneck.
4. **Planned: grouping by suspected album.** Tracks whose tags disagree but whose folder, track numbers and
   lengths say they belong together are grouped as one suspected album, so one batch edit fixes it.
   Fingerprinting (Phase C) then suggests the album itself.

## Consequences

- A scan of a large library is something you start and leave; its progress shows on the Review page
  rather than in a dialog, and it survives closing the program.
- The JSON store's 50,000-result cap is gone; the database keeps every result and removes rows for files
  that left the library when a library scan runs.
- Measurements above must be repeated at 50,000 and 100,000 songs before step 3 is designed in detail.

## Measured at 100,000 songs (2026-11-03)

Synthetic library of 100,000 one-second MP3s (523 MB, `-Quality 9`), release build, after steps 1 and 2:

| What | 100,000 songs |
|---|---|
| Import | 7.4 s |
| `library_snapshot` | 1.1 s, 34.6 MB of JSON |
| Unchanged rescan | 7.8 s, 34.7 MB |
| Start-up until the library is listed | 1.1 s |
| Opening Library, Review sections, Home | 25 to 59 ms |
| Page memory | 141 MB |

Conclusion: with step 1 the page copes with 100,000 songs, so step 3 (paged library queries) is not needed for the page yet. What does cost at this size is a **change to the music folder**: the watcher resyncs the whole library (about 8 s) and resends all of it, and while the sidecar works on that it answers nothing else (starting a song waits too, because the media scheme asks the sidecar where the library is). Next for large libraries: make the folder watcher resync only what changed and send only the changed tracks, and let the media scheme remember the library folder instead of asking each time. The Library page draws one card per artist (2,000 elements for 500 artists); a library with thousands of artists needs the same paging as Review.


## Step 3a: folder changes (built 2026-11-03)

- The folder watcher uses Windows' own change notifications (`notify`'s recommended watcher); checking every file every two seconds is only the fallback, every 30 seconds, for folders that send no notifications. Idle processor use with 100,000 songs: 2.2 s per 20 s before, 0 after.
- A resync re-reads tags only of files whose size or modification time changed, and the watcher sends nothing when no audio file changed (a new cover or `.lrc` file no longer resends the library). One changed song in 100,000: the page is updated after 4.5 s (was about 8 s); the remaining time is the full database rewrite and the whole-library reply, the next refinement.
- Track IDs now stay with their file across rescans (they were all new after every rescan, so ticked tracks in Review were lost whenever the folder changed).
- The library database is now updated by difference (only new, changed and removed rows are written). Measured at 100,000 songs with the cache warm: a rescan takes 3.3 s, of which about 1 s is building and sending the 35 MB reply and the rest listing the folder and checking each file's date; the page shows one changed song after 4.2 s.
- Still to do: react to the exact files the watcher reports instead of listing the whole folder, and send only the changed tracks to the page instead of the whole library.

## Step 3b: file records kept across restarts (built 2026-11-10, D91)

- Each file's size, modification time, length, bitrate, disc number and creation time are kept in `library.sqlite` (table `file_records`, written by difference like the tracks). At start they are joined with the stored tracks, so the sync that runs after every start only compares each file's size and date and reads the tags of files that changed while the program was closed. Before, every start read every file's tags again and then sent the whole library a second time.
- Measured on the owner's library (13,476 songs, disk cache warm): 2.7 s of tag reading and a second 5.5 MB library reply after every start before; none now, and the first `library_snapshot` already carries the lengths (the song list's columns were empty until the second reply).
- `FILE_READ_VERSION` in `crates/host` must be raised whenever the tag reading changes what it finds in an unchanged file; older records are then ignored and every file is read once more. A library with a record missing for any track is read in full, as on a first run.
- A folder change reported while a sync is running is no longer dropped: the running sync is followed by one more (a file changed after the sync had passed it, the end of a long batch of tag writes for one, stayed stale until the next change).