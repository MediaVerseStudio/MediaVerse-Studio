use mediaverse_application::{ApplicationError, LibraryRepository};
use mediaverse_domain::{Track, TrackId};
use rusqlite::{Connection, OptionalExtension, params};
use std::path::Path;

pub struct SqliteLibraryRepository {
    connection: Connection,
}

/// What a library file looked like when its tags were last read: its size and modification time (to tell
/// whether it changed since), and what the read found beyond the tags kept in `tracks`. Kept so that starting
/// the program does not read every file's tags again (ADR 0008).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FileRecord {
    pub source_uri: String,
    pub size: u64,
    pub modified_nanos: u128,
    pub length_ms: Option<u64>,
    pub bitrate_kbps: Option<u32>,
    pub disc_number: Option<u32>,
    pub created_secs: Option<u64>,
    pub read_ok: bool,
    pub title_from_file_name: bool,
}

impl SqliteLibraryRepository {
    pub fn open(path: &Path) -> Result<Self, ApplicationError> {
        let connection = Connection::open(path)
            .map_err(|error| ApplicationError::Repository(error.to_string()))?;
        initialize_schema(&connection)?;

        Ok(Self { connection })
    }

    pub fn collection_root(&self) -> Result<Option<String>, ApplicationError> {
        self.connection
            .query_row(
                "SELECT value FROM settings WHERE key = 'collection_root'",
                [],
                |row| row.get(0),
            )
            .optional()
            .map_err(|error| ApplicationError::Repository(error.to_string()))
    }

    pub fn set_collection_root(&self, root: &str) -> Result<(), ApplicationError> {
        self.connection
            .execute(
                "INSERT INTO settings (key, value) VALUES ('collection_root', ?1)
                 ON CONFLICT(key) DO UPDATE SET value = excluded.value",
                params![root],
            )
            .map_err(|error| ApplicationError::Repository(error.to_string()))?;
        Ok(())
    }

    /// What every library file looked like when its tags were last read by reader `version` (rows written by
    /// another version of the tag reading are left out, so those files are read again).
    pub fn file_records(&self, version: u32) -> Result<Vec<FileRecord>, ApplicationError> {
        let repo = |error: rusqlite::Error| ApplicationError::Repository(error.to_string());
        let mut statement = self
            .connection
            .prepare(
                "SELECT source_uri, size, modified_nanos, length_ms, bitrate_kbps, disc_number, created_secs, read_ok, title_from_file_name
                 FROM file_records WHERE version = ?1",
            )
            .map_err(repo)?;
        let rows = statement
            .query_map(params![version], |row| {
                Ok(FileRecord {
                    source_uri: row.get(0)?,
                    size: row.get::<_, i64>(1)? as u64,
                    modified_nanos: row.get::<_, i64>(2)? as u128,
                    length_ms: row.get::<_, Option<i64>>(3)?.map(|v| v as u64),
                    bitrate_kbps: row.get(4)?,
                    disc_number: row.get(5)?,
                    created_secs: row.get::<_, Option<i64>>(6)?.map(|v| v as u64),
                    read_ok: row.get(7)?,
                    title_from_file_name: row.get(8)?,
                })
            })
            .map_err(repo)?;
        rows.collect::<Result<Vec<_>, _>>().map_err(repo)
    }

    /// Forgets every file record (a different library folder was chosen).
    pub fn clear_file_records(&self) -> Result<(), ApplicationError> {
        self.connection
            .execute("DELETE FROM file_records", [])
            .map_err(|error| ApplicationError::Repository(error.to_string()))?;
        Ok(())
    }

    /// Stores `changed` (new or re-read files) and drops the records of `removed` files, in one transaction.
    pub fn update_file_records(
        &mut self,
        version: u32,
        changed: &[FileRecord],
        removed: &[String],
    ) -> Result<(), ApplicationError> {
        let repo = |error: rusqlite::Error| ApplicationError::Repository(error.to_string());
        if changed.is_empty() && removed.is_empty() {
            return Ok(());
        }
        let transaction = self.connection.transaction().map_err(repo)?;
        {
            let mut delete = transaction
                .prepare_cached("DELETE FROM file_records WHERE source_uri = ?1")
                .map_err(repo)?;
            for source_uri in removed {
                delete.execute(params![source_uri]).map_err(repo)?;
            }
            let mut write = transaction
                .prepare_cached(
                    "INSERT OR REPLACE INTO file_records (
                        source_uri, version, size, modified_nanos, length_ms, bitrate_kbps, disc_number, created_secs, read_ok, title_from_file_name
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10)",
                )
                .map_err(repo)?;
            for record in changed {
                write
                    .execute(params![
                        record.source_uri,
                        version,
                        record.size as i64,
                        // Nanoseconds since 1970 fit 64 bits until the year 2262.
                        i64::try_from(record.modified_nanos).unwrap_or(i64::MAX),
                        record.length_ms.map(|v| v as i64),
                        record.bitrate_kbps,
                        record.disc_number,
                        record.created_secs.map(|v| v as i64),
                        record.read_ok,
                        record.title_from_file_name,
                    ])
                    .map_err(repo)?;
            }
        }
        transaction.commit().map_err(repo)
    }

    fn save(&self, track: &Track) -> Result<(), ApplicationError> {
        self.connection
            .execute(
                "INSERT INTO tracks (
                    id, source_uri, title, artist, album, album_artist, release_year, genre, track_number
                 ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    track.id().as_str(),
                    track.source_uri(),
                    track.title(),
                    track.artist(),
                    track.album(),
                    track.album_artist(),
                    track.release_year(),
                    track.genre(),
                    track.track_number(),
                ],
            )
            .map_err(|error| ApplicationError::Repository(error.to_string()))?;
        Ok(())
    }
}

fn initialize_schema(connection: &Connection) -> Result<(), ApplicationError> {
    connection
        .execute_batch(
            "
                PRAGMA foreign_keys = ON;
                CREATE TABLE IF NOT EXISTS tracks (
                    id TEXT PRIMARY KEY NOT NULL,
                    source_uri TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL,
                    artist TEXT,
                    album TEXT,
                    genre TEXT,
                    track_number INTEGER
                );
                CREATE TABLE IF NOT EXISTS settings (
                    key TEXT PRIMARY KEY NOT NULL,
                    value TEXT NOT NULL
                );
                CREATE TABLE IF NOT EXISTS file_records (
                    source_uri TEXT PRIMARY KEY NOT NULL,
                    version INTEGER NOT NULL,
                    size INTEGER NOT NULL,
                    modified_nanos INTEGER NOT NULL,
                    length_ms INTEGER,
                    bitrate_kbps INTEGER,
                    disc_number INTEGER,
                    created_secs INTEGER,
                    read_ok INTEGER NOT NULL,
                    title_from_file_name INTEGER NOT NULL
                );
                ",
        )
        .map_err(|error| ApplicationError::Repository(error.to_string()))?;
    migrate_tracks_schema(connection)
}

impl LibraryRepository for SqliteLibraryRepository {
    fn list_tracks(&self) -> Result<Vec<Track>, ApplicationError> {
        let mut statement = self
            .connection
            .prepare(
                "SELECT id, source_uri, title, artist, album, album_artist, release_year, genre, track_number
                 FROM tracks",
            )
            .map_err(|error| ApplicationError::Repository(error.to_string()))?;
        let rows = statement
            .query_map([], |row| {
                let id: String = row.get(0)?;
                let source_uri: String = row.get(1)?;
                let title: String = row.get(2)?;
                let artist: Option<String> = row.get(3)?;
                let album: Option<String> = row.get(4)?;
                let album_artist: Option<String> = row.get(5)?;
                let release_year: Option<u32> = row.get(6)?;
                let genre: Option<String> = row.get(7)?;
                let track_number: Option<u32> = row.get(8)?;
                Ok((
                    id,
                    source_uri,
                    title,
                    artist,
                    album,
                    album_artist,
                    release_year,
                    genre,
                    track_number,
                ))
            })
            .map_err(|error| ApplicationError::Repository(error.to_string()))?;

        rows.map(|row| {
            let (
                id,
                source_uri,
                title,
                artist,
                album,
                album_artist,
                release_year,
                genre,
                track_number,
            ) = row.map_err(|error| ApplicationError::Repository(error.to_string()))?;
            Track::with_extended_metadata(
                TrackId::new(id).map_err(ApplicationError::InvalidTrack)?,
                title,
                source_uri,
                artist,
                album,
                album_artist,
                release_year,
                genre,
                track_number,
            )
            .map_err(ApplicationError::InvalidTrack)
        })
        .collect()
    }

    fn save_track(&mut self, track: Track) -> Result<(), ApplicationError> {
        self.save(&track)
    }

    /// Makes the stored library equal to `tracks`, writing only the difference: rows that are gone are
    /// deleted, and only new or changed rows are written (ADR 0008: rewriting 100,000 rows for one changed
    /// song was most of the time a folder change took). All in one transaction.
    fn replace_tracks(&mut self, tracks: Vec<Track>) -> Result<(), ApplicationError> {
        let repo = |error: rusqlite::Error| ApplicationError::Repository(error.to_string());
        let existing: std::collections::HashMap<String, Track> = self
            .list_tracks()?
            .into_iter()
            .map(|track| (track.id().as_str().to_owned(), track))
            .collect();
        let keep: std::collections::HashSet<&str> =
            tracks.iter().map(|track| track.id().as_str()).collect();
        let transaction = self.connection.transaction().map_err(repo)?;
        {
            let mut delete = transaction
                .prepare_cached("DELETE FROM tracks WHERE id = ?1")
                .map_err(repo)?;
            for id in existing.keys().filter(|id| !keep.contains(id.as_str())) {
                delete.execute(params![id]).map_err(repo)?;
            }
            // OR REPLACE also clears a row that holds the same file under another ID, so the unique path stays unique.
            let mut write = transaction
                .prepare_cached(
                    "INSERT OR REPLACE INTO tracks (
                        id, source_uri, title, artist, album, album_artist, release_year, genre, track_number
                     ) VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                )
                .map_err(repo)?;
            for track in tracks
                .iter()
                .filter(|track| existing.get(track.id().as_str()) != Some(*track))
            {
                write
                    .execute(params![
                        track.id().as_str(),
                        track.source_uri(),
                        track.title(),
                        track.artist(),
                        track.album(),
                        track.album_artist(),
                        track.release_year(),
                        track.genre(),
                        track.track_number(),
                    ])
                    .map_err(repo)?;
            }
        }
        transaction.commit().map_err(repo)?;
        Ok(())
    }
}

fn migrate_tracks_schema(connection: &Connection) -> Result<(), ApplicationError> {
    let columns = connection
        .prepare("PRAGMA table_info(tracks)")
        .and_then(|mut statement| {
            statement
                .query_map([], |row| row.get::<_, String>(1))?
                .collect::<Result<Vec<_>, _>>()
        })
        .map_err(|error| ApplicationError::Repository(error.to_string()))?;

    for (column, definition) in [("album_artist", "TEXT"), ("release_year", "INTEGER")] {
        if !columns.iter().any(|existing| existing == column) {
            connection
                .execute(
                    &format!("ALTER TABLE tracks ADD COLUMN {column} {definition}"),
                    [],
                )
                .map_err(|error| ApplicationError::Repository(error.to_string()))?;
        }
    }

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn migrates_existing_track_tables_with_album_artist_and_release_year() {
        let connection = Connection::open_in_memory().expect("in-memory database should open");
        connection
            .execute_batch(
                "
                CREATE TABLE tracks (
                    id TEXT PRIMARY KEY NOT NULL,
                    source_uri TEXT NOT NULL UNIQUE,
                    title TEXT NOT NULL,
                    artist TEXT,
                    album TEXT,
                    genre TEXT,
                    track_number INTEGER
                );
                ",
            )
            .expect("legacy tracks table should be created");

        initialize_schema(&connection).expect("schema should migrate");
        let columns = connection
            .prepare("PRAGMA table_info(tracks)")
            .expect("table info query should prepare")
            .query_map([], |row| row.get::<_, String>(1))
            .expect("table info query should execute")
            .collect::<Result<Vec<_>, _>>()
            .expect("table info rows should read");

        assert!(columns.contains(&"album_artist".to_owned()));
        assert!(columns.contains(&"release_year".to_owned()));
    }

    fn track(id: &str, uri: &str, title: &str) -> Track {
        Track::with_extended_metadata(
            TrackId::new(id).unwrap(),
            title,
            uri,
            Some("Band".to_owned()),
            Some("Album".to_owned()),
            None,
            Some(2001),
            None,
            Some(1),
        )
        .unwrap()
    }

    #[test]
    fn file_records_come_back_as_stored_and_only_for_the_same_reader_version() {
        let dir =
            std::env::temp_dir().join(format!("mv-persistence-records-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut repository = SqliteLibraryRepository::open(&dir.join("library.sqlite")).unwrap();
        let record = |uri: &str, size: u64| FileRecord {
            source_uri: uri.to_owned(),
            size,
            modified_nanos: 1_762_000_000_123_456_700,
            length_ms: Some(215_000),
            bitrate_kbps: Some(245),
            disc_number: None,
            created_secs: Some(1_700_000_000),
            read_ok: true,
            title_from_file_name: false,
        };
        repository
            .update_file_records(1, &[record("a.mp3", 10), record("b.mp3", 20)], &[])
            .unwrap();
        let mut stored = repository.file_records(1).unwrap();
        stored.sort_by(|a, b| a.source_uri.cmp(&b.source_uri));
        assert_eq!(stored, [record("a.mp3", 10), record("b.mp3", 20)]);
        // One file changed, one left the library.
        repository
            .update_file_records(1, &[record("a.mp3", 11)], &["b.mp3".to_owned()])
            .unwrap();
        assert_eq!(repository.file_records(1).unwrap(), [record("a.mp3", 11)]);
        // A program whose tag reading changed sees none of the old records.
        assert!(repository.file_records(2).unwrap().is_empty());
        drop(repository);
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn replacing_the_library_writes_only_the_difference() {
        let dir = std::env::temp_dir().join(format!("mv-persistence-diff-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        std::fs::create_dir_all(&dir).unwrap();
        let mut repository = SqliteLibraryRepository::open(&dir.join("library.sqlite")).unwrap();
        repository
            .replace_tracks(vec![
                track("track-1", "file:///a.mp3", "A"),
                track("track-2", "file:///b.mp3", "B"),
                track("track-3", "file:///c.mp3", "C"),
            ])
            .unwrap();
        // Count the rows SQLite actually changes from here on.
        let changes = |repo: &SqliteLibraryRepository| {
            repo.connection
                .query_row("SELECT total_changes()", [], |r| r.get::<_, i64>(0))
                .unwrap()
        };
        let before = changes(&repository);
        // One title changed, one track removed, one unchanged, and a file listed again under a new ID.
        repository
            .replace_tracks(vec![
                track("track-1", "file:///a.mp3", "A"),
                track("track-2", "file:///b.mp3", "B (remastered)"),
                track("track-9", "file:///c.mp3", "C"),
            ])
            .unwrap();
        let mut stored = repository.list_tracks().unwrap();
        stored.sort_by(|a, b| a.source_uri().cmp(b.source_uri()));
        let summary: Vec<(String, String)> = stored
            .iter()
            .map(|t| (t.id().as_str().to_owned(), t.title().to_owned()))
            .collect();
        assert_eq!(
            summary,
            [
                ("track-1".to_owned(), "A".to_owned()),
                ("track-2".to_owned(), "B (remastered)".to_owned()),
                ("track-9".to_owned(), "C".to_owned())
            ]
        );
        assert!(
            changes(&repository) - before <= 3,
            "only the changed rows were written"
        );
        // Nothing changed: nothing is written.
        let settled = changes(&repository);
        repository.replace_tracks(stored).unwrap();
        assert_eq!(changes(&repository), settled);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
