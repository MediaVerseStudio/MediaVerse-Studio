//! Matching an album folder to releases, and the proposal for each (ADR 0009).

use crate::musicbrainz::{Medium, Release, ReleaseTrack, genre_tag};
use crate::names::{
    FromFolders, from_file_name, from_folders, is_placeholder, is_various, name_similarity,
    normalise, similarity,
};

fn first_year(release: &Release) -> Option<String> {
    release.first_release_date.get(..4).map(ToOwned::to_owned)
}
use mediaverse_disc_metadata::DiscToc;
use serde::{Deserialize, Serialize};

/// A file's tags as read, before repair.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
pub struct Tags {
    pub title: Option<String>,
    pub artist: Option<String>,
    pub album: Option<String>,
    pub album_artist: Option<String>,
    pub genre: Option<String>,
    pub year: Option<u32>,
    pub track: Option<u32>,
    pub disc: Option<u32>,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct FolderFile {
    pub path: String,
    /// The file name without its extension: "01 Annihilation".
    pub stem: String,
    pub tags: Tags,
    pub length_ms: u64,
}

/// One album folder: its files and its folder names from its own upwards (stopping at the library root).
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct Folder {
    pub parents: Vec<String>,
    pub files: Vec<FolderFile>,
}

/// The fields tag repair fills, in the order the review shows them.
#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum Field {
    Title,
    Artist,
    Album,
    AlbumArtist,
    Genre,
    Year,
    Track,
}

impl Field {
    pub const ALL: [Field; 7] = [
        Field::Title,
        Field::Artist,
        Field::Album,
        Field::AlbumArtist,
        Field::Genre,
        Field::Year,
        Field::Track,
    ];
}

impl Tags {
    pub fn get(&self, field: Field) -> Option<String> {
        match field {
            Field::Title => self.title.clone(),
            Field::Artist => self.artist.clone(),
            Field::Album => self.album.clone(),
            Field::AlbumArtist => self.album_artist.clone(),
            Field::Genre => self.genre.clone(),
            Field::Year => self.year.map(|y| y.to_string()),
            Field::Track => self.track.map(|t| t.to_string()),
        }
    }

    /// Fields that are empty or hold a placeholder ("Unknown artist", "Track 3").
    pub fn missing(&self) -> Vec<Field> {
        Field::ALL
            .into_iter()
            .filter(|field| is_placeholder(self.get(*field).as_deref()))
            .collect()
    }
}

impl Folder {
    /// True when any file has a field to fill.
    pub fn needs_repair(&self) -> bool {
        self.files
            .iter()
            .any(|file| !file.tags.missing().is_empty())
    }

    /// What the folder names say.
    pub fn clues(&self) -> FromFolders {
        let parents: Vec<&str> = self.parents.iter().map(String::as_str).collect();
        from_folders(&parents)
    }

    /// Each file's disc and track number. Normally from the tags, else the file name; but when the tags' track
    /// numbers repeat or are incomplete while the file names are numbered one to a file, the file names are
    /// used for all (a file whose tags were copied from another song, as in the owner's "01 Noah's Dove.mp3"
    /// tagged as track 10, "Tolerance").
    pub fn track_numbers(&self) -> Vec<(Option<u32>, Option<u32>)> {
        let from_tags: Vec<Option<(u32, u32)>> = self
            .files
            .iter()
            .map(|f| {
                f.tags
                    .track
                    .filter(|n| *n > 0)
                    .map(|t| (f.tags.disc.filter(|n| *n > 0).unwrap_or(1), t))
            })
            .collect();
        let from_names: Vec<Option<(u32, u32)>> = self
            .files
            .iter()
            .map(|f| {
                let name = from_file_name(&f.stem);
                name.track
                    .map(|t| (name.disc.or(f.tags.disc.filter(|n| *n > 0)).unwrap_or(1), t))
            })
            .collect();
        let distinct = |numbers: &[Option<(u32, u32)>]| {
            let known: Vec<(u32, u32)> = numbers.iter().flatten().copied().collect();
            known.len() == numbers.len()
                && known.iter().collect::<std::collections::HashSet<_>>().len() == known.len()
        };
        if !distinct(&from_tags) && distinct(&from_names) {
            return from_names
                .into_iter()
                .map(|n| (n.map(|(d, _)| d), n.map(|(_, t)| t)))
                .collect();
        }
        self.files
            .iter()
            .zip(from_tags.iter().zip(&from_names))
            .map(|(f, (tag, name))| {
                let chosen = tag.or(*name);
                (
                    chosen.map(|(d, _)| d).or(f.tags.disc),
                    chosen.map(|(_, t)| t),
                )
            })
            .collect()
    }

    /// True when the tags' track numbers repeat or are incomplete but the file names number every file.
    pub fn tag_numbers_unreliable(&self) -> bool {
        let tags: Vec<Option<u32>> = self
            .files
            .iter()
            .map(|f| f.tags.track.filter(|n| *n > 0))
            .collect();
        let known: Vec<u32> = tags.iter().flatten().copied().collect();
        let repeated = known.iter().collect::<std::collections::HashSet<_>>().len() < known.len();
        repeated
            && self
                .track_numbers()
                .iter()
                .zip(&tags)
                .any(|((_, chosen), tag)| chosen != tag)
    }

    /// File indexes in disc order: by disc, then track number (see `track_numbers`), else by name.
    pub fn disc_order(&self) -> Vec<usize> {
        let numbers = self.track_numbers();
        let mut order: Vec<usize> = (0..self.files.len()).collect();
        let key = |i: &usize| {
            let (disc, track) = numbers[*i];
            (
                disc.unwrap_or(1),
                track.unwrap_or(u32::MAX),
                self.files[*i].stem.to_lowercase(),
            )
        };
        order.sort_by_key(key);
        order
    }

    /// The disc's table of contents rebuilt from the files' lengths, in disc order.
    pub fn toc(&self) -> Option<DiscToc> {
        let lengths: Vec<u64> = self
            .disc_order()
            .into_iter()
            .map(|i| self.files[i].length_ms)
            .collect();
        DiscToc::from_track_lengths(&lengths)
    }

    /// The best title the file itself offers: its tag unless that is a placeholder, else its file name.
    fn known_title(&self, index: usize) -> Option<String> {
        let file = &self.files[index];
        file.tags
            .title
            .clone()
            .filter(|t| !is_placeholder(Some(t)))
            .or_else(|| from_file_name(&file.stem).title)
    }

    fn known_artist(&self) -> Option<String> {
        self.files
            .iter()
            .find_map(|f| {
                f.tags
                    .album_artist
                    .clone()
                    .filter(|v| !is_placeholder(Some(v)))
                    .or_else(|| f.tags.artist.clone().filter(|v| !is_placeholder(Some(v))))
            })
            .or(self.clues().artist)
    }

    fn known_album(&self) -> Option<String> {
        self.files
            .iter()
            .find_map(|f| f.tags.album.clone().filter(|v| !is_placeholder(Some(v))))
            .or(self.clues().album)
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum EvidenceKind {
    /// Supports the match.
    Good,
    /// Worth knowing.
    Info,
    /// Speaks against it, or needs the user's eye.
    Warn,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Evidence {
    pub kind: EvidenceKind,
    pub text: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct Change {
    pub field: Field,
    pub from: Option<String>,
    pub to: String,
}

#[derive(Clone, Debug, PartialEq, Eq, Serialize, Deserialize)]
pub struct FileProposal {
    pub path: String,
    pub track: u32,
    /// Only fields that are missing or placeholders, and only where the release has a value.
    pub changes: Vec<Change>,
    /// Real values that disagree with the release (not proposed: the first version only fills gaps), shown so
    /// the person can judge them: a misspelt title, a wrong track number, another artist. Genre is left out
    /// (a matter of taste), as are differences of case, punctuation or a leading "The".
    pub differences: Vec<Change>,
    /// How well this file's length and name fit its track, 0 to 100.
    pub fit: u8,
}

#[derive(Clone, Debug, PartialEq, Serialize, Deserialize)]
pub struct Proposal {
    pub release_id: String,
    pub release_group_id: String,
    pub medium: u32,
    pub artist: String,
    pub album: String,
    pub edition: String,
    pub barcode: String,
    pub catalog_number: String,
    /// "musicbrainz" or "discogs", and the release's page there.
    pub source: String,
    pub url: String,
    /// 0 to 100.
    pub confidence: u8,
    pub evidence: Vec<Evidence>,
    pub files: Vec<FileProposal>,
}

/// A difference in length small enough to be the same recording: rips lose or gain a little at the edges.
const SAME_LENGTH_MS: u64 = 3_000;
const SAME_TITLE: f64 = 0.6;

/// The folder matched against one release: None when no medium has as many tracks as the folder has files
/// (incomplete or mixed folders are for fingerprints, a later step).
pub fn match_release(folder: &Folder, release: &Release) -> Option<Proposal> {
    let count = folder.files.len();
    let clues = folder.clues();
    let disc_hint = clues
        .disc
        .or_else(|| folder.files.iter().find_map(|f| f.tags.disc));
    // One disc with as many tracks as the folder has files (the disc the folder names, if they name one), or else
    // every disc together when the whole set was ripped into one folder (medium 0 in the proposal).
    let single: Option<&Medium> = release
        .media
        .iter()
        .filter(|m| m.tracks.len() == count)
        .min_by_key(|m| {
            if Some(m.position) == disc_hint {
                0
            } else {
                m.position
            }
        });
    let whole_set = single.is_none()
        && release.media.len() > 1
        && release.media.iter().map(|m| m.tracks.len()).sum::<usize>() == count;
    let combined;
    let medium: &Medium = match single {
        Some(medium) => medium,
        None if whole_set => {
            combined = Medium {
                position: 0,
                format: format!(
                    "{}×{}",
                    release.media.len(),
                    release
                        .media
                        .first()
                        .map(|m| m.format.clone())
                        .filter(|f| !f.is_empty())
                        .unwrap_or_else(|| "disc".into())
                ),
                tracks: release
                    .media
                    .iter()
                    .flat_map(|m| m.tracks.iter().cloned())
                    .collect(),
            };
            &combined
        }
        None => return numbered_match(folder, release, disc_hint),
    };
    let order = folder.disc_order();
    let pairs: Vec<(usize, &ReleaseTrack)> = order
        .iter()
        .enumerate()
        .map(|(slot, &index)| (index, &medium.tracks[slot]))
        .collect();
    Some(score_pairs(
        folder,
        release,
        medium,
        &pairs,
        medium.tracks.len(),
    ))
}

/// When the folder has a few tracks more or fewer than any disc (a missing song, a bonus or hidden track), its
/// files are paired with the tracks of the same number, as long as every file has its own number. At most a
/// quarter of the disc may be missing, and at most two files may have no track; each gap lowers the confidence.
fn numbered_match(folder: &Folder, release: &Release, disc_hint: Option<u32>) -> Option<Proposal> {
    let numbers = folder.track_numbers();
    if numbers.iter().any(|(_, track)| track.is_none()) {
        return titled_match(folder, release, disc_hint);
    }
    let count = folder.files.len();
    let mut best: Option<Proposal> = None;
    for medium in &release.media {
        let wanted = medium.tracks.len();
        if wanted == 0
            || count.abs_diff(wanted) * 4 > wanted
            || (disc_hint.is_some()
                && Some(medium.position) != disc_hint
                && release.media.len() > 1)
        {
            continue;
        }
        let mut seen = std::collections::HashSet::new();
        let mut pairs = Vec::new();
        for (index, (_, track)) in numbers.iter().enumerate() {
            let number = track.unwrap_or(0);
            if !seen.insert(number) {
                return None; // two files claim the same track: not a numbered folder
            }
            if let Some(release_track) = medium.tracks.iter().find(|t| t.number == number) {
                pairs.push((index, release_track));
            }
        }
        let unplaced = count - pairs.len();
        if unplaced > 2 || pairs.len() * 4 < wanted * 3 {
            continue;
        }
        let proposal = score_pairs(folder, release, medium, &pairs, wanted);
        if best
            .as_ref()
            .is_none_or(|b| proposal.confidence > b.confidence)
        {
            best = Some(proposal);
        }
    }
    best
}

/// For folders whose files have no track numbers and are a few tracks off: each file is paired with the track
/// whose title is most like its own (the tag, or else the file name), when that is clearly alike (0.75) and
/// not already taken. The same limits as `numbered_match` apply.
fn titled_match(folder: &Folder, release: &Release, disc_hint: Option<u32>) -> Option<Proposal> {
    let titles: Vec<Option<String>> = (0..folder.files.len())
        .map(|i| folder.known_title(i))
        .collect();
    if titles.iter().filter(|t| t.is_none()).count() > 2 {
        return None;
    }
    let count = folder.files.len();
    let mut best: Option<Proposal> = None;
    for medium in &release.media {
        let wanted = medium.tracks.len();
        if wanted == 0
            || count.abs_diff(wanted) * 4 > wanted
            || (disc_hint.is_some()
                && Some(medium.position) != disc_hint
                && release.media.len() > 1)
        {
            continue;
        }
        let mut taken = vec![false; wanted];
        let mut pairs = Vec::new();
        for (index, title) in titles.iter().enumerate() {
            let Some(title) = title else { continue };
            let found = medium
                .tracks
                .iter()
                .enumerate()
                .filter(|(slot, _)| !taken[*slot])
                .map(|(slot, track)| (slot, similarity(title, &track.title)))
                .filter(|(_, score)| *score >= 0.75)
                .max_by(|a, b| a.1.total_cmp(&b.1));
            if let Some((slot, _)) = found {
                taken[slot] = true;
                pairs.push((index, &medium.tracks[slot]));
            }
        }
        if count - pairs.len() > 2 || pairs.len() * 4 < wanted * 3 {
            continue;
        }
        let proposal = score_pairs(folder, release, medium, &pairs, wanted);
        if best
            .as_ref()
            .is_none_or(|b| proposal.confidence > b.confidence)
        {
            best = Some(proposal);
        }
    }
    best
}

/// Scores files paired with release tracks and builds the proposal. `disc_tracks` is how many tracks the disc
/// (or set) has, so missing ones count against the match.
fn score_pairs(
    folder: &Folder,
    release: &Release,
    medium: &Medium,
    pairs: &[(usize, &ReleaseTrack)],
    disc_tracks: usize,
) -> Proposal {
    let count = folder.files.len();
    let mut lengths_ok = 0;
    let mut lengths_known = 0;
    let mut titles_ok = 0;
    let mut titles_known = 0;
    let mut title_sum = 0.0;
    let mut files = Vec::with_capacity(count);
    let genre = release.genres.first().map(|g| genre_tag(g));
    let year = release.year().map(|y| y.to_string());
    for &(index, track) in pairs {
        let file = &folder.files[index];
        let length_fit = track.length_ms.map(|ms| {
            lengths_known += 1;
            let ok = ms.abs_diff(file.length_ms) <= SAME_LENGTH_MS;
            if ok {
                lengths_ok += 1;
            }
            ok
        });
        let title_fit = folder.known_title(index).map(|title| {
            titles_known += 1;
            let score = similarity(&title, &track.title);
            title_sum += score;
            if score >= SAME_TITLE {
                titles_ok += 1;
            }
            score
        });
        let fit = match (length_fit, title_fit) {
            (Some(true), Some(t)) => 70.0 + 30.0 * t,
            (Some(true), None) => 85.0,
            (Some(false), Some(t)) => 50.0 * t,
            (Some(false), None) => 20.0,
            (None, Some(t)) => 80.0 * t,
            (None, None) => 40.0,
        };
        let artist = if track.artist.is_empty() {
            release.artist.clone()
        } else {
            track.artist.clone()
        };
        let values = [
            (Field::Title, Some(track.title.clone())),
            (Field::Artist, Some(artist)),
            (Field::Album, Some(release.title.clone())),
            (Field::AlbumArtist, Some(release.artist.clone())),
            (Field::Genre, genre.clone()),
            (Field::Year, year.clone()),
            (Field::Track, Some(track.number.to_string())),
        ];
        let missing = file.tags.missing();
        let mut changes = Vec::new();
        let mut differences = Vec::new();
        for (field, value) in values {
            let Some(value) = value.filter(|v| !v.trim().is_empty()) else {
                continue;
            };
            if missing.contains(&field) {
                changes.push(Change {
                    field,
                    from: file.tags.get(field),
                    to: value,
                });
                continue;
            }
            let Some(have) = file.tags.get(field) else {
                continue;
            };
            let differs = match field {
                Field::Genre => false,
                // An edition's year or the album's first year are both fine.
                Field::Year => {
                    release.year().map(|y| y.to_string()) != Some(have.clone())
                        && first_year(release) != Some(have.clone())
                }
                Field::Track => have.trim_start_matches('0') != value,
                _ => normalise(&have) != normalise(&value),
            };
            if differs {
                differences.push(Change {
                    field,
                    from: Some(have),
                    to: value,
                });
            }
        }
        files.push(FileProposal {
            path: file.path.clone(),
            track: track.number,
            changes,
            differences,
            fit: fit.round().clamp(0.0, 100.0) as u8,
        });
    }

    // How the parts add up: lengths weigh most (they are what a TOC search matched on), then titles, then names.
    let length_score = if lengths_known > 0 {
        lengths_ok as f64 / lengths_known as f64
    } else {
        0.5
    };
    let title_score = if titles_known > 0 {
        title_sum / titles_known as f64
    } else {
        length_score
    };
    let album_sim = folder
        .known_album()
        .map(|a| name_similarity(&a, &release.title));
    // A compilation is credited to "Various Artists": compare that with the folder or the album artist tag, not
    // with each song's own artist.
    let artist_sim = if is_various(&release.artist) {
        let named = folder
            .files
            .iter()
            .find_map(|f| {
                f.tags
                    .album_artist
                    .clone()
                    .filter(|v| !is_placeholder(Some(v)))
            })
            .or_else(|| folder.clues().artist);
        named.map(|a| {
            if is_various(&a) {
                1.0
            } else {
                name_similarity(&a, &release.artist)
            }
        })
    } else {
        folder
            .known_artist()
            .map(|a| name_similarity(&a, &release.artist))
    };
    let name_score = match (album_sim, artist_sim) {
        (Some(a), Some(b)) => (a + b) / 2.0,
        (Some(s), None) | (None, Some(s)) => s,
        (None, None) => 0.6,
    };
    let paired = pairs.len();
    let mut confidence = 100.0 * (0.5 * length_score + 0.3 * title_score + 0.2 * name_score);
    // Titles the files know that almost all disagree mean another record whose lengths happen to fit (seen on
    // the owner's library: a 3-song EP matched to an unrelated single by lengths alone). Not offered.
    if titles_known >= 3 && titles_known * 2 >= paired && title_score < 0.35 {
        confidence = confidence.min(40.0);
    }
    if lengths_known < paired {
        confidence -= 5.0; // MusicBrainz lacks some lengths: less to go on
    }
    // Tracks of the release the folder lacks, and files the release has no track for, each lower the confidence.
    let missing_tracks = disc_tracks.saturating_sub(paired);
    let extra_files = count - paired;
    confidence -= 4.0 * missing_tracks as f64 + 6.0 * extra_files as f64;

    let mut evidence = Vec::new();
    let kind = |good: bool| {
        if good {
            EvidenceKind::Good
        } else {
            EvidenceKind::Warn
        }
    };
    if missing_tracks > 0 {
        evidence.push(Evidence {
            kind: EvidenceKind::Warn,
            text: format!("Folder has {paired} of this release's {disc_tracks} tracks"),
        });
    }
    if extra_files > 0 {
        evidence.push(Evidence {
            kind: EvidenceKind::Warn,
            text: format!(
                "{extra_files} file{} not on this release",
                if extra_files == 1 { "" } else { "s" }
            ),
        });
    }
    if lengths_known > 0 {
        evidence.push(Evidence {
            kind: kind(lengths_ok == lengths_known),
            text: format!("Track lengths match {lengths_ok} of {paired}"),
        });
    }
    if titles_known > 0 {
        evidence.push(Evidence {
            kind: kind(titles_ok * 10 >= titles_known * 8),
            text: format!("Titles agree {titles_ok} of {titles_known}"),
        });
    }
    match (album_sim, artist_sim) {
        (Some(a), Some(b)) if a >= 0.8 && b >= 0.8 => evidence.push(Evidence {
            kind: EvidenceKind::Good,
            text: "Artist and album names agree".into(),
        }),
        (Some(a), _) if a < 0.5 => evidence.push(Evidence {
            kind: EvidenceKind::Warn,
            text: "Album name differs from the folder".into(),
        }),
        (_, Some(b)) if b < 0.5 => evidence.push(Evidence {
            kind: EvidenceKind::Warn,
            text: "Artist name differs from the folder".into(),
        }),
        _ => {}
    }
    if genre.is_none() {
        evidence.push(Evidence {
            kind: EvidenceKind::Info,
            text: "No genre known for this album".into(),
        });
    }
    if folder.tag_numbers_unreliable() {
        evidence.push(Evidence {
            kind: EvidenceKind::Warn,
            text: "Track numbers repeat in the tags; the file names' numbers were used".into(),
        });
    }
    let differing: usize = files
        .iter()
        .map(|f: &FileProposal| f.differences.len())
        .sum();
    if differing > 0 {
        evidence.push(Evidence {
            kind: EvidenceKind::Info,
            text: format!(
                "{differing} existing tag{} differ from this release (not changed)",
                if differing == 1 { "" } else { "s" }
            ),
        });
    }

    Proposal {
        release_id: release.id.clone(),
        release_group_id: release.release_group_id.clone(),
        medium: medium.position,
        artist: release.artist.clone(),
        album: release.title.clone(),
        edition: release.edition_label(medium),
        barcode: release.barcode.clone(),
        catalog_number: release.catalog_number.clone(),
        source: release.source.clone(),
        url: release.url.clone(),
        confidence: confidence.round().clamp(0.0, 99.0) as u8,
        evidence,
        files,
    }
}

/// Every release that fits, best first. Equal scores (editions of one album) put dated editions first, then the
/// earliest; the user can choose another edition in the review.
pub fn rank(folder: &Folder, releases: &[Release]) -> Vec<Proposal> {
    // The album's first year, from every edition seen together (a TOC search's reply often lacks it), so a
    // file dated with the original year (1987) is not taken to disagree with a 1989 reissue.
    let mut releases: Vec<Release> = releases.to_vec();
    let mut first_dates: std::collections::HashMap<String, String> =
        std::collections::HashMap::new();
    for release in &releases {
        for date in [&release.first_release_date, &release.date] {
            if date.len() >= 4 && !release.release_group_id.is_empty() {
                let entry = first_dates
                    .entry(release.release_group_id.clone())
                    .or_insert_with(|| date.clone());
                if date < entry {
                    *entry = date.clone();
                }
            }
        }
    }
    for release in &mut releases {
        if let Some(first) = first_dates.get(&release.release_group_id)
            && (release.first_release_date.is_empty() || *first < release.first_release_date)
        {
            release.first_release_date = first.clone();
        }
    }
    // The year the files already carry (most common), to prefer that edition when editions tie.
    let mut years: std::collections::HashMap<u32, usize> = std::collections::HashMap::new();
    for file in &folder.files {
        if let Some(year) = file.tags.year {
            *years.entry(year).or_default() += 1;
        }
    }
    let file_year = years.into_iter().max_by_key(|(_, n)| *n).map(|(y, _)| y);
    let mut found: Vec<(Proposal, &Release)> = releases
        .iter()
        .filter_map(|r| match_release(folder, r).map(|p| (p, r)))
        .collect();
    found.sort_by(|(a, ra), (b, rb)| {
        b.confidence
            .cmp(&a.confidence)
            .then_with(|| {
                (rb.year() == file_year && file_year.is_some())
                    .cmp(&(ra.year() == file_year && file_year.is_some()))
            })
            .then_with(|| ra.date.is_empty().cmp(&rb.date.is_empty()))
            .then_with(|| ra.date.cmp(&rb.date))
    });
    let mut proposals: Vec<Proposal> = found.into_iter().map(|(p, _)| p).collect();
    if proposals.len() > 1 {
        let editions = proposals.len();
        proposals[0].evidence.push(Evidence {
            kind: EvidenceKind::Info,
            text: format!("{editions} editions fit"),
        });
    }
    proposals
}
