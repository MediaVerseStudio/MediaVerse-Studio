//! Review > Album IDs, "Compare": an album folder's own tags laid beside a MusicBrainz release, song by song, so a person
//! choosing between editions can see exactly what differs (titles, artists, track numbers, lengths, album details),
//! take the release's values for the ones they tick (journalled, so Fix tags' Undo puts them back), or flag the disc for a
//! re-rip. Nothing is written by `compare`; `adopt` writes only what was ticked.

use crate::lookup::{MetadataState, SourceResult, fail, http_get};
use crate::tag_repair::{TagRepairStore, audio_files, read_file};
use mediaverse_disc_metadata::musicbrainz;
use mediaverse_disc_metadata::settings::MetadataSettings;
use mediaverse_metadata_tags::{TagField, patch_track_metadata};
use mediaverse_tag_repair::musicbrainz::ReleaseTrack;
use mediaverse_tag_repair::{Folder, FolderFile, Release, parse_releases, rank};
use serde_json::{Value, json};
use std::collections::{BTreeMap, HashMap};
use std::path::Path;
use std::sync::{Mutex, OnceLock};
use std::time::{Duration, Instant};

const APP_NAME: &str = "MediaVerseStudio";
const APP_VERSION: &str = env!("CARGO_PKG_VERSION");
/// A release is kept this long, so cycling back to one in the list does not ask MusicBrainz again.
const KEEP: Duration = Duration::from_secs(600);

fn cache() -> &'static Mutex<HashMap<String, (Instant, Release)>> {
    static CACHE: OnceLock<Mutex<HashMap<String, (Instant, Release)>>> = OnceLock::new();
    CACHE.get_or_init(|| Mutex::new(HashMap::new()))
}

/// The release, from the cache or from MusicBrainz (an interactive request: it gives up with `rate_limited` rather than waiting long).
fn fetch_release(
    release_id: &str,
    settings: &MetadataSettings,
    state: &MetadataState,
) -> SourceResult<Release> {
    if let Ok(mut kept) = cache().lock() {
        kept.retain(|_, (at, _)| at.elapsed() < KEEP);
        if let Some((_, release)) = kept.get(release_id) {
            return Ok(release.clone());
        }
    }
    let mb = &settings.musicbrainz;
    let contact = settings.identity.contact.trim();
    let ua = musicbrainz::user_agent(
        APP_NAME,
        APP_VERSION,
        if contact.is_empty() {
            "https://mediaverse.studio"
        } else {
            contact
        },
    );
    state.wait_turn_for_person(
        "musicbrainz",
        Duration::from_millis(mb.min_interval_ms.max(1_000)),
    )?;
    let reply = http_get(
        &musicbrainz::release_url(&mb.base_url, release_id),
        &ua,
        Duration::from_secs(mb.timeout_seconds.max(10)),
    )?;
    let body = match reply.status {
        200 => {
            state.outcome("musicbrainz", false, None);
            String::from_utf8_lossy(&reply.body).into_owned()
        }
        404 => {
            state.outcome("musicbrainz", false, None);
            return fail(
                "not_found",
                "MusicBrainz has no release with that ID any more.",
            );
        }
        429 | 503 => {
            state.outcome("musicbrainz", true, reply.retry_after);
            return fail(
                "rate_limited",
                "MusicBrainz is busy or limiting requests right now. Try again in a moment.",
            );
        }
        other => return fail("http_error", format!("MusicBrainz answered HTTP {other}.")),
    };
    let release = parse_releases(&body)
        .map_err(|m| ("bad_reply".to_owned(), m))?
        .into_iter()
        .next()
        .ok_or_else(|| {
            (
                "bad_reply".to_owned(),
                "MusicBrainz sent no release.".to_owned(),
            )
        })?;
    if let Ok(mut kept) = cache().lock() {
        kept.insert(release_id.to_owned(), (Instant::now(), release.clone()));
    }
    Ok(release)
}

fn norm(text: &str) -> String {
    text.chars()
        .filter(|c| c.is_alphanumeric())
        .flat_map(char::to_lowercase)
        .collect()
}

/// Two spellings that differ by more than capitals and punctuation.
fn differs(yours: &str, release: &str) -> bool {
    norm(yours) != norm(release)
}

fn most_common(values: impl Iterator<Item = String>) -> Option<String> {
    let mut counts: BTreeMap<String, usize> = BTreeMap::new();
    for value in values.filter(|v| !v.trim().is_empty()) {
        *counts.entry(value).or_default() += 1;
    }
    counts
        .into_iter()
        .max_by(|a, b| a.1.cmp(&b.1).then_with(|| b.0.cmp(&a.0)))
        .map(|(value, _)| value)
}

fn capitalised(genre: &str) -> String {
    genre
        .split_whitespace()
        .map(|word| {
            word.split('-')
                .map(|part| {
                    part.chars().next().map_or(String::new(), |c| {
                        c.to_uppercase().collect::<String>() + &part[c.len_utf8()..]
                    })
                })
                .collect::<Vec<_>>()
                .join("-")
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// Which release track each file is: the matcher's alignment when it found one, else by position.
fn align<'a>(
    files: &[FolderFile],
    release: &'a Release,
) -> (Vec<(String, u32)>, &'a [ReleaseTrack]) {
    let folder = Folder {
        parents: Vec::new(),
        files: files.to_vec(),
    };
    let proposal = rank(&folder, std::slice::from_ref(release))
        .into_iter()
        .next();
    let medium = proposal
        .as_ref()
        .and_then(|p| release.media.iter().find(|m| m.position == p.medium))
        .or_else(|| release.media.iter().find(|m| m.tracks.len() == files.len()))
        .or_else(|| release.media.first());
    let tracks: &[ReleaseTrack] = medium.map_or(&[], |m| m.tracks.as_slice());
    let aligned = match proposal {
        Some(p) if !p.files.is_empty() => {
            p.files.iter().map(|f| (f.path.clone(), f.track)).collect()
        }
        _ => {
            let mut sorted: Vec<&FolderFile> = files.iter().collect();
            sorted.sort_by(|a, b| a.path.cmp(&b.path));
            sorted
                .iter()
                .zip(tracks)
                .map(|(file, track)| (file.path.clone(), track.number))
                .collect()
        }
    };
    (aligned, tracks)
}

/// The album's tags beside the release, as the page shows them. Pure: the files and the release are given.
pub fn compare_files(files: &[FolderFile], release: &Release) -> Value {
    let (aligned, tracks) = align(files, release);
    let aligned: BTreeMap<String, u32> = aligned.into_iter().collect();
    let mut rows: Vec<Value> = Vec::new();
    let mut used = std::collections::BTreeSet::new();
    for file in files {
        let number = aligned.get(&file.path).copied();
        let track = number.and_then(|n| tracks.iter().find(|t| t.number == n));
        if let Some(number) = number
            && track.is_some()
        {
            used.insert(number);
        }
        let yours_title = file.tags.title.clone().unwrap_or_default();
        let yours_artist = file.tags.artist.clone().unwrap_or_default();
        let mut differing: Vec<&str> = Vec::new();
        let theirs = track.map(|t| {
            let artist = if t.artist.is_empty() { release.artist.clone() } else { t.artist.clone() };
            json!({ "number": t.number, "title": t.title, "artist": artist, "length_ms": t.length_ms })
        });
        if let Some(t) = track {
            if differs(&yours_title, &t.title) {
                differing.push("title");
            }
            let their_artist = if t.artist.is_empty() {
                &release.artist
            } else {
                &t.artist
            };
            if !yours_artist.is_empty() && differs(&yours_artist, their_artist) {
                differing.push("artist");
            }
            if file.tags.track != Some(t.number) {
                differing.push("track");
            }
        }
        let diff_ms = track
            .and_then(|t| t.length_ms)
            .filter(|_| file.length_ms > 0)
            .map(|ms| file.length_ms as i64 - ms as i64);
        rows.push(json!({
            "path": file.path, "name": file.stem,
            "yours": { "track": file.tags.track, "disc": file.tags.disc, "title": yours_title, "artist": yours_artist, "length_ms": (file.length_ms > 0).then_some(file.length_ms) },
            "release": theirs, "diff_ms": diff_ms, "differs": differing, "extra": track.is_none(),
        }));
    }
    rows.sort_by_key(|row| {
        (
            row["release"]["number"].as_u64().unwrap_or(u64::MAX),
            row["name"].as_str().unwrap_or("").to_owned(),
        )
    });
    let missing: Vec<Value> = tracks
        .iter()
        .filter(|t| !used.contains(&t.number))
        .map(|t| json!({ "number": t.number, "title": t.title, "length_ms": t.length_ms }))
        .collect();

    let yours_album =
        most_common(files.iter().filter_map(|f| f.tags.album.clone())).unwrap_or_default();
    let yours_album_artist =
        most_common(files.iter().filter_map(|f| f.tags.album_artist.clone())).unwrap_or_default();
    let yours_year = most_common(
        files
            .iter()
            .filter_map(|f| f.tags.year.map(|y| y.to_string())),
    )
    .unwrap_or_default();
    let yours_genre =
        most_common(files.iter().filter_map(|f| f.tags.genre.clone())).unwrap_or_default();
    let their_year = release.year().map(|y| y.to_string()).unwrap_or_default();
    let their_genre = release
        .genres
        .first()
        .map(|g| capitalised(g))
        .unwrap_or_default();
    let album_fields = [
        ("album", yours_album, release.title.clone()),
        ("album_artist", yours_album_artist, release.artist.clone()),
        ("year", yours_year, their_year),
        ("genre", yours_genre, their_genre),
    ];
    let album: Vec<Value> = album_fields
        .iter()
        .map(|(field, yours, theirs)| {
            // Genre is a matter of taste and a missing value on either side is not a disagreement worth flagging in red.
            let differing = !theirs.is_empty() && differs(yours, theirs);
            json!({ "field": field, "yours": yours, "release": theirs, "differs": differing })
        })
        .collect();
    json!({
        "release": {
            "id": release.id, "release_group_id": release.release_group_id, "title": release.title, "artist": release.artist, "date": release.date, "country": release.country,
            "label": release.label, "catalog_number": release.catalog_number, "barcode": release.barcode, "url": release.url, "tracks": tracks.len(),
        },
        "songs": files.len(),
        "album": album,
        "rows": rows,
        "missing": missing,
    })
}

/// Reads the folder's songs and the release, and lays them side by side.
pub fn compare(
    dir: &Path,
    release_id: &str,
    settings: &MetadataSettings,
    state: &MetadataState,
) -> SourceResult<Value> {
    let paths = audio_files(dir);
    if paths.is_empty() {
        return fail(
            "no_files",
            "There are no songs in that album folder any more.",
        );
    }
    let files: Vec<FolderFile> = paths.iter().filter_map(|p| read_file(p).ok()).collect();
    if files.len() < paths.len() {
        return fail(
            "unreadable",
            "Some songs' tags could not be read, so they cannot be compared.",
        );
    }
    let release = fetch_release(release_id, settings, state)?;
    Ok(compare_files(&files, &release))
}

/// What to write, per file: `(path, [(field name, value)])`, from the ticked boxes. `album_fields` go into every song;
/// `songs` name a song and the fields (title, artist, track) to take from its release track.
pub fn plan_adoption(
    files: &[FolderFile],
    release: &Release,
    album_fields: &[String],
    songs: &[(String, Vec<String>)],
) -> Vec<(String, Vec<(String, String)>)> {
    let (aligned, tracks) = align(files, release);
    let aligned: BTreeMap<String, u32> = aligned.into_iter().collect();
    let mut plan: Vec<(String, Vec<(String, String)>)> = Vec::new();
    for file in files {
        let mut changes: Vec<(String, String)> = Vec::new();
        for field in album_fields {
            let value = match field.as_str() {
                "album" => Some(release.title.clone()),
                "album_artist" => Some(release.artist.clone()),
                "year" => release.year().map(|y| y.to_string()),
                "genre" => release.genres.first().map(|g| capitalised(g)),
                _ => None,
            };
            if let Some(value) = value.filter(|v| !v.trim().is_empty()) {
                changes.push((field.clone(), value));
            }
        }
        if let Some(wanted) = songs
            .iter()
            .find(|(path, _)| *path == file.path)
            .map(|(_, fields)| fields)
            && let Some(track) = aligned
                .get(&file.path)
                .and_then(|n| tracks.iter().find(|t| t.number == *n))
        {
            for field in wanted {
                let value = match field.as_str() {
                    "title" => Some(track.title.clone()),
                    "artist" => Some(if track.artist.is_empty() {
                        release.artist.clone()
                    } else {
                        track.artist.clone()
                    }),
                    "track" => Some(track.number.to_string()),
                    _ => None,
                };
                if let Some(value) = value.filter(|v| !v.trim().is_empty()) {
                    changes.retain(|(f, _)| f != field);
                    changes.push((field.clone(), value));
                }
            }
        }
        if !changes.is_empty() {
            plan.push((file.path.clone(), changes));
        }
    }
    plan
}

/// Writes the ticked values into the songs, journalled in the Fix tags journal so "Undo it" there puts them back.
pub fn adopt(
    store: &TagRepairStore,
    dir: &Path,
    release_id: &str,
    album_fields: &[String],
    songs: &[(String, Vec<String>)],
    settings: &MetadataSettings,
    state: &MetadataState,
) -> SourceResult<Value> {
    let paths = audio_files(dir);
    let files: Vec<FolderFile> = paths.iter().filter_map(|p| read_file(p).ok()).collect();
    if files.is_empty() {
        return fail(
            "no_files",
            "There are no readable songs in that album folder.",
        );
    }
    let release = fetch_release(release_id, settings, state)?;
    let plan = plan_adoption(&files, &release, album_fields, songs);
    let mut journal: Vec<(String, String, Option<String>, Option<String>)> = Vec::new();
    let mut problems: Vec<Value> = Vec::new();
    let mut written_files = 0usize;
    for (path, changes) in &plan {
        let fields: Vec<(TagField, Option<String>)> = changes
            .iter()
            .filter_map(|(field, value)| Some((TagField::from_name(field)?, Some(value.clone()))))
            .collect();
        match patch_track_metadata(Path::new(path), &fields) {
            Ok(before) => {
                written_files += 1;
                for ((field, new), (_, old)) in fields.iter().zip(before) {
                    journal.push((path.clone(), field.name().to_owned(), old, new.clone()));
                }
            }
            Err(e) => problems.push(json!({ "path": path, "message": e.to_string() })),
        }
    }
    let batch = store.journal(&journal, 1, written_files).map_err(|e| {
        (
            "journal_failed".to_owned(),
            format!("The values were written but could not be journalled: {e}"),
        )
    })?;
    Ok(
        json!({ "batch": batch, "files": written_files, "fields": journal.len(), "problems": problems }),
    )
}

#[cfg(test)]
mod tests {
    use super::*;
    use mediaverse_tag_repair::Tags;
    use mediaverse_tag_repair::musicbrainz::Medium;

    fn release() -> Release {
        let track = |n: u32, title: &str, ms: u64| ReleaseTrack {
            number: n,
            title: title.to_owned(),
            artist: String::new(),
            length_ms: Some(ms),
            recording_id: String::new(),
        };
        Release {
            id: "r1".into(),
            title: "Black Sails in the Sunset".into(),
            artist: "AFI".into(),
            date: "1999-06-22".into(),
            country: "US".into(),
            barcode: String::new(),
            label: "Nitro".into(),
            catalog_number: "15870".into(),
            release_group_id: "g1".into(),
            first_release_date: "1999-06-22".into(),
            genres: vec!["punk rock".into()],
            media: vec![Medium {
                position: 1,
                format: "CD".into(),
                tracks: vec![
                    track(1, "Miseria Cantare", 120_000),
                    track(2, "Malleus Maleficarum", 150_000),
                    track(3, "A Single Second", 180_000),
                    track(4, "Sacrifice Theory", 200_000),
                ],
            }],
            source: "musicbrainz".into(),
            url: String::new(),
        }
    }

    fn file(n: u32, stem: &str, title: &str, ms: u64) -> FolderFile {
        FolderFile {
            path: format!("C:\\M\\AFI\\{stem}.mp3"),
            stem: stem.to_owned(),
            tags: Tags {
                title: Some(title.to_owned()),
                artist: Some("A.F.I.".into()),
                album: Some("Black Sails".into()),
                album_artist: Some("A.F.I.".into()),
                genre: Some("Punk".into()),
                year: Some(1999),
                track: Some(n),
                disc: None,
            },
            length_ms: ms,
        }
    }

    fn files() -> Vec<FolderFile> {
        vec![
            file(1, "01", "Miseria Cantare", 120_400),
            file(2, "02", "Malleus Maleficarum", 150_100),
            file(3, "03", "A Single Sec", 176_000),
            file(4, "04", "Sacrifice Theory", 200_200),
        ]
    }

    #[test]
    fn songs_are_laid_beside_their_release_tracks_with_what_differs() {
        let result = compare_files(&files(), &release());
        let rows = result["rows"].as_array().unwrap();
        assert_eq!(rows.len(), 4);
        assert_eq!(rows[2]["release"]["title"], "A Single Second");
        assert_eq!(rows[2]["differs"], json!(["title"]), "{rows:?}");
        assert_eq!(
            rows[2]["diff_ms"], -4_000,
            "4 seconds shorter than the release"
        );
        assert_eq!(rows[0]["differs"], json!([]));
        assert_eq!(rows[0]["diff_ms"], 400);
        // "A.F.I." against "AFI" differs only by punctuation: not a difference.
        assert!(
            rows.iter()
                .all(|r| !r["differs"].as_array().unwrap().contains(&json!("artist")))
        );
        assert_eq!(result["missing"], json!([]));
        let album = result["album"].as_array().unwrap();
        let by = |field: &str| album.iter().find(|a| a["field"] == field).unwrap();
        assert_eq!(
            by("album")["differs"],
            true,
            "Black Sails is not Black Sails in the Sunset"
        );
        assert_eq!(by("album_artist")["differs"], false);
        assert_eq!(by("year")["release"], "1999");
        assert_eq!(by("genre")["release"], "Punk Rock");
    }

    #[test]
    fn a_release_track_without_a_song_is_listed_as_missing() {
        let mut few = files();
        few.remove(1);
        let result = compare_files(&few, &release());
        let missing = result["missing"].as_array().unwrap();
        assert_eq!(missing.len(), 1);
        assert_eq!(missing[0]["number"], 2);
    }

    fn mp3(path: &Path, title: &str, album: &str, track: u32) {
        let mut bytes = Vec::new();
        for _ in 0..4 {
            bytes.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
            bytes.extend(std::iter::repeat_n(0u8, 413));
        }
        std::fs::write(path, bytes).unwrap();
        patch_track_metadata(
            path,
            &[
                (TagField::Title, Some(title.to_owned())),
                (TagField::Album, Some(album.to_owned())),
                (TagField::Artist, Some("AFI".to_owned())),
                (TagField::Track, Some(track.to_string())),
            ],
        )
        .unwrap();
    }

    #[test]
    fn ticked_values_are_written_journalled_and_put_back_by_undo() {
        let base = std::env::temp_dir().join(format!("mv-adopt-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&base);
        let album = base.join("AFI").join("Black Sails");
        std::fs::create_dir_all(&album).unwrap();
        for (n, title) in [
            (1, "Miseria Cantare"),
            (2, "Malleus Maleficarum"),
            (3, "A Single Sec"),
            (4, "Sacrifice Theory"),
        ] {
            mp3(&album.join(format!("0{n}.mp3")), title, "Black Sails", n);
        }
        // The release is already known (as if just fetched), so no network is used.
        cache()
            .lock()
            .unwrap()
            .insert("r-adopt".to_owned(), (Instant::now(), release()));
        let store = TagRepairStore::new(&base);
        let settings = MetadataSettings::default();
        let state = MetadataState::new(&base);
        let third = album.join("03.mp3").to_string_lossy().into_owned();
        let result = adopt(
            &store,
            &album,
            "r-adopt",
            &["album".to_owned()],
            &[(third.clone(), vec!["title".to_owned()])],
            &settings,
            &state,
        )
        .unwrap();
        assert_eq!(result["files"], 4, "{result}");
        assert_eq!(
            result["fields"], 5,
            "the album title in 4 songs and one song title: {result}"
        );
        assert_eq!(result["problems"], json!([]));
        let after = |n: u32| read_file(&album.join(format!("0{n}.mp3"))).unwrap().tags;
        assert_eq!(after(3).title.as_deref(), Some("A Single Second"));
        assert_eq!(
            after(1).title.as_deref(),
            Some("Miseria Cantare"),
            "an unticked title is left as it was"
        );
        assert!((1..=4).all(|n| after(n).album.as_deref() == Some("Black Sails in the Sunset")));
        // Fix tags' Undo puts everything back.
        let batch = result["batch"].as_i64().expect("a batch was journalled");
        let undone = crate::tag_repair::undo(&store, batch).unwrap();
        assert_eq!(undone["files"], 4, "{undone}");
        assert_eq!(after(3).title.as_deref(), Some("A Single Sec"));
        assert!((1..=4).all(|n| after(n).album.as_deref() == Some("Black Sails")));
        // Nothing ticked: nothing written, and no batch left behind.
        let none = adopt(&store, &album, "r-adopt", &[], &[], &settings, &state).unwrap();
        assert_eq!(
            (none["files"].as_u64(), none["batch"].is_null()),
            (Some(0), true)
        );
        let _ = std::fs::remove_dir_all(&base);
    }
    #[test]
    fn the_ticked_values_are_what_gets_planned() {
        let plan = plan_adoption(
            &files(),
            &release(),
            &["album".to_owned(), "year".to_owned()],
            &[("C:\\M\\AFI\\03.mp3".to_owned(), vec!["title".to_owned()])],
        );
        assert_eq!(plan.len(), 4, "album fields go into every song");
        let third = plan.iter().find(|(p, _)| p.ends_with("03.mp3")).unwrap();
        assert!(
            third
                .1
                .contains(&("title".to_owned(), "A Single Second".to_owned()))
        );
        assert!(
            third
                .1
                .contains(&("album".to_owned(), "Black Sails in the Sunset".to_owned()))
        );
        assert!(third.1.contains(&("year".to_owned(), "1999".to_owned())));
        let first = plan.iter().find(|(p, _)| p.ends_with("01.mp3")).unwrap();
        assert!(
            !first.1.iter().any(|(f, _)| f == "title"),
            "only the ticked song's title"
        );
        assert!(
            plan_adoption(&files(), &release(), &[], &[]).is_empty(),
            "nothing ticked, nothing planned"
        );
    }
}
