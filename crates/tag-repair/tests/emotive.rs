//! The owner's own case (ADR 0009): `Music\A Perfect Circle\eMOTIVe`, 12 MP3s ripped long ago and tagged only
//! "Track 1".."Track 12", "Unknown artist", "Unknown album (…)", "Unknown genre", no album artist, no year. The
//! file lengths are the real ones (measured 2026-11-03); the fixture is MusicBrainz's real reply to the fuzzy TOC
//! search built from them (MusicBrainz data is CC0).

use mediaverse_tag_repair::{
    EvidenceKind, Folder, FolderFile, Tags, matcher::Field, parse_releases, rank,
};

const LENGTHS_MS: [u64; 12] = [
    133_820, 287_760, 302_950, 293_450, 249_940, 138_520, 222_850, 179_150, 207_970, 336_150,
    355_020, 186_100,
];
const STEMS: [&str; 12] = [
    "01 Annihilation",
    "02 Imagine",
    "03 Peace Love And Understanding",
    "04 What's Going On",
    "05 Passive",
    "06 Gimmie Gimmie Gimmie",
    "07 People Are People",
    "08 Freedom Of Choice",
    "09 Let's Have A War",
    "10 Counting Bodies Like Sheep To The Rhythm Of The War Drums",
    "11 When The Levee Breaks",
    "12 Fiddle And The Drum",
];

fn emotive(tags_for: impl Fn(usize) -> Tags) -> Folder {
    Folder {
        parents: vec!["eMOTIVe".into(), "A Perfect Circle".into()],
        files: (0..12)
            .map(|i| FolderFile {
                path: format!("C:/Music/A Perfect Circle/eMOTIVe/{}.mp3", STEMS[i]),
                stem: STEMS[i].into(),
                tags: tags_for(i),
                length_ms: LENGTHS_MS[i],
            })
            // Shuffled, as a folder listing may be: the order comes from the numbers.
            .rev()
            .collect(),
    }
}

fn placeholder_tags(i: usize) -> Tags {
    Tags {
        title: Some(format!("Track {}", i + 1)),
        artist: Some("Unknown artist".into()),
        album: Some("Unknown album (2/20/2008 10:12:34 PM)".into()),
        album_artist: None,
        genre: Some("Unknown genre".into()),
        year: None,
        track: Some(i as u32 + 1),
        disc: None,
    }
}

fn releases() -> Vec<mediaverse_tag_repair::Release> {
    parse_releases(include_str!("fixtures/emotive-toc-search.json")).unwrap()
}

#[test]
fn the_folder_is_recognised_with_high_confidence_and_every_missing_tag_is_proposed() {
    let folder = emotive(placeholder_tags);
    assert!(folder.needs_repair());
    let proposals = rank(&folder, &releases());
    assert_eq!(proposals.len(), 7, "all seven editions fit");
    let best = &proposals[0];
    assert_eq!(
        (best.artist.as_str(), best.album.as_str()),
        ("A Perfect Circle", "eMOTIVe")
    );
    assert!(
        best.confidence >= 90,
        "confidence {} with {:?}",
        best.confidence,
        best.evidence
    );
    assert!(
        best.evidence
            .iter()
            .any(|e| e.kind == EvidenceKind::Good && e.text == "Track lengths match 12 of 12"),
        "{:?}",
        best.evidence
    );
    assert!(best.edition.contains("Virgin"), "{}", best.edition);

    // Every file gets its title, artist, album, album artist, genre and year; the track numbers were already there.
    let first = best.files.iter().find(|f| f.track == 1).unwrap();
    assert!(first.path.ends_with("01 Annihilation.mp3"));
    let value = |field: Field| {
        first
            .changes
            .iter()
            .find(|c| c.field == field)
            .map(|c| c.to.clone())
    };
    assert_eq!(value(Field::Title).as_deref(), Some("Annihilation"));
    assert_eq!(value(Field::Artist).as_deref(), Some("A Perfect Circle"));
    assert_eq!(value(Field::Album).as_deref(), Some("eMOTIVe"));
    assert_eq!(
        value(Field::AlbumArtist).as_deref(),
        Some("A Perfect Circle")
    );
    assert_eq!(value(Field::Year).as_deref(), Some("2004"));
    assert_eq!(value(Field::Genre).as_deref(), Some("Alternative Metal"));
    assert_eq!(
        value(Field::Track),
        None,
        "a track number already there is kept"
    );
    assert_eq!(
        first
            .changes
            .iter()
            .find(|c| c.field == Field::Title)
            .unwrap()
            .from
            .as_deref(),
        Some("Track 1")
    );
    for file in &best.files {
        assert_eq!(file.changes.len(), 6, "{}: {:?}", file.path, file.changes);
        assert!(file.fit >= 70, "{} fit {}", file.path, file.fit);
    }
}

#[test]
fn real_values_are_never_changed() {
    // Titles, artist and album already right (as the owner may have typed them); only genre and year missing.
    let real = |i: usize| Tags {
        title: Some(if i == 4 {
            "Pasive".to_owned()
        } else {
            STEMS[i][3..].to_owned()
        }),
        artist: Some("A Perfect Circle".into()),
        album: Some("Emotive".into()),
        album_artist: Some("APC".into()),
        genre: None,
        year: None,
        track: Some(i as u32 + 1),
        disc: None,
    };
    let best = rank(&emotive(real), &releases()).remove(0);
    assert!(best.confidence >= 85, "{}", best.confidence);
    for file in &best.files {
        let fields: Vec<Field> = file.changes.iter().map(|c| c.field).collect();
        assert_eq!(fields, vec![Field::Genre, Field::Year], "{}", file.path);
    }
    // Real values that disagree are noted, not changed: "APC" is not "A Perfect Circle"; "Emotive" differs from
    // "eMOTIVe" only in case, which is not noted.
    let first = best.files.iter().find(|f| f.track == 1).unwrap();
    let noted: Vec<(Field, String)> = first
        .differences
        .iter()
        .map(|c| (c.field, c.to.clone()))
        .collect();
    assert_eq!(
        noted,
        vec![(Field::AlbumArtist, "A Perfect Circle".to_owned())]
    );
    let fifth = best.files.iter().find(|f| f.track == 5).unwrap();
    assert!(
        fifth
            .differences
            .iter()
            .any(|c| c.field == Field::Title && c.to == "Passive"),
        "a misspelt title is noted: {:?}",
        fifth.differences
    );
    let third = best.files.iter().find(|f| f.track == 3).unwrap();
    assert!(
        !third.differences.iter().any(|c| c.field == Field::Title),
        "a difference of case only is not: {:?}",
        third.differences
    );
    assert!(
        best.evidence
            .iter()
            .any(|e| e.text.contains("differ from this release"))
    );
}

#[test]
fn a_folder_missing_a_song_matches_by_track_number_with_lower_confidence() {
    let mut folder = emotive(placeholder_tags);
    folder.files.retain(|f| !f.stem.starts_with("05 "));
    let best = rank(&folder, &releases()).remove(0);
    assert_eq!(best.album, "eMOTIVe");
    // Still clearly this album (everything there matches), a little less sure, and the gap is said.
    let complete = rank(&emotive(placeholder_tags), &releases())
        .remove(0)
        .confidence;
    assert!(
        best.confidence >= 85 && best.confidence < complete,
        "{} vs {complete}: {:?}",
        best.confidence,
        best.evidence
    );
    assert!(
        best.evidence.iter().any(|e| e.kind == EvidenceKind::Warn
            && e.text == "Folder has 11 of this release's 12 tracks"),
        "{:?}",
        best.evidence
    );
    let sixth = best
        .files
        .iter()
        .find(|f| f.path.contains("06 Gimmie"))
        .unwrap();
    assert_eq!(sixth.track, 6);
    assert_eq!(
        sixth
            .changes
            .iter()
            .find(|c| c.field == Field::Title)
            .unwrap()
            .to,
        "Gimmie Gimmie Gimmie"
    );
}

#[test]
fn a_file_with_another_songs_tags_is_found_and_its_wrong_tags_are_noted() {
    // As in the owner's "10,000 Maniacs\Our Time In Eden\01 Noah's Dove.mp3", tagged as track 10, "Tolerance":
    // here 01 Annihilation carries track 10's tags. The file names' numbers order the folder instead.
    let tagged = |i: usize| {
        let own = if i == 0 { 9 } else { i };
        Tags {
            title: Some(STEMS[own][3..].to_owned()),
            artist: Some("A Perfect Circle".into()),
            album: Some("eMOTIVe".into()),
            album_artist: None,
            genre: None,
            year: Some(2004),
            track: Some(own as u32 + 1),
            disc: None,
        }
    };
    let best = rank(&emotive(tagged), &releases()).remove(0);
    assert_eq!(best.album, "eMOTIVe");
    assert!(
        best.confidence >= 85,
        "{} {:?}",
        best.confidence,
        best.evidence
    );
    assert!(
        best.evidence
            .iter()
            .any(|e| e.text.starts_with("Track numbers repeat in the tags")),
        "{:?}",
        best.evidence
    );
    let first = best
        .files
        .iter()
        .find(|f| f.path.contains("01 Annihilation"))
        .unwrap();
    assert_eq!(first.track, 1);
    let noted: Vec<(Field, &str)> = first
        .differences
        .iter()
        .map(|c| (c.field, c.to.as_str()))
        .collect();
    assert!(
        noted.contains(&(Field::Title, "Annihilation")) && noted.contains(&(Field::Track, "1")),
        "{noted:?}"
    );
}

#[test]
fn an_original_year_in_the_files_is_not_a_difference_and_picks_the_original_edition() {
    // As with the owner's In My Tribe (files say 1987; a 1989 reissue fits as well): one edition here is a 2010
    // reissue that comes without the album's first date, as TOC search replies often do.
    let mut all = releases();
    for release in &mut all {
        release.first_release_date.clear();
    }
    all[1].date = "2010-05-01".into();
    let dated = |i: usize| Tags {
        year: Some(2004),
        ..placeholder_tags(i)
    };
    let proposals = rank(&emotive(dated), &all);
    assert!(
        proposals[0].edition.starts_with("2004"),
        "{}",
        proposals[0].edition
    );
    let reissue = proposals
        .iter()
        .find(|p| p.edition.starts_with("2010"))
        .expect("the reissue still fits");
    assert!(
        reissue
            .files
            .iter()
            .all(|f| f.differences.iter().all(|c| c.field != Field::Year)),
        "2004 is the album's first year"
    );
}

#[test]
fn a_folder_without_track_numbers_and_a_song_short_matches_by_title() {
    // As the owner's Aphex Twin, Millencolin and Boards of Canada folders: no numbers anywhere.
    let mut folder = emotive(|i| Tags {
        track: None,
        ..placeholder_tags(i)
    });
    folder.files.retain(|f| !f.stem.starts_with("07 "));
    for file in &mut folder.files {
        file.stem = file.stem[3..].to_owned(); // "Annihilation" with no number
    }
    let best = rank(&folder, &releases()).remove(0);
    assert_eq!(best.album, "eMOTIVe");
    assert!(
        best.evidence
            .iter()
            .any(|e| e.text == "Folder has 11 of this release's 12 tracks"),
        "{:?}",
        best.evidence
    );
    let freedom = best
        .files
        .iter()
        .find(|f| f.path.contains("Freedom Of Choice"))
        .unwrap();
    assert_eq!(freedom.track, 8);
}

#[test]
fn a_folder_of_a_different_size_without_numbers_or_titles_does_not_match() {
    let mut folder = emotive(|i| Tags {
        track: None,
        ..placeholder_tags(i)
    });
    folder.files.pop();
    for (i, file) in folder.files.iter_mut().enumerate() {
        file.stem = format!("zq{i}x");
    }
    assert!(rank(&folder, &releases()).is_empty());
}

#[test]
fn a_two_disc_set_ripped_into_one_folder_matches_both_discs_in_order() {
    use mediaverse_tag_repair::musicbrainz::{Medium, ReleaseTrack};
    // The eMOTIVe release split into two discs of 6, and the folder's files named "1-01".."2-06".
    let mut release = releases().remove(1);
    let tracks = release.media[0].tracks.clone();
    let disc = |position: u32, part: &[ReleaseTrack]| Medium {
        position,
        format: "CD".into(),
        tracks: part
            .iter()
            .enumerate()
            .map(|(i, t)| ReleaseTrack {
                number: i as u32 + 1,
                ..t.clone()
            })
            .collect(),
    };
    release.media = vec![disc(1, &tracks[..6]), disc(2, &tracks[6..])];
    let mut folder = emotive(placeholder_tags);
    for file in &mut folder.files {
        let n: usize = file.stem[..2].parse().unwrap();
        file.stem = format!(
            "{}-{:02} {}",
            if n <= 6 { 1 } else { 2 },
            if n <= 6 { n } else { n - 6 },
            &file.stem[3..]
        );
        file.tags.track = None;
    }
    let best = rank(&folder, &[release]).remove(0);
    assert_eq!(best.medium, 0, "the whole set");
    assert!(best.edition.contains("2×CD"), "{}", best.edition);
    assert!(
        best.confidence >= 90,
        "{} {:?}",
        best.confidence,
        best.evidence
    );
    let titles: Vec<String> = best
        .files
        .iter()
        .map(|f| {
            f.changes
                .iter()
                .find(|c| c.field == Field::Title)
                .unwrap()
                .to
                .clone()
        })
        .collect();
    assert_eq!(titles[0], "Annihilation");
    assert_eq!(titles[6], "People Are People");
}

#[test]
fn wrong_lengths_lower_the_confidence() {
    let mut folder = emotive(placeholder_tags);
    for (i, file) in folder.files.iter_mut().enumerate() {
        file.length_ms += 20_000 * (i as u64 % 3); // two of every three tracks far off
    }
    let best = rank(&folder, &releases()).remove(0);
    assert!(best.confidence < 75, "{}", best.confidence);
    assert!(
        best.evidence
            .iter()
            .any(|e| e.kind == EvidenceKind::Warn && e.text.starts_with("Track lengths match"))
    );
}
