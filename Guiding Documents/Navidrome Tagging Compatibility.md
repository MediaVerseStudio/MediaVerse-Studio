# Navidrome Tagging Compatibility

MediaVerse Studio follows Navidrome's library tagging guidance as the controlling standard for
library display, corrections, and tag writes. File paths may produce suggestions, but audio-file
tags remain authoritative after user review.

## Required and recommended fields

- Every track should have **Title**, **Artist**, **Album**, **Album Artist**, and **Track Number**.
- **Year/Date**, **Genre**, and **Disc Number** are recommended.
- Avoid blank or generic values such as "Unknown Artist".
- Use consistent spelling and punctuation for an artist and album across their tracks.

## Compilations and collaborators

- **Artist** is the performing artist or artists for an individual track.
- **Album Artist** is the shared primary artist for the album.
- Compilation and soundtrack albums use `Album Artist = Various Artists`; individual performers
  remain in each track's `Artist` field.
- When supported by the file format, preserve multiple artists as multi-valued artist tags.
  For older ID3v2.3 MP3 files, use a consistent display separator rather than silently losing
  contributors.

> **Owner decision (2026-11-02):** the MP3 copies made by the ripper keep the limited tag set: a single Artist string
> (no multi-valued artist tags) and a release year only. The multi-artist and precise-date advice below applies to
> the library editor and to files from other sources, not to ripped MP3s.

## Release information and artwork

- Treat a plain year as a release year. Preserve a more precise release date where available.
- Album sorting may use alphabetical album title or release year, scoped by Album Artist.
- Use a compilation flag for compilation albums where the tag format supports it. This program
  writes `COMPILATION=1` in FLAC and `TCMP=1` in MP3 (an iTunes extension that is widely read), and
  only for Various Artists albums (D16, D30).
- Prefer a consistent embedded cover image across an album; folder artwork can be a secondary
  source.

## Editing workflow

- Show suggestions before writing. Never overwrite tags without an explicit user confirmation.
- Scope album choices to the selected Album Artist. Genre and artist choices may reuse values
  already cataloged in the library.
- Preserve the original file until a tag write succeeds; report any failure explicitly.

## Source

Derived from the Navidrome Tagging Guidelines:
https://www.navidrome.org/docs/usage/library/tagging/
