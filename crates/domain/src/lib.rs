use std::fmt;

#[derive(Clone, Debug, Eq, Hash, Ord, PartialEq, PartialOrd)]
pub struct TrackId(String);

impl TrackId {
    pub fn new(value: impl Into<String>) -> Result<Self, DomainError> {
        let value = value.into();
        if value.trim().is_empty() {
            return Err(DomainError::EmptyTrackId);
        }

        Ok(Self(value))
    }

    pub fn as_str(&self) -> &str {
        &self.0
    }
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub struct Track {
    album: Option<String>,
    album_artist: Option<String>,
    artist: Option<String>,
    genre: Option<String>,
    id: TrackId,
    release_year: Option<u32>,
    track_number: Option<u32>,
    title: String,
    source_uri: String,
}

impl Track {
    pub fn new(
        id: TrackId,
        title: impl Into<String>,
        source_uri: impl Into<String>,
    ) -> Result<Self, DomainError> {
        Self::with_extended_metadata(id, title, source_uri, None, None, None, None, None, None)
    }

    pub fn with_metadata(
        id: TrackId,
        title: impl Into<String>,
        source_uri: impl Into<String>,
        artist: Option<String>,
        album: Option<String>,
        genre: Option<String>,
        track_number: Option<u32>,
    ) -> Result<Self, DomainError> {
        Self::with_extended_metadata(
            id,
            title,
            source_uri,
            artist,
            album,
            None,
            None,
            genre,
            track_number,
        )
    }

    pub fn with_extended_metadata(
        id: TrackId,
        title: impl Into<String>,
        source_uri: impl Into<String>,
        artist: Option<String>,
        album: Option<String>,
        album_artist: Option<String>,
        release_year: Option<u32>,
        genre: Option<String>,
        track_number: Option<u32>,
    ) -> Result<Self, DomainError> {
        let title = title.into();
        if title.trim().is_empty() {
            return Err(DomainError::EmptyTrackTitle);
        }

        let source_uri = source_uri.into();
        if source_uri.trim().is_empty() {
            return Err(DomainError::EmptyTrackSource);
        }

        Ok(Self {
            album: Self::normalize_metadata_value(album),
            album_artist: Self::normalize_metadata_value(album_artist),
            artist: Self::normalize_metadata_value(artist),
            genre: Self::normalize_metadata_value(genre),
            id,
            release_year,
            track_number,
            title,
            source_uri,
        })
    }

    pub fn id(&self) -> &TrackId {
        &self.id
    }

    pub fn album(&self) -> Option<&str> {
        self.album.as_deref()
    }

    pub fn artist(&self) -> Option<&str> {
        self.artist.as_deref()
    }

    pub fn album_artist(&self) -> Option<&str> {
        self.album_artist.as_deref()
    }

    pub fn genre(&self) -> Option<&str> {
        self.genre.as_deref()
    }

    pub fn track_number(&self) -> Option<u32> {
        self.track_number
    }

    pub fn release_year(&self) -> Option<u32> {
        self.release_year
    }

    pub fn title(&self) -> &str {
        &self.title
    }

    fn normalize_metadata_value(value: Option<String>) -> Option<String> {
        value.and_then(|value| {
            let value = value.trim().to_owned();
            (!value.is_empty()).then_some(value)
        })
    }

    pub fn source_uri(&self) -> &str {
        &self.source_uri
    }
}

pub fn is_supported_audio_source(source_uri: &str) -> bool {
    let normalized = source_uri.trim().to_ascii_lowercase();
    [".aac", ".flac", ".m4a", ".mp3", ".ogg", ".opus", ".wav"]
        .iter()
        .any(|extension| normalized.ends_with(extension))
}

#[derive(Clone, Debug, Eq, PartialEq)]
pub enum DomainError {
    EmptyTrackId,
    EmptyTrackSource,
    EmptyTrackTitle,
}

impl fmt::Display for DomainError {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        match self {
            Self::EmptyTrackId => formatter.write_str("A track ID is required."),
            Self::EmptyTrackSource => formatter.write_str("A track source is required."),
            Self::EmptyTrackTitle => formatter.write_str("A track title is required."),
        }
    }
}

impl std::error::Error for DomainError {}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn creates_track_with_stable_identity() {
        let track = Track::with_metadata(
            TrackId::new("track-1").expect("ID should be valid"),
            "Lateralus",
            "file:///music/lateralus.flac",
            Some("Tool".to_owned()),
            Some("Lateralus".to_owned()),
            Some("Alternative Metal".to_owned()),
            Some(1),
        )
        .expect("track should be valid");

        assert_eq!(track.id().as_str(), "track-1");
        assert_eq!(track.title(), "Lateralus");
        assert_eq!(track.artist(), Some("Tool"));
        assert_eq!(track.album(), Some("Lateralus"));
        assert_eq!(track.genre(), Some("Alternative Metal"));
        assert_eq!(track.track_number(), Some(1));
    }

    #[test]
    fn preserves_album_artist_and_release_year() {
        let track = Track::with_extended_metadata(
            TrackId::new("track-1").expect("ID should be valid"),
            "Song",
            "file:///music/song.flac",
            Some("Featured performer".to_owned()),
            Some("Compilation".to_owned()),
            Some("Various Artists".to_owned()),
            Some(2024),
            None,
            Some(2),
        )
        .expect("track should be valid");

        assert_eq!(track.artist(), Some("Featured performer"));
        assert_eq!(track.album_artist(), Some("Various Artists"));
        assert_eq!(track.release_year(), Some(2024));
    }

    #[test]
    fn rejects_blank_track_fields() {
        assert_eq!(TrackId::new("  "), Err(DomainError::EmptyTrackId));
        assert_eq!(
            Track::new(
                TrackId::new("track-1").expect("ID should be valid"),
                " ",
                "file:///music/lateralus.flac"
            ),
            Err(DomainError::EmptyTrackTitle)
        );
    }

    #[test]
    fn recognizes_supported_audio_extensions_case_insensitively() {
        assert!(is_supported_audio_source("file:///music/Track.FLAC"));
        assert!(is_supported_audio_source("file:///music/Track.opus"));
        assert!(!is_supported_audio_source("file:///music/cover.jpg"));
    }
}
