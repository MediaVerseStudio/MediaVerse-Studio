# Jellyfin and MediaVerse Studio: how they overlap, and what to build (D97, 2026-11-15)

Owner's brief: Jellyfin already does much of what MediaVerse Studio set out to do (genres, similar items, image fetchers,
metadata, lyrics, casting, SyncPlay). Use Jellyfin's strengths when it is there, keep MediaVerse Studio a complete
stand-alone program on every device, and let the two share one library.

## 1. The short answer

- Jellyfin is a **server with its own database**. It reads your files and keeps what it learns (artist photos, biographies,
  styles, MusicBrainz and TheAudioDB IDs) in its **own metadata folder**, not in your music folders and not in the songs.
  That is why you saw artist photos in Jellyfin and nowhere else. (Verified on the test server: its
  `metadata\artists\<name>\` folders hold `artist.nfo`, `folder.jpg`, `backdrop.jpg` and `logo.png`; 366 of 620 artists had a
  `folder.jpg`; the library option "save local metadata" is off.)
- MediaVerse Studio is a **file curator and player**: it writes tags, covers and lyrics into the files, rips and verifies
  CDs, finds audio defects. Jellyfin does none of that by default. The two are complementary: files that MediaVerse fixed are
  better files for Jellyfin to read, and what Jellyfin finds online can be written back into the files by MediaVerse so the
  knowledge travels with the music to the phone, the TV and any other player.
- So the plan is **"stand-alone first, Jellyfin-enhanced"**: every feature works from the files alone; where a Jellyfin
  server is signed in, it is one more source for the same feature, never a requirement.

## 2. How Jellyfin does each thing

| Capability | How Jellyfin does it | Where the result lives |
|---|---|---|
| Artist and album identity | Reads embedded tags and folder layout (one album per folder; artist folders hold album folders). Artists are grouped by the **exact tag text**; custom delimiters split multi-artist tags (the test server's library options list `/ | ; \`). | Its database |
| Metadata providers | Plugins (MusicBrainz, TheAudioDB, and others); each library has, per item type (album, artist, song), an ordered list of metadata fetchers and image fetchers (`MetadataFetchers`, `ImageFetchers` in the library's `options.xml`). Internet providers can be switched off per library. | Its metadata folder |
| Artist photos | Image fetchers for the artist type (TheAudioDB's artist thumbnail, backdrop and logo). A `folder.jpg` in the artist's folder wins if present. | `metadata\artists\<name>\folder.jpg`; only copied into media folders if "save artwork into media folders" is on |
| Album and song covers | Local files first (`cover`, `folder`, `poster`, `default`, `jacket`), else the embedded cover of the first track that has one ("Embedded Image Extractor"). | Read from the files |
| Biographies, styles, IDs | `artist.nfo` and `album.nfo`: biography, formed/disbanded, styles, `musicbrainzartistid`, `audiodbartistid`. The NFO saver is optional; NFO artwork paths take priority over remote providers. | NFO in the metadata folder, or beside the music if saving locally |
| Lyrics | A `.lrc`, `.elrc` or `.txt` with the song's file name beside it. Lyric fetchers are plugins (the official one is LrcLib); a scheduled task downloads them; "Save lyrics into media folders" is a library option. Synced lyrics let a click jump to the line. | Beside the song if the option is on, otherwise its data folder |
| Similar items / instant mix | Computed on the server from its own data. Jellyfin 12 lists `SimilarItemProviders` per type in the library options, so providers can be added or ordered; the ListenBrainz plugin sends your listens to ListenBrainz (needs the track's MusicBrainz ID) and ListenBrainz can recommend from them. | Server |
| Casting and remote control | Every client is a *session*; any signed-in client can send play, pause and seek commands to another session. | Server's session list |
| SyncPlay | REST calls (`/SyncPlay/New`, `/List`, `/Unpause`, …) for groups and control, plus WebSocket messages that carry timed commands to every member. Needs WebSocket pass-through behind a reverse proxy. | Server |

Not verified here (no sign-in to the server): the plugin list on the home server, the exact choice of fetchers on the library you
are using, and how Jellyfin treats embedded SYLT lyrics (its docs only describe lyric files).

## 3. Where the two overlap, and who should own it

| Job | Owner | Why |
|---|---|---|
| Writing tags, covers, lyrics **into files** | MediaVerse | Jellyfin does not edit files; our journalled, checked rewrite with Undo is the point of the program. |
| CD ripping, AccurateRip, audio defects | MediaVerse | No equivalent in Jellyfin. |
| Online lookups at the moment of ripping or tag fixing (MusicBrainz, Discogs, GnuDB, LRCLIB, AcoustID) | MediaVerse | Must work with no server. |
| Artist photos, biographies, styles | **Either**: Jellyfin where signed in, MediaVerse's own source otherwise; MediaVerse writes the result into the files | A server-only photo is invisible to the other devices and players. |
| Library shared across devices | Jellyfin | The TV and phone already play from it (D96). |
| Flags and playlists across devices | Jellyfin playlists (D96) | Done for flags. |
| Favourites, play counts across devices | Jellyfin user data (not built) | Today each device keeps its own. |
| Scrobbling to ListenBrainz | Jellyfin's plugin | One plugin on the server covers every client; no reason to build it into three apps. |
| Similar items / "more like this" | Jellyfin where available; a simple local one (genre, decade, artist) otherwise | |
| Casting | Both, different jobs: MediaVerse's own Cast/DLNA code plays to TVs and speakers; Jellyfin sessions let one app drive another | |
| Listening together (SyncPlay) | Jellyfin, later | Needs WebSocket and clock sync; large. |

## 4. Built in this session (D97)

1. **Review > Artists > Artist names.** Finds artists spelt more than one way (punctuation, spacing, capitals, accents, "&" against
   "and", a leading "The" are ignored when comparing), suggests the commonest and plainest spelling, and on your command changes
   every song's Artist and Album artist tag to it. Only tags that are *exactly* one of the spellings change ("AFI & Friends" is
   never touched), every old value is journalled, and **Undo** puts them back (and leaves alone anything changed again since).
   Chosen over a one-off because the same mistake ("A.F.I." / "AFI", "Guns N' Roses" / "Guns N Roses") is common
   in tagged libraries and nothing else in the program can see it: Jellyfin and the wall both treat the two spellings as two artists.
2. **Review > Artists > Artist photos.** Signed in to Jellyfin (the Quick Connect sign-in already in Settings), it lists the
   server's album artists, matches them to the wall's artists (loosely, so "A.F.I." finds "AFI"), downloads each photo
   (at most 1000 pixels, re-requested smaller if it would not fit the 500 KB tag limit) and writes it into every song of that artist
   as the **Artist** picture (ID3 picture type 8; the same journal and Undo as the Artwork tools). Artists whose songs already
   carry a photo are skipped unless "Replace" is ticked.
3. **The photo on the artist wall.** The artist's tile now lays their photo on top of the album stack when their songs carry one
   (or an `artist.jpg` sits in their folder or their songs' folder); the album covers fan out behind it.
4. The desktop's Jellyfin sign-in and request code moved into `jellyfin-desktop.ts`, shared by the problem-track sync and the photo tool.

Checked in the real program on a throwaway library: the photo embeds, reads back, shows only on the AFI tile, the name tool
renames and undoes on real tags. **Not checked live:** the calls to the Jellyfin server (listing album artists, downloading an
image): they could not be tried without the owner approving a Quick Connect code. Both endpoints exist on Jellyfin 12.4 (they
answer 401 until signed in), and the rest is unit tested. First real try: Settings > Jellyfin > sign in, then Review > Artists >
Look on Jellyfin.

## 5. Recommended next steps, in order

1. **MusicBrainz IDs in the tags** (`MUSICBRAINZ_ARTISTID` and friends as ID3 `TXXX` frames). Jellyfin's `artist.nfo` already holds
   them, Fix tags already finds the release, and with an ID two spellings of one artist are provably one. This would also let
   Jellyfin, Navidrome and Picard agree with us. Small to medium.
2. **A stand-alone photo source**, so artist photos do not depend on a server. Options, each needs the owner's approval before
   any code (the third-party rule):
   - *Wikimedia Commons via MusicBrainz → Wikidata* (image property P18): free, no key, open licences (attribution needed);
     MusicBrainz asks for about 1 request a second and a User-Agent naming the program and a contact address; many bands have no image.
   - *TheAudioDB*: the source Jellyfin uses; a shared free key exists for low-volume use (about 30 requests a minute), a paid key
     for more; check its current terms before relying on it in a distributed program.
   - *Fanart.tv*: good artwork, needs a project key.
   Recommendation: Wikimedia first (clean licence, no key), TheAudioDB as an optional second, only if the terms allow.
3. **Artist information on the artist page** (biography, formed, styles): from Jellyfin where signed in (the same album-artist call
   returns an overview), otherwise nothing, since writing a biography into MP3s is not standard.
4. **Favourites and play counts through Jellyfin user data**, so a heart on the phone shows on the PC and TV. Needs the song match
   the problem-track sync already does (artist, title, album).
5. **"More like this"** from Jellyfin's similar-items call where signed in, with a simple local fallback.
6. **MediaVerse as a Jellyfin remote-control target**: register the phone and PC as Jellyfin sessions so Jellyfin's own apps can
   send play commands to them. Medium.
7. **SyncPlay** (listen together): last; large, and the main use of it is video.
8. **Lyrics sidecar option**: Jellyfin reads `.lrc` files beside songs (and the LrcLib plugin can fill gaps on the server). Our
   lyrics are embedded in the tag; an option to also write the `.lrc` file would make our timed lyrics visible to Jellyfin at once.

## 6. Questions for the owner

- Which stand-alone photo source (step 5.2), if any?
- Write MusicBrainz IDs into the tags (5.1)? It changes tags in every file, with the same preview and Undo as the other tools.
- Should the name tool also offer to fix names on Jellyfin's side? Not possible from outside (Jellyfin has no tag editor); after the
  rename, "Scan library" on the server picks the new spelling up, and the duplicate artist disappears.

## Sources

- Jellyfin docs, music: https://jellyfin.org/docs/general/server/media/music/
- Jellyfin docs, NFO: https://jellyfin.org/docs/general/server/metadata/nfo/
- Jellyfin forum threads on artist images, TheAudioDB, saving artwork and lyrics (user reports): https://forum.jellyfin.org/t-solved-theaudiodb-entry-not-found-as-a-result-music-artist-image-not-loaded , https://forum.jellyfin.org/t-lrclib
- LrcLib plugin: https://github.com/jellyfin/jellyfin-plugin-lrclib ; ListenBrainz plugin: https://github.com/lyarenei/jellyfin-plugin-listenbrainz
- SyncPlay API: https://eb48e63b.jellyfin-org.pages.dev/developers/docs/api/syncplay
- MusicBrainz rate limiting: https://musicbrainz.org/doc/MusicBrainz_API/Rate_Limiting
- TheAudioDB (terms to be checked at the source): https://www.theaudiodb.com/free_music_api
- Local evidence: the test server's `data\metadata\artists`, `data\root\default\Music\options.xml` and `data\plugins\configurations`.
