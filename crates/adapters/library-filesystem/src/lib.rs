use mediaverse_domain::is_supported_audio_source;
use std::fmt;
use std::fs;
use std::path::{Path, PathBuf};

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscoveredTrack {
    pub source_uri: String,
    pub title: String,
}

/// Files and folders that only an operating system or an unpacked archive leaves behind: macOS "AppleDouble"
/// files (`._01 Song.mp3`, which are not audio although named like it) and `__MACOSX` folders from zip files
/// (owner, 2026-11-05: they showed up as "Unknown album" songs). Every library scan skips them.
pub fn is_system_clutter(name: &str) -> bool {
    name.starts_with("._")
        || name.eq_ignore_ascii_case("__MACOSX")
        || name.eq_ignore_ascii_case(".AppleDouble")
        || name.eq_ignore_ascii_case(".Trashes")
}

pub fn scan_music_collection(root: &Path) -> Result<Vec<DiscoveredTrack>, ScanError> {
    if !root.is_dir() {
        return Err(ScanError::NotADirectory(root.to_path_buf()));
    }

    let mut tracks = Vec::new();
    scan_directory(root, &mut tracks)?;
    tracks.sort_by(|left, right| left.source_uri.cmp(&right.source_uri));
    Ok(tracks)
}

fn scan_directory(directory: &Path, tracks: &mut Vec<DiscoveredTrack>) -> Result<(), ScanError> {
    for entry in fs::read_dir(directory).map_err(|error| ScanError::ReadDirectory {
        path: directory.to_path_buf(),
        error,
    })? {
        let entry = entry.map_err(|error| ScanError::ReadDirectory {
            path: directory.to_path_buf(),
            error,
        })?;
        let path = entry.path();
        if is_system_clutter(&entry.file_name().to_string_lossy()) {
            continue;
        }
        let file_type = entry.file_type().map_err(|error| ScanError::ReadEntry {
            path: path.clone(),
            error,
        })?;

        if file_type.is_dir() {
            scan_directory(&path, tracks)?;
        } else if file_type.is_file() && is_supported_audio_source(&path.to_string_lossy()) {
            let title = path
                .file_stem()
                .map(|stem| stem.to_string_lossy().into_owned())
                .unwrap_or_else(|| path.to_string_lossy().into_owned());
            tracks.push(DiscoveredTrack {
                source_uri: path.to_string_lossy().into_owned(),
                title,
            });
        }
    }

    Ok(())
}

#[derive(Debug)]
pub enum ScanError {
    NotADirectory(PathBuf),
    ReadDirectory {
        path: PathBuf,
        error: std::io::Error,
    },
    ReadEntry {
        path: PathBuf,
        error: std::io::Error,
    },
}

impl fmt::Display for ScanError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::NotADirectory(path) => {
                write!(formatter, "'{}' is not a directory.", path.display())
            }
            Self::ReadDirectory { path, error } => {
                write!(formatter, "Could not read '{}': {error}", path.display())
            }
            Self::ReadEntry { path, error } => {
                write!(formatter, "Could not inspect '{}': {error}", path.display())
            }
        }
    }
}

impl std::error::Error for ScanError {}

#[cfg(test)]
mod tests {
    use super::*;
    use std::time::{SystemTime, UNIX_EPOCH};

    fn temporary_directory() -> PathBuf {
        let suffix = SystemTime::now()
            .duration_since(UNIX_EPOCH)
            .expect("system clock should be after Unix epoch")
            .as_nanos();
        std::env::temp_dir().join(format!("mediaverse-library-filesystem-{suffix}"))
    }

    #[test]
    fn finds_supported_audio_files_in_nested_directories() {
        let root = temporary_directory();
        let artist = root.join("Artist");
        fs::create_dir_all(&artist).expect("test directory should be created");
        fs::write(artist.join("Track.FLAC"), []).expect("audio file should be created");
        fs::write(root.join("cover.jpg"), []).expect("non-audio file should be created");

        let tracks = scan_music_collection(&root).expect("collection should scan");

        assert_eq!(tracks.len(), 1);
        assert_eq!(tracks[0].title, "Track");
        assert!(tracks[0].source_uri.ends_with("Track.FLAC"));

        fs::remove_dir_all(root).expect("test directory should be removed");
    }

    #[test]
    fn rejects_a_missing_collection_directory() {
        let missing = temporary_directory();

        assert!(matches!(
            scan_music_collection(&missing),
            Err(ScanError::NotADirectory(_))
        ));
    }
}
