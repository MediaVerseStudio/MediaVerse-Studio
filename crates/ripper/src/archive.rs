//! The Media Library Archive (decision D3): a write-only home for FLAC masters, kept apart from the
//! Main Media Library that holds the playable MP3s. This module holds the rules; nothing here ever
//! reads the archive back into the library.
//!
//! * the archive and the library must be different folders and must not contain one another;
//! * file names are made safe for Windows (and other platforms) without losing the meaning;
//! * a file that already exists is never overwritten.

use std::fmt;
use std::io::{self, Write};
use std::path::{Component, Path, PathBuf};

#[derive(Clone, Copy, Debug, Eq, PartialEq)]
pub enum LocationError {
    NotAbsolute,
    SameFolder,
    ArchiveInsideLibrary,
    LibraryInsideArchive,
}

impl fmt::Display for LocationError {
    fn fmt(&self, f: &mut fmt::Formatter<'_>) -> fmt::Result {
        f.write_str(match self {
            Self::NotAbsolute => "Choose a full folder path for the archive.",
            Self::SameFolder => "The archive must be a different folder from your music library.",
            Self::ArchiveInsideLibrary => {
                "The archive cannot be inside your music library, or its files would show up in playback."
            }
            Self::LibraryInsideArchive => "Your music library cannot be inside the archive folder.",
        })
    }
}

impl std::error::Error for LocationError {}

/// Lexically normalised, case-folded path components: `.` removed, `..` resolved, and the
/// `\\?\` prefix ignored, so the same folder written two ways compares equal. Windows paths are
/// case-insensitive, so everything is lower-cased (this errs on the side of refusing).
fn components(path: &Path) -> Option<Vec<String>> {
    let mut parts: Vec<String> = Vec::new();
    for component in path.components() {
        match component {
            Component::Prefix(prefix) => {
                let text = prefix.as_os_str().to_string_lossy().to_lowercase();
                parts.push(text.trim_start_matches(r"\\?\").to_owned());
            }
            Component::RootDir => parts.push(String::from("\\")),
            Component::CurDir => {}
            Component::ParentDir => {
                parts.pop()?;
            }
            Component::Normal(name) => parts.push(name.to_string_lossy().to_lowercase()),
        }
    }
    Some(parts)
}

/// Checks that the archive and the Main Media Library are separate, un-nested folders.
pub fn validate_locations(library: &Path, archive: &Path) -> Result<(), LocationError> {
    if !archive.is_absolute() || !library.is_absolute() {
        return Err(LocationError::NotAbsolute);
    }
    let (Some(library), Some(archive)) = (components(library), components(archive)) else {
        return Err(LocationError::NotAbsolute);
    };
    if library == archive {
        Err(LocationError::SameFolder)
    } else if archive.starts_with(&library) {
        Err(LocationError::ArchiveInsideLibrary)
    } else if library.starts_with(&archive) {
        Err(LocationError::LibraryInsideArchive)
    } else {
        Ok(())
    }
}

const RESERVED_NAMES: [&str; 22] = [
    "con", "prn", "aux", "nul", "com1", "com2", "com3", "com4", "com5", "com6", "com7", "com8",
    "com9", "lpt1", "lpt2", "lpt3", "lpt4", "lpt5", "lpt6", "lpt7", "lpt8", "lpt9",
];
const MAX_COMPONENT_CHARS: usize = 100;

/// Makes one folder or file name safe for Windows: replaces characters it forbids, strips trailing
/// dots and spaces, avoids reserved device names, and caps the length. Never returns an empty name.
pub fn sanitize_component(name: &str, fallback: &str) -> String {
    let replaced: String = name
        .chars()
        .map(|c| match c {
            '<' | '>' | ':' | '"' | '/' | '\\' | '|' | '?' | '*' => '_',
            c if c.is_control() => '_',
            c => c,
        })
        .collect();
    let mut clean: String = replaced.trim().chars().take(MAX_COMPONENT_CHARS).collect();
    clean = clean.trim_end_matches(['.', ' ']).to_owned();
    if clean.is_empty() {
        return fallback.to_owned();
    }
    let stem = clean.split('.').next().unwrap_or("").to_lowercase();
    if RESERVED_NAMES.contains(&stem.as_str()) {
        clean.insert(0, '_');
    }
    clean
}

/// Details needed to place a track in the archive.
pub struct ArchiveTrack<'a> {
    pub album_artist: &'a str,
    pub album: &'a str,
    pub track_number: u32,
    pub title: &'a str,
}

/// `<archive>/<album artist>/<album>/NN - Title.flac`.
pub fn track_path(archive: &Path, track: &ArchiveTrack) -> PathBuf {
    track_path_with_extension(archive, track, "flac")
}

/// The same layout for any file type (the MP3 library copies use `mp3`).
pub fn track_path_with_extension(archive: &Path, track: &ArchiveTrack, extension: &str) -> PathBuf {
    let file = format!(
        "{:02} - {}.{extension}",
        track.track_number,
        sanitize_component(track.title, &format!("Track {:02}", track.track_number))
    );
    archive
        .join(sanitize_component(track.album_artist, "Unknown Artist"))
        .join(sanitize_component(track.album, "Unknown Album"))
        .join(file)
}

/// Writes `bytes` to a new file, creating parent folders. Refuses to replace an existing file
/// (`AlreadyExists`) and removes the partial file if the write fails.
pub fn write_new_file(path: &Path, bytes: &[u8]) -> io::Result<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let mut file = std::fs::OpenOptions::new()
        .write(true)
        .create_new(true)
        .open(path)?;
    let result = file.write_all(bytes).and_then(|()| file.sync_all());
    if result.is_err() {
        drop(file);
        let _ = std::fs::remove_file(path);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;

    fn check(library: &str, archive: &str) -> Result<(), LocationError> {
        validate_locations(Path::new(library), Path::new(archive))
    }

    #[test]
    #[cfg(windows)]
    fn separate_folders_are_accepted() {
        assert_eq!(check(r"C:\Music", r"D:\Archive"), Ok(()));
        assert_eq!(check(r"C:\Music", r"C:\Archive"), Ok(()));
        assert_eq!(
            check(r"C:\Music", r"C:\Music Archive"),
            Ok(()),
            "a shared name prefix is not nesting"
        );
    }

    #[test]
    #[cfg(windows)]
    fn the_same_folder_is_refused_however_it_is_written() {
        for archive in [
            r"C:\Music",
            r"c:\music",
            r"C:\Music\",
            r"C:\Music\.",
            r"C:\Other\..\Music",
            r"\\?\C:\Music",
        ] {
            assert_eq!(
                check(r"C:\Music", archive),
                Err(LocationError::SameFolder),
                "{archive}"
            );
        }
    }

    #[test]
    #[cfg(windows)]
    fn nesting_is_refused_in_both_directions() {
        assert_eq!(
            check(r"C:\Music", r"C:\Music\Archive"),
            Err(LocationError::ArchiveInsideLibrary)
        );
        assert_eq!(
            check(r"C:\Music", r"c:\MUSIC\a\b"),
            Err(LocationError::ArchiveInsideLibrary)
        );
        assert_eq!(
            check(r"C:\Archive\Music", r"C:\Archive"),
            Err(LocationError::LibraryInsideArchive)
        );
        assert_eq!(
            check(r"C:\Music", r"C:\Music\..\Music\Archive"),
            Err(LocationError::ArchiveInsideLibrary)
        );
    }

    #[test]
    #[cfg(windows)]
    fn relative_paths_are_refused() {
        assert_eq!(
            check(r"C:\Music", "archive"),
            Err(LocationError::NotAbsolute)
        );
        assert_eq!(
            check("music", r"C:\Archive"),
            Err(LocationError::NotAbsolute)
        );
    }

    #[test]
    fn names_are_made_safe_for_windows() {
        assert_eq!(sanitize_component("AC/DC", "x"), "AC_DC");
        assert_eq!(
            sanitize_component("What?: <Live> *Tour*", "x"),
            "What__ _Live_ _Tour_"
        );
        assert_eq!(
            sanitize_component("Ends with dots...  ", "x"),
            "Ends with dots"
        );
        assert_eq!(sanitize_component("  ", "Unknown"), "Unknown");
        assert_eq!(sanitize_component("...", "Unknown"), "Unknown");
        assert_eq!(sanitize_component("CON", "x"), "_CON");
        assert_eq!(sanitize_component("nul.txt", "x"), "_nul.txt");
        assert_eq!(sanitize_component("Console", "x"), "Console");
        assert_eq!(sanitize_component("tab\there", "x"), "tab_here");
        assert_eq!(
            sanitize_component(&"é".repeat(300), "x").chars().count(),
            MAX_COMPONENT_CHARS
        );
    }

    #[test]
    #[cfg(windows)]
    fn tracks_are_laid_out_by_artist_album_and_number() {
        let path = track_path(
            Path::new(r"D:\Archive"),
            &ArchiveTrack {
                album_artist: "Operation Ivy",
                album: "Energy",
                track_number: 5,
                title: "Sound System",
            },
        );
        assert_eq!(
            path,
            Path::new(r"D:\Archive")
                .join("Operation Ivy")
                .join("Energy")
                .join("05 - Sound System.flac")
        );

        let blank = track_path(
            Path::new(r"D:\Archive"),
            &ArchiveTrack {
                album_artist: "",
                album: "?",
                track_number: 12,
                title: "",
            },
        );
        assert_eq!(
            blank,
            Path::new(r"D:\Archive")
                .join("Unknown Artist")
                .join("_")
                .join("12 - Track 12.flac")
        );
    }

    #[test]
    fn existing_files_are_never_overwritten() {
        let dir = std::env::temp_dir().join(format!("mv-archive-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let path = dir.join("Artist").join("Album").join("01 - Song.flac");

        write_new_file(&path, b"first").unwrap();
        assert_eq!(std::fs::read(&path).unwrap(), b"first");

        let error = write_new_file(&path, b"second").unwrap_err();
        assert_eq!(error.kind(), io::ErrorKind::AlreadyExists);
        assert_eq!(
            std::fs::read(&path).unwrap(),
            b"first",
            "the original must be untouched"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }
}
