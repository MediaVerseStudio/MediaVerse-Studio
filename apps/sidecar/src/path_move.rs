//! Carrying a song's saved references with it when its file is moved or renamed (issue #9, the organiser's apply step). A song's path is written in many places:
//! the favourites, flags, history, playlists, the re-rip and instrumental lists, pins, the caches and the databases of audio checks, tag repairs, loudness and the
//! library index. When the organiser moves a file, every one of them is rewritten from the old path to the new one, so nothing is lost or orphaned, and the same
//! rewrite run backwards undoes it. Each file is copied aside first. Paths are compared the way Windows does (case and the kind of slash do not matter).

use rusqlite::{Connection, params};
use serde_json::Value;
use std::collections::HashMap;
use std::path::Path;

/// One comparable form of a path: lower case, forward slashes.
pub fn key(path: &str) -> String {
    path.replace('\\', "/").to_lowercase()
}

/// Old path to new path, for songs and for folders.
#[derive(Debug, Default, Clone)]
pub struct Rewriter {
    files: HashMap<String, String>,
    folders: HashMap<String, String>,
}

impl Rewriter {
    pub fn new(file_moves: &[(String, String)], folder_moves: &[(String, String)]) -> Self {
        Self {
            files: file_moves
                .iter()
                .map(|(from, to)| (key(from), to.clone()))
                .collect(),
            folders: folder_moves
                .iter()
                .map(|(from, to)| {
                    (
                        key(from.trim_end_matches(['\\', '/'])),
                        to.trim_end_matches(['\\', '/']).to_owned(),
                    )
                })
                .collect(),
        }
    }

    /// The same moves the other way round.
    pub fn inverse(file_moves: &[(String, String)], folder_moves: &[(String, String)]) -> Self {
        let f: Vec<(String, String)> = file_moves
            .iter()
            .map(|(a, b)| (b.clone(), a.clone()))
            .collect();
        let d: Vec<(String, String)> = folder_moves
            .iter()
            .map(|(a, b)| (b.clone(), a.clone()))
            .collect();
        Self::new(&f, &d)
    }

    pub fn is_empty(&self) -> bool {
        self.files.is_empty() && self.folders.is_empty()
    }

    /// The new text for a string that is exactly a moved song's path or a moved folder's path (with or without a trailing slash).
    pub fn map(&self, text: &str) -> Option<String> {
        let k = key(text);
        if let Some(new) = self.files.get(&k) {
            return Some(new.clone());
        }
        let bare = k.trim_end_matches('/');
        if let Some(new) = self.folders.get(bare) {
            let trailing = text.chars().last().filter(|c| matches!(c, '\\' | '/'));
            return Some(match trailing {
                Some(c) => format!("{new}{c}"),
                None => new.clone(),
            });
        }
        None
    }
}

/// Rewrites every string (and every object key) of a JSON value that is a moved path; returns how many were changed.
pub fn rewrite_json(value: &mut Value, rewriter: &Rewriter) -> usize {
    match value {
        Value::String(s) => match rewriter.map(s) {
            Some(new) => {
                *s = new;
                1
            }
            None => 0,
        },
        Value::Array(items) => items.iter_mut().map(|v| rewrite_json(v, rewriter)).sum(),
        Value::Object(map) => {
            let mut changed = 0;
            let keys: Vec<String> = map.keys().cloned().collect();
            for old in keys {
                if let Some(new) = rewriter.map(&old)
                    && let Some(v) = map.remove(&old)
                {
                    map.insert(new, v);
                    changed += 1;
                }
            }
            for v in map.values_mut() {
                changed += rewrite_json(v, rewriter);
            }
            changed
        }
        _ => 0,
    }
}

/// A text file with one path per line.
pub fn rewrite_lines(text: &str, rewriter: &Rewriter) -> (String, usize) {
    let mut changed = 0;
    let mut out = String::with_capacity(text.len());
    for (i, line) in text.split('\n').enumerate() {
        if i > 0 {
            out.push('\n');
        }
        let bare = line.trim_end_matches('\r');
        match rewriter.map(bare) {
            Some(new) => {
                changed += 1;
                out.push_str(&new);
                if line.ends_with('\r') {
                    out.push('\r');
                }
            }
            None => out.push_str(line),
        }
    }
    (out, changed)
}

fn io(error: impl std::fmt::Display) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

/// Rewrites one JSON file in place (copied aside first as `<name>.before-organize`). Returns how many references changed; a missing file is 0.
pub fn rewrite_json_file(path: &Path, rewriter: &Rewriter) -> std::io::Result<usize> {
    if !path.is_file() {
        return Ok(0);
    }
    let text = std::fs::read_to_string(path)?;
    let Ok(mut value) = serde_json::from_str::<Value>(&text) else {
        return Ok(0);
    };
    let changed = rewrite_json(&mut value, rewriter);
    if changed > 0 {
        backup(path)?;
        std::fs::write(path, serde_json::to_string(&value).map_err(io)?)?;
    }
    Ok(changed)
}

pub fn rewrite_text_file(path: &Path, rewriter: &Rewriter) -> std::io::Result<usize> {
    if !path.is_file() {
        return Ok(0);
    }
    let text = std::fs::read_to_string(path)?;
    let (out, changed) = rewrite_lines(&text, rewriter);
    if changed > 0 {
        backup(path)?;
        std::fs::write(path, out)?;
    }
    Ok(changed)
}

fn backup(path: &Path) -> std::io::Result<()> {
    let mut name = path
        .file_name()
        .map(|n| n.to_os_string())
        .unwrap_or_default();
    name.push(".before-organize");
    std::fs::copy(path, path.with_file_name(name)).map(|_| ())
}

/// Rewrites one text column of a table (`table.column`), every row whose value is a moved path. Returns how many rows changed.
pub fn rewrite_column(
    connection: &Connection,
    table: &str,
    column: &str,
    rewriter: &Rewriter,
) -> rusqlite::Result<usize> {
    // Table and column names come from this program, never from a page.
    let mut statement = connection.prepare(&format!("SELECT rowid, {column} FROM {table}"))?;
    let rows: Vec<(i64, String)> = statement
        .query_map([], |r| Ok((r.get::<_, i64>(0)?, r.get::<_, String>(1)?)))?
        .filter_map(Result::ok)
        .collect();
    drop(statement);
    let mut changed = 0;
    for (rowid, old) in rows {
        if let Some(new) = rewriter.map(&old) {
            // A row that would collide with another (the new path already has a row) is dropped: the other one is current.
            match connection.execute(
                &format!("UPDATE {table} SET {column} = ?1 WHERE rowid = ?2"),
                params![new, rowid],
            ) {
                Ok(n) => changed += n,
                Err(_) => {
                    let _ = connection.execute(
                        &format!("DELETE FROM {table} WHERE rowid = ?1"),
                        params![rowid],
                    );
                }
            }
        }
    }
    Ok(changed)
}

/// Opens a database file if it exists, waits for a busy one, and runs `work` inside one transaction.
pub fn with_database(
    path: &Path,
    work: impl FnOnce(&Connection) -> rusqlite::Result<usize>,
) -> std::io::Result<usize> {
    if !path.is_file() {
        return Ok(0);
    }
    let connection = Connection::open(path).map_err(io)?;
    connection
        .busy_timeout(std::time::Duration::from_secs(15))
        .map_err(io)?;
    connection.execute_batch("BEGIN IMMEDIATE").map_err(io)?;
    match work(&connection) {
        Ok(n) => {
            connection.execute_batch("COMMIT").map_err(io)?;
            Ok(n)
        }
        Err(error) => {
            let _ = connection.execute_batch("ROLLBACK");
            Err(io(error))
        }
    }
}

/// Everything that stores a path, rewritten. Returns (what, how many) for each store that changed.
pub fn rewrite_all(data_dir: &Path, rewriter: &Rewriter) -> Vec<(String, usize)> {
    let mut report = Vec::new();
    if rewriter.is_empty() {
        return report;
    }
    let mut note = |what: &str, result: std::io::Result<usize>| {
        if let Ok(n) = result
            && n > 0
        {
            report.push((what.to_owned(), n));
        }
    };
    for name in [
        "favorites.json",
        "flags.json",
        "history.json",
        "playlists.json",
        "rerip-flags.json",
        "lyrics-instrumental.json",
        "pins.json",
        "library-gaps-cache.json",
    ] {
        note(name, rewrite_json_file(&data_dir.join(name), rewriter));
    }
    note(
        "audio-check/results.json",
        rewrite_json_file(&data_dir.join("audio-check").join("results.json"), rewriter),
    );
    note(
        "lyrics-confirmed.txt",
        rewrite_text_file(&data_dir.join("lyrics-confirmed.txt"), rewriter),
    );
    note(
        "defect-results.sqlite",
        with_database(&data_dir.join("defect-results.sqlite"), |c| {
            rewrite_column(c, "defect_results", "path", rewriter)
        }),
    );
    note(
        "loudness.sqlite",
        with_database(&data_dir.join("loudness.sqlite"), |c| {
            Ok(rewrite_column(c, "loudness", "path", rewriter)?
                + rewrite_column(c, "loudness", "folder", rewriter)?)
        }),
    );
    note(
        "tag-repair.sqlite",
        with_database(&data_dir.join("tag-repair.sqlite"), |c| {
            Ok(rewrite_column(c, "folders", "path", rewriter)?
                + rewrite_column(c, "batch_folders", "path", rewriter)?
                + rewrite_column(c, "batch_changes", "path", rewriter)?
                + rewrite_column(c, "confirmed_values", "path", rewriter)?)
        }),
    );
    note(
        "library.sqlite",
        with_database(&data_dir.join("library.sqlite"), |c| {
            Ok(rewrite_column(c, "tracks", "source_uri", rewriter)?
                + rewrite_column(c, "file_records", "source_uri", rewriter)?)
        }),
    );
    report
}

#[cfg(test)]
mod tests {
    use super::*;
    use serde_json::json;

    fn moves() -> (Vec<(String, String)>, Vec<(String, String)>) {
        (
            vec![(
                "M:\\Music\\old\\01 One.mp3".to_owned(),
                "M:\\Music\\Band\\Record\\01 - One.mp3".to_owned(),
            )],
            vec![(
                "M:\\Music\\old".to_owned(),
                "M:\\Music\\Band\\Record".to_owned(),
            )],
        )
    }

    #[test]
    fn a_path_matches_however_its_case_and_slashes_are_written() {
        let (f, d) = moves();
        let r = Rewriter::new(&f, &d);
        assert_eq!(
            r.map("m:/music/OLD/01 one.MP3").as_deref(),
            Some("M:\\Music\\Band\\Record\\01 - One.mp3")
        );
        assert_eq!(
            r.map("M:\\Music\\old\\").as_deref(),
            Some("M:\\Music\\Band\\Record\\"),
            "a folder keeps its trailing slash"
        );
        assert_eq!(
            r.map("M:\\Music\\old").as_deref(),
            Some("M:\\Music\\Band\\Record")
        );
        assert_eq!(r.map("M:\\Music\\older\\01 One.mp3"), None);
        assert_eq!(
            r.map("a note that mentions M:\\Music\\old\\01 One.mp3 inside"),
            None,
            "only whole values are paths"
        );
    }

    #[test]
    fn json_is_rewritten_in_strings_keys_and_nested_lists() {
        let (f, d) = moves();
        let r = Rewriter::new(&f, &d);
        let mut value = json!({
            "playlists": [{ "name": "Mix", "paths": ["M:\\Music\\old\\01 One.mp3", "M:\\Music\\other.mp3"] }],
            "favorites": { "M:\\Music\\old\\01 One.mp3": { "added_at": 5 } },
            "pin": { "folder": "M:\\Music\\old" },
            "count": 3
        });
        assert_eq!(rewrite_json(&mut value, &r), 3);
        assert_eq!(
            value["playlists"][0]["paths"][0],
            "M:\\Music\\Band\\Record\\01 - One.mp3"
        );
        assert_eq!(value["playlists"][0]["paths"][1], "M:\\Music\\other.mp3");
        assert!(
            value["favorites"]
                .get("M:\\Music\\Band\\Record\\01 - One.mp3")
                .is_some()
        );
        assert_eq!(value["pin"]["folder"], "M:\\Music\\Band\\Record");
        // and back again
        let back = Rewriter::inverse(&f, &d);
        assert_eq!(rewrite_json(&mut value, &back), 3);
        assert_eq!(
            value["playlists"][0]["paths"][0],
            "M:\\Music\\old\\01 One.mp3"
        );
    }

    #[test]
    fn text_lists_keep_their_line_endings() {
        let (f, d) = moves();
        let r = Rewriter::new(&f, &d);
        let (out, n) = rewrite_lines("M:\\Music\\old\\01 One.mp3\r\nM:\\Music\\keep.mp3\r\n", &r);
        assert_eq!(n, 1);
        assert_eq!(
            out,
            "M:\\Music\\Band\\Record\\01 - One.mp3\r\nM:\\Music\\keep.mp3\r\n"
        );
    }

    #[test]
    fn database_columns_are_rewritten_and_a_colliding_row_is_dropped() {
        let (f, d) = moves();
        let r = Rewriter::new(&f, &d);
        let connection = Connection::open_in_memory().unwrap();
        connection
            .execute_batch("CREATE TABLE t (path TEXT PRIMARY KEY, n INTEGER);")
            .unwrap();
        connection.execute("INSERT INTO t VALUES ('M:\\Music\\old\\01 One.mp3', 1), ('M:\\Music\\keep.mp3', 2)", []).unwrap();
        assert_eq!(rewrite_column(&connection, "t", "path", &r).unwrap(), 1);
        let n: i64 = connection
            .query_row(
                "SELECT n FROM t WHERE path = 'M:\\Music\\Band\\Record\\01 - One.mp3'",
                [],
                |row| row.get(0),
            )
            .unwrap();
        assert_eq!(n, 1);
        // the new path already has a row (a rescan made one): the stale row goes, the current one stays
        connection
            .execute("INSERT INTO t VALUES ('M:\\Music\\old\\01 One.mp3', 9)", [])
            .unwrap();
        rewrite_column(&connection, "t", "path", &r).unwrap();
        let rows: i64 = connection
            .query_row("SELECT COUNT(*) FROM t", [], |row| row.get(0))
            .unwrap();
        assert_eq!(rows, 2);
    }

    #[test]
    fn every_store_in_a_data_folder_is_rewritten_and_the_files_are_copied_aside() {
        let dir = std::env::temp_dir().join(format!("mv-pathmove-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let (f, d) = moves();
        std::fs::write(
            dir.join("favorites.json"),
            r#"{"favorites":[{"path":"M:\\Music\\old\\01 One.mp3","added_at":1}]}"#,
        )
        .unwrap();
        std::fs::write(
            dir.join("lyrics-confirmed.txt"),
            "M:\\Music\\old\\01 One.mp3\n",
        )
        .unwrap();
        let db = Connection::open(dir.join("defect-results.sqlite")).unwrap();
        db.execute_batch("CREATE TABLE defect_results (path TEXT PRIMARY KEY, verdict TEXT); INSERT INTO defect_results VALUES ('M:\\Music\\old\\01 One.mp3', 'clean');").unwrap();
        drop(db);
        let report = rewrite_all(&dir, &Rewriter::new(&f, &d));
        let names: Vec<&str> = report.iter().map(|r| r.0.as_str()).collect();
        assert_eq!(
            names,
            vec![
                "favorites.json",
                "lyrics-confirmed.txt",
                "defect-results.sqlite"
            ]
        );
        assert!(dir.join("favorites.json.before-organize").is_file());
        assert!(
            std::fs::read_to_string(dir.join("favorites.json"))
                .unwrap()
                .contains("Band")
        );
        // the same moves backwards put everything back
        rewrite_all(&dir, &Rewriter::inverse(&f, &d));
        assert!(
            std::fs::read_to_string(dir.join("favorites.json"))
                .unwrap()
                .contains("old")
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
