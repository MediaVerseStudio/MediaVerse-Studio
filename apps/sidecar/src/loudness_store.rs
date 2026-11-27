//! The loudness of every library song and the levelling gains worked out from it, kept in `<data dir>/loudness.sqlite` (issue #6). A result is trusted only
//! while the file keeps the size and modification time it had when it was measured. Gains are never stored: they are worked out from the album's songs each
//! time they are asked for (`album_level::plan_album`), so a changed setting, or one more song measured, changes them at once.

use crate::album_level::{Strength, plan_album};
use crate::defect_results::fingerprint;
use crate::loudness::Loudness;
use rusqlite::{Connection, params};
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};

pub struct LoudnessStore {
    path: PathBuf,
}

fn io(error: rusqlite::Error) -> std::io::Error {
    std::io::Error::other(error.to_string())
}

/// The folder a song is in: songs of one folder are one album (they were ripped together).
pub fn folder_of(path: &str) -> String {
    Path::new(path)
        .parent()
        .map(|p| p.to_string_lossy().into_owned())
        .unwrap_or_default()
}

impl LoudnessStore {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("loudness.sqlite"),
        }
    }

    pub fn open(&self) -> std::io::Result<Connection> {
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
                 CREATE TABLE IF NOT EXISTS loudness (
                   path TEXT PRIMARY KEY, folder TEXT NOT NULL, size INTEGER NOT NULL, modified INTEGER NOT NULL,
                   lufs REAL NOT NULL, peak REAL NOT NULL, range_lu REAL NOT NULL, loud_end REAL NOT NULL,
                   samples INTEGER NOT NULL, year INTEGER);
                 CREATE INDEX IF NOT EXISTS loudness_folder ON loudness (folder);
                 CREATE TABLE IF NOT EXISTS meta (key TEXT PRIMARY KEY, value TEXT NOT NULL);",
            )
            .map_err(io)?;
        Ok(connection)
    }

    pub fn record(
        &self,
        connection: &Connection,
        path: &str,
        loudness: &Loudness,
        year: Option<i32>,
    ) -> std::io::Result<()> {
        let Some((size, modified)) = fingerprint(Path::new(path)) else {
            return Ok(());
        };
        connection
            .execute(
                "INSERT INTO loudness (path, folder, size, modified, lufs, peak, range_lu, loud_end, samples, year)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)
                 ON CONFLICT(path) DO UPDATE SET folder = excluded.folder, size = excluded.size, modified = excluded.modified, lufs = excluded.lufs,
                   peak = excluded.peak, range_lu = excluded.range_lu, loud_end = excluded.loud_end, samples = excluded.samples, year = excluded.year",
                params![path, folder_of(path), size as i64, modified as i64, loudness.lufs, loudness.peak, loudness.range_lu, loudness.loud_end_lufs, loudness.samples as i64, year],
            )
            .map_err(io)?;
        Ok(())
    }

    /// Size and modification time of every measured song, the "same version" test.
    pub fn fingerprints(&self) -> std::io::Result<HashMap<String, (u64, u64)>> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare("SELECT path, size, modified FROM loudness")
            .map_err(io)?;
        let rows = statement
            .query_map([], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    (row.get::<_, i64>(1)? as u64, row.get::<_, i64>(2)? as u64),
                ))
            })
            .map_err(io)?;
        Ok(rows.filter_map(Result::ok).collect())
    }

    /// Forgets songs that are no longer in the library.
    pub fn forget_except(&self, keep: &HashSet<String>) -> std::io::Result<()> {
        let connection = self.open()?;
        let known: Vec<String> = {
            let mut statement = connection
                .prepare("SELECT path FROM loudness")
                .map_err(io)?;
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(io)?
                .filter_map(Result::ok)
                .collect()
        };
        for path in known.into_iter().filter(|p| !keep.contains(p)) {
            connection
                .execute("DELETE FROM loudness WHERE path = ?1", params![path])
                .map_err(io)?;
        }
        Ok(())
    }

    pub fn count(&self) -> usize {
        self.open()
            .ok()
            .and_then(|c| {
                c.query_row("SELECT COUNT(*) FROM loudness", [], |r| r.get::<_, i64>(0))
                    .ok()
            })
            .unwrap_or(0) as usize
    }

    /// "off", "gentle" or "standard" (the default).
    pub fn mode(&self) -> String {
        self.open()
            .ok()
            .and_then(|c| {
                c.query_row("SELECT value FROM meta WHERE key = 'mode'", [], |r| {
                    r.get::<_, String>(0)
                })
                .ok()
            })
            .unwrap_or_else(|| "standard".to_owned())
    }

    pub fn set_mode(&self, mode: &str) -> std::io::Result<()> {
        self.open()?.execute("INSERT INTO meta (key, value) VALUES ('mode', ?1) ON CONFLICT(key) DO UPDATE SET value = excluded.value", params![mode]).map_err(io)?;
        Ok(())
    }

    /// One album's measured songs and the plan worked out for them, or none when nothing of the folder is measured.
    fn plan_folder(
        &self,
        connection: &Connection,
        folder: &str,
        strength: Strength,
    ) -> std::io::Result<Option<(Vec<(String, Loudness)>, crate::album_level::AlbumPlan)>> {
        let mut statement = connection.prepare("SELECT path, lufs, peak, range_lu, loud_end, samples, year FROM loudness WHERE folder = ?1 ORDER BY path").map_err(io)?;
        let rows: Vec<(String, Loudness, Option<i32>)> = statement
            .query_map(params![folder], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    Loudness {
                        lufs: row.get(1)?,
                        peak: row.get(2)?,
                        gain_db: 0.0,
                        range_lu: row.get(3)?,
                        loud_end_lufs: row.get(4)?,
                        samples: row.get::<_, i64>(5)? as usize,
                    },
                    row.get::<_, Option<i32>>(6)?,
                ))
            })
            .map_err(io)?
            .filter_map(Result::ok)
            .collect();
        if rows.is_empty() {
            return Ok(None);
        }
        let mut years: Vec<i32> = rows.iter().filter_map(|r| r.2).collect();
        years.sort_unstable();
        let year = years.get(years.len() / 2).copied();
        let songs: Vec<Loudness> = rows.iter().map(|r| r.1).collect();
        let plan = plan_album(&songs, year, strength);
        Ok(Some((
            rows.into_iter().map(|(p, l, _)| (p, l)).collect(),
            plan,
        )))
    }

    /// The levelling gain in dB of each asked-for song that has been measured (the others are left out), worked out with its whole album.
    pub fn gains(&self, paths: &[String]) -> std::io::Result<HashMap<String, serde_json::Value>> {
        let strength = Strength::parse(&self.mode());
        let connection = self.open()?;
        let mut out = HashMap::new();
        let folders: HashSet<String> = paths.iter().map(|p| folder_of(p)).collect();
        for folder in folders {
            let Some((rows, plan)) = self.plan_folder(&connection, &folder, strength)? else {
                continue;
            };
            for ((path, _), gain) in rows.iter().zip(&plan.gains_db) {
                if paths.contains(path) {
                    out.insert(path.clone(), serde_json::json!({ "gain_db": gain, "album_gain_db": plan.album_gain_db, "album_lufs": plan.album_lufs, "reasons": plan.reasons }));
                }
            }
        }
        Ok(out)
    }

    /// Every measured album that would be turned up: its songs with their own gain and loudest sample, and the album's gain and loudest sample.
    pub fn boosted_albums(&self) -> std::io::Result<Vec<BoostedAlbum>> {
        let strength = Strength::parse(&self.mode());
        let connection = self.open()?;
        let folders: Vec<String> = {
            let mut statement = connection
                .prepare("SELECT DISTINCT folder FROM loudness ORDER BY folder")
                .map_err(io)?;
            statement
                .query_map([], |row| row.get::<_, String>(0))
                .map_err(io)?
                .filter_map(Result::ok)
                .collect()
        };
        let mut out = Vec::new();
        for folder in folders {
            let Some((rows, plan)) = self.plan_folder(&connection, &folder, strength)? else {
                continue;
            };
            if plan.album_gain_db <= 0.0 {
                continue;
            }
            let album_peak = rows.iter().map(|(_, l)| l.peak).fold(0.0, f64::max);
            out.push(BoostedAlbum {
                folder: folder.clone(),
                album_gain_db: plan.album_gain_db,
                album_peak,
                songs: rows
                    .iter()
                    .zip(&plan.gains_db)
                    .filter(|(_, g)| **g > 0.0)
                    .map(|((p, l), g)| (p.clone(), *g, l.peak))
                    .collect(),
            });
        }
        Ok(out)
    }

    /// Every measured song, or only those of one album folder.
    pub fn measured_paths(&self, folder: Option<&str>) -> std::io::Result<Vec<String>> {
        let connection = self.open()?;
        let mut statement = connection
            .prepare("SELECT path FROM loudness WHERE (?1 IS NULL OR folder = ?1) ORDER BY path")
            .map_err(io)?;
        let rows = statement
            .query_map(params![folder], |row| row.get::<_, String>(0))
            .map_err(io)?
            .filter_map(Result::ok)
            .collect();
        Ok(rows)
    }

    /// Notes the size and modification time a file has now as the version that was measured (after the program itself wrote its tags).
    pub fn refresh_fingerprint(&self, connection: &Connection, path: &str) {
        if let Some((size, modified)) = fingerprint(Path::new(path)) {
            let _ = connection.execute(
                "UPDATE loudness SET size = ?2, modified = ?3 WHERE path = ?1",
                params![path, size as i64, modified as i64],
            );
        }
    }

    /// The size and modification time recorded for a measured song.
    pub fn recorded(&self, connection: &Connection, path: &str) -> Option<(u64, u64)> {
        connection
            .query_row(
                "SELECT size, modified FROM loudness WHERE path = ?1",
                params![path],
                |r| Ok((r.get::<_, i64>(0)? as u64, r.get::<_, i64>(1)? as u64)),
            )
            .ok()
    }
}

/// An album that would be turned up, with what is needed to write its levelling into the files.
pub struct BoostedAlbum {
    /// The album's folder (what makes the songs one album).
    pub folder: String,
    pub album_gain_db: f64,
    pub album_peak: f64,
    /// (path, the song's gain in dB, the song's loudest sample as a number)
    pub songs: Vec<(String, f64, f64)>,
}
#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn songs_of_one_folder_are_one_album() {
        // This system's own form of a path: songs are stored with it.
        let (song, folder) = if cfg!(windows) {
            ("M:\\Band\\Record\\01 Song.mp3", "M:\\Band\\Record")
        } else {
            ("/music/Band/Record/01 Song.mp3", "/music/Band/Record")
        };
        assert_eq!(folder_of(song), folder);
        assert_eq!(folder_of("song.mp3"), "");
    }

    #[test]
    fn the_mode_is_standard_until_it_is_set() {
        let dir = std::env::temp_dir().join(format!("mv-loudness-test-{}", std::process::id()));
        let store = LoudnessStore::new(&dir);
        assert_eq!(store.mode(), "standard");
        store.set_mode("gentle").unwrap();
        assert_eq!(store.mode(), "gentle");
        assert!(
            store
                .gains(&["M:\\none\\x.mp3".to_owned()])
                .unwrap()
                .is_empty()
        );
        let _ = std::fs::remove_dir_all(dir);
    }
}
