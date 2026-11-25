//! The last defect scan result of each library file, kept in `<data dir>/defect-results.sqlite` (ADR 0008), so
//! the Review page can list tracks with audio problems without scanning again. A result is only trusted while
//! the file still has the same size and modification time it had when it was scanned. A "reviewed, it sounds
//! fine" mark belongs to that version of the file in the same way.
//!
//! Earlier versions kept a JSON file that was rewritten whole for every result; it is imported once and renamed
//! to `defect-results.json.imported`.

use mediaverse_ripper::defects::ENGINE_VERSION;
use rusqlite::{Connection, OptionalExtension, params};
use serde_json::{Value, json};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

const MAX_FINDINGS_KEPT: usize = 40;

pub struct DefectResults {
    path: PathBuf,
    legacy: PathBuf,
}

/// Size and modification time (seconds) of a file, the "same version" test for stored results.
pub fn fingerprint(file: &Path) -> Option<(u64, u64)> {
    let meta = std::fs::metadata(file).ok()?;
    let modified = meta
        .modified()
        .ok()?
        .duration_since(std::time::UNIX_EPOCH)
        .ok()?
        .as_secs();
    Some((meta.len(), modified))
}

fn io(error: rusqlite::Error) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

/// How bad a verdict is, for sorting (worst first).
fn rank(verdict: &str) -> u8 {
    match verdict {
        "suspect" => 0,
        "minor" => 1,
        _ => 2,
    }
}

/// An open store for many results in a row (the library scan): one connection, one statement.
pub struct Recorder {
    connection: Connection,
}

impl Recorder {
    pub fn record(&self, path: &str, report: &Value, now_secs: u64) -> std::io::Result<()> {
        record_with(&self.connection, path, report, now_secs)
    }
}

fn record_with(
    connection: &Connection,
    path: &str,
    report: &Value,
    now_secs: u64,
) -> std::io::Result<()> {
    let Some((size, modified)) = fingerprint(Path::new(path)) else {
        return Ok(());
    };
    let mut kept = report.clone();
    if let Some(findings) = kept["findings"].as_array_mut() {
        findings.truncate(MAX_FINDINGS_KEPT);
    }
    let verdict = kept["verdict"].as_str().unwrap_or("clean").to_owned();
    connection
        .execute(
            "INSERT INTO defect_results (path, size, modified, scanned_at, verdict, report, reviewed_good)
             VALUES (?1, ?2, ?3, ?4, ?5, ?6, 0)
             ON CONFLICT(path) DO UPDATE SET
               reviewed_good = CASE WHEN defect_results.size = excluded.size AND defect_results.modified = excluded.modified
                                    THEN defect_results.reviewed_good ELSE 0 END,
               size = excluded.size, modified = excluded.modified, scanned_at = excluded.scanned_at,
               verdict = excluded.verdict, report = excluded.report",
            params![path, size as i64, modified as i64, now_secs as i64, verdict, kept.to_string()],
        )
        .map_err(io)?;
    Ok(())
}

fn row_json(
    path: String,
    size: i64,
    modified: i64,
    scanned_at: i64,
    report: String,
    reviewed: bool,
) -> Value {
    let mut entry = json!({
        "path": path, "size": size, "modified": modified, "scanned_at": scanned_at,
        "report": serde_json::from_str::<Value>(&report).unwrap_or(Value::Null),
    });
    if reviewed {
        entry["reviewed_good"] = json!(true);
    }
    entry
}

impl DefectResults {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("defect-results.sqlite"),
            legacy: data_dir.join("defect-results.json"),
        }
    }

    fn open(&self) -> std::io::Result<Connection> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let connection = Connection::open(&self.path).map_err(io)?;
        connection
            .busy_timeout(std::time::Duration::from_secs(10))
            .map_err(io)?;
        connection
            .execute_batch(
                "PRAGMA journal_mode = WAL;
                 PRAGMA synchronous = NORMAL;
                 CREATE TABLE IF NOT EXISTS defect_results (
                   path TEXT PRIMARY KEY, size INTEGER NOT NULL, modified INTEGER NOT NULL,
                   scanned_at INTEGER NOT NULL, verdict TEXT NOT NULL, report TEXT NOT NULL,
                   reviewed_good INTEGER NOT NULL DEFAULT 0);
                 CREATE INDEX IF NOT EXISTS defect_results_verdict ON defect_results (verdict);",
            )
            .map_err(io)?;
        // Results made by an older scanner are not trusted (its rules produced many false alarms): marking them
        // as not matching their file makes the library scan do them again.
        let version: i64 = connection
            .query_row("PRAGMA user_version", [], |r| r.get(0))
            .map_err(io)?;
        if version < ENGINE_VERSION {
            connection
                .execute_batch(&format!(
                    "UPDATE defect_results SET size = -1; PRAGMA user_version = {ENGINE_VERSION};"
                ))
                .map_err(io)?;
        }
        self.import_legacy(&connection);
        Ok(connection)
    }

    /// Brings in results from the old JSON file once, then renames it so it is not read again.
    fn import_legacy(&self, connection: &Connection) {
        let Ok(bytes) = std::fs::read(&self.legacy) else {
            return;
        };
        let entries = serde_json::from_slice::<Value>(&bytes)
            .ok()
            .and_then(|v| v.as_array().cloned())
            .unwrap_or_default();
        for e in &entries {
            let (Some(path), Some(size), Some(modified)) = (
                e["path"].as_str(),
                e["size"].as_i64(),
                e["modified"].as_i64(),
            ) else {
                continue;
            };
            let report = &e["report"];
            let _ = connection.execute(
                "INSERT OR IGNORE INTO defect_results (path, size, modified, scanned_at, verdict, report, reviewed_good)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    path,
                    size,
                    modified,
                    e["scanned_at"].as_i64().unwrap_or(0),
                    report["verdict"].as_str().unwrap_or("clean"),
                    report.to_string(),
                    i64::from(e["reviewed_good"] == true)
                ],
            );
        }
        let _ = std::fs::rename(&self.legacy, self.legacy.with_extension("json.imported"));
    }

    /// Stores the scan `report` (as produced by `library_defects::report_json`) for `path`.
    pub fn record(&self, path: &str, report: &Value, now_secs: u64) -> std::io::Result<()> {
        record_with(&self.open()?, path, report, now_secs)
    }

    /// A store kept open for recording many results (one per thread of a library scan).
    pub fn recorder(&self) -> std::io::Result<Recorder> {
        Ok(Recorder {
            connection: self.open()?,
        })
    }

    /// Marks the stored result of `path` as reviewed by the person and found good (or clears the mark).
    /// The mark belongs to that version of the file: once the file changes, the result and the mark are stale.
    /// Returns false when there is no current result for `path` (nothing to mark).
    pub fn set_reviewed_good(&self, path: &str, good: bool) -> std::io::Result<bool> {
        let Some((size, modified)) = fingerprint(Path::new(path)) else {
            return Ok(false);
        };
        let changed = self
            .open()?
            .execute(
                "UPDATE defect_results SET reviewed_good = ?4 WHERE path = ?1 AND size = ?2 AND modified = ?3",
                params![path, size as i64, modified as i64, i64::from(good)],
            )
            .map_err(io)?;
        Ok(changed > 0)
    }

    /// Every result whose file is unchanged since it was scanned (checks each file; for small sets).
    pub fn current(&self) -> Vec<Value> {
        let Ok(connection) = self.open() else {
            return Vec::new();
        };
        let Ok(mut statement) = connection.prepare(
            "SELECT path, size, modified, scanned_at, report, reviewed_good FROM defect_results",
        ) else {
            return Vec::new();
        };
        let rows = statement.query_map([], |r| {
            Ok((
                r.get::<_, String>(0)?,
                r.get::<_, i64>(1)?,
                r.get::<_, i64>(2)?,
                r.get::<_, i64>(3)?,
                r.get::<_, String>(4)?,
                r.get::<_, i64>(5)? != 0,
            ))
        });
        let Ok(rows) = rows else { return Vec::new() };
        rows.flatten()
            .filter(|(path, size, modified, ..)| {
                fingerprint(Path::new(path))
                    .is_some_and(|(s, m)| s as i64 == *size && m as i64 == *modified)
            })
            .map(|(path, size, modified, scanned_at, report, reviewed)| {
                row_json(path, size, modified, scanned_at, report, reviewed)
            })
            .collect()
    }

    /// The stored fingerprint of every result, to decide which library files still need scanning.
    pub fn fingerprints(&self) -> std::io::Result<HashMap<String, (u64, u64)>> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare("SELECT path, size, modified FROM defect_results")
            .map_err(io)?;
        let rows = statement
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    (r.get::<_, i64>(1)? as u64, r.get::<_, i64>(2)? as u64),
                ))
            })
            .map_err(io)?;
        Ok(rows.flatten().collect())
    }

    /// Removes results of files that are no longer in the library.
    pub fn forget_except(&self, keep: &HashSet<String>) -> std::io::Result<usize> {
        let stored = self.fingerprints()?;
        let gone: Vec<&String> = stored.keys().filter(|p| !keep.contains(*p)).collect();
        if gone.is_empty() {
            return Ok(0);
        }
        let mut connection = self.open()?;
        let transaction = connection.transaction().map_err(io)?;
        for path in &gone {
            transaction
                .execute("DELETE FROM defect_results WHERE path = ?1", params![path])
                .map_err(io)?;
        }
        transaction.commit().map_err(io)?;
        Ok(gone.len())
    }

    /// One page of the songs worth a listen (worst first, not marked as good, file unchanged), with counts:
    /// `{total, offset, items, scanned, good}`. Only problem rows are checked against the disk, so this stays
    /// quick however many clean results there are.
    pub fn problems(&self, offset: usize, limit: usize) -> std::io::Result<Value> {
        let connection = self.open()?;
        let count = |sql: &str| -> std::io::Result<i64> {
            connection.query_row(sql, [], |r| r.get(0)).map_err(io)
        };
        let scanned = count("SELECT COUNT(*) FROM defect_results")?;
        let good = count("SELECT COUNT(*) FROM defect_results WHERE reviewed_good = 1")?;
        let mut statement = connection
            .prepare("SELECT path, size, modified, scanned_at, report, verdict FROM defect_results WHERE verdict != 'clean' AND reviewed_good = 0")
            .map_err(io)?;
        let mut rows: Vec<(u8, String, Value)> = statement
            .query_map([], |r| {
                Ok((
                    r.get::<_, String>(0)?,
                    r.get::<_, i64>(1)?,
                    r.get::<_, i64>(2)?,
                    r.get::<_, i64>(3)?,
                    r.get::<_, String>(4)?,
                    r.get::<_, String>(5)?,
                ))
            })
            .map_err(io)?
            .flatten()
            .filter(|(path, size, modified, ..)| {
                fingerprint(Path::new(path))
                    .is_some_and(|(s, m)| s as i64 == *size && m as i64 == *modified)
            })
            .map(|(path, size, modified, scanned_at, report, verdict)| {
                (
                    rank(&verdict),
                    path.clone(),
                    row_json(path, size, modified, scanned_at, report, false),
                )
            })
            .collect();
        rows.sort_by(|a, b| a.0.cmp(&b.0).then_with(|| a.1.cmp(&b.1)));
        let total = rows.len();
        let items: Vec<Value> = rows
            .into_iter()
            .skip(offset)
            .take(limit)
            .map(|(_, _, v)| v)
            .collect();
        Ok(
            json!({ "total": total, "offset": offset, "items": items, "scanned": scanned, "good": good }),
        )
    }

    /// The stored verdict of one file, if any (for tests and for single-file views).
    pub fn verdict_of(&self, path: &str) -> Option<String> {
        self.open()
            .ok()?
            .query_row(
                "SELECT verdict FROM defect_results WHERE path = ?1",
                params![path],
                |r| r.get(0),
            )
            .optional()
            .ok()
            .flatten()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp_dir(name: &str) -> PathBuf {
        let dir =
            std::env::temp_dir().join(format!("mv-defect-results-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    #[test]
    fn results_are_kept_until_the_file_changes() {
        let dir = temp_dir("keep");
        let song = dir.join("a.mp3");
        std::fs::write(&song, b"first version").unwrap();
        let store = DefectResults::new(&dir);
        let report = json!({ "verdict": "suspect", "findings": (0..100).map(|i| json!({ "kind": "click", "time_ms": i })).collect::<Vec<_>>() });
        store.record(song.to_str().unwrap(), &report, 10).unwrap();
        let current = DefectResults::new(&dir).current();
        assert_eq!(current.len(), 1);
        assert_eq!(
            current[0]["report"]["findings"].as_array().unwrap().len(),
            MAX_FINDINGS_KEPT,
            "long lists are trimmed"
        );
        // A scan of the same file again replaces the old result rather than adding a second.
        store
            .record(
                song.to_str().unwrap(),
                &json!({ "verdict": "clean", "findings": [] }),
                20,
            )
            .unwrap();
        assert_eq!(store.current().len(), 1);
        assert_eq!(store.current()[0]["report"]["verdict"], "clean");
        // Changing the file makes the stored result stale.
        std::fs::write(&song, b"second, longer version").unwrap();
        assert!(store.current().is_empty());
        // "Reviewed: sounds fine" sticks to this version of the file, survives a re-scan, and goes when it changes.
        store.record(song.to_str().unwrap(), &report, 40).unwrap();
        assert!(
            store
                .set_reviewed_good(song.to_str().unwrap(), true)
                .unwrap()
        );
        assert_eq!(store.current()[0]["reviewed_good"], true);
        store.record(song.to_str().unwrap(), &report, 50).unwrap();
        assert_eq!(
            store.current()[0]["reviewed_good"],
            true,
            "a re-scan of the unchanged file keeps the mark"
        );
        assert!(
            store
                .set_reviewed_good(song.to_str().unwrap(), false)
                .unwrap()
        );
        assert!(store.current()[0].get("reviewed_good").is_none());
        store
            .set_reviewed_good(song.to_str().unwrap(), true)
            .unwrap();
        std::fs::write(&song, b"third version, changed again").unwrap();
        assert!(
            !store
                .set_reviewed_good(song.to_str().unwrap(), true)
                .unwrap(),
            "no current result once the file changed"
        );
        store.record(song.to_str().unwrap(), &report, 60).unwrap();
        assert!(
            store.current()[0].get("reviewed_good").is_none(),
            "a changed file is not trusted as reviewed"
        );
        // A file that is not there is harmless.
        store
            .record(dir.join("missing.mp3").to_str().unwrap(), &report, 70)
            .unwrap();
        assert_eq!(store.current().len(), 1);
    }

    #[test]
    fn the_old_json_file_is_imported_once() {
        let dir = temp_dir("legacy");
        let song = dir.join("b.mp3");
        std::fs::write(&song, b"audio").unwrap();
        let (size, modified) = fingerprint(&song).unwrap();
        let old = json!([{ "path": song.to_str().unwrap(), "size": size, "modified": modified, "scanned_at": 5, "reviewed_good": true, "report": { "verdict": "minor", "findings": [] } }]);
        std::fs::write(dir.join("defect-results.json"), old.to_string()).unwrap();
        let store = DefectResults::new(&dir);
        let current = store.current();
        assert_eq!(current.len(), 1);
        assert_eq!(current[0]["reviewed_good"], true);
        assert!(
            !dir.join("defect-results.json").exists()
                && dir.join("defect-results.json.imported").exists()
        );
        // A damaged old file is simply set aside.
        std::fs::write(dir.join("defect-results.json"), b"junk").unwrap();
        assert_eq!(DefectResults::new(&dir).current().len(), 1);
    }

    #[test]
    fn problems_come_a_page_at_a_time_worst_first_and_marked_songs_are_left_out() {
        let dir = temp_dir("pages");
        let store = DefectResults::new(&dir);
        let recorder = store.recorder().unwrap();
        let mut paths = Vec::new();
        for i in 0..30 {
            let song = dir.join(format!("{i:02}.mp3"));
            std::fs::write(&song, format!("song {i}")).unwrap();
            let verdict = if i % 10 == 0 {
                "suspect"
            } else if i % 3 == 0 {
                "minor"
            } else {
                "clean"
            };
            recorder
                .record(
                    song.to_str().unwrap(),
                    &json!({ "verdict": verdict, "findings": [] }),
                    1,
                )
                .unwrap();
            paths.push(song);
        }
        // 3 suspect (0, 10, 20) and 7 minor (3, 6, 9, 12, 15, 18, 21, 24, 27 minus the suspects' multiples of 10).
        let first = store.problems(0, 4).unwrap();
        assert_eq!(first["scanned"], 30);
        let total = first["total"].as_u64().unwrap();
        assert_eq!(total, 3 + 9);
        let verdicts: Vec<&str> = first["items"]
            .as_array()
            .unwrap()
            .iter()
            .map(|i| i["report"]["verdict"].as_str().unwrap())
            .collect();
        assert_eq!(verdicts, ["suspect", "suspect", "suspect", "minor"]);
        assert_eq!(
            store.problems(8, 4).unwrap()["items"]
                .as_array()
                .unwrap()
                .len(),
            4
        );
        assert!(
            store
                .set_reviewed_good(paths[0].to_str().unwrap(), true)
                .unwrap()
        );
        let after = store.problems(0, 100).unwrap();
        assert_eq!(after["total"].as_u64().unwrap(), total - 1);
        assert_eq!(after["good"], 1);
        // Results of files that left the library can be removed.
        let keep: HashSet<String> = paths
            .iter()
            .take(10)
            .map(|p| p.to_string_lossy().into_owned())
            .collect();
        assert_eq!(store.forget_except(&keep).unwrap(), 20);
        assert_eq!(store.problems(0, 100).unwrap()["scanned"], 10);
    }
}
