# Profiles (D213)

**Being replaced (2026-11-26):** the owner prefers MediaVerse's own profiles, with the computer or our Jellyfin plugin
holding them, over Jellyfin users with no password. See `docs/wifi-sync.md`. What follows describes what is built.

Netflix-style profiles for the TV, phone and computer, held on the Jellyfin server. Approved by the owner on
2026-11-26.

## What the owner asked for

- A profile, not a password account: separate favorites, last played and playlists. For family members, or a profile
  per device.
- TV (shared): pick your icon when the program starts.
- Phone and computer: when first connected, choose a default profile from a list or make a new one, and choose
  whether the picker shows at every start.
- Flagged songs are shared by everyone; anyone with access to the server may check, fix and clear them.
- Playlists are not shared by default; sharing them should be possible. They need not be strictly private.
- A profile of one's own if the present account is the administrator.

## What Jellyfin 12.4.0 does (tried on a throwaway server, 2026-11-26; the owner's servers are 12.4.0)

| Question | Answer |
|---|---|
| User with no password | Only an administrator can make one (`POST /Users/New`). Made **hidden**: set `IsHidden` false. |
| Telling that a user has no password | Not possible: `HasPassword` is true either way. Try signing in with an empty password. |
| One device signed in as several | Yes: each sign-in has its own token (device id per profile). |
| Favorites and plays | Per user. `POST /UserPlayedItems/{id}?datePlayed=` keeps a given time. |
| New playlists | **Public** unless `IsPublic: false` is sent: every user sees them (only the owner and editors change them). |
| Sharing | `Users: [{UserId, CanEdit}]` when made, or `POST /Playlists/{id}` with the whole list. The owner **or an editor** may replace it. |
| `POST /Playlists/{id}/Users/{userId}` | Fails (500) when the list has no share yet: not used. |
| An editor | Adds and removes songs and renames; cannot delete the playlist. |
| Delete another user's playlist | Refused, even for the administrator when it is private. |
| All users' names | `GET /Users` answers any signed-in user; `GET /Users/Public` (no sign-in) lists the unhidden ones. |

## Design

- **Profile:** an unhidden, enabled Jellyfin user who is not an administrator and signs in with an empty password.
  Made by the app with the administrator's name and password, asked once and not kept; remote access off.
- **Playlists:** made private. "Share" gives chosen profiles view or edit.
- **Flags:** one list, "Problem tracks", with every profile as editor. Any editor adds profiles that are missing.
  Inbox lists ("Problem Playlist …") are made with the same shares; whoever merges one empties it, and its owner
  deletes it once empty.
- **Moving to a profile of one's own:** favorites and playlists are copied; the originals are left as they are unless the
  owner says otherwise.
- **Without Jellyfin:** the TV keeps its own profiles (D45) for the computer and USB sources.

## TV (built)

With Jellyfin as the source and profiles on the server, "Who's listening?" shows them: at start, and from the name at
the end of the tabs. Each has its favorites, playlists, a "Recently played" list, and its own queue and place. Favorites
the TV kept for a person (D45) are copied once to the profile of the same name. A profile cannot add itself to the
flag list: the account that owns it does, at its next sync (the computer). Without server profiles the TV works as
before.

## Phone (built)

After connecting (or at the first start with an existing sign-in) the phone asks who uses it: a profile from the list or
a new one, and whether to ask at every start. Settings shows the profile and switches it. The first profile chosen
takes over the phone's favorites, playlists, play counts and queue; each other profile has its own, kept apart on the
phone (also in Android Auto) and in step with the server. Flags, downloads and the server stay the phone's. A profile
used before can be switched to away from home. Tried on an emulator against a throwaway server (2026-11-26).

## Stages

1. Shared logic and tests; computer: Settings > Jellyfin > Profiles (make profiles, copy into one).
2. TV: picker from the server; favorites, playlists, last played and flags per profile; favorites kept on the TV
   carried over to the profile of the same name.
3. Phone: setup (choose or make a profile, show the picker or not), switching, per-profile favorites, playlists and
   history.
4. Computer: the same as the phone.
5. Sharing playlists between profiles.
