//! Looking up what a CD is: disc identifiers, the data model shared by every metadata source,
//! parsers for each source's replies, user-editable settings for every service, rate limiting,
//! and the merging of answers from several sources (ADR 0006).
//!
//! Everything here is pure: no network, no clock, no files. The sidecar does the I/O.

pub mod acoustid;
pub mod cddb;
pub mod ctdb;
pub mod discid;
pub mod fit;
pub mod gnudb_submit;
pub mod merge;
pub mod musicbrainz;
pub mod rate;
pub mod settings;
pub mod streaming;

use serde::{Deserialize, Serialize};

/// The program version the AcoustID application registration currently describes
/// (https://acoustid.org/application/38031). **When the program's version number changes, update the
/// registration on that page first, then change this constant to the new version.** The test below
/// fails on a version bump until that is done, as a reminder.
pub const ACOUSTID_REGISTERED_VERSION: &str = "0.9.0";

#[cfg(test)]
mod registration {
    #[test]
    fn the_acoustid_registration_matches_the_program_version() {
        assert_eq!(
            super::ACOUSTID_REGISTERED_VERSION,
            env!("CARGO_PKG_VERSION"),
            "The program version changed. Update the AcoustID application registration at \
             https://acoustid.org/application/38031 to the new version, then set \
             ACOUSTID_REGISTERED_VERSION in crates/disc-metadata/src/lib.rs to match."
        );
    }
}

/// The disc's layout, from the table of contents. Sector numbers are LSNs (the first track of a
/// normal disc starts at 0); the lead-out is the first sector after the last track.
#[derive(Clone, Debug, Eq, PartialEq)]
pub struct DiscToc {
    pub track_starts: Vec<u32>,
    pub leadout: u32,
}

impl DiscToc {
    pub fn track_count(&self) -> usize {
        self.track_starts.len()
    }

    /// A table of contents rebuilt from the lengths of a CD's tracks as files (ADR 0009), in milliseconds and in
    /// disc order: tracks laid end to end from sector 0, 75 sectors a second. Rips do not keep the gaps
    /// between tracks or a data track, so this matches a real disc only approximately; MusicBrainz's fuzzy
    /// TOC search allows for that. None for no tracks or more than 99.
    pub fn from_track_lengths(lengths_ms: &[u64]) -> Option<Self> {
        if lengths_ms.is_empty() || lengths_ms.len() > 99 {
            return None;
        }
        let mut track_starts = Vec::with_capacity(lengths_ms.len());
        let mut at: u64 = 0;
        for length in lengths_ms {
            track_starts.push(u32::try_from(at).ok()?);
            at += (length * 75 + 500) / 1000; // to the nearest sector
        }
        Some(Self {
            track_starts,
            leadout: u32::try_from(at).ok()?,
        })
    }

    /// Length in whole seconds, as CDDB counts it.
    pub fn seconds(&self) -> u32 {
        (self.leadout + 150) / 75 - (self.track_starts.first().copied().unwrap_or(0) + 150) / 75
    }
}

/// How closely a source says its record matches the disc.
#[derive(Clone, Copy, Debug, Deserialize, Eq, Ord, PartialEq, PartialOrd, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum MatchQuality {
    /// The source matched a disc identifier it computed for this exact disc layout.
    Inexact,
    Exact,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct TrackInfo {
    pub number: u8,
    pub title: String,
    /// Set when it differs from the album artist (compilations).
    pub artist: Option<String>,
    /// How long the source says the track is, in milliseconds, when it says (MusicBrainz, Discogs, iTunes, Deezer).
    #[serde(default)]
    pub length_ms: Option<u32>,
}

/// What a source says about the particular release (edition) the disc belongs to, so the person can tell the 1998 UK
/// pressing from the 2007 remaster before ripping. Every field is optional: a source gives what it has.
#[derive(Clone, Debug, Default, Deserialize, Eq, PartialEq, Serialize)]
pub struct ReleaseInfo {
    /// "1998-03-02", "1998" or empty.
    #[serde(default)]
    pub date: String,
    #[serde(default)]
    pub country: String,
    #[serde(default)]
    pub label: String,
    #[serde(default)]
    pub catalog_number: String,
    #[serde(default)]
    pub barcode: String,
    /// "CD", "Enhanced CD" and the like.
    #[serde(default)]
    pub format: String,
    /// "Official", "Promotion", "Bootleg".
    #[serde(default)]
    pub status: String,
}

/// One source's idea of what the disc is.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct AlbumInfo {
    /// Which source said so: `musicbrainz`, or the name of a CDDB server entry.
    pub source: String,
    /// The source's own identifier (a MusicBrainz release id, or `category/discid`).
    pub source_id: String,
    pub album: String,
    pub album_artist: String,
    pub year: Option<u32>,
    pub genre: Option<String>,
    pub tracks: Vec<TrackInfo>,
    pub quality: MatchQuality,
    /// MusicBrainz release id for cover art lookups, when the source provides one.
    pub cover_art_release: Option<String>,
    /// Which disc of a multi-disc release this is (1-based), when the source says.
    #[serde(default)]
    pub disc_number: Option<u32>,
    /// How many discs the release has, when the source says.
    #[serde(default)]
    pub disc_count: Option<u32>,
    /// True for compilations and "Various Artists" albums.
    #[serde(default)]
    pub compilation: bool,
    /// Which edition this is (label, country, barcode...), when the source says.
    #[serde(default)]
    pub release: Option<ReleaseInfo>,
}

/// A failure talking to one source. Reported per source; one failing source never hides the
/// answers of the others.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct SourceError {
    pub source: String,
    pub code: String,
    pub message: String,
}
