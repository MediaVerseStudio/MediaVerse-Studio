//! Combining the answers of several sources. Sources often agree, sometimes differ (a remaster
//! versus the original, different spellings), and sometimes only one has the disc. Answers that
//! describe the same album are grouped, the group remembers who agreed, and the user (or, when it
//! is clear-cut, the program) chooses.

use crate::{AlbumInfo, MatchQuality};
use serde::Serialize;

#[derive(Clone, Debug, Eq, PartialEq, Serialize)]
pub struct Candidate {
    pub album: AlbumInfo,
    /// Every source that returned this album, best first.
    pub sources: Vec<String>,
    /// How well its track lengths agree with the disc in the drive; filled in by the sidecar, which knows the disc.
    #[serde(default)]
    pub length_fit: Option<crate::fit::LengthFit>,
}

fn normalize(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

fn key(album: &AlbumInfo) -> (String, String, usize) {
    (
        normalize(&album.album_artist),
        normalize(&album.album),
        album.tracks.len(),
    )
}

/// Preference when choosing which source's wording represents a group: MusicBrainz first (curated,
/// full Unicode), then exact matches over inexact ones, then the order they were received.
fn rank(album: &AlbumInfo) -> (u8, u8) {
    (
        u8::from(album.source != "musicbrainz"),
        u8::from(album.quality != MatchQuality::Exact),
    )
}

/// Groups albums that agree on artist, album title and track count, fills gaps (year, genre, cover
/// art) from other members of the group, and orders the groups by how many sources agree.
pub fn consolidate(albums: Vec<AlbumInfo>) -> Vec<Candidate> {
    let mut groups: Vec<((String, String, usize), Vec<AlbumInfo>)> = Vec::new();
    // Each MusicBrainz release is a candidate of its own: the 1998 UK pressing and the 2007 remaster are different
    // releases of one album, and the person has to be able to tell them apart before ripping. A source with no release
    // of its own (a CDDB entry) joins the first candidate describing the same album, whatever order the sources answered in.
    let own_release =
        |album: &AlbumInfo| album.source == "musicbrainz" && !album.source_id.is_empty();
    let (releases, others): (Vec<AlbumInfo>, Vec<AlbumInfo>) =
        albums.into_iter().partition(|a| own_release(a));
    for album in releases.into_iter().chain(others) {
        let k = key(&album);
        let joined = if own_release(&album) {
            None
        } else {
            groups.iter_mut().find(|(existing, _)| *existing == k)
        };
        match joined {
            Some((_, members)) => members.push(album),
            None => groups.push((k, vec![album])),
        }
    }

    let mut candidates: Vec<Candidate> = groups
        .into_iter()
        .map(|(_, mut members)| {
            members.sort_by_key(rank); // stable: ties keep arrival order
            let mut best = members[0].clone();
            for other in &members[1..] {
                best.year = best.year.or(other.year);
                best.genre = best.genre.clone().or_else(|| other.genre.clone());
                best.cover_art_release = best
                    .cover_art_release
                    .clone()
                    .or_else(|| other.cover_art_release.clone());
                // Lengths from a member that has them (the group agrees on the track count).
                for (mine, theirs) in best.tracks.iter_mut().zip(&other.tracks) {
                    mine.length_ms = mine.length_ms.or(theirs.length_ms);
                }
            }
            let mut sources: Vec<String> = Vec::new();
            for member in &members {
                if !sources.contains(&member.source) {
                    sources.push(member.source.clone());
                }
            }
            Candidate {
                album: best,
                sources,
                length_fit: None,
            }
        })
        .collect();

    candidates.sort_by(|a, b| {
        b.sources
            .len()
            .cmp(&a.sources.len())
            .then_with(|| rank(&a.album).cmp(&rank(&b.album)))
    });
    candidates
}

/// Picks a candidate without asking only when that is safe: there is exactly one, or the best is
/// backed by two or more sources and nothing else is. Otherwise `None`, and the user decides.
/// Inexact-only answers are never chosen automatically.
pub fn automatic_choice(candidates: &[Candidate]) -> Option<usize> {
    let first = candidates.first()?;
    if first.album.quality != MatchQuality::Exact {
        return None;
    }
    let strong = candidates.iter().filter(|c| c.sources.len() >= 2).count();
    match (candidates.len(), first.sources.len(), strong) {
        (1, _, _) => Some(0),
        (_, n, 1) if n >= 2 => Some(0),
        _ => None,
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::TrackInfo;

    fn album(
        source: &str,
        artist: &str,
        title: &str,
        tracks: usize,
        quality: MatchQuality,
    ) -> AlbumInfo {
        AlbumInfo {
            source: source.to_owned(),
            source_id: format!("{source}-id"),
            album: title.to_owned(),
            album_artist: artist.to_owned(),
            year: None,
            genre: None,
            tracks: (1..=tracks)
                .map(|n| TrackInfo {
                    number: n as u8,
                    title: format!("T{n}"),
                    artist: None,
                    length_ms: None,
                })
                .collect(),
            quality,
            cover_art_release: None,
            disc_number: None,
            disc_count: None,
            compilation: false,
            release: None,
        }
    }

    #[test]
    fn agreeing_sources_become_one_candidate_that_prefers_musicbrainz_wording() {
        let mut cddb = album(
            "gnudb",
            "the watchmen",
            "BRAND NEW DAY",
            12,
            MatchQuality::Exact,
        );
        cddb.genre = Some("Rock".into());
        let mut mb = album(
            "musicbrainz",
            "The Watchmen",
            "Brand New Day",
            12,
            MatchQuality::Exact,
        );
        mb.year = Some(1996);
        mb.cover_art_release = Some("rel".into());

        let found = consolidate(vec![cddb, mb]);
        assert_eq!(found.len(), 1);
        let best = &found[0];
        assert_eq!(best.sources, ["musicbrainz", "gnudb"]);
        assert_eq!(best.album.album, "Brand New Day");
        assert_eq!(
            best.album.genre.as_deref(),
            Some("Rock"),
            "genre filled in from the other source"
        );
        assert_eq!(best.album.year, Some(1996));
        assert_eq!(best.album.cover_art_release.as_deref(), Some("rel"));
    }

    #[test]
    fn every_musicbrainz_release_stays_a_candidate_and_a_cddb_entry_joins_the_first() {
        let mut uk = album(
            "musicbrainz",
            "Operation Ivy",
            "Energy",
            27,
            MatchQuality::Exact,
        );
        uk.source_id = "uk".into();
        let mut remaster = album(
            "musicbrainz",
            "Operation Ivy",
            "Energy",
            27,
            MatchQuality::Exact,
        );
        remaster.source_id = "remaster".into();
        let cddb = album("gnudb", "operation ivy", "ENERGY", 27, MatchQuality::Exact);
        let found = consolidate(vec![cddb, uk, remaster]);
        assert_eq!(
            found.len(),
            2,
            "two releases of one album are two candidates"
        );
        let ids: Vec<&str> = found.iter().map(|c| c.album.source_id.as_str()).collect();
        assert_eq!(
            ids,
            ["uk", "remaster"],
            "the one CDDB agreed with comes first"
        );
        assert_eq!(found[0].sources, ["musicbrainz", "gnudb"]);
        assert_eq!(found[1].sources, ["musicbrainz"]);
    }

    #[test]
    fn different_albums_stay_separate_and_the_best_supported_comes_first() {
        let found = consolidate(vec![
            album("gnudb", "Operation Ivy", "Energy", 27, MatchQuality::Exact),
            album(
                "musicbrainz",
                "Operation Ivy",
                "Operation Ivy",
                27,
                MatchQuality::Exact,
            ),
            album("other", "Operation Ivy", "Energy", 27, MatchQuality::Exact),
        ]);
        assert_eq!(found.len(), 2);
        assert_eq!(found[0].album.album, "Energy");
        assert_eq!(found[0].sources.len(), 2);
        assert_eq!(found[1].album.album, "Operation Ivy");
    }

    #[test]
    fn a_different_track_count_is_a_different_album() {
        let found = consolidate(vec![
            album("a", "X", "Y", 10, MatchQuality::Exact),
            album("b", "X", "Y", 12, MatchQuality::Exact),
        ]);
        assert_eq!(found.len(), 2);
    }

    #[test]
    fn automatic_choice_is_made_only_when_it_is_clear() {
        let one = consolidate(vec![album("musicbrainz", "A", "B", 5, MatchQuality::Exact)]);
        assert_eq!(automatic_choice(&one), Some(0), "a single exact answer");

        let agreed = consolidate(vec![
            album("musicbrainz", "A", "B", 5, MatchQuality::Exact),
            album("gnudb", "A", "B", 5, MatchQuality::Exact),
            album("gnudb", "C", "D", 5, MatchQuality::Exact),
        ]);
        assert_eq!(
            automatic_choice(&agreed),
            Some(0),
            "two sources agree and nothing else does"
        );

        let split = consolidate(vec![
            album("musicbrainz", "A", "B", 5, MatchQuality::Exact),
            album("gnudb", "C", "D", 5, MatchQuality::Exact),
        ]);
        assert_eq!(
            automatic_choice(&split),
            None,
            "sources disagree: ask the user"
        );

        let two_pairs = consolidate(vec![
            album("musicbrainz", "A", "B", 5, MatchQuality::Exact),
            album("gnudb", "A", "B", 5, MatchQuality::Exact),
            album("x", "C", "D", 5, MatchQuality::Exact),
            album("y", "C", "D", 5, MatchQuality::Exact),
        ]);
        assert_eq!(automatic_choice(&two_pairs), None);

        let inexact = consolidate(vec![album("gnudb", "A", "B", 5, MatchQuality::Inexact)]);
        assert_eq!(
            automatic_choice(&inexact),
            None,
            "inexact matches always need confirmation"
        );
        assert_eq!(automatic_choice(&[]), None);
    }
}
