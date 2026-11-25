//! Tag repair (ADR 0009): recognise an album folder from its files and propose the tags it is missing.
//!
//! The steps, each in its own module: [`names`] reads what placeholders, file names and folder names say;
//! [`musicbrainz`] reads MusicBrainz's releases with their track lengths, editions and genres; [`matcher`] lines a
//! folder's files up against each release, scores the fit with the evidence written out, and proposes values
//! for the fields that are empty or hold a placeholder, never changing a real value.

pub mod discogs;
pub mod judge;
pub mod matcher;
pub mod musicbrainz;
pub mod names;

pub use matcher::{
    Change, Evidence, EvidenceKind, Field, FileProposal, Folder, FolderFile, Proposal, Tags,
    match_release, rank,
};
pub use musicbrainz::{Release, parse_releases};
pub use names::is_placeholder;
