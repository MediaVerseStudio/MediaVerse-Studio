//! How sure a folder's match to MusicBrainz is, for writing MusicBrainz IDs into whole libraries without a person
//! looking at every album (D99). Only an *exact* fit is written automatically: every song paired with a track,
//! no track missing or extra, every title and length agreeing. Editions of one album that all fit equally (another
//! country, a remaster) still identify the album itself, so the album's ID is written and the edition's is left for
//! a person who cares. Everything else is set aside with the reason in plain words.

use crate::matcher::{EvidenceKind, Folder, Proposal};
use serde::Serialize;

/// Every file's title and length must agree this well (see `score_pairs`: length right and title 0.6 alike is 88).
const EXACT_FIT: u8 = 88;
/// The whole match must also be at least this confident.
const EXACT_CONFIDENCE: u8 = 75;

#[derive(Clone, Debug, PartialEq, Eq, Serialize)]
#[serde(tag = "kind", rename_all = "snake_case")]
pub enum Verdict {
    /// One edition is the clear answer: write the release ID and the release group ID.
    Ready {
        release_id: String,
        release_group_id: String,
        edition: String,
    },
    /// The album is certain but several editions fit alike: write the release group ID only.
    AlbumOnly {
        release_group_id: String,
        editions: usize,
    },
    /// Needs a person (or nothing fits): why, in words.
    Review { reason: String },
}

/// "Titles agree 7 of 12" or "Track lengths match 11 of 12" in the matcher's evidence: (7, 12).
fn agreement(proposal: &Proposal, prefix: &str) -> Option<(usize, usize)> {
    let text = proposal
        .evidence
        .iter()
        .find(|e| e.text.starts_with(prefix))?
        .text
        .strip_prefix(prefix)?
        .trim()
        .to_owned();
    let (k, n) = text.split_once(" of ")?;
    Some((
        k.trim().parse().ok()?,
        n.trim().split_whitespace().next()?.parse().ok()?,
    ))
}

/// Whether a proposal is an exact fit for the folder: as many paired songs as files, every title agreeing, nothing
/// the evidence warns of. A few songs whose lengths differ (another edition or a remaster) do not matter when the
/// names and the count are the same, as long as most lengths agree.
pub fn is_exact(folder: &Folder, proposal: &Proposal) -> bool {
    if proposal.confidence < EXACT_CONFIDENCE
        || proposal.files.is_empty()
        || proposal.files.len() != folder.files.len()
    {
        return false;
    }
    // Warnings that do not speak against the album itself: a few lengths (checked below), the local tags' repeated track
    // numbers (the file names were used) and a folder named differently from the release.
    const HARMLESS: [&str; 3] = [
        "Track lengths",
        "Track numbers repeat",
        "Album name differs",
    ];
    // A folder or tag spelling the artist differently is harmless too when every title and every length agrees.
    let all_agree = agreement(proposal, "Titles agree").is_some_and(|(k, n)| k == n)
        && agreement(proposal, "Track lengths match").is_some_and(|(k, n)| k == n);
    if proposal.evidence.iter().any(|e| {
        e.kind == EvidenceKind::Warn
            && !HARMLESS.iter().any(|h| e.text.starts_with(h))
            && !(all_agree && e.text.starts_with("Artist name differs"))
    }) {
        return false;
    }
    let lengths_mostly_right =
        agreement(proposal, "Track lengths match").is_none_or(|(k, n)| k * 2 >= n);
    match agreement(proposal, "Titles agree") {
        // Every title agrees, or all but one on a longer album (a tidied or re-spelt name).
        Some((k, n)) => (k == n || (n >= 6 && k + 1 == n)) && lengths_mostly_right,
        None => proposal.files.iter().all(|f| f.fit >= EXACT_FIT),
    }
}
/// The most common year the files carry.
fn file_year(folder: &Folder) -> Option<u32> {
    let mut counts: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
    for year in folder.files.iter().filter_map(|f| f.tags.year) {
        *counts.entry(year).or_default() += 1;
    }
    counts
        .into_iter()
        .max_by_key(|(year, n)| (*n, *year))
        .map(|(year, _)| year)
}

/// The first four digits of an edition label such as "2004 · Virgin · US · CD".
fn edition_year(edition: &str) -> Option<u32> {
    edition.get(..4)?.parse().ok()
}

fn why_not(proposals: &[Proposal], folder: &Folder) -> String {
    let Some(top) = proposals.first() else {
        return "No MusicBrainz release fits these songs.".to_owned();
    };
    let warn = |needle: &str| {
        top.evidence
            .iter()
            .find(|e| e.kind == EvidenceKind::Warn && e.text.contains(needle))
            .map(|e| e.text.clone())
    };
    if let Some(text) = warn("tracks").filter(|t| t.starts_with("Folder has")) {
        return format!("Tracks missing: {text}.");
    }
    if let Some(text) = warn("not on this release") {
        return format!("Extra songs: {text}.");
    }
    if let Some(text) = warn("Titles agree") {
        return format!("Song names differ: {text}.");
    }
    if let Some(text) = warn("Track lengths") {
        return format!("Song lengths differ: {text}.");
    }
    if top.files.len() != folder.files.len() {
        return format!(
            "The folder has {} songs; the closest release pairs {}.",
            folder.files.len(),
            top.files.len()
        );
    }
    let warns: Vec<&str> = top
        .evidence
        .iter()
        .filter(|e| {
            e.kind == EvidenceKind::Warn
                || e.text.starts_with("Titles agree")
                || e.text.starts_with("Track lengths")
        })
        .map(|e| e.text.as_str())
        .collect();
    if warns.is_empty() {
        format!("Not an exact match (best fit {}%).", top.confidence)
    } else {
        format!(
            "Not an exact match (best fit {}%): {}.",
            top.confidence,
            warns.join("; ")
        )
    }
}

/// Decides what to do with one folder, given its ranked proposals (best first, as `rank` returns them).
pub fn judge(folder: &Folder, proposals: &[Proposal]) -> Verdict {
    let exact: Vec<&Proposal> = proposals.iter().filter(|p| is_exact(folder, p)).collect();
    if exact.is_empty() {
        return Verdict::Review {
            reason: why_not(proposals, folder),
        };
    }
    let group = exact[0].release_group_id.clone();
    // Two different albums that fit: a clearly better fit (the proposals come best first) is the answer; a near tie waits.
    let rival = exact
        .iter()
        .filter(|p| p.release_group_id != group)
        .map(|p| p.confidence)
        .max();
    if rival.is_some_and(|c| u16::from(c) + 2 >= u16::from(exact[0].confidence)) {
        return Verdict::Review {
            reason: "Two different albums fit these songs equally.".to_owned(),
        };
    }
    let exact: Vec<&Proposal> = exact
        .into_iter()
        .filter(|p| p.release_group_id == group)
        .collect();
    let ready = |p: &Proposal| Verdict::Ready {
        release_id: p.release_id.clone(),
        release_group_id: p.release_group_id.clone(),
        edition: p.edition.clone(),
    };
    if exact.len() == 1 {
        return ready(exact[0]);
    }
    // Several editions fit: the one whose year the files already carry, if that picks exactly one.
    if let Some(year) = file_year(folder) {
        let same_year: Vec<&&Proposal> = exact
            .iter()
            .filter(|p| edition_year(&p.edition) == Some(year))
            .collect();
        if same_year.len() == 1 {
            return ready(same_year[0]);
        }
    }
    if group.is_empty() {
        return Verdict::Review {
            reason: format!("{} editions fit and none names its album.", exact.len()),
        };
    }
    Verdict::AlbumOnly {
        release_group_id: group,
        editions: exact.len(),
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::matcher::{Evidence, FileProposal, FolderFile, Tags};

    fn folder(songs: usize, year: Option<u32>) -> Folder {
        Folder {
            parents: vec![],
            files: (0..songs)
                .map(|i| FolderFile {
                    path: format!("{i}.mp3"),
                    stem: format!("{i}"),
                    tags: Tags {
                        year,
                        ..Default::default()
                    },
                    length_ms: 180_000,
                })
                .collect(),
        }
    }

    fn proposal(
        release: &str,
        group: &str,
        edition: &str,
        songs: usize,
        fit: u8,
        warn: Option<&str>,
    ) -> Proposal {
        Proposal {
            release_id: release.into(),
            release_group_id: group.into(),
            medium: 1,
            artist: "AFI".into(),
            album: "Crash Love".into(),
            edition: edition.into(),
            barcode: String::new(),
            catalog_number: String::new(),
            source: "musicbrainz".into(),
            url: String::new(),
            confidence: 95,
            evidence: warn
                .map(|text| {
                    vec![Evidence {
                        kind: EvidenceKind::Warn,
                        text: text.into(),
                    }]
                })
                .unwrap_or_default(),
            files: (0..songs)
                .map(|i| FileProposal {
                    path: format!("{i}.mp3"),
                    track: i as u32 + 1,
                    changes: vec![],
                    differences: vec![],
                    fit,
                })
                .collect(),
        }
    }

    #[test]
    fn one_exact_edition_is_ready() {
        let verdict = judge(
            &folder(12, Some(2009)),
            &[proposal(
                "r1",
                "g1",
                "2009 · Interscope · US · CD",
                12,
                97,
                None,
            )],
        );
        assert!(matches!(verdict, Verdict::Ready { ref release_id, .. } if release_id == "r1"));
    }

    #[test]
    fn editions_that_fit_alike_give_the_album_only_unless_the_year_picks_one() {
        let editions = [
            proposal("r1", "g1", "2009 · Interscope · US · CD", 12, 97, None),
            proposal("r2", "g1", "2009 · Polydor · UK · CD", 12, 97, None),
            proposal("r3", "g1", "2010 · Interscope · JP · CD", 12, 97, None),
        ];
        // Two editions share the files' year: the album is certain, the edition is not.
        assert_eq!(
            judge(&folder(12, Some(2009)), &editions),
            Verdict::AlbumOnly {
                release_group_id: "g1".into(),
                editions: 3
            }
        );
        // One edition has the files' year: that one.
        assert!(
            matches!(judge(&folder(12, Some(2010)), &editions), Verdict::Ready { ref release_id, .. } if release_id == "r3")
        );
        // Files with no year at all: album only.
        assert!(matches!(
            judge(&folder(12, None), &editions),
            Verdict::AlbumOnly { .. }
        ));
    }

    #[test]
    fn missing_tracks_wrong_names_and_a_different_count_are_set_aside_with_a_reason() {
        let missing = proposal(
            "r1",
            "g1",
            "2009",
            11,
            97,
            Some("Folder has 11 of this release's 12 tracks"),
        );
        match judge(&folder(11, None), &[missing]) {
            Verdict::Review { reason } => assert!(reason.contains("Tracks missing"), "{reason}"),
            other => panic!("{other:?}"),
        }
        let names = proposal("r1", "g1", "2009", 12, 97, Some("Titles agree 7 of 12"));
        match judge(&folder(12, None), &[names]) {
            Verdict::Review { reason } => assert!(reason.contains("Song names differ"), "{reason}"),
            other => panic!("{other:?}"),
        }
        // Pairs fewer songs than the folder has (a bonus track on the files).
        let bonus = proposal("r1", "g1", "2009", 12, 97, None);
        assert!(matches!(
            judge(&folder(13, None), &[bonus]),
            Verdict::Review { .. }
        ));
        // A weak fit on one song is not exact.
        let weak = proposal("r1", "g1", "2009", 12, 70, None);
        assert!(matches!(
            judge(&folder(12, None), &[weak]),
            Verdict::Review { .. }
        ));
        assert!(matches!(
            judge(&folder(12, None), &[]),
            Verdict::Review { .. }
        ));
    }

    #[test]
    fn a_song_or_two_with_another_length_is_still_exact_when_every_name_agrees() {
        let mut p = proposal("r1", "g1", "2009", 12, 60, None);
        p.evidence = vec![
            Evidence {
                kind: EvidenceKind::Warn,
                text: "Track lengths match 11 of 12".into(),
            },
            Evidence {
                kind: EvidenceKind::Good,
                text: "Titles agree 12 of 12".into(),
            },
        ];
        assert!(matches!(
            judge(&folder(12, None), &[p.clone()]),
            Verdict::Ready { .. }
        ));
        // Most lengths wrong, or a name off: not exact.
        p.evidence[0].text = "Track lengths match 3 of 12".into();
        assert!(matches!(
            judge(&folder(12, None), &[p.clone()]),
            Verdict::Review { .. }
        ));
        p.evidence = vec![Evidence {
            kind: EvidenceKind::Warn,
            text: "Titles agree 9 of 12".into(),
        }];
        match judge(&folder(12, None), &[p.clone()]) {
            Verdict::Review { reason } => assert!(reason.contains("Song names differ"), "{reason}"),
            other => panic!("{other:?}"),
        }
        // One odd name out of twelve is tolerated; on a short album it is not.
        p.evidence = vec![
            Evidence {
                kind: EvidenceKind::Good,
                text: "Titles agree 11 of 12".into(),
            },
            Evidence {
                kind: EvidenceKind::Warn,
                text: "Track numbers repeat in the tags; the file names' numbers were used".into(),
            },
        ];
        assert!(matches!(
            judge(&folder(12, None), &[p.clone()]),
            Verdict::Ready { .. }
        ));
        p.evidence = vec![Evidence {
            kind: EvidenceKind::Good,
            text: "Titles agree 4 of 5".into(),
        }];
        p.files.truncate(5);
        assert!(matches!(
            judge(&folder(5, None), &[p]),
            Verdict::Review { .. }
        ));
    }

    #[test]
    fn a_different_artist_spelling_is_harmless_when_every_title_and_length_agrees() {
        let mut p = proposal("r1", "g1", "2009", 12, 90, None);
        p.evidence = vec![
            Evidence {
                kind: EvidenceKind::Good,
                text: "Track lengths match 12 of 12".into(),
            },
            Evidence {
                kind: EvidenceKind::Good,
                text: "Titles agree 12 of 12".into(),
            },
            Evidence {
                kind: EvidenceKind::Warn,
                text: "Artist name differs from the folder".into(),
            },
        ];
        assert!(matches!(
            judge(&folder(12, None), &[p.clone()]),
            Verdict::Ready { .. }
        ));
        p.evidence[0].text = "Track lengths match 11 of 12".into();
        assert!(matches!(
            judge(&folder(12, None), &[p]),
            Verdict::Review { .. }
        ));
    }

    #[test]
    fn two_different_albums_that_fit_equally_wait_for_a_person() {
        let verdict = judge(
            &folder(12, None),
            &[
                proposal("r1", "g1", "2009", 12, 97, None),
                proposal("r2", "g2", "2009", 12, 97, None),
            ],
        );
        assert!(
            matches!(verdict, Verdict::Review { ref reason } if reason.contains("Two different albums"))
        );
    }
}
