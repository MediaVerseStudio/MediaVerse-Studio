//! The newest audio files in the music library (by modification time), for the home page's "New" shelf.
//! Reads only file names and times; never follows links out of the library.

use serde_json::{Value, json};
use std::path::Path;

const AUDIO: [&str; 7] = ["mp3", "flac", "wav", "m4a", "aac", "ogg", "opus"];
const MAX_DEPTH: usize = 8;
const MAX_FILES: usize = 200_000;

fn walk(dir: &Path, depth: usize, out: &mut Vec<(u64, String)>) {
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
            walk(&path, depth + 1, out);
        } else if path
            .extension()
            .and_then(|e| e.to_str())
            .is_some_and(|e| AUDIO.contains(&e.to_ascii_lowercase().as_str()))
        {
            let modified = entry
                .metadata()
                .and_then(|m| m.modified())
                .ok()
                .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
                .map_or(0, |d| d.as_secs());
            out.push((modified, path.to_string_lossy().into_owned()));
        }
    }
}

/// The newest songs from the library's own database (it keeps every file's modification time, kept up to date by the scan and the folder watcher), or
/// `None` when it cannot be read or holds nothing for this folder. Walking a network share to read 14,000 file times took 3 seconds on every Home page.
fn from_database(database: &Path, limit: usize, root: &Path) -> Option<Vec<(u64, String)>> {
    use rusqlite::{Connection, OpenFlags};
    if !database.is_file() {
        return None;
    }
    let connection = Connection::open_with_flags(
        database,
        OpenFlags::SQLITE_OPEN_READ_ONLY | OpenFlags::SQLITE_OPEN_NO_MUTEX,
    )
    .ok()?;
    let _ = connection.busy_timeout(std::time::Duration::from_millis(500));
    // The most recent few thousand are asked for, because some may belong to another folder (an old library); the folder test is done here.
    let mut statement = connection
        .prepare(
            "SELECT source_uri, modified_nanos FROM file_records WHERE version = 1 ORDER BY modified_nanos DESC, source_uri LIMIT 4000",
        )
        .ok()?;
    let rows = statement
        .query_map([], |row| {
            Ok((row.get::<_, String>(0)?, row.get::<_, i64>(1)?))
        })
        .ok()?;
    let mut found: Vec<(u64, String)> = Vec::new();
    for (path, nanos) in rows.flatten() {
        if Path::new(&path).starts_with(root) {
            found.push(((nanos.max(0) / 1_000_000_000) as u64, path));
            if found.len() >= limit {
                break;
            }
        }
    }
    (!found.is_empty()).then_some(found)
}

/// `recent_files {limit}` -> `{files: [{path, modified}]}`, newest first. Read from the library database (`database`) when it has the songs, else from the folder.
pub fn recent_files(
    limit: usize,
    library_root: Option<&Path>,
    database: Option<&Path>,
) -> Result<Value, String> {
    let root = library_root.ok_or("No music library folder is chosen.")?;
    let limit = limit.clamp(1, 500);
    let mut found = database
        .and_then(|db| from_database(db, limit, root))
        .unwrap_or_default();
    if found.is_empty() {
        walk(root, 0, &mut found);
    }
    found.sort_by(|a, b| b.0.cmp(&a.0).then_with(|| a.1.cmp(&b.1)));
    found.truncate(limit);
    Ok(
        json!({ "files": found.into_iter().map(|(modified, path)| json!({ "path": path, "modified": modified })).collect::<Vec<_>>() }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_newest_audio_files_come_first_and_other_files_are_ignored() {
        let root = std::env::temp_dir().join(format!("mv-recent-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&root);
        std::fs::create_dir_all(root.join("A").join("Old")).unwrap();
        std::fs::create_dir_all(root.join("B").join("New")).unwrap();
        let old = root.join("A").join("Old").join("1.mp3");
        let new = root.join("B").join("New").join("1.flac");
        std::fs::write(&old, b"x").unwrap();
        std::fs::write(&new, b"x").unwrap();
        std::fs::write(root.join("B").join("New").join("cover.jpg"), b"x").unwrap();
        let older = std::time::SystemTime::now() - std::time::Duration::from_secs(5000);
        std::fs::File::options()
            .write(true)
            .open(&old)
            .unwrap()
            .set_modified(older)
            .unwrap();
        let reply = recent_files(10, Some(&root), None).unwrap();
        let files = reply["files"].as_array().unwrap();
        assert_eq!(files.len(), 2, "the picture is not audio");
        assert!(files[0]["path"].as_str().unwrap().ends_with("1.flac"));
        assert!(files[1]["path"].as_str().unwrap().ends_with("1.mp3"));
        assert_eq!(
            recent_files(1, Some(&root), None).unwrap()["files"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(recent_files(5, None, None).is_err());

        // From the library database: newest first, only this folder's songs, and the folder is not walked (these paths do not exist).
        let database = root.join("library.sqlite");
        let connection = rusqlite::Connection::open(&database).unwrap();
        connection
            .execute_batch(&format!(
                "CREATE TABLE file_records (source_uri TEXT PRIMARY KEY, version INTEGER NOT NULL, modified_nanos INTEGER NOT NULL);
                 INSERT INTO file_records VALUES ('{r}/Ghost/Newest/1.mp3', 1, 3000000000000000000);
                 INSERT INTO file_records VALUES ('{r}/Ghost/Older/1.mp3', 1, 2000000000000000000);
                 INSERT INTO file_records VALUES ('{r}/Ghost/OtherVersion/1.mp3', 2, 4000000000000000000);
                 INSERT INTO file_records VALUES ('Z:/Elsewhere/1.mp3', 1, 5000000000000000000);",
                r = root.to_string_lossy().replace('\\', "/")
            ))
            .unwrap();
        drop(connection);
        let reply = recent_files(10, Some(&root), Some(&database)).unwrap();
        let files = reply["files"].as_array().unwrap();
        assert_eq!(files.len(), 2);
        assert!(files[0]["path"].as_str().unwrap().ends_with("Newest/1.mp3"));
        assert_eq!(files[0]["modified"], 3_000_000_000u64);
    }
}
