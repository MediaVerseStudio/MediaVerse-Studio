//! Cover pictures for the library and player: the front cover embedded in an MP3 (the ripper writes
//! one), or a `cover.jpg`/`folder.jpg` style file in the same folder. Only files inside the music
//! library are read, and only images that really are JPEG or PNG and of a sensible size are returned.

use crate::cover_art::MAX_IMAGE_BYTES;
use mediaverse_ripper::id3;
use serde_json::{Value, json};
use std::io::Read;
use std::path::{Path, PathBuf};

const MAX_TAG_BYTES: usize = 12 * 1024 * 1024;
const FOLDER_NAMES: [&str; 6] = [
    "cover.jpg",
    "cover.png",
    "folder.jpg",
    "folder.png",
    "front.jpg",
    "front.png",
];

pub fn base64(bytes: &[u8]) -> String {
    const TABLE: &[u8; 64] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";
    let mut out = String::with_capacity(bytes.len().div_ceil(3) * 4);
    for chunk in bytes.chunks(3) {
        let n = (u32::from(chunk[0]) << 16)
            | (u32::from(*chunk.get(1).unwrap_or(&0)) << 8)
            | u32::from(*chunk.get(2).unwrap_or(&0));
        out.push(TABLE[(n >> 18) as usize & 63] as char);
        out.push(TABLE[(n >> 12) as usize & 63] as char);
        out.push(if chunk.len() > 1 {
            TABLE[(n >> 6) as usize & 63] as char
        } else {
            '='
        });
        out.push(if chunk.len() > 2 {
            TABLE[n as usize & 63] as char
        } else {
            '='
        });
    }
    out
}

pub(crate) fn mime_of(bytes: &[u8]) -> Option<&'static str> {
    if bytes.starts_with(&[0xFF, 0xD8, 0xFF]) {
        Some("image/jpeg")
    } else if bytes.starts_with(&[0x89, b'P', b'N', b'G', 0x0D, 0x0A, 0x1A, 0x0A]) {
        Some("image/png")
    } else {
        None
    }
}

fn real(path: &Path) -> Option<PathBuf> {
    path.canonicalize().ok()
}

/// The real path of the library folder. Working it out is a round trip to the network share, and every cover, play and edit asked for it again, so a good
/// answer is kept for a minute (a folder that is unreachable is not remembered, and a changed library folder is a different key).
fn real_root(path: &Path) -> Option<PathBuf> {
    use std::collections::HashMap;
    use std::sync::{Mutex, OnceLock};
    use std::time::{Duration, Instant};
    static KNOWN: OnceLock<Mutex<HashMap<PathBuf, (Instant, PathBuf)>>> = OnceLock::new();
    let known = KNOWN.get_or_init(|| Mutex::new(HashMap::new()));
    if let Ok(known) = known.lock()
        && let Some((when, real)) = known.get(path)
        && when.elapsed() < Duration::from_secs(60)
    {
        return Some(real.clone());
    }
    let found = real(path)?;
    if let Ok(mut known) = known.lock() {
        known.insert(path.to_path_buf(), (Instant::now(), found.clone()));
    }
    Some(found)
}

/// A stable 64-bit hash of a text (FNV-1a), for naming cache files; `DefaultHasher` may differ between builds.
fn fnv1a(text: &str) -> u64 {
    text.bytes().fold(0xcbf2_9ce4_8422_2325, |hash, byte| {
        (hash ^ u64::from(byte)).wrapping_mul(0x0100_0000_01b3)
    })
}

/// What a file looked like when its picture was cached: its size and modification time.
fn stamp(path: &Path) -> Option<(u64, u128)> {
    let meta = std::fs::metadata(path).ok()?;
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_nanos();
    Some((meta.len(), modified))
}

/// A cover kept on this computer's disk, so the next start does not read every album's tag over the network share again (owner, 2026-11-24: slow Home).
/// The file holds one line of JSON (the song's and, for a folder picture, the picture's size and time, the picture's kind) and then the picture. It is used
/// only while those still match, so a re-tagged song or a replaced `cover.jpg` is read again. Only songs without a cover are never kept.
mod cache {
    use super::*;

    const LARGEST: usize = 4 * 1024 * 1024;

    fn file_for(dir: &Path, song: &Path) -> PathBuf {
        dir.join(format!(
            "{:016x}.cover",
            fnv1a(&song.to_string_lossy().to_lowercase())
        ))
    }

    pub fn read(dir: &Path, song: &Path) -> Option<(Vec<u8>, String, &'static str)> {
        let bytes = std::fs::read(file_for(dir, song)).ok()?;
        let split = bytes.iter().position(|b| *b == b'\n')?;
        let head: Value = serde_json::from_slice(&bytes[..split]).ok()?;
        let (size, modified) = stamp(song)?;
        if head["size"].as_u64()? != size || head["modified"].as_str()? != modified.to_string() {
            return None;
        }
        let from = match head["from"].as_str()? {
            "embedded" => "embedded",
            "folder" => {
                let picture = Path::new(head["picture"].as_str()?);
                let (picture_size, picture_modified) = stamp(picture)?;
                if head["picture_size"].as_u64()? != picture_size
                    || head["picture_modified"].as_str()? != picture_modified.to_string()
                {
                    return None;
                }
                "folder"
            }
            _ => return None,
        };
        let data = bytes[split + 1..].to_vec();
        let mime = mime_of(&data)?.to_owned();
        Some((data, mime, from))
    }

    pub fn write(dir: &Path, song: &Path, data: &[u8], from: &str, picture: Option<&Path>) {
        if data.len() > LARGEST {
            return;
        }
        let Some((size, modified)) = stamp(song) else {
            return;
        };
        let mut head = json!({ "size": size, "modified": modified.to_string(), "from": from });
        if let Some(picture) = picture {
            let Some((picture_size, picture_modified)) = stamp(picture) else {
                return;
            };
            head["picture"] = json!(picture.to_string_lossy());
            head["picture_size"] = json!(picture_size);
            head["picture_modified"] = json!(picture_modified.to_string());
        }
        if std::fs::create_dir_all(dir).is_err() {
            return;
        }
        let target = file_for(dir, song);
        let temp = target.with_extension(
            format!("tmp{:?}", std::thread::current().id()).replace(['(', ')'], ""),
        );
        let mut out = head.to_string().into_bytes();
        out.push(b'\n');
        out.extend_from_slice(data);
        if std::fs::write(&temp, out).is_ok() && std::fs::rename(&temp, &target).is_err() {
            let _ = std::fs::remove_file(&temp);
        }
    }
}

/// A song of a Jellyfin server's library, as the program names it when the server alone is the library (D173): `jellyfin:<album id>/<song id>`
/// (`loose` when the song has no album). It has no file on this computer, but it can be a favorite, in a playlist, flagged or in the history.
pub fn is_server_song(requested: &str) -> bool {
    let valid = |part: &str| {
        !part.is_empty()
            && part.len() <= 64
            && part
                .chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_')
    };
    requested.strip_prefix("jellyfin:").is_some_and(|rest| {
        rest.split_once('/')
            .is_some_and(|(album, song)| valid(album) && valid(song))
    })
}

/// Whether a song the page names may go into the favorites, a playlist, the flags or the history: a file in the library, or a song of the server library.
pub fn song_allowed(requested: &str, library_root: Option<&Path>) -> Result<(), String> {
    if is_server_song(requested) {
        return Ok(());
    }
    resolve_in_library(requested, library_root).map(|_| ())
}

/// The real path of `requested` if it is a file inside the music library folder; an error otherwise.
/// Shared by everything that reads or edits library files, so the rule lives in one place.
pub fn resolve_in_library(requested: &str, library_root: Option<&Path>) -> Result<PathBuf, String> {
    let root = library_root
        .and_then(real_root)
        .ok_or("No music library folder is chosen.")?;
    let found = real(Path::new(requested));
    if let Some(file) = &found
        && file.starts_with(&root)
        && *file != root
    {
        return Ok(file.clone());
    }
    // A path kept from before the library moved (`C:\Users\X\Music\Band\Album\song.mp3` when the library is now `M:\`): the same song under the
    // current folder, if there is one (owner, 2026-11-22: songs whose stored path was the old place would not play or save).
    if let Some(moved) = relocate(requested, &root) {
        return Ok(moved);
    }
    match found {
        None => Err("The file could not be found.".to_owned()),
        Some(_) => Err("The file is outside your music library.".to_owned()),
    }
}

/// The file under `root` that ends the same way as `requested` (its last five, four, three or two parts, the longest that matches), as a real path.
fn relocate(requested: &str, root: &Path) -> Option<PathBuf> {
    let parts: Vec<&str> = requested
        .split(['\\', '/'])
        .filter(|p| !p.is_empty() && *p != "." && *p != ".." && !p.contains(':'))
        .collect();
    (2..=5.min(parts.len())).rev().find_map(|n| {
        let mut candidate = root.to_path_buf();
        candidate.extend(&parts[parts.len() - n..]);
        let file = real(&candidate)?;
        (file.is_file() && file.starts_with(root) && file != *root).then_some(file)
    })
}

/// Decodes standard base64 (as sent by the page); `None` for anything malformed.
pub fn unbase64(text: &str) -> Option<Vec<u8>> {
    let value = |c: u8| -> Option<u32> {
        match c {
            b'A'..=b'Z' => Some(u32::from(c - b'A')),
            b'a'..=b'z' => Some(u32::from(c - b'a') + 26),
            b'0'..=b'9' => Some(u32::from(c - b'0') + 52),
            b'+' => Some(62),
            b'/' => Some(63),
            _ => None,
        }
    };
    let bytes = text.trim_end_matches('=').as_bytes();
    if bytes.len() % 4 == 1 || text.len() - bytes.len() > 2 {
        return None;
    }
    let mut out = Vec::with_capacity(bytes.len() * 3 / 4);
    for chunk in bytes.chunks(4) {
        let mut n = 0u32;
        for (i, &c) in chunk.iter().enumerate() {
            n |= value(c)? << (18 - 6 * i as u32);
        }
        out.push((n >> 16) as u8);
        if chunk.len() > 2 {
            out.push((n >> 8) as u8);
        }
        if chunk.len() > 3 {
            out.push(n as u8);
        }
    }
    Some(out)
}

/// Every embedded picture of an MP3 as (ID3 picture type, bytes), JPEG and PNG only.
pub(crate) fn embedded_pictures(file: &Path) -> Vec<(u8, Vec<u8>)> {
    let read = || -> Option<Vec<(u8, Vec<u8>)>> {
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
        let frames = id3::read_frames(&tag).ok()?;
        Some(
            frames
                .iter()
                .filter(|f| f.id == "APIC")
                .filter_map(|f| id3::frame_picture(f).ok())
                .filter(|(_, _, data)| mime_of(data).is_some())
                .map(|(_, kind, data)| (kind, data))
                .collect(),
        )
    };
    read().unwrap_or_default()
}

/**
 * The pictures of an album (or one song) for the Album pictures dialog: for the front cover, back cover and artist
 * photo, the picture from the first song that has one, with how many of the songs have that kind (`tracks` of
 * `total`). With no embedded front cover, a cover file in the folder is given (`from: "folder"`). Every path must be
 * inside the library.
 */
pub fn album_pictures(paths: &[String], library_root: Option<&Path>) -> Result<Value, String> {
    if paths.is_empty() || paths.len() > 500 {
        return Err("Give the songs of one album.".to_owned());
    }
    let files: Vec<PathBuf> = paths
        .iter()
        .map(|p| resolve_in_library(p, library_root))
        .collect::<Result<_, _>>()?;
    let mut out = json!({ "total": files.len() });
    // The picture files in the album folder and their sizes, so a full-size copy is not saved over a bigger one.
    if let Some(dir) = files.first().and_then(|f| f.parent()) {
        let size_of = |names: &[&str]| -> Value {
            names
                .iter()
                .flat_map(|n| ["jpg", "jpeg", "png"].map(|e| dir.join(format!("{n}.{e}"))))
                .filter_map(|p| {
                    let mut head = vec![0u8; 256 * 1024];
                    let read = std::fs::File::open(&p).ok()?.read(&mut head).ok()?;
                    crate::cover_art::image_info(&head[..read]).map(|i| (i.width, i.height))
                })
                .max_by_key(|(w, h)| (*w).min(*h))
                .map_or(Value::Null, |(w, h)| json!({ "width": w, "height": h }))
        };
        out["folder"] = json!({ "front_cover": size_of(&["cover", "folder", "front"]), "back_cover": size_of(&["back"]), "artist_photo": size_of(&["artist"]) });
    }
    for (name, kind) in [("front_cover", 3u8), ("back_cover", 4), ("artist_photo", 8)] {
        let mut first: Option<Vec<u8>> = None;
        let mut count = 0;
        for file in &files {
            // A cover stored as picture type 0 ("Other") counts as the front cover when there is no labelled one.
            let pictures = embedded_pictures(file);
            let found = pictures
                .iter()
                .find(|(k, _)| *k == kind)
                .or_else(|| {
                    (kind == 3)
                        .then(|| pictures.iter().find(|(k, _)| *k == id3::OTHER_PICTURE))
                        .flatten()
                })
                .cloned();
            if let Some((_, data)) = found {
                count += 1;
                first.get_or_insert(data);
            }
        }
        out[name] = match first {
            Some(data) => {
                json!({ "mime": mime_of(&data).unwrap_or("image/jpeg"), "data_base64": base64(&data), "from": "embedded", "tracks": count })
            }
            None if kind == 3 => match files.first().and_then(|f| folder_picture(f)) {
                Some(data) => {
                    json!({ "mime": mime_of(&data).unwrap_or("image/jpeg"), "data_base64": base64(&data), "from": "folder", "tracks": 0 })
                }
                None => Value::Null,
            },
            None => Value::Null,
        };
    }
    Ok(out)
}

/// The embedded picture of an MP3, preferring the front cover, then any other.
fn embedded_picture(file: &Path) -> Option<Vec<u8>> {
    let mut handle = std::fs::File::open(file).ok()?;
    let mut header = [0u8; 10];
    handle.read_exact(&mut header).ok()?;
    if !header.starts_with(b"ID3") {
        return None;
    }
    // The size field is four 7-bit bytes; the whole tag is that plus the 10-byte header.
    if header[6..10].iter().any(|b| b & 0x80 != 0) {
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
    let frames = id3::read_frames(&tag).ok()?;
    let mut best: Option<(u8, Vec<u8>)> = None;
    for frame in frames.iter().filter(|f| f.id == "APIC") {
        if let Ok((_, kind, data)) = id3::frame_picture(frame) {
            let rank = if kind == 3 { 0 } else { 1 };
            if mime_of(&data).is_some() && best.as_ref().is_none_or(|(r, _)| rank < *r) {
                best = Some((rank, data));
            }
        }
    }
    best.map(|(_, data)| data)
}

/// The picture file in the song's folder (`cover.jpg` and the like), with its bytes.
fn folder_picture_file(file: &Path) -> Option<(Vec<u8>, PathBuf)> {
    let dir = file.parent()?;
    for name in FOLDER_NAMES {
        let candidate = dir.join(name);
        let Ok(meta) = std::fs::metadata(&candidate) else {
            continue;
        };
        if meta.is_file()
            && meta.len() as usize <= MAX_IMAGE_BYTES
            && let Ok(bytes) = std::fs::read(&candidate)
            && mime_of(&bytes).is_some()
        {
            return Some((bytes, candidate));
        }
    }
    None
}

fn folder_picture(file: &Path) -> Option<Vec<u8>> {
    folder_picture_file(file).map(|(bytes, _)| bytes)
}

/// The cover for the track at `requested`, as `{mime, data_base64, from}`, or `null` when there is none.
/// Fails if the file is not inside `library_root`.
pub fn track_cover(requested: &str, library_root: Option<&Path>) -> Result<Value, String> {
    track_cover_cached(requested, library_root, None)
}

/// `track_cover`, remembering the picture in `cache_dir` (on this computer's disk) so a later start does not read it from the music folder again.
pub fn track_cover_cached(
    requested: &str,
    library_root: Option<&Path>,
    cache_dir: Option<&Path>,
) -> Result<Value, String> {
    let file = resolve_in_library(requested, library_root)?;
    if let Some((bytes, mime, from)) = cache_dir.and_then(|dir| cache::read(dir, &file)) {
        return Ok(json!({ "mime": mime, "data_base64": base64(&bytes), "from": from }));
    }
    let (bytes, from, picture) = match embedded_picture(&file) {
        Some(bytes) => (bytes, "embedded", None),
        None => match folder_picture_file(&file) {
            Some((bytes, picture)) => (bytes, "folder", Some(picture)),
            None => return Ok(Value::Null),
        },
    };
    if let Some(dir) = cache_dir {
        cache::write(dir, &file, &bytes, from, picture.as_deref());
    }
    let mime = mime_of(&bytes).unwrap_or("image/jpeg");
    Ok(json!({ "mime": mime, "data_base64": base64(&bytes), "from": from }))
}

/// An `artist.jpg`/`artist.png` in the song's folder or the folder above it (`Artist/Album/song.mp3` keeps the
/// photo in `Artist/`, the way Navidrome and Kodi look for it).
fn folder_artist_photo(file: &Path) -> Option<Vec<u8>> {
    let dir = file.parent()?;
    for folder in [Some(dir), dir.parent()].into_iter().flatten() {
        for name in ["artist.jpg", "artist.jpeg", "artist.png"] {
            let candidate = folder.join(name);
            let Ok(meta) = std::fs::metadata(&candidate) else {
                continue;
            };
            if meta.is_file()
                && meta.len() as usize <= MAX_IMAGE_BYTES
                && let Ok(bytes) = std::fs::read(&candidate)
                && mime_of(&bytes).is_some()
            {
                return Some(bytes);
            }
        }
    }
    None
}

/// The artist photo for the song at `requested`, as `{mime, data_base64, from}` (`from`: "embedded" for an ID3
/// "artist" picture, "folder" for an `artist.jpg`), or `null` when there is none. Fails if the file is not inside
/// `library_root`.
pub fn track_artist_photo(requested: &str, library_root: Option<&Path>) -> Result<Value, String> {
    let file = resolve_in_library(requested, library_root)?;
    let embedded = embedded_pictures(&file)
        .into_iter()
        .find(|(kind, _)| *kind == 8)
        .map(|(_, data)| data);
    let (bytes, from) = match embedded {
        Some(bytes) => (bytes, "embedded"),
        None => match folder_artist_photo(&file) {
            Some(bytes) => (bytes, "folder"),
            None => return Ok(Value::Null),
        },
    };
    let mime = mime_of(&bytes).unwrap_or("image/jpeg");
    Ok(json!({ "mime": mime, "data_base64": base64(&bytes), "from": from }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mediaverse_ripper::id3::{Picture, PictureKind, TagSet};

    #[test]
    fn songs_of_a_server_library_are_told_from_everything_else() {
        let id = "0123456789abcdef0123456789abcdef";
        assert!(is_server_song(&format!("jellyfin:{id}/{id}")));
        assert!(is_server_song(&format!("jellyfin:loose/{id}")));
        for bad in [
            "jellyfin:",
            "jellyfin:abc",
            "jellyfin:abc/",
            "jellyfin:/abc",
            "jellyfin:a/b/c",
            "jellyfin:a b/c",
            "jellyfin:..\\x/y",
            "C:\\Music\\a.mp3",
            "http://x/y",
            "Jellyfin:a/b",
        ] {
            assert!(!is_server_song(bad), "{bad}");
        }
        // They need no library folder: the server alone can be the library.
        assert!(song_allowed(&format!("jellyfin:{id}/{id}"), None).is_ok());
        assert!(song_allowed("C:\\nowhere\\a.mp3", None).is_err());
    }

    fn jpeg() -> Vec<u8> {
        let mut data = vec![0xFF, 0xD8, 0xFF, 0xE0, 0, 16];
        data.extend(std::iter::repeat_n(0x33, 300));
        data.extend_from_slice(&[0xFF, 0xD9]);
        data
    }

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mv-cover-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn base64_round_trips_and_rejects_junk() {
        for sample in [&b""[..], b"f", b"fo", b"foo", b"foob", b"\x00\xFF\x10\x80"] {
            assert_eq!(unbase64(&base64(sample)).as_deref(), Some(sample));
        }
        assert_eq!(unbase64("Zm9v!"), None);
        assert_eq!(unbase64("Z"), None);
        assert_eq!(unbase64("Zg==="), None);
    }

    #[test]
    fn base64_matches_the_standard_examples() {
        assert_eq!(base64(b""), "");
        assert_eq!(base64(b"f"), "Zg==");
        assert_eq!(base64(b"fo"), "Zm8=");
        assert_eq!(base64(b"foo"), "Zm9v");
        assert_eq!(base64(b"foobar"), "Zm9vYmFy");
    }

    #[test]
    fn a_cover_is_kept_on_disk_and_read_again_only_when_the_song_or_picture_changed() {
        let library = temp("lib-cache");
        let cache = temp("cache");
        let album = library.join("Artist").join("Album");
        std::fs::create_dir_all(&album).unwrap();
        let song = album.join("01.mp3");
        let mp3 = album.join("01.mp3");
        std::fs::write(&mp3, [0xFF, 0xFB, 0x90, 0x00]).unwrap();
        std::fs::write(album.join("cover.jpg"), jpeg()).unwrap();
        let ask =
            || track_cover_cached(song.to_str().unwrap(), Some(&library), Some(&cache)).unwrap();
        let first = ask();
        assert_eq!(first["from"], "folder");
        assert_eq!(
            std::fs::read_dir(&cache).unwrap().count(),
            1,
            "one file kept"
        );
        assert_eq!(ask(), first, "the same answer from the kept copy");
        // The folder picture is replaced: the kept copy no longer matches, so the new picture is read.
        let mut other = jpeg();
        other.push(7);
        std::fs::write(album.join("cover.jpg"), &other).unwrap();
        assert_eq!(ask()["data_base64"], base64(&other));
        // A song with no picture at all is not kept (so a picture added later is found at once).
        let bare = album.join("02.mp3");
        std::fs::remove_file(album.join("cover.jpg")).unwrap();
        std::fs::write(&bare, [0xFF, 0xFB, 0x90, 0x00]).unwrap();
        assert_eq!(
            track_cover_cached(bare.to_str().unwrap(), Some(&library), Some(&cache)).unwrap(),
            Value::Null
        );
        assert_eq!(std::fs::read_dir(&cache).unwrap().count(), 1);
    }

    #[test]
    fn the_front_cover_is_preferred_and_folder_art_is_the_fallback() {
        let library = temp("lib");
        let album = library.join("Artist").join("Album");
        std::fs::create_dir_all(&album).unwrap();
        let mut tags = TagSet {
            title: "T".into(),
            ..TagSet::default()
        };
        let artist = {
            let mut d = jpeg();
            d[10] = 0x01;
            d
        };
        tags.pictures = vec![
            Picture {
                kind: PictureKind::ArtistPhoto,
                data: artist,
            },
            Picture {
                kind: PictureKind::FrontCover,
                data: jpeg(),
            },
        ];
        let mut bytes = id3::write_tag(&tags).unwrap();
        bytes.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
        std::fs::write(album.join("01.mp3"), &bytes).unwrap();
        let found = track_cover(album.join("01.mp3").to_str().unwrap(), Some(&library)).unwrap();
        assert_eq!(found["from"], "embedded");
        assert_eq!(found["mime"], "image/jpeg");
        assert_eq!(
            found["data_base64"],
            base64(&jpeg()),
            "the front cover, not the artist photo"
        );

        // No embedded picture: the folder's cover.jpg is used; a file that is not an image is ignored.
        std::fs::write(album.join("02.mp3"), [0xFF, 0xFB, 0x90, 0x00]).unwrap();
        assert_eq!(
            track_cover(album.join("02.mp3").to_str().unwrap(), Some(&library)).unwrap(),
            Value::Null
        );
        std::fs::write(album.join("cover.jpg"), b"not an image").unwrap();
        assert_eq!(
            track_cover(album.join("02.mp3").to_str().unwrap(), Some(&library)).unwrap(),
            Value::Null
        );
        std::fs::write(album.join("cover.jpg"), jpeg()).unwrap();
        assert_eq!(
            track_cover(album.join("02.mp3").to_str().unwrap(), Some(&library)).unwrap()["from"],
            "folder"
        );
    }

    #[test]
    fn the_artist_photo_is_embedded_or_an_artist_file_in_the_song_or_artist_folder() {
        let library = temp("artistphoto");
        let album = library.join("Artist").join("Album");
        std::fs::create_dir_all(&album).unwrap();
        let photo = {
            let mut d = jpeg();
            d[10] = 0x07;
            d
        };
        let song = |name: &str, pictures: Vec<Picture>| {
            let mut bytes = id3::write_tag(&TagSet {
                title: "T".into(),
                pictures,
                ..TagSet::default()
            })
            .unwrap();
            bytes.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
            std::fs::write(album.join(name), &bytes).unwrap();
            album.join(name).to_string_lossy().into_owned()
        };
        let with = song(
            "01.mp3",
            vec![
                Picture {
                    kind: PictureKind::FrontCover,
                    data: jpeg(),
                },
                Picture {
                    kind: PictureKind::ArtistPhoto,
                    data: photo.clone(),
                },
            ],
        );
        let without = song(
            "02.mp3",
            vec![Picture {
                kind: PictureKind::FrontCover,
                data: jpeg(),
            }],
        );
        let found = track_artist_photo(&with, Some(&library)).unwrap();
        assert_eq!(
            (found["from"].clone(), found["data_base64"].clone()),
            (json!("embedded"), json!(base64(&photo)))
        );
        assert_eq!(
            track_artist_photo(&without, Some(&library)).unwrap(),
            Value::Null,
            "a cover is not an artist photo"
        );
        // An artist.jpg in the artist's folder (above the album) is found; junk named artist.jpg is not.
        std::fs::write(library.join("Artist").join("artist.jpg"), b"junk").unwrap();
        assert_eq!(
            track_artist_photo(&without, Some(&library)).unwrap(),
            Value::Null
        );
        std::fs::write(library.join("Artist").join("artist.jpg"), &photo).unwrap();
        assert_eq!(
            track_artist_photo(&without, Some(&library)).unwrap()["from"],
            "folder"
        );
        assert!(track_artist_photo(&without, None).is_err());
    }

    #[test]
    fn album_pictures_gives_each_kind_with_how_many_songs_have_it() {
        let library = temp("albumpics");
        let album = library.join("Artist").join("Album");
        std::fs::create_dir_all(&album).unwrap();
        let back = {
            let mut d = jpeg();
            d[10] = 0x02;
            d
        };
        let song = |name: &str, pictures: Vec<Picture>| {
            let mut bytes = id3::write_tag(&TagSet {
                title: "T".into(),
                pictures,
                ..TagSet::default()
            })
            .unwrap();
            bytes.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
            std::fs::write(album.join(name), &bytes).unwrap();
            album.join(name).to_string_lossy().into_owned()
        };
        let paths = vec![
            song(
                "01.mp3",
                vec![Picture {
                    kind: PictureKind::FrontCover,
                    data: jpeg(),
                }],
            ),
            song(
                "02.mp3",
                vec![
                    Picture {
                        kind: PictureKind::FrontCover,
                        data: jpeg(),
                    },
                    Picture {
                        kind: PictureKind::BackCover,
                        data: back.clone(),
                    },
                ],
            ),
            song("03.mp3", vec![]),
        ];
        let found = album_pictures(&paths, Some(&library)).unwrap();
        assert_eq!(found["total"], 3);
        assert_eq!(
            (
                found["front_cover"]["tracks"].clone(),
                found["front_cover"]["from"].clone()
            ),
            (json!(2), json!("embedded"))
        );
        assert_eq!(found["back_cover"]["data_base64"], base64(&back));
        assert_eq!(found["back_cover"]["tracks"], 1);
        assert_eq!(found["artist_photo"], Value::Null);

        // No embedded front cover anywhere: the folder's cover file is shown.
        let bare = vec![song("04.mp3", vec![])];
        assert_eq!(
            album_pictures(&bare, Some(&library)).unwrap()["front_cover"],
            Value::Null
        );
        std::fs::write(album.join("folder.jpg"), jpeg()).unwrap();
        assert_eq!(
            album_pictures(&bare, Some(&library)).unwrap()["front_cover"]["from"],
            "folder"
        );
        assert!(album_pictures(&[], Some(&library)).is_err());
    }

    #[test]
    fn files_outside_the_library_are_refused() {
        let library = temp("lib2");
        let outside = temp("out2");
        std::fs::write(outside.join("x.mp3"), [0u8; 4]).unwrap();
        assert!(
            track_cover(outside.join("x.mp3").to_str().unwrap(), Some(&library))
                .unwrap_err()
                .contains("outside")
        );
        assert!(track_cover(outside.join("x.mp3").to_str().unwrap(), None).is_err());
        assert!(
            track_cover(
                library
                    .join("..")
                    .join("out2")
                    .join("x.mp3")
                    .to_str()
                    .unwrap(),
                Some(&library)
            )
            .is_err()
        );
        assert!(track_cover("relative.mp3", Some(&library)).is_err());
    }

    #[test]
    fn a_path_from_before_the_library_moved_finds_the_same_song_in_the_library() {
        let library = temp("moved-lib");
        let album = library.join("MxPx").join("Living In The Chaos");
        std::fs::create_dir_all(&album).unwrap();
        std::fs::write(album.join("13 - Nervous Energy.mp3"), [0u8; 4]).unwrap();
        let real_file = album
            .join("13 - Nervous Energy.mp3")
            .canonicalize()
            .unwrap();
        // The old place (which does not exist here) with the same ending.
        for old in [
            r"C:\Users\Sam\Music\MxPx\Living In The Chaos\13 - Nervous Energy.mp3",
            "C:/Users/Sam/Music/MxPx/Living In The Chaos/13 - Nervous Energy.mp3",
        ] {
            assert_eq!(
                resolve_in_library(old, Some(&library)).unwrap(),
                real_file,
                "{old}"
            );
        }
        // A song the library does not have, or a path trying to climb out, is still refused.
        assert!(resolve_in_library(r"C:\Old\Nobody\Nothing\1.mp3", Some(&library)).is_err());
        assert!(resolve_in_library(r"C:\Old\..\..\Windows\win.ini", Some(&library)).is_err());
    }
}
