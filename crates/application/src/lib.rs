use mediaverse_domain::{DomainError, Track, TrackId, is_supported_audio_source};
use std::collections::BTreeMap;
use std::fmt;

pub trait LibraryRepository {
    fn list_tracks(&self) -> Result<Vec<Track>, ApplicationError>;
    fn replace_tracks(&mut self, tracks: Vec<Track>) -> Result<(), ApplicationError>;
    fn save_track(&mut self, track: Track) -> Result<(), ApplicationError>;
}

pub trait TrackIdGenerator {
    fn next_track_id(&mut self) -> Result<TrackId, ApplicationError>;
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct ImportTrack {
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub artist: Option<String>,
    pub genre: Option<String>,
    pub release_year: Option<u32>,
    pub source_uri: String,
    pub track_number: Option<u32>,
    pub title: String,
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct LibrarySnapshot {
    pub tracks: Vec<Track>,
}

pub struct LibraryService<R, G> {
    repository: R,
    id_generator: G,
}

impl<R, G> LibraryService<R, G>
where
    R: LibraryRepository,
    G: TrackIdGenerator,
{
    pub fn new(repository: R, id_generator: G) -> Self {
        Self {
            repository,
            id_generator,
        }
    }

    pub fn import_track(&mut self, command: ImportTrack) -> Result<Track, ApplicationError> {
        if !is_supported_audio_source(&command.source_uri) {
            return Err(ApplicationError::UnsupportedAudioSource(command.source_uri));
        }

        let track = Track::with_extended_metadata(
            self.id_generator.next_track_id()?,
            command.title,
            command.source_uri,
            command.artist,
            command.album,
            command.album_artist,
            command.release_year,
            command.genre,
            command.track_number,
        )
        .map_err(ApplicationError::InvalidTrack)?;

        self.repository.save_track(track.clone())?;
        Ok(track)
    }

    pub fn snapshot(&self) -> Result<LibrarySnapshot, ApplicationError> {
        let mut tracks = self.repository.list_tracks()?;
        tracks.sort_by(|left, right| left.title().cmp(right.title()));
        Ok(LibrarySnapshot { tracks })
    }

    pub fn replace_library(
        &mut self,
        imports: Vec<ImportTrack>,
    ) -> Result<LibrarySnapshot, ApplicationError> {
        let mut tracks = Vec::with_capacity(imports.len());
        // A file keeps its track ID across rescans (selections and links in the page follow the track, not the
        // moment it was read). New files get fresh IDs that no kept track already uses.
        let existing: std::collections::HashMap<String, TrackId> = self
            .repository
            .list_tracks()?
            .into_iter()
            .map(|track| (track.source_uri().to_owned(), track.id().clone()))
            .collect();
        let mut used: std::collections::HashSet<TrackId> = imports
            .iter()
            .filter_map(|import| existing.get(&import.source_uri).cloned())
            .collect();

        for import in imports {
            if !is_supported_audio_source(&import.source_uri) {
                return Err(ApplicationError::UnsupportedAudioSource(import.source_uri));
            }
            let id = match existing.get(&import.source_uri) {
                Some(id) => id.clone(),
                None => loop {
                    let candidate = self.id_generator.next_track_id()?;
                    if used.insert(candidate.clone()) {
                        break candidate;
                    }
                },
            };

            tracks.push(
                Track::with_extended_metadata(
                    id,
                    import.title,
                    import.source_uri,
                    import.artist,
                    import.album,
                    import.album_artist,
                    import.release_year,
                    import.genre,
                    import.track_number,
                )
                .map_err(ApplicationError::InvalidTrack)?,
            );
        }

        self.repository.replace_tracks(tracks)?;
        self.snapshot()
    }
}

#[derive(Default)]
pub struct InMemoryLibraryRepository {
    tracks: BTreeMap<TrackId, Track>,
}

impl LibraryRepository for InMemoryLibraryRepository {
    fn list_tracks(&self) -> Result<Vec<Track>, ApplicationError> {
        Ok(self.tracks.values().cloned().collect())
    }

    fn save_track(&mut self, track: Track) -> Result<(), ApplicationError> {
        if self.tracks.contains_key(track.id()) {
            return Err(ApplicationError::DuplicateTrackId(
                track.id().as_str().to_owned(),
            ));
        }

        self.tracks.insert(track.id().clone(), track);
        Ok(())
    }

    fn replace_tracks(&mut self, tracks: Vec<Track>) -> Result<(), ApplicationError> {
        let tracks_by_id = tracks
            .into_iter()
            .map(|track| (track.id().clone(), track))
            .collect();
        self.tracks = tracks_by_id;
        Ok(())
    }
}

#[derive(Default)]
pub struct SequentialTrackIdGenerator {
    next_id: u64,
}

impl TrackIdGenerator for SequentialTrackIdGenerator {
    fn next_track_id(&mut self) -> Result<TrackId, ApplicationError> {
        self.next_id += 1;
        TrackId::new(format!("track-{}", self.next_id)).map_err(ApplicationError::InvalidTrack)
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum ApplicationError {
    DuplicateTrackId(String),
    InvalidTrack(DomainError),
    Repository(String),
    UnsupportedAudioSource(String),
}

impl fmt::Display for ApplicationError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::DuplicateTrackId(id) => write!(formatter, "Track ID '{id}' already exists."),
            Self::InvalidTrack(error) => error.fmt(formatter),
            Self::Repository(message) => write!(formatter, "Library storage failed: {message}"),
            Self::UnsupportedAudioSource(source) => {
                write!(formatter, "Unsupported audio source: {source}")
            }
        }
    }
}

impl std::error::Error for ApplicationError {}

#[cfg(test)]
mod tests {
    use super::*;

    fn import(uri: &str, title: &str) -> ImportTrack {
        ImportTrack {
            album: None,
            album_artist: None,
            artist: None,
            genre: None,
            release_year: None,
            title: title.to_owned(),
            source_uri: uri.to_owned(),
            track_number: None,
        }
    }

    #[test]
    fn a_rescan_keeps_each_files_track_id_and_new_files_never_reuse_one() {
        // The repository already holds two tracks from an earlier session; the ID generator starts again at 1,
        // as it does after every restart, so a careless new ID would collide with a kept one.
        let mut repository = InMemoryLibraryRepository::default();
        for (id, uri) in [
            ("track-1", "file:///music/a.mp3"),
            ("track-2", "file:///music/b.mp3"),
        ] {
            repository
                .save_track(Track::new(TrackId::new(id).unwrap(), "x", uri).unwrap())
                .unwrap();
        }
        let mut service = LibraryService::new(repository, SequentialTrackIdGenerator::default());
        let snapshot = service
            .replace_library(vec![
                import("file:///music/b.mp3", "B"),
                import("file:///music/c.mp3", "C"),
                import("file:///music/a.mp3", "A"),
            ])
            .unwrap();
        let id_of = |uri: &str| {
            snapshot
                .tracks
                .iter()
                .find(|t| t.source_uri() == uri)
                .unwrap()
                .id()
                .as_str()
                .to_owned()
        };
        assert_eq!(id_of("file:///music/a.mp3"), "track-1");
        assert_eq!(id_of("file:///music/b.mp3"), "track-2");
        let new_id = id_of("file:///music/c.mp3");
        assert!(
            new_id != "track-1" && new_id != "track-2",
            "new file got {new_id}"
        );
        // A second rescan with one file gone keeps the others as they were.
        let again = service
            .replace_library(vec![
                import("file:///music/c.mp3", "C"),
                import("file:///music/a.mp3", "A"),
            ])
            .unwrap();
        assert_eq!(
            again
                .tracks
                .iter()
                .find(|t| t.source_uri() == "file:///music/c.mp3")
                .unwrap()
                .id()
                .as_str(),
            new_id
        );
    }

    #[test]
    fn imports_supported_track_and_returns_sorted_snapshot() {
        let mut service = LibraryService::new(
            InMemoryLibraryRepository::default(),
            SequentialTrackIdGenerator::default(),
        );

        service
            .import_track(ImportTrack {
                album: None,
                album_artist: None,
                artist: None,
                genre: None,
                release_year: None,
                title: "Zebra".to_owned(),
                source_uri: "file:///music/zebra.mp3".to_owned(),
                track_number: None,
            })
            .expect("MP3 should import");
        service
            .import_track(ImportTrack {
                album: None,
                album_artist: None,
                artist: None,
                genre: None,
                release_year: None,
                title: "Alpha".to_owned(),
                source_uri: "file:///music/alpha.flac".to_owned(),
                track_number: None,
            })
            .expect("FLAC should import");

        let snapshot = service.snapshot().expect("snapshot should be available");

        assert_eq!(snapshot.tracks.len(), 2);
        assert_eq!(snapshot.tracks[0].title(), "Alpha");
        assert_eq!(snapshot.tracks[1].title(), "Zebra");
    }

    #[test]
    fn rejects_unsupported_sources_without_saving_a_track() {
        let mut service = LibraryService::new(
            InMemoryLibraryRepository::default(),
            SequentialTrackIdGenerator::default(),
        );

        let error = service
            .import_track(ImportTrack {
                album: None,
                album_artist: None,
                artist: None,
                genre: None,
                release_year: None,
                title: "Artwork".to_owned(),
                source_uri: "file:///music/cover.png".to_owned(),
                track_number: None,
            })
            .expect_err("image files are not audio sources");

        assert_eq!(
            error,
            ApplicationError::UnsupportedAudioSource("file:///music/cover.png".to_owned())
        );
        assert!(
            service
                .snapshot()
                .expect("snapshot should be available")
                .tracks
                .is_empty()
        );
    }

    #[test]
    fn replaces_tracks_when_a_collection_is_rescanned() {
        let mut service = LibraryService::new(
            InMemoryLibraryRepository::default(),
            SequentialTrackIdGenerator::default(),
        );
        service
            .import_track(ImportTrack {
                album: None,
                album_artist: None,
                artist: None,
                genre: None,
                release_year: None,
                title: "Removed track".to_owned(),
                source_uri: "file:///music/removed.mp3".to_owned(),
                track_number: None,
            })
            .expect("track should import");

        let snapshot = service
            .replace_library(vec![ImportTrack {
                album: None,
                album_artist: None,
                artist: None,
                genre: None,
                release_year: None,
                title: "Current track".to_owned(),
                source_uri: "file:///music/current.flac".to_owned(),
                track_number: None,
            }])
            .expect("collection should replace");

        assert_eq!(snapshot.tracks.len(), 1);
        assert_eq!(snapshot.tracks[0].title(), "Current track");
    }

    #[test]
    fn imports_album_owner_and_release_year_separately_from_track_artist() {
        let mut service = LibraryService::new(
            InMemoryLibraryRepository::default(),
            SequentialTrackIdGenerator::default(),
        );

        let track = service
            .import_track(ImportTrack {
                album: Some("Compilation".to_owned()),
                album_artist: Some("Various Artists".to_owned()),
                artist: Some("Guest Performer".to_owned()),
                genre: None,
                release_year: Some(2024),
                source_uri: "file:///music/compilation.flac".to_owned(),
                track_number: Some(1),
                title: "Featured Song".to_owned(),
            })
            .expect("track should import");

        assert_eq!(track.artist(), Some("Guest Performer"));
        assert_eq!(track.album_artist(), Some("Various Artists"));
        assert_eq!(track.release_year(), Some(2024));
    }
}
