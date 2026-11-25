//! Finds what the library is missing: albums without a cover picture and tracks without lyrics, for the Review page.
//! Reads only tag headers and file names. A cover counts as present if the MP3 has an embedded picture or the folder
//! holds a cover image; lyrics count as present if the MP3 has them in its tags or a `.lrc` file sits beside the song.

use mediaverse_ripper::id3;
use serde_json::{Value, json};
use std::collections::HashMap;
use std::io::Read;
use std::path::{Path, PathBuf};
use std::sync::Mutex;
use std::sync::atomic::{AtomicUsize, Ordering};

const AUDIO: [&str; 7] = ["mp3", "flac", "wav", "m4a", "aac", "ogg", "opus"];
const FOLDER_COVERS: [&str; 6] = [
    "cover.jpg",
    "cover.png",
    "folder.jpg",
    "folder.png",
    "front.jpg",
    "front.png",
];
const MAX_DEPTH: usize = 8;
const MAX_FILES: usize = 200_000;
const MAX_TAG_BYTES: usize = 12 * 1024 * 1024;

fn collect(dir: &Path, depth: usize, out: &mut Vec<std::path::PathBuf>) {
    if depth > MAX_DEPTH || out.len() >= MAX_FILES {
        return;
    }
    let Ok(read) = std::fs::read_dir(dir) else {
        return;
    };
    for entry in read.flatten() {
        let Ok(kind) = entry.file_type() else {
            continue;
        };
        if kind.is_symlink()
            || mediaverse_library_filesystem::is_system_clutter(
                &entry.file_name().to_string_lossy(),
            )
        {
            continue;
        }
        let path = entry.path();
        if kind.is_dir() {
            collect(&path, depth + 1, out);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| AUDIO.contains(&e.to_ascii_lowercase().as_str()))
        {
            out.push(path);
        }
    }
}

/// The frames of an MP3's ID3v2.3 tag, if it has a readable one.
fn mp3_frames(file: &Path) -> Option<Vec<id3::Frame>> {
    let mut handle = std::fs::File::open(file).ok()?;
    let mut header = [0u8; 10];
    handle.read_exact(&mut header).ok()?;
    if !header.starts_with(b"ID3") || header[6..10].iter().any(|b| b & 0x80 != 0) {
        return None;
    }
    let length = 10
        + header[6..10]
            .iter()
            .fold(0usize, |acc, &b| (acc << 7) | usize::from(b));
    if length > MAX_TAG_BYTES {
        return None;
    }
    let mut tag = header.to_vec();
    tag.resize(length, 0);
    handle.read_exact(&mut tag[10..]).ok()?;
    id3::read_frames(&tag).ok()
}

/// The largest cover file in a folder, as (width, height).
fn folder_cover_size(dir: &Path) -> Option<(u32, u32)> {
    FOLDER_COVERS
        .iter()
        .filter_map(|name| {
            let path = dir.join(name);
            std::fs::metadata(&path).ok().filter(|m| m.is_file())?;
            // The size is in the first part of the file (a JPEG's frame header, a PNG's IHDR).
            let mut head = vec![0u8; 256 * 1024];
            let mut handle = std::fs::File::open(&path).ok()?;
            let read = handle.read(&mut head).ok()?;
            head.truncate(read);
            crate::cover_art::image_info(&head).map(|i| (i.width, i.height))
        })
        .max_by_key(|(w, h)| (*w).min(*h))
}

const PICTURE_NAMES: [(u8, &str); 3] = [(3, "front_cover"), (4, "back_cover"), (8, "artist_photo")];

/// Owner, 2026-11-05: pictures inside the songs are JPEG, at most 1000 × 1000 pixels, under 500 KB and ideally under
/// 200 KB. Anything else is listed (the page groups them, and the 200 to 500 KB ones can be ignored).
const IDEAL_EMBED_BYTES: usize = 200 * 1024;
fn breaks_embedding_rules(width: u32, height: u32, bytes: usize, png: bool) -> bool {
    width.max(height) > crate::cover_art::EMBED_MAX_SIDE || png || bytes > IDEAL_EMBED_BYTES
}

/// `{files: [{path, cover, lyrics, mp3, cover_size, embed_issues}]}` for every audio file under `root`:
/// `cover_size` is the pixel size of the best front cover there is (in the song or the folder) as [width, height];
/// `embed_issues` lists the song's pictures that break the embedding rules, each `{kind, width, height, kb, png}`.
/// Calls `progress(done, total)` now and then.
pub fn scan(root: &Path, progress: &mut dyn FnMut(usize, usize)) -> Value {
    scan_with_cache(root, None, progress)
}

/// `scan`, remembering what each song's tag held in `cache_file` (owner, 2026-11-22: with the library on a network share, reading every
/// song's tag, covers included, took minutes at each start). A song whose size and modified time are the same as last time is not read
/// again; what depends on the folder (its cover file) and a `.lrc` file beside the song is looked at every time, so those stay current.
pub fn scan_with_cache(
    root: &Path,
    cache_file: Option<&Path>,
    progress: &mut dyn FnMut(usize, usize),
) -> Value {
    let mut files = Vec::new();
    collect(root, 0, &mut files);
    files.sort();
    let total = files.len();
    let (known, known_folders) = cache_file.map(|f| load_facts(f, root)).unwrap_or_default();
    let learned: Mutex<HashMap<String, Facts>> = Mutex::new(HashMap::new());
    // What a folder holds (its cover file and that file's size) is the same for every song in it: asked once per folder, by whichever
    // worker gets there first. On a network share every question costs a round trip, so this and the workers below are what keep the
    // scan quick (owner, 2026-11-22: it had become very slow with the library on the Jellyfin share).
    let folders: Mutex<HashMap<PathBuf, FolderCover>> = Mutex::new(HashMap::new());
    let next = AtomicUsize::new(0);
    let done = AtomicUsize::new(0);
    let results: Vec<Mutex<Option<Value>>> = (0..total).map(|_| Mutex::new(None)).collect();
    let workers = WORKERS.min(total.max(1));
    std::thread::scope(|scope| {
        for _ in 0..workers {
            scope.spawn(|| {
                loop {
                    let index = next.fetch_add(1, Ordering::SeqCst);
                    let Some(file) = files.get(index) else { break };
                    let key = file.to_string_lossy().into_owned();
                    let (entry, facts) = scan_file(file, &folders, &known_folders, known.get(&key));
                    if let Some(facts) = facts
                        && let Ok(mut all) = learned.lock()
                    {
                        all.insert(key, facts);
                    }
                    if let Ok(mut slot) = results[index].lock() {
                        *slot = Some(entry);
                    }
                    done.fetch_add(1, Ordering::SeqCst);
                }
            });
        }
        while done.load(Ordering::SeqCst) < total {
            progress(done.load(Ordering::SeqCst), total);
            std::thread::sleep(std::time::Duration::from_millis(150));
        }
    });
    progress(total, total);
    if let (Some(cache_file), Ok(all), Ok(seen)) = (cache_file, learned.lock(), folders.lock()) {
        save_facts(cache_file, root, &all, &seen);
    }
    let entries: Vec<Value> = results
        .into_iter()
        .filter_map(|slot| slot.into_inner().ok().flatten())
        .collect();
    json!({ "files": entries })
}

/// How many files are read at once: a network share answers many requests together far faster than one after another, and a local disk loses nothing.
const WORKERS: usize = 12;

/// A folder's cover files: whether there is one, the size of the largest, and how each file looked (name, size, modified time) when that was worked out.
#[derive(Clone)]
struct FolderCover {
    has: bool,
    size: Option<(u32, u32)>,
    stamps: Vec<(String, u64, u64)>,
}

/// What a folder's cover files are. The pictures are only opened (to read their size) when the files are not the ones remembered from the last scan.
fn folder_cover(
    folders: &Mutex<HashMap<PathBuf, FolderCover>>,
    remembered: &HashMap<String, FolderCover>,
    dir: &Path,
) -> FolderCover {
    if let Ok(map) = folders.lock()
        && let Some(found) = map.get(dir)
    {
        return found.clone();
    }
    // Not held while the folder is read: two workers reaching a new folder at once both ask, which is only a little wasted work.
    let stamps: Vec<(String, u64, u64)> = FOLDER_COVERS
        .iter()
        .filter_map(|name| {
            let (len, modified) = stamp(&dir.join(name))?;
            Some(((*name).to_owned(), len, modified))
        })
        .collect();
    let size = match remembered.get(dir.to_string_lossy().as_ref()) {
        Some(old) if old.stamps == stamps => old.size,
        _ => folder_cover_size(dir),
    };
    let found = FolderCover {
        has: !stamps.is_empty(),
        size,
        stamps,
    };
    if let Ok(mut map) = folders.lock() {
        map.insert(dir.to_path_buf(), found.clone());
    }
    found
}

/// What a song's own tag held when it was last read: the part of the answer that depends on the file alone.
#[derive(Clone)]
struct Facts {
    len: u64,
    /// Milliseconds since 1970 of the file's last change.
    modified: u64,
    embedded_cover: bool,
    tag_lyrics: bool,
    /// The largest front cover inside the song, as (width, height).
    embedded_best: Option<(u32, u32)>,
    /// Pictures inside the song that break the embedding rules (`{kind, width, height, kb, png}`).
    issues: Vec<Value>,
}

impl Facts {
    fn to_json(&self) -> Value {
        json!([
            self.len,
            self.modified,
            self.embedded_cover,
            self.tag_lyrics,
            self.embedded_best.map(|(w, h)| json!([w, h])),
            self.issues
        ])
    }

    fn from_json(value: &Value) -> Option<Facts> {
        let list = value.as_array()?;
        let size = |v: &Value| -> Option<(u32, u32)> {
            let pair = v.as_array()?;
            Some((
                u32::try_from(pair.first()?.as_u64()?).ok()?,
                u32::try_from(pair.get(1)?.as_u64()?).ok()?,
            ))
        };
        Some(Facts {
            len: list.first()?.as_u64()?,
            modified: list.get(1)?.as_u64()?,
            embedded_cover: list.get(2)?.as_bool()?,
            tag_lyrics: list.get(3)?.as_bool()?,
            embedded_best: size(list.get(4)?),
            issues: list.get(5)?.as_array()?.clone(),
        })
    }
}

/// The file's size and modified time, which say whether it changed since it was read.
fn stamp(file: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(file).ok().filter(|m| m.is_file())?;
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_millis();
    Some((meta.len(), u64::try_from(modified).ok()?))
}

/// What the tag of this MP3 holds, read from the file.
fn read_facts(file: &Path, len: u64, modified: u64) -> Facts {
    let frames = mp3_frames(file);
    let mut facts = Facts {
        len,
        modified,
        embedded_cover: frames
            .as_ref()
            .is_some_and(|f| f.iter().any(|fr| fr.id == "APIC")),
        tag_lyrics: frames
            .as_ref()
            .is_some_and(|f| f.iter().any(|fr| fr.id == "USLT" || fr.id == "SYLT")),
        embedded_best: None,
        issues: Vec::new(),
    };
    for frame in frames.iter().flatten().filter(|f| f.id == "APIC") {
        let Ok((_, kind, data)) = id3::frame_picture(frame) else {
            continue;
        };
        let Some(info) = crate::cover_art::image_info(&data) else {
            continue;
        };
        // Type 0 ("Other") is how many programs store the cover: it is treated as the front cover.
        let kind = if kind == id3::OTHER_PICTURE { 3 } else { kind };
        if kind == 3
            && facts
                .embedded_best
                .is_none_or(|(w, h)| info.width.min(info.height) > w.min(h))
        {
            facts.embedded_best = Some((info.width, info.height));
        }
        let png = info.kind == crate::cover_art::Kind::Png;
        if breaks_embedding_rules(info.width, info.height, data.len(), png) {
            let name = PICTURE_NAMES
                .iter()
                .find(|(k, _)| *k == kind)
                .map_or("other", |(_, n)| n);
            facts.issues.push(json!({ "kind": name, "width": info.width, "height": info.height, "kb": data.len() / 1024, "png": png }));
        }
    }
    facts
}

/// What the scan records about one song, and (for an MP3 that was read or checked) what its tag held, to be remembered.
fn scan_file(
    file: &Path,
    folders: &Mutex<HashMap<PathBuf, FolderCover>>,
    remembered_folders: &HashMap<String, FolderCover>,
    known: Option<&Facts>,
) -> (Value, Option<Facts>) {
    let is_mp3 = file
        .extension()
        .is_some_and(|e| e.eq_ignore_ascii_case("mp3"));
    let facts = if is_mp3 {
        match stamp(file) {
            Some((len, modified)) => Some(match known {
                Some(old) if old.len == len && old.modified == modified => old.clone(),
                _ => read_facts(file, len, modified),
            }),
            None => None,
        }
    } else {
        None
    };
    let embedded_cover = facts.as_ref().is_some_and(|f| f.embedded_cover);
    let tag_lyrics = facts.as_ref().is_some_and(|f| f.tag_lyrics);
    let folder = file
        .parent()
        .map(|dir| folder_cover(folders, remembered_folders, dir));
    let cover = embedded_cover || folder.as_ref().is_some_and(|f| f.has);
    // (the `.lrc` file is only looked for when the tag has no lyrics: one question fewer for most songs)
    let lyrics = tag_lyrics || file.with_extension("lrc").is_file();
    // The best front cover: the folder's, unless one inside the song is larger.
    let mut best: Option<(u32, u32)> = folder.as_ref().and_then(|f| f.size);
    if let Some((w, h)) = facts.as_ref().and_then(|f| f.embedded_best)
        && best.is_none_or(|(bw, bh)| w.min(h) > bw.min(bh))
    {
        best = Some((w, h));
    }
    let issues = facts.as_ref().map_or_else(Vec::new, |f| f.issues.clone());
    let entry = json!({
        "path": file.to_string_lossy(), "cover": cover, "lyrics": lyrics, "mp3": is_mp3,
        "cover_size": best.map(|(w, h)| json!([w, h])), "embed_issues": issues,
    });
    (entry, facts)
}

const CACHE_VERSION: u64 = 2;

/// A folder's cover files as stored: `[[[name, size, modified], ...], [width, height] | null]`.
fn folder_to_json(folder: &FolderCover) -> Value {
    json!([
        folder
            .stamps
            .iter()
            .map(|(name, len, modified)| json!([name, len, modified]))
            .collect::<Vec<_>>(),
        folder.size.map(|(w, h)| json!([w, h]))
    ])
}

fn folder_from_json(value: &Value) -> Option<FolderCover> {
    let list = value.as_array()?;
    let stamps: Vec<(String, u64, u64)> = list
        .first()?
        .as_array()?
        .iter()
        .filter_map(|s| {
            let s = s.as_array()?;
            Some((
                s.first()?.as_str()?.to_owned(),
                s.get(1)?.as_u64()?,
                s.get(2)?.as_u64()?,
            ))
        })
        .collect();
    let size = list.get(1).and_then(|v| {
        let pair = v.as_array()?;
        Some((
            u32::try_from(pair.first()?.as_u64()?).ok()?,
            u32::try_from(pair.get(1)?.as_u64()?).ok()?,
        ))
    });
    Some(FolderCover {
        has: !stamps.is_empty(),
        size,
        stamps,
    })
}

/// What was remembered about this library's songs and folders, if the file is there, is ours and is for this library folder.
fn load_facts(
    cache_file: &Path,
    root: &Path,
) -> (HashMap<String, Facts>, HashMap<String, FolderCover>) {
    let Some(value) = std::fs::read(cache_file)
        .ok()
        .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
    else {
        return Default::default();
    };
    if value["version"] != CACHE_VERSION || value["root"].as_str() != Some(&root.to_string_lossy())
    {
        return Default::default();
    }
    let songs = value["songs"]
        .as_object()
        .map(|songs| {
            songs
                .iter()
                .filter_map(|(path, facts)| Some((path.clone(), Facts::from_json(facts)?)))
                .collect()
        })
        .unwrap_or_default();
    let folders = value["folders"]
        .as_object()
        .map(|folders| {
            folders
                .iter()
                .filter_map(|(dir, folder)| Some((dir.clone(), folder_from_json(folder)?)))
                .collect()
        })
        .unwrap_or_default();
    (songs, folders)
}

/// Remembers what was read (only songs and folders still in the library are kept). A failure to save only means the next scan reads again.
fn save_facts(
    cache_file: &Path,
    root: &Path,
    facts: &HashMap<String, Facts>,
    folders: &HashMap<PathBuf, FolderCover>,
) {
    let songs: serde_json::Map<String, Value> = facts
        .iter()
        .map(|(path, facts)| (path.clone(), facts.to_json()))
        .collect();
    let folders: serde_json::Map<String, Value> = folders
        .iter()
        .map(|(dir, folder)| (dir.to_string_lossy().into_owned(), folder_to_json(folder)))
        .collect();
    let body = json!({ "version": CACHE_VERSION, "root": root.to_string_lossy(), "songs": songs, "folders": folders });
    let Ok(bytes) = serde_json::to_vec(&body) else {
        return;
    };
    if let Some(parent) = cache_file.parent() {
        let _ = std::fs::create_dir_all(parent);
    }
    let temp = cache_file.with_extension("json.tmp");
    if std::fs::write(&temp, bytes).is_ok() {
        let _ = std::fs::rename(&temp, cache_file);
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use mediaverse_ripper::id3::{Picture, PictureKind, TagSet};

    fn mp3(path: &Path, tags: &TagSet) {
        let mut bytes = id3::write_tag(tags).unwrap();
        bytes.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, bytes).unwrap();
    }

    /// A JPEG header of the given size (enough for the size to be read).
    fn sized_jpeg(width: u16, height: u16, padding: usize) -> Vec<u8> {
        let mut data = vec![0xFF, 0xD8, 0xFF, 0xC0, 0x00, 0x11, 0x08];
        data.extend_from_slice(&height.to_be_bytes());
        data.extend_from_slice(&width.to_be_bytes());
        data.extend(std::iter::repeat_n(0u8, 10 + padding));
        data.extend_from_slice(&[0xFF, 0xD9]);
        data
    }

    /// A timing aid, not a check: `MV_SCAN_ROOT=M:\ cargo test -p mediaverse_sidecar a_real_library -- --ignored --nocapture`
    /// (scans twice: the second time everything comes from the remembered facts, in a scratch cache file).
    #[test]
    #[ignore = "reads a real library; set MV_SCAN_ROOT"]
    fn a_real_library_is_scanned_in_reasonable_time() {
        let Ok(root) = std::env::var("MV_SCAN_ROOT") else {
            return;
        };
        let cache =
            std::env::temp_dir().join(format!("mv-gaps-timing-{}.json", std::process::id()));
        let _ = std::fs::remove_file(&cache);
        for round in ["first", "second"] {
            let started = std::time::Instant::now();
            let reply = scan_with_cache(Path::new(&root), Some(&cache), &mut |_, _| {});
            let files = reply["files"].as_array().map_or(0, Vec::len);
            println!(
                "{round} scan: {files} files in {:.1} s",
                started.elapsed().as_secs_f64()
            );
        }
        let _ = std::fs::remove_file(&cache);
    }

    #[test]
    fn a_remembered_song_is_not_read_again_until_it_changes_but_its_folder_is_always_looked_at() {
        let root = std::env::temp_dir().join(format!("mv-gaps-cache-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let song = root.join("Album").join("01.mp3");
        mp3(
            &song,
            &TagSet {
                title: "x".into(),
                ..TagSet::default()
            },
        );
        let cache = root.join("cache.json");
        let first = scan_with_cache(&root, Some(&cache), &mut |_, _| {});
        assert_eq!(first["files"][0]["lyrics"], false);
        assert_eq!(first["files"][0]["cover"], false);
        assert!(cache.is_file(), "the facts were remembered");

        // A cover file appears in the folder: noticed at once, though the song was not read again.
        std::fs::write(
            root.join("Album").join("cover.jpg"),
            sized_jpeg(600, 600, 0),
        )
        .unwrap();
        let second = scan_with_cache(&root, Some(&cache), &mut |_, _| {});
        assert_eq!(second["files"][0]["cover"], true);
        assert_eq!(second["files"][0]["cover_size"], json!([600, 600]));

        // The song gets lyrics (its size and time change): read again.
        mp3(
            &song,
            &TagSet {
                title: "x".into(),
                lyrics: Some("la la la".into()),
                ..TagSet::default()
            },
        );
        let third = scan_with_cache(&root, Some(&cache), &mut |_, _| {});
        assert_eq!(third["files"][0]["lyrics"], true);

        // A cache made for another library folder is ignored.
        let other = root.join("Elsewhere");
        std::fs::create_dir_all(&other).unwrap();
        let fresh = scan_with_cache(&other, Some(&cache), &mut |_, _| {});
        assert_eq!(fresh["files"].as_array().unwrap().len(), 0);
    }

    #[test]
    fn cover_sizes_and_pictures_too_big_to_embed_are_reported() {
        let root = std::env::temp_dir().join(format!("mv-gaps-sizes-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let plain = TagSet {
            title: "x".into(),
            ..TagSet::default()
        };
        // A small embedded cover, but a bigger cover file in the folder: the best one counts.
        mp3(
            &root.join("Small").join("01.mp3"),
            &TagSet {
                pictures: vec![Picture {
                    kind: PictureKind::FrontCover,
                    data: sized_jpeg(200, 200, 0),
                }],
                ..plain.clone()
            },
        );
        std::fs::write(
            root.join("Small").join("cover.jpg"),
            sized_jpeg(600, 600, 0),
        )
        .unwrap();
        // Embedded pictures over 1000 pixels: listed as issues.
        mp3(
            &root.join("Big").join("01.mp3"),
            &TagSet {
                pictures: vec![
                    Picture {
                        kind: PictureKind::FrontCover,
                        data: sized_jpeg(1400, 1400, 0),
                    },
                    Picture {
                        kind: PictureKind::ArtistPhoto,
                        data: sized_jpeg(800, 600, 0),
                    },
                ],
                ..plain.clone()
            },
        );
        mp3(&root.join("None").join("01.mp3"), &plain);
        let found = scan(&root, &mut |_, _| {});
        let get = |name: &str| {
            found["files"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["path"].as_str().unwrap().contains(&format!("{name}\\")))
                .unwrap()
                .clone()
        };
        assert_eq!(get("Small")["cover_size"], json!([600, 600]));
        assert_eq!(get("Small")["embed_issues"], json!([]));
        assert_eq!(get("Big")["cover_size"], json!([1400, 1400]));
        assert_eq!(
            get("Big")["embed_issues"],
            json!([{ "kind": "front_cover", "width": 1400, "height": 1400, "kb": 0, "png": false }])
        );
        assert_eq!(get("None")["cover_size"], Value::Null);
        assert!(
            breaks_embedding_rules(500, 500, 600 * 1024, false)
                && breaks_embedding_rules(500, 500, 1000, true)
                && !breaks_embedding_rules(1000, 1000, 199 * 1024, false)
        );
        assert!(
            breaks_embedding_rules(800, 800, 300 * 1024, false),
            "200 to 500 KB is listed too"
        );
    }

    #[test]
    fn missing_covers_and_lyrics_are_found_and_present_ones_are_not() {
        let root = std::env::temp_dir().join(format!("mv-gaps-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        let mut jpeg = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 16];
        jpeg.extend(std::iter::repeat(7u8).take(50));
        jpeg.extend_from_slice(&[0xFF, 0xD9]);
        let plain = TagSet {
            title: "x".into(),
            ..TagSet::default()
        };
        mp3(&root.join("Bare").join("LP").join("01.mp3"), &plain);
        mp3(
            &root.join("Covered").join("LP").join("01.mp3"),
            &TagSet {
                pictures: vec![Picture {
                    kind: PictureKind::FrontCover,
                    data: jpeg.clone(),
                }],
                ..plain.clone()
            },
        );
        mp3(
            &root.join("Words").join("LP").join("01.mp3"),
            &TagSet {
                lyrics: Some("la la".into()),
                ..plain.clone()
            },
        );
        mp3(&root.join("Folder").join("LP").join("01.mp3"), &plain);
        std::fs::write(root.join("Folder").join("LP").join("cover.jpg"), &jpeg).unwrap();
        mp3(&root.join("Beside").join("LP").join("01.mp3"), &plain);
        std::fs::write(
            root.join("Beside").join("LP").join("01.lrc"),
            "[00:01.00]hi",
        )
        .unwrap();
        std::fs::write(root.join("Bare").join("notes.txt"), "x").unwrap();
        let mut ticks = 0;
        let found = scan(&root, &mut |_, _| ticks += 1);
        assert!(ticks >= 2);
        let get = |name: &str| {
            found["files"]
                .as_array()
                .unwrap()
                .iter()
                .find(|f| f["path"].as_str().unwrap().contains(&format!("{name}\\")))
                .unwrap()
                .clone()
        };
        assert_eq!(found["files"].as_array().unwrap().len(), 5);
        assert_eq!(
            (get("Bare")["cover"].clone(), get("Bare")["lyrics"].clone()),
            (json!(false), json!(false))
        );
        assert_eq!(get("Covered")["cover"], true);
        assert_eq!(get("Words")["lyrics"], true);
        assert_eq!(get("Words")["cover"], false);
        assert_eq!(
            get("Folder")["cover"],
            true,
            "a cover image in the folder counts"
        );
        assert_eq!(
            get("Beside")["lyrics"],
            true,
            "a .lrc file beside the song counts"
        );
    }
}
