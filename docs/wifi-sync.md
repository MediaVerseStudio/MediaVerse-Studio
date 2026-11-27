# Sync without a server, and the Jellyfin plugin (D214, D215)

Owner's direction, 2026-11-26: everything works with only the computer app; Jellyfin makes it better; no tricks with
Jellyfin (no storing our data in settings meant for something else). The computer is not always on.

## The design

Each device keeps its own full copy and brings itself into step with whichever **hub** it can reach:

| Hub | When it is there | State |
|---|---|---|
| MediaVerse Studio on a computer, over Wi-Fi | While the program is open with sharing on | Built for Android (D214) |
| Our Jellyfin plugin, on the server | Whenever the server runs | Test version (D215); the phone sends new music to it |

## Phone and computer (built)

Computer: Settings > TV & Phone Pairing > "Share my library with my TVs and phones", then **Pair a TV or phone**. Phone: Settings >
Your computer, type the address, then the 6-digit code.

| What | How |
|---|---|
| Music | Chosen artists, albums, playlists or everything, fetched into the phone's Music folder (the rules of D177/D178) |
| Favorites, flags, playlists | Both ways. A removal on either side wins; only what **both** sides held can be removed |
| New music | The phone lists what the computer lacks (by artist and title) and sends chosen albums to `MediaVerse Incoming` in the user's folder. Off until allowed on the computer; never writes over a file |

- Songs are named between them by a hash of their place in the library folder: no paths leave the computer.
- The phone keeps a separate record for the computer and for a Jellyfin server; a song either one keeps is not taken
  off by the other.
- A playlist removed from a phone is kept in `playlists-removed-by-phones.json` beside the share settings.
- A drive that is not connected is an error to the phone, never an empty library.
- Only a device paired as a phone may use `/api/sync/*`. A TV keeps its earlier rights (play, flag, favorite).

### Limits now

- One computer per phone. Pairing another (by name) starts a new record; songs stay on the phone.
- The phone keeps the address typed. If the computer's address changes, pair again.
- With a second profile on the phone, favorites and playlists go to the computer only for the first profile (the
  computer has no profiles yet).
- Smart TVs already play from the computer and mark favorites and flags; they cannot change playlists there.
- Play counts do not go to the computer.
- Songs are known by where they are in the library folder. Renaming or reorganizing them on the computer makes the
  phone fetch them again and take the old copies off; more than 25 (or a fifth of those kept) at once are held on the
  phone instead, so there can be two copies until the person clears them. (Jellyfin behaves the same way.)
- A song already sent to the computer is not offered again, even if it was later deleted from the incoming folder.
- A playlist holding songs the computer cannot find (or Jellyfin-only songs) is left alone on both sides.

## Safety rules

Nothing is taken for removed because the other side could not see it: only what both sides held at the last round can
be removed by one of them; an empty or unreadable computer library is an error; songs the computer cannot find take no
part in a round; pairing again starts by joining both sides; hearts are not compared while a sync is replacing files.

## Jellyfin plugin (test version)

`apps/jellyfin-plugin`, built by `tools/package-jellyfin-plugin.ps1` (.NET 10 SDK; Jellyfin 12.4.0 only). It adds
`/MediaVerse/...` addresses for signed-in apps: profiles (no extra Jellyfin users), one shared list of problem tracks,
each with a revision so one device cannot silently undo another, and new music into an incoming folder (off until the
administrator allows it). Its data is in the plugin's own folder; a removed profile's file is kept aside.

Tried on a throwaway server (2026-11-26): added as a repository, installed from the catalog, restarted; signed-out
requests refused; profile settings only for the administrator; a 40 MB upload (above the web server's usual limit);
paths outside the folder refused.

Installed on the owner's server 2026-11-26 (copied into the server's plugin folder), with an incoming folder of its
own outside the music library, shared to the computer.

**Phone to server (built):** Settings > Keep music from the server on this phone > New music on this phone. The phone
lists what the server's library lacks (by artist, title and album) and sends chosen albums, all of it, or five
minutes' worth, with a progress bar. Each server's sent songs are remembered, so they are not offered again while they
wait to be looked over. Any signed-in user of the server may send while the administrator allows it.

Not yet: the repository is not hosted anywhere (it needs a public address, for example with the project's releases);
profiles and problem tracks in the plugin are not used by any app; the computer app does not use the plugin.

## Next

1. Profiles in the computer app, with the picker (the computer is then a complete hub).
2. Apps keep profiles and problem tracks in the plugin; move the profiles made as Jellyfin users (D213) over.
3. TVs: profiles from either hub.
