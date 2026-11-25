//! How well an album's track lengths agree with the disc in the drive. A source that lists lengths (MusicBrainz, Discogs,
//! iTunes, Deezer) lets a name match that is not this exact disc be checked against the disc itself: the same album
//! has the same song lengths, give or take a second or two between pressings. Pure arithmetic; the sidecar attaches the
//! result to each candidate.

use crate::TrackInfo;
use serde::Serialize;

/// Two pressings of one album differ by a moment at most (different pregap or fade); beyond this the length disagrees.
pub const TOLERANCE_MS: u32 = 3_000;
const SECTORS_PER_SECOND: u64 = 75;

/// The tracks of a disc compared with an album's listed lengths.
#[derive(Clone, Copy, Debug, Eq, PartialEq, Serialize)]
pub struct LengthFit {
    /// Tracks the album gives a length for, and the disc has.
    pub compared: usize,
    /// Tracks on the disc.
    pub total: usize,
    /// Of those compared, how many agree within [`TOLERANCE_MS`].
    pub within: usize,
    /// The biggest difference found, in milliseconds.
    pub worst_ms: u32,
}

impl LengthFit {
    /// Nearly every track has a length to compare and all of them agree: for practical purposes the same album, so the
    /// "these details match my disc" check can start ticked. At least four tracks, so a short disc is never "certain".
    pub fn strong(&self) -> bool {
        self.compared >= 4 && self.within == self.compared && self.compared * 10 >= self.total * 9
    }

    /// Several tracks disagree: probably another album or edition.
    pub fn weak(&self) -> bool {
        self.compared > 0 && self.within * 2 < self.compared
    }
}

/// Each audio track's length in milliseconds from the disc's table of contents (start sectors and the lead-out).
pub fn disc_lengths_ms(track_starts: &[u32], leadout: u32) -> Vec<u32> {
    (0..track_starts.len())
        .map(|i| {
            let end = track_starts.get(i + 1).copied().unwrap_or(leadout);
            let sectors = u64::from(end.saturating_sub(track_starts[i]));
            u32::try_from(sectors * 1000 / SECTORS_PER_SECOND).unwrap_or(u32::MAX)
        })
        .collect()
}

/// Compares the disc's lengths with an album's. `None` when the album has a different number of tracks or lists lengths
/// for fewer than half of them (a source that gives none says nothing about the fit).
pub fn length_fit(disc_ms: &[u32], tracks: &[TrackInfo]) -> Option<LengthFit> {
    if tracks.len() != disc_ms.len() || disc_ms.is_empty() {
        return None;
    }
    let listed: Vec<(u32, u32)> = tracks
        .iter()
        .zip(disc_ms)
        .filter_map(|(t, disc)| Some((t.length_ms?, *disc)))
        .collect();
    if listed.len() * 2 < tracks.len() {
        return None;
    }
    let differences: Vec<u32> = listed
        .iter()
        .map(|(album, disc)| album.abs_diff(*disc))
        .collect();
    Some(LengthFit {
        compared: listed.len(),
        total: tracks.len(),
        within: differences.iter().filter(|d| **d <= TOLERANCE_MS).count(),
        worst_ms: differences.iter().copied().max().unwrap_or(0),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn track(n: u8, length_ms: Option<u32>) -> TrackInfo {
        TrackInfo {
            number: n,
            title: format!("T{n}"),
            artist: None,
            length_ms,
        }
    }

    #[test]
    fn disc_lengths_come_from_the_sector_numbers() {
        // 75 sectors a second: 0 to 15000 is 200 s; the last track runs to the lead-out.
        assert_eq!(
            disc_lengths_ms(&[0, 15_000, 30_075], 45_075),
            vec![200_000, 201_000, 200_000]
        );
        assert!(disc_lengths_ms(&[], 10).is_empty());
    }

    #[test]
    fn the_same_album_fits_strongly_even_with_small_differences() {
        let disc = [200_000, 180_000, 240_000, 210_000, 190_000];
        let album: Vec<TrackInfo> = [201_500, 179_000, 240_000, 212_000, 190_500]
            .iter()
            .enumerate()
            .map(|(i, ms)| track(i as u8 + 1, Some(*ms)))
            .collect();
        let fit = length_fit(&disc, &album).unwrap();
        assert_eq!((fit.compared, fit.within, fit.worst_ms), (5, 5, 2_000));
        assert!(fit.strong() && !fit.weak());
    }

    #[test]
    fn another_album_with_the_same_track_count_does_not_fit() {
        let disc = [200_000, 180_000, 240_000, 210_000];
        let album: Vec<TrackInfo> = [90_000, 300_000, 150_000, 120_000]
            .iter()
            .enumerate()
            .map(|(i, ms)| track(i as u8 + 1, Some(*ms)))
            .collect();
        let fit = length_fit(&disc, &album).unwrap();
        assert_eq!(fit.within, 0);
        assert!(!fit.strong() && fit.weak());
    }

    #[test]
    fn one_long_track_stops_a_fit_being_strong_but_is_not_weak() {
        let disc = [200_000, 180_000, 240_000, 210_000, 190_000];
        let album: Vec<TrackInfo> = [200_000, 180_000, 240_000, 210_000, 260_000]
            .iter()
            .enumerate()
            .map(|(i, ms)| track(i as u8 + 1, Some(*ms)))
            .collect();
        let fit = length_fit(&disc, &album).unwrap();
        assert_eq!((fit.within, fit.worst_ms), (4, 70_000));
        assert!(!fit.strong() && !fit.weak());
    }

    #[test]
    fn no_lengths_a_different_count_or_a_short_disc_say_nothing_certain() {
        let disc = [200_000, 180_000, 240_000];
        assert!(
            length_fit(&disc, &[track(1, None), track(2, None), track(3, None)]).is_none(),
            "a source with no lengths"
        );
        assert!(
            length_fit(&disc, &[track(1, Some(200_000)), track(2, Some(180_000))]).is_none(),
            "another number of tracks"
        );
        let short: Vec<TrackInfo> = disc
            .iter()
            .enumerate()
            .map(|(i, ms)| track(i as u8 + 1, Some(*ms)))
            .collect();
        assert!(
            !length_fit(&disc, &short).unwrap().strong(),
            "three tracks are never enough to be sure"
        );
    }
}
