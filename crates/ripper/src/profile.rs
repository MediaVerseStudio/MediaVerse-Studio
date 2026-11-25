//! Per-drive profiles (ADR 0004). A profile says what we know about one drive and how we know it.

use serde::{Deserialize, Serialize};

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Connection {
    Internal,
    Usb,
    Unknown,
}

/// What identifies a drive. The drive letter is deliberately not part of it.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DriveIdentity {
    pub vendor: String,
    pub model: String,
    pub revision: String,
    pub connection: Connection,
}

impl DriveIdentity {
    /// Stable key for storing and looking up profiles. Excludes the firmware revision, which marks
    /// a profile stale instead of creating a new one.
    pub fn key(&self) -> String {
        let clean = |text: &str| text.trim().to_ascii_lowercase();
        format!(
            "{}|{}|{:?}",
            clean(&self.vendor),
            clean(&self.model),
            self.connection
        )
        .to_lowercase()
    }
}

/// How a profile value was obtained. Only `Measured` may be presented as verified.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(rename_all = "snake_case")]
pub enum Provenance {
    Measured,
    /// From a database or an imported profile; not yet checked on this drive.
    Suggested,
    Manual,
}

#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct Field<T> {
    pub value: T,
    pub provenance: Provenance,
}

impl<T> Field<T> {
    pub fn measured(value: T) -> Self {
        Self {
            value,
            provenance: Provenance::Measured,
        }
    }
}

/// Result of the cache test, in sectors.
#[derive(Clone, Copy, Debug, Deserialize, Eq, PartialEq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum CacheSize {
    /// No re-read was served from a cache.
    None,
    /// Cached through `cached_through` intervening sectors, not at `uncached_at`.
    Between {
        cached_through: u32,
        uncached_at: u32,
    },
    /// Still cached at the largest size tested.
    AtLeast { sectors: u32 },
}

impl CacheSize {
    /// The largest cache size, in sectors, that this result allows.
    pub fn upper_bound(&self) -> Option<u32> {
        match self {
            Self::None => Some(0),
            Self::Between { uncached_at, .. } => Some(*uncached_at),
            Self::AtLeast { .. } => Option::None,
        }
    }
}

/// Why we believe the offset: which disc, which tracks, when.
#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct OffsetEvidence {
    pub disc: String,
    pub tracks_matched: Vec<u8>,
    pub checksum_versions: Vec<u8>,
    pub date: String,
}

#[derive(Clone, Debug, Deserialize, Eq, PartialEq, Serialize)]
pub struct DriveProfile {
    pub identity: DriveIdentity,
    /// Samples; positive means the track appears later in the drive's output.
    pub read_offset: Option<Field<i32>>,
    pub offset_evidence: Option<OffsetEvidence>,
    pub cache: Option<Field<CacheSize>>,
    pub max_transfer_sectors: Option<Field<u32>>,
    pub repeat_reads_agree: Option<bool>,
    pub app_version: String,
    pub notes: String,
}

impl DriveProfile {
    pub fn new(identity: DriveIdentity, app_version: &str) -> Self {
        Self {
            identity,
            read_offset: None,
            offset_evidence: None,
            cache: None,
            max_transfer_sectors: None,
            repeat_reads_agree: None,
            app_version: app_version.to_owned(),
            notes: String::new(),
        }
    }

    /// True when the drive now looks different from the one the profile describes (new firmware
    /// or a different connection), so stored measurements should be repeated.
    pub fn is_stale_for(&self, current: &DriveIdentity) -> bool {
        self.identity.revision.trim() != current.revision.trim()
            || self.identity.connection != current.connection
    }

    /// True only when the offset was measured against a database match on this drive.
    pub fn offset_is_verified(&self) -> bool {
        matches!(&self.read_offset, Some(field) if field.provenance == Provenance::Measured)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn identity(revision: &str, connection: Connection) -> DriveIdentity {
        DriveIdentity {
            vendor: "ASUS    ".to_owned(),
            model: "BW-16D1HT       ".to_owned(),
            revision: revision.to_owned(),
            connection,
        }
    }

    #[test]
    fn key_ignores_padding_case_and_revision_but_not_connection() {
        let a = identity("3.11", Connection::Internal);
        let mut b = identity("3.12", Connection::Internal);
        b.vendor = "asus".to_owned();
        assert_eq!(a.key(), b.key());
        assert_ne!(a.key(), identity("3.11", Connection::Usb).key());
    }

    #[test]
    fn new_firmware_or_connection_makes_a_profile_stale() {
        let profile = DriveProfile::new(identity("3.11", Connection::Internal), "0.1.0");
        assert!(!profile.is_stale_for(&identity(" 3.11", Connection::Internal)));
        assert!(profile.is_stale_for(&identity("3.12", Connection::Internal)));
        assert!(profile.is_stale_for(&identity("3.11", Connection::Usb)));
    }

    #[test]
    fn only_measured_offsets_count_as_verified() {
        let mut profile = DriveProfile::new(identity("3.11", Connection::Internal), "0.1.0");
        assert!(!profile.offset_is_verified());
        profile.read_offset = Some(Field {
            value: 6,
            provenance: Provenance::Suggested,
        });
        assert!(!profile.offset_is_verified());
        profile.read_offset = Some(Field::measured(6));
        assert!(profile.offset_is_verified());
    }

    #[test]
    fn profiles_round_trip_through_json() {
        let mut profile = DriveProfile::new(identity("3.11", Connection::Usb), "0.1.0");
        profile.read_offset = Some(Field::measured(6));
        profile.cache = Some(Field::measured(CacheSize::Between {
            cached_through: 28,
            uncached_at: 32,
        }));
        let json = serde_json::to_string(&profile).unwrap();
        assert_eq!(
            serde_json::from_str::<DriveProfile>(&json).unwrap(),
            profile
        );
    }
}
