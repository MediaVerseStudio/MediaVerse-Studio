//! Library organiser (issue #9): works out, without touching anything, how the library's files would be named and placed by a rule such as
//! `{albumartist}/{album}/{disc}{track} - {title}` (the person picks one of the common ones, or writes their own), which songs would conflict, and which songs look
//! like duplicates. `organize_apply.rs` makes the moves; this file only decides and describes. Compilation albums can be kept together under "Various Artists".

use serde_json::{Value, json};
use std::collections::HashMap;
use std::path::{Path, PathBuf};

pub const DEFAULT_PATTERN: &str = "{albumartist}/{album}/{disc}{track} - {title}";
/// The folder compilations are kept under.
pub const VARIOUS: &str = "Various Artists";

/// The choices that are not part of the naming rule.
#[derive(Debug, Clone, Copy)]
pub struct Options {
    /// Albums that are compilations (flagged in the tags, or several different artists with no album artist) go under "Various Artists".
    pub keep_compilations: bool,
}

impl Default for Options {
    fn default() -> Self {
        Self {
            keep_compilations: true,
        }
    }
}

const MAX_COMPONENT: usize = 120;
const MAX_LISTED: usize = 2000;

#[derive(Debug, Clone, Default)]
pub struct Song {
    pub path: String,
    pub artist: Option<String>,
    pub album_artist: Option<String>,
    pub album: Option<String>,
    pub title: Option<String>,
    pub track: Option<u32>,
    pub disc: Option<u32>,
    pub year: Option<u32>,
    pub length_ms: Option<u64>,
    pub size: u64,
    pub bitrate_kbps: Option<u32>,
    /// The album is a compilation: its tags say so, or its folder holds one album by several different artists with no album artist.
    pub compilation: bool,
}

/// The file name without its extension (what `{file}` gives, to keep a song's own name and only fix its folders).
fn file_stem(path: &str) -> String {
    Path::new(path)
        .file_stem()
        .map(|s| s.to_string_lossy().into_owned())
        .unwrap_or_default()
}

/// A name for one folder or file: no characters Windows refuses, no trailing dots or spaces, not too long, never empty.
pub fn sanitize(text: &str) -> String {
    let cleaned: String = text
        .chars()
        .map(|c| {
            if matches!(c, '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*') || c.is_control() {
                '_'
            } else {
                c
            }
        })
        .collect();
    let mut cleaned = cleaned.trim().trim_end_matches(['.', ' ']).to_owned();
    if cleaned.chars().count() > MAX_COMPONENT {
        cleaned = cleaned
            .chars()
            .take(MAX_COMPONENT)
            .collect::<String>()
            .trim_end()
            .to_owned();
    }
    let upper = cleaned.to_ascii_uppercase();
    let reserved = [
        "CON", "PRN", "AUX", "NUL", "COM1", "COM2", "COM3", "COM4", "LPT1", "LPT2", "LPT3",
    ];
    if reserved.contains(&upper.as_str()) {
        cleaned.push('_');
    }
    if cleaned.is_empty() {
        "_".to_owned()
    } else {
        cleaned
    }
}

fn present(value: &Option<String>) -> Option<&str> {
    value.as_deref().map(str::trim).filter(|v| !v.is_empty())
}

/// The path (relative to the library, with `/` between folders) the rule gives a song, or why it cannot be named.
pub fn render(pattern: &str, song: &Song, options: &Options) -> Result<String, String> {
    let artist =
        if options.keep_compilations && song.compilation && present(&song.album_artist).is_none() {
            Some(VARIOUS)
        } else {
            present(&song.album_artist).or_else(|| present(&song.artist))
        };
    let (Some(album), Some(title), Some(artist)) =
        (present(&song.album), present(&song.title), artist)
    else {
        return Err(
            "it has no artist, album or title in its tags, so it is left where it is".to_owned(),
        );
    };
    let extension = Path::new(&song.path)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("")
        .to_ascii_lowercase();
    let disc = match song.disc {
        Some(d) if d > 1 => format!("{d}-"),
        _ => String::new(),
    };
    let track = song.track.map(|t| format!("{t:02}")).unwrap_or_default();
    let parts: Vec<String> = pattern
        .split(['/', '\\'])
        .filter(|p| !p.is_empty())
        .map(|part| {
            let filled = part
                .replace("{albumartist}", artist)
                .replace("{artist}", present(&song.artist).unwrap_or(artist))
                .replace("{album}", album)
                .replace("{title}", title)
                .replace("{disc}", &disc)
                .replace("{track}", &track)
                .replace("{file}", &file_stem(&song.path))
                .replace(
                    "{year}",
                    &song.year.map(|y| y.to_string()).unwrap_or_default(),
                );
            // A missing track number leaves " - Title": drop the dangling separator.
            // An empty "()" (no year) and a dangling separator go.
            let filled = filled.replace(" ()", "").replace("()", "");
            let filled = filled.trim().trim_start_matches(['-', ' ']).to_owned();
            sanitize(&filled)
        })
        .collect();
    if parts.is_empty() {
        return Err("the rule is empty".to_owned());
    }
    let mut last = parts.last().cloned().unwrap_or_default();
    if !extension.is_empty() {
        last.push('.');
        last.push_str(&extension);
    }
    let mut all = parts[..parts.len() - 1].to_vec();
    all.push(last);
    Ok(all.join("/"))
}

#[derive(Debug, Default)]
pub struct Plan {
    /// (from, to) pairs that differ, with `to` a full path.
    pub moves: Vec<(String, String)>,
    pub already_right: usize,
    pub skipped: Vec<(String, String)>,
    pub conflicts: Vec<Conflict>,
}

/// A song that cannot be placed because another file is in the way (a file already there, or another song wanting the same place).
#[derive(Debug, Clone)]
pub struct Conflict {
    pub from: String,
    pub to: String,
    pub why: String,
    /// The file in the way, when it is a song of the library.
    pub other: Option<String>,
    /// Both files have exactly the same size and length: very likely the same file twice.
    pub identical: bool,
}

fn same_place(a: &str, b: &str) -> bool {
    a.replace('\\', "/")
        .eq_ignore_ascii_case(&b.replace('\\', "/"))
}

/// Works out the plan for `songs` under `root`. Pure: `exists` says whether a path is already a file.
pub fn plan(
    root: &Path,
    songs: &[Song],
    pattern: &str,
    options: &Options,
    exists: &dyn Fn(&str) -> bool,
) -> Plan {
    let mut out = Plan::default();
    let mut wanted: HashMap<String, usize> = HashMap::new();
    let by_path: HashMap<String, usize> = songs
        .iter()
        .enumerate()
        .map(|(i, s)| (s.path.replace('\\', "/").to_ascii_lowercase(), i))
        .collect();
    let same_file =
        |a: &Song, b: &Song| a.size == b.size && a.size > 0 && a.length_ms == b.length_ms;
    for (n, song) in songs.iter().enumerate() {
        match render(pattern, song, options) {
            Err(why) => out.skipped.push((song.path.clone(), why)),
            Ok(relative) => {
                let target: PathBuf =
                    root.join(relative.replace('/', std::path::MAIN_SEPARATOR_STR));
                let target = target.to_string_lossy().into_owned();
                if same_place(&target, &song.path) {
                    out.already_right += 1;
                    continue;
                }
                let key = target.replace('\\', "/").to_ascii_lowercase();
                if let Some(&other) = wanted.get(&key) {
                    out.conflicts.push(Conflict {
                        from: song.path.clone(),
                        to: target,
                        why: "another song wants the same place".to_owned(),
                        other: Some(songs[other].path.clone()),
                        identical: same_file(song, &songs[other]),
                    });
                } else if exists(&target) {
                    let other = by_path.get(&key).copied().filter(|&i| i != n);
                    out.conflicts.push(Conflict {
                        from: song.path.clone(),
                        to: target,
                        why: "another file is already there".to_owned(),
                        other: other.map(|i| songs[i].path.clone()),
                        identical: other.is_some_and(|i| same_file(song, &songs[i])),
                    });
                } else {
                    wanted.insert(key, n);
                    out.moves.push((song.path.clone(), target));
                }
            }
        }
    }
    out
}

fn key_text(text: &str) -> String {
    let mut out = String::new();
    let mut depth = 0u32;
    for c in text.chars() {
        match c {
            '(' | '[' => depth += 1,
            ')' | ']' => depth = depth.saturating_sub(1),
            c if depth == 0 && c.is_alphanumeric() => out.extend(c.to_lowercase()),
            _ => {}
        }
    }
    out
}

/// Groups of songs that are the same song twice in one folder: the same artist and title (brackets such as "(Remastered)" ignored) of about the same
/// length, in the same folder. Songs in different folders are never grouped: they come from different albums or releases, and that is meant.
pub fn duplicates(songs: &[Song]) -> Vec<Vec<usize>> {
    let mut by_key: HashMap<String, Vec<usize>> = HashMap::new();
    for (i, song) in songs.iter().enumerate() {
        let (Some(artist), Some(title)) = (
            present(&song.artist).or_else(|| present(&song.album_artist)),
            present(&song.title),
        ) else {
            continue;
        };
        if key_text(title).is_empty() {
            continue;
        }
        by_key
            .entry(format!(
                "{}|{}|{}",
                key_text(artist),
                key_text(title),
                folder_of(&song.path)
            ))
            .or_default()
            .push(i);
    }
    let close =
        |a: &Song, b: &Song| a.length_ms.unwrap_or(0).abs_diff(b.length_ms.unwrap_or(0)) <= 3000;
    let mut groups = Vec::new();
    for (_, mut members) in by_key {
        members.sort_by_key(|&i| songs[i].length_ms.unwrap_or(0));
        let mut clusters: Vec<Vec<usize>> = Vec::new();
        for i in members {
            match clusters
                .iter_mut()
                .find(|c| close(&songs[i], &songs[c[c.len() - 1]]))
            {
                Some(cluster) => cluster.push(i),
                None => clusters.push(vec![i]),
            }
        }
        groups.extend(clusters.into_iter().filter(|c| c.len() > 1));
    }
    groups.sort_by_key(|g| songs[g[0]].path.clone());
    groups
}
fn folder_of(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(|p| p.to_string_lossy().to_ascii_lowercase())
        .unwrap_or_default()
}

/// Marks the songs of compilation albums: the tags say so, or one folder holds one album by at least three different artists and none of its songs has an album artist.
pub fn mark_compilations(songs: &mut [Song]) {
    let mut albums: HashMap<(String, String), Vec<usize>> = HashMap::new();
    for (i, song) in songs.iter().enumerate() {
        if let Some(album) = present(&song.album) {
            albums
                .entry((folder_of(&song.path), key_text(album)))
                .or_default()
                .push(i);
        }
    }
    for members in albums.values() {
        let artists: std::collections::HashSet<String> = members
            .iter()
            .filter_map(|&i| present(&songs[i].artist).map(key_text))
            .collect();
        let no_album_artist = members
            .iter()
            .all(|&i| present(&songs[i].album_artist).is_none());
        if members.len() >= 3 && artists.len() >= 3 && no_album_artist {
            for &i in members {
                songs[i].compilation = true;
            }
        }
    }
}

/// Reads the tags of every song in the library folder.
pub fn read_songs(root: &Path) -> Result<Vec<Song>, String> {
    read_songs_with(root, &|_, _| {})
}

/// Reads the tags of every song under `root`. A network drive answers one file at a time slowly, so several are read at once, and `progress(done, total)` is
/// told how far it has got (about every 25 songs) so the page can show a progress bar.
pub fn read_songs_with(
    root: &Path,
    progress: &(dyn Fn(usize, usize) + Sync),
) -> Result<Vec<Song>, String> {
    use std::sync::Mutex;
    use std::sync::atomic::{AtomicUsize, Ordering};
    let found =
        mediaverse_library_filesystem::scan_music_collection(root).map_err(|e| e.to_string())?;
    let total = found.len();
    progress(0, total);
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let slots: Mutex<Vec<Option<Song>>> = Mutex::new(vec![None; total]);
    std::thread::scope(|scope| {
        for _ in 0..8usize.min(total.max(1)) {
            scope.spawn(|| {
                loop {
                    let i = next.fetch_add(1, Ordering::Relaxed);
                    if i >= total {
                        break;
                    }
                    let song = read_one(&found[i].source_uri);
                    if let Ok(mut slots) = slots.lock() {
                        slots[i] = Some(song);
                    }
                    let finished = done.fetch_add(1, Ordering::Relaxed) + 1;
                    if finished % 25 == 0 || finished == total {
                        progress(finished, total);
                    }
                }
            });
        }
    });
    let mut songs: Vec<Song> = slots
        .into_inner()
        .map_err(|_| "reading the songs failed".to_owned())?
        .into_iter()
        .flatten()
        .collect();
    mark_compilations(&mut songs);
    Ok(songs)
}

fn read_one(source_uri: &str) -> Song {
    use lofty::file::TaggedFileExt;
    use lofty::tag::ItemKey;
    let path = Path::new(source_uri);
    let (meta, facts) = mediaverse_metadata_tags::read_track_details(path).unwrap_or_default();
    let flagged = mediaverse_metadata_tags::read_tagged(path)
        .ok()
        .and_then(|f| {
            f.primary_tag().or_else(|| f.first_tag()).and_then(|tag| {
                tag.get_string(&ItemKey::FlagCompilation)
                    .map(|v| matches!(v.trim(), "1" | "true" | "yes"))
            })
        })
        .unwrap_or(false);
    Song {
        size: std::fs::metadata(path).map(|m| m.len()).unwrap_or(0),
        path: source_uri.to_owned(),
        artist: meta.artist,
        album_artist: meta.album_artist,
        album: meta.album,
        title: meta.title,
        track: meta.track_number,
        disc: facts.disc_number,
        year: meta.release_year,
        length_ms: facts.length_ms,
        bitrate_kbps: facts.bitrate_kbps,
        compilation: flagged,
    }
}
pub fn preview_json(root: &Path, songs: &[Song], pattern: &str, options: &Options) -> Value {
    let exists = |p: &str| Path::new(p).is_file();
    let plan = plan(root, songs, pattern, options, &exists);
    let groups = duplicates(songs);
    let short = |p: &str| {
        p.strip_prefix(&root.to_string_lossy().to_string())
            .unwrap_or(p)
            .trim_start_matches(['\\', '/'])
            .to_owned()
    };
    // What the person needs to choose which of two files to keep: the tags, the size and bitrate, and when each file was made and changed.
    let by_path: HashMap<String, &Song> = songs
        .iter()
        .map(|s| (s.path.replace('\\', "/").to_ascii_lowercase(), s))
        .collect();
    let facts = |path: &str| -> Value {
        let song = by_path.get(&path.replace('\\', "/").to_ascii_lowercase());
        let meta = std::fs::metadata(path).ok();
        let seconds = |t: Option<std::io::Result<std::time::SystemTime>>| {
            t.and_then(Result::ok)
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map(|d| d.as_secs())
        };
        json!({
            "path": path, "path_short": short(path),
            "artist": song.and_then(|s| s.artist.clone()), "title": song.and_then(|s| s.title.clone()),
            "album": song.and_then(|s| s.album.clone()), "year": song.and_then(|s| s.year), "track": song.and_then(|s| s.track),
            "size": meta.as_ref().map_or_else(|| song.map_or(0, |s| s.size), |m| m.len()),
            "bitrate_kbps": song.and_then(|s| s.bitrate_kbps), "length_ms": song.and_then(|s| s.length_ms),
            "created": seconds(meta.as_ref().map(|m| m.created())), "modified": seconds(meta.as_ref().map(|m| m.modified())),
        })
    };
    json!({
        "pattern": pattern,
        "songs": songs.len(),
        "compilations": songs.iter().filter(|s| s.compilation).count(),
        "already_right": plan.already_right,
        "moves_total": plan.moves.len(),
        "moves": plan.moves.iter().take(MAX_LISTED).map(|(f, t)| json!({ "from": f, "to": t, "from_short": short(f), "to_short": short(t) })).collect::<Vec<_>>(),
        "skipped_total": plan.skipped.len(),
        "skipped": plan.skipped.iter().take(MAX_LISTED).map(|(p, why)| json!({ "path": p, "path_short": short(p), "why": why })).collect::<Vec<_>>(),
        "conflicts_total": plan.conflicts.len(),
        "conflicts_identical": plan.conflicts.iter().filter(|c| c.identical).count(),
        "conflicts": plan.conflicts.iter().take(MAX_LISTED).map(|c| json!({ "from": c.from, "to": c.to, "from_short": short(&c.from), "to_short": short(&c.to), "why": c.why, "other_short": c.other.as_deref().map(short), "identical": c.identical, "from_file": facts(&c.from), "other_file": c.other.as_deref().map(facts) })).collect::<Vec<_>>(),
        "duplicate_groups_total": groups.len(),
        "duplicate_groups": groups.iter().take(MAX_LISTED).map(|g| {
            let same_size = g.iter().all(|&i| songs[i].size == songs[g[0]].size);
            json!({
                "title": songs[g[0]].title, "artist": songs[g[0]].artist, "identical_size": same_size,
                "files": g.iter().map(|&i| facts(&songs[i].path)).collect::<Vec<_>>(),
            })
        }).collect::<Vec<_>>(),
        "applies": true,
    })
}
#[cfg(test)]
mod tests {
    use super::*;

    /// A path written the Windows way, in this system's own form (`M:\Music` becomes `/M/Music` elsewhere).
    fn native(path: &str) -> String {
        if cfg!(windows) {
            path.to_owned()
        } else {
            format!("/{}", path.replace(':', "").replace('\\', "/"))
        }
    }

    fn song(path: &str, artist: &str, album: &str, title: &str, track: u32) -> Song {
        Song {
            path: native(path),
            artist: Some(artist.to_owned()),
            album: Some(album.to_owned()),
            title: Some(title.to_owned()),
            track: Some(track),
            size: 5_000_000,
            length_ms: Some(200_000),
            ..Song::default()
        }
    }

    #[test]
    fn names_are_made_safe_for_windows() {
        assert_eq!(sanitize("AC/DC: Live?"), "AC_DC_ Live_");
        assert_eq!(sanitize("  Dots...  "), "Dots");
        assert_eq!(sanitize("CON"), "CON_");
        assert_eq!(sanitize("   "), "_");
        assert_eq!(sanitize(&"x".repeat(300)).chars().count(), MAX_COMPONENT);
    }

    #[test]
    fn the_rule_gives_artist_album_and_numbered_title_with_the_extension_kept() {
        let s = song("M:\\x\\a.MP3", "Band", "Record", "Song", 3);
        assert_eq!(
            render(DEFAULT_PATTERN, &s, &Options::default()).unwrap(),
            "Band/Record/03 - Song.mp3"
        );
        let two = Song {
            disc: Some(2),
            ..s.clone()
        };
        assert_eq!(
            render(DEFAULT_PATTERN, &two, &Options::default()).unwrap(),
            "Band/Record/2-03 - Song.mp3"
        );
        let none = Song { track: None, ..s };
        assert_eq!(
            render(DEFAULT_PATTERN, &none, &Options::default()).unwrap(),
            "Band/Record/Song.mp3"
        );
    }

    #[test]
    fn the_album_artist_is_preferred_and_untagged_songs_are_left_alone() {
        let mut s = song("a.flac", "Guest", "Compilation", "Song", 1);
        s.album_artist = Some("Various Artists".into());
        assert_eq!(
            render(DEFAULT_PATTERN, &s, &Options::default()).unwrap(),
            "Various Artists/Compilation/01 - Song.flac"
        );
        let untagged = Song { album: None, ..s };
        assert!(render(DEFAULT_PATTERN, &untagged, &Options::default()).is_err());
    }

    #[test]
    fn the_plan_separates_moves_correct_places_skips_and_conflicts() {
        let root = native("M:\\Music");
        let root = Path::new(&root);
        let songs = vec![
            song(
                "M:\\Music\\Band\\Record\\01 - One.mp3",
                "Band",
                "Record",
                "One",
                1,
            ), // already right
            song("M:\\Music\\misc\\two.mp3", "Band", "Record", "Two", 2),
            Song {
                path: "M:\\Music\\misc\\unknown.mp3".into(),
                ..Song::default()
            },
            song("M:\\Music\\a\\three.mp3", "Band", "Record", "Three", 3),
            song("M:\\Music\\b\\three-copy.mp3", "Band", "Record", "Three", 3), // wants the same place
            song("M:\\Music\\c\\four.mp3", "Band", "Record", "Four", 4),        // target exists
        ];
        let exists = |p: &str| p.ends_with("04 - Four.mp3");
        let plan = plan(root, &songs, DEFAULT_PATTERN, &Options::default(), &exists);
        assert_eq!(plan.already_right, 1);
        assert_eq!(plan.moves.len(), 2);
        assert_eq!(plan.skipped.len(), 1);
        assert_eq!(plan.conflicts.len(), 2);
        assert!(
            plan.moves
                .iter()
                .all(|(_, to)| to.starts_with(&native("M:\\Music\\Band\\Record\\")))
        );
    }

    #[test]
    fn duplicates_are_the_same_artist_and_title_of_about_the_same_length() {
        let mut a = song(
            "M:\\Music\\Band\\Record\\1.mp3",
            "Band",
            "Record",
            "Song (Remastered)",
            1,
        );
        let mut b = song(
            "M:\\Music\\Band\\Record\\2.mp3",
            "BAND",
            "Record",
            "Song",
            5,
        );
        let mut live = song(
            "M:\\Music\\Band\\Record\\3.mp3",
            "Band",
            "Record",
            "Song",
            2,
        );
        live.length_ms = Some(340_000); // a different recording
        a.length_ms = Some(200_500);
        b.length_ms = Some(201_000);
        let other = song(
            "M:\\Music\\Band\\Record\\4.mp3",
            "Band",
            "Record",
            "Other",
            3,
        );
        let groups = duplicates(&[a, b, live, other]);
        assert_eq!(groups, vec![vec![0, 1]]);
    }

    #[test]
    fn a_compilation_is_kept_together_under_various_artists_unless_that_is_switched_off() {
        let mut songs: Vec<Song> = (1..=4)
            .map(|i| {
                song(
                    &format!("M:\\Music\\Hits\\{i}.mp3"),
                    &format!("Artist {i}"),
                    "Now 50",
                    &format!("Song {i}"),
                    i,
                )
            })
            .collect();
        mark_compilations(&mut songs);
        assert!(songs.iter().all(|s| s.compilation));
        assert_eq!(
            render(DEFAULT_PATTERN, &songs[0], &Options::default()).unwrap(),
            "Various Artists/Now 50/01 - Song 1.mp3"
        );
        let off = Options {
            keep_compilations: false,
        };
        assert_eq!(
            render(DEFAULT_PATTERN, &songs[0], &off).unwrap(),
            "Artist 1/Now 50/01 - Song 1.mp3"
        );
        // an album by one artist, or with an album artist set, is not a compilation
        let mut single: Vec<Song> = (1..=4)
            .map(|i| {
                song(
                    &format!("M:\\Music\\A\\{i}.mp3"),
                    "Band",
                    "Record",
                    &format!("S{i}"),
                    i,
                )
            })
            .collect();
        mark_compilations(&mut single);
        assert!(single.iter().all(|s| !s.compilation));
        let mut tagged: Vec<Song> = (1..=4)
            .map(|i| Song {
                album_artist: Some("Band".into()),
                ..song(
                    &format!("M:\\Music\\B\\{i}.mp3"),
                    &format!("Guest {i}"),
                    "Duets",
                    &format!("S{i}"),
                    i,
                )
            })
            .collect();
        mark_compilations(&mut tagged);
        assert!(tagged.iter().all(|s| !s.compilation));
        // a flagged song goes under Various Artists even when it is alone
        let flagged = Song {
            compilation: true,
            ..song("M:\\Music\\C\\1.mp3", "Solo", "Mix", "Only", 1)
        };
        assert!(
            render(DEFAULT_PATTERN, &flagged, &Options::default())
                .unwrap()
                .starts_with("Various Artists/")
        );
    }

    #[test]
    fn other_naming_rules_and_the_songs_own_file_name_can_be_used() {
        let s = Song {
            year: Some(1999),
            ..song("M:\\x\\my old name.mp3", "Band", "Record", "Song", 3)
        };
        let o = Options::default();
        assert_eq!(
            render("{albumartist}/{album}/{track} {title}", &s, &o).unwrap(),
            "Band/Record/03 Song.mp3"
        );
        assert_eq!(
            render("{albumartist}/{album} ({year})/{track}. {title}", &s, &o).unwrap(),
            "Band/Record (1999)/03. Song.mp3"
        );
        assert_eq!(
            render("{albumartist}/{year} - {album}/{track} - {title}", &s, &o).unwrap(),
            "Band/1999 - Record/03 - Song.mp3"
        );
        assert_eq!(
            render("{albumartist}/{album}/{file}", &s, &o).unwrap(),
            "Band/Record/my old name.mp3",
            "folders only: the file keeps its name"
        );
        let no_year = Song { year: None, ..s };
        assert_eq!(
            render("{albumartist}/{album} ({year})/{title}", &no_year, &o).unwrap(),
            "Band/Record/Song.mp3",
            "an empty (year) is dropped"
        );
    }

    #[test]
    fn a_conflict_says_what_is_in_the_way_and_whether_it_is_the_same_file() {
        let root = Path::new("M:\\Music");
        let a = song("M:\\Music\\a\\x.mp3", "Band", "Record", "One", 1);
        let copy = song("M:\\Music\\b\\x-copy.mp3", "Band", "Record", "One", 1);
        let different = Song {
            size: 4_000_000,
            length_ms: Some(199_000),
            ..song("M:\\Music\\c\\y.mp3", "Band", "Record", "One", 1)
        };
        let plan = plan(
            root,
            &[a, copy, different],
            DEFAULT_PATTERN,
            &Options::default(),
            &|_| false,
        );
        assert_eq!(plan.moves.len(), 1);
        assert_eq!(plan.conflicts.len(), 2);
        assert!(
            plan.conflicts[0].identical
                && plan.conflicts[0].other == Some(native("M:\\Music\\a\\x.mp3"))
        );
        assert!(!plan.conflicts[1].identical);
    }

    #[test]
    fn duplicates_are_only_the_same_song_twice_in_one_folder() {
        let a = song("M:\\Music\\B\\Record\\1.mp3", "Band", "Record", "Song", 1);
        let twice = song("M:\\Music\\B\\Record\\2.mp3", "Band", "Record", "Song", 1);
        let hits = song(
            "M:\\Music\\B\\Greatest Hits\\9.mp3",
            "Band",
            "Greatest Hits",
            "Song",
            9,
        );
        let remaster = song(
            "M:\\Music\\B\\Record (Remastered)\\1.mp3",
            "Band",
            "Record",
            "Song",
            1,
        );
        let songs = [a, twice, hits, remaster];
        assert_eq!(
            duplicates(&songs),
            vec![vec![0, 1]],
            "the best-of's copy and the remaster are other releases in other folders, not duplicates"
        );
    }
}
