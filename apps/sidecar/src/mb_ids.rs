//! MusicBrainz IDs for the whole library (D99). A scan looks every album up on MusicBrainz and files it as
//! `ready` (one edition fits exactly), `album_only` (the album is certain, several editions fit alike),
//! `review` (missing tracks, a different count, other names, no match: set aside with the reason) or `has_ids`
//! (already tagged). Applying writes only the `ready` and `album_only` albums (the person pressed the button), journals
//! every tag it adds and can be undone. The answers live in `<data>/mb-ids/results.json`, so a stopped scan
//! carries on where it ended and nothing is asked twice.

use crate::lookup::MetadataState;
use crate::tag_repair::{
    ScanState, audio_files, credible, musicbrainz_get, parents, read_file, search_by_name,
    signature,
};
use mediaverse_disc_metadata::musicbrainz;
use mediaverse_disc_metadata::settings::MetadataSettings;
use mediaverse_metadata_tags::{TagField, patch_track_metadata, read_tag_fields};
use mediaverse_tag_repair::judge::{Verdict, judge};
use mediaverse_tag_repair::{Folder, Proposal, parse_releases, rank};
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const MIN_SONGS: usize = 3;
/// Bumped when the rules for judging a match change, so older answers are asked again once.
const RULES: u32 = 4;
const ID_FIELDS: [TagField; 2] = [
    TagField::MusicBrainzReleaseId,
    TagField::MusicBrainzReleaseGroupId,
];

#[derive(Clone, Debug, Default)]
pub struct Candidate {
    pub release_id: String,
    pub release_group_id: String,
    pub edition: String,
    pub confidence: u8,
    pub artist: String,
    pub album: String,
}

#[derive(Clone, Debug, Default)]
pub struct Entry {
    pub sig: String,
    /// ready | album_only | review | has_ids | too_few | applied | dismissed | error
    pub status: String,
    /// The rules version that made this answer.
    pub rules: u32,
    pub reason: String,
    pub release_id: String,
    pub release_group_id: String,
    pub edition: String,
    pub artist: String,
    pub album: String,
    pub songs: usize,
    /// The closest releases, for a person choosing by hand.
    pub candidates: Vec<Candidate>,
    /// The most common year the songs carry (0: none), for choosing between editions.
    pub year: u32,
    /// How the match was found: "disc layout" (the track lengths found it in MusicBrainz's disc ID data) or "names".
    pub method: String,
    /// The closest releases with the evidence the judge used (slimmed: no per-song tag changes), so the rules can be
    /// changed and every album judged again without asking MusicBrainz a second time.
    pub proposals: Vec<Value>,
}

fn text(value: &Value, key: &str) -> String {
    value[key].as_str().unwrap_or_default().to_owned()
}

impl Candidate {
    fn to_json(&self) -> Value {
        json!({ "release_id": self.release_id, "release_group_id": self.release_group_id, "edition": self.edition, "confidence": self.confidence, "artist": self.artist, "album": self.album })
    }

    pub fn from_json(v: &Value) -> Self {
        Self {
            release_id: text(v, "release_id"),
            release_group_id: text(v, "release_group_id"),
            edition: text(v, "edition"),
            confidence: v["confidence"].as_u64().unwrap_or(0) as u8,
            artist: text(v, "artist"),
            album: text(v, "album"),
        }
    }
}

impl Entry {
    fn to_json(&self) -> Value {
        json!({
            "sig": self.sig, "status": self.status, "rules": self.rules, "reason": self.reason, "release_id": self.release_id, "release_group_id": self.release_group_id, "edition": self.edition,
            "artist": self.artist, "album": self.album, "songs": self.songs, "candidates": self.candidates.iter().map(Candidate::to_json).collect::<Vec<_>>(),
            "year": self.year, "method": self.method, "proposals": self.proposals,
        })
    }

    fn from_json(v: &Value) -> Self {
        Self {
            sig: text(v, "sig"),
            status: text(v, "status"),
            rules: v["rules"].as_u64().unwrap_or(0) as u32,
            reason: text(v, "reason"),
            release_id: text(v, "release_id"),
            release_group_id: text(v, "release_group_id"),
            edition: text(v, "edition"),
            artist: text(v, "artist"),
            album: text(v, "album"),
            songs: v["songs"].as_u64().unwrap_or(0) as usize,
            candidates: v["candidates"]
                .as_array()
                .into_iter()
                .flatten()
                .map(Candidate::from_json)
                .collect(),
            year: v["year"].as_u64().unwrap_or(0) as u32,
            method: text(v, "method"),
            proposals: v["proposals"].as_array().cloned().unwrap_or_default(),
        }
    }
}

pub struct Store {
    dir: PathBuf,
}

impl Store {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("mb-ids"),
        }
    }

    fn file(&self) -> PathBuf {
        self.dir.join("results.json")
    }

    pub fn load(&self) -> BTreeMap<String, Entry> {
        let value: Value = std::fs::read_to_string(self.file())
            .ok()
            .and_then(|text| serde_json::from_str(&text).ok())
            .unwrap_or(Value::Null);
        value
            .as_object()
            .into_iter()
            .flatten()
            .map(|(path, e)| (path.clone(), Entry::from_json(e)))
            .collect()
    }

    pub fn save(&self, entries: &BTreeMap<String, Entry>) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| format!("could not make {}: {e}", self.dir.display()))?;
        let partial = self.dir.join("results.json.tmp");
        std::fs::write(
            &partial,
            serde_json::to_vec(&Value::Object(
                entries
                    .iter()
                    .map(|(p, e)| (p.clone(), e.to_json()))
                    .collect(),
            ))
            .map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        std::fs::rename(&partial, self.file()).map_err(|e| e.to_string())
    }

    fn journal_dir(&self, batch: &str) -> PathBuf {
        self.dir.join("batches").join(batch)
    }
}

fn candidates(proposals: &[Proposal]) -> Vec<Candidate> {
    proposals
        .iter()
        .take(4)
        .map(|p| Candidate {
            release_id: p.release_id.clone(),
            release_group_id: p.release_group_id.clone(),
            edition: p.edition.clone(),
            confidence: p.confidence,
            artist: p.artist.clone(),
            album: p.album.clone(),
        })
        .collect()
}

fn most_common_year(folder: &Folder) -> u32 {
    let mut counts: BTreeMap<u32, usize> = BTreeMap::new();
    for year in folder.files.iter().filter_map(|f| f.tags.year) {
        *counts.entry(year).or_default() += 1;
    }
    counts
        .into_iter()
        .max_by_key(|(year, n)| (*n, *year))
        .map(|(year, _)| year)
        .unwrap_or(0)
}

/// The proposals the judge needs, without the per-song tag changes (they are large and not used).
fn slim(proposals: &[Proposal]) -> Vec<Value> {
    proposals
        .iter()
        .take(6)
        .map(|p| {
            let mut p = p.clone();
            for file in &mut p.files {
                file.changes.clear();
                file.differences.clear();
            }
            serde_json::to_value(&p).unwrap_or(Value::Null)
        })
        .collect()
}

fn set_verdict(entry: &mut Entry, verdict: Verdict) {
    entry.release_id.clear();
    entry.release_group_id.clear();
    entry.edition.clear();
    entry.reason.clear();
    match verdict {
        Verdict::Ready {
            release_id,
            release_group_id,
            edition,
        } => {
            entry.status = "ready".into();
            entry.release_id = release_id;
            entry.release_group_id = release_group_id;
            entry.edition = edition;
        }
        Verdict::AlbumOnly {
            release_group_id,
            editions,
        } => {
            entry.status = "album_only".into();
            entry.release_group_id = release_group_id;
            entry.reason = format!("{editions} editions fit equally; the album is certain.");
        }
        Verdict::Review { reason } => {
            entry.status = "review".into();
            entry.reason = reason;
        }
    }
}

/// Judges an answer again from its saved evidence (the rules changed), with no question to MusicBrainz.
fn rejudge(entry: &mut Entry) {
    if entry.proposals.is_empty()
        || !matches!(entry.status.as_str(), "ready" | "album_only" | "review")
    {
        return;
    }
    let proposals: Vec<Proposal> = entry
        .proposals
        .iter()
        .filter_map(|v| serde_json::from_value(v.clone()).ok())
        .collect();
    if proposals.is_empty() {
        return;
    }
    let year = (entry.year > 0).then_some(entry.year);
    let folder = Folder {
        parents: Vec::new(),
        files: (0..entry.songs)
            .map(|i| mediaverse_tag_repair::FolderFile {
                path: i.to_string(),
                stem: i.to_string(),
                tags: mediaverse_tag_repair::Tags {
                    year,
                    ..Default::default()
                },
                length_ms: 0,
            })
            .collect(),
    };
    set_verdict(entry, judge(&folder, &proposals));
    entry.rules = RULES;
}

/// An earlier answer that stays good after the rules changed: nothing to ask again.
fn reusable(entry: &Entry) -> bool {
    entry.rules == RULES
        || matches!(entry.status.as_str(), "has_ids" | "too_few")
        || !entry.proposals.is_empty()
        || (entry.status == "review" && entry.reason.starts_with("No MusicBrainz release"))
}
/// One folder looked up and judged. A lookup that failed (offline, MusicBrainz refusing) is `error`, tried again next time.
fn identify(
    dir: &Path,
    files: &[PathBuf],
    root: &Path,
    sig: String,
    settings: &MetadataSettings,
    state: &MetadataState,
) -> Entry {
    let mut entry = Entry {
        sig,
        songs: files.len(),
        rules: RULES,
        ..Default::default()
    };
    // Already carrying the IDs on every song: nothing to do.
    let has_ids = files.iter().all(|f| {
        read_tag_fields(f, &ID_FIELDS)
            .ok()
            .is_some_and(|v| v.iter().any(|(_, value)| value.is_some()))
    });
    if has_ids && !files.is_empty() {
        entry.status = "has_ids".into();
        return entry;
    }
    let read: Vec<_> = files.iter().filter_map(|f| read_file(f).ok()).collect();
    if read.len() < files.len() {
        entry.status = "review".into();
        entry.reason = "Some songs' tags could not be read.".into();
        return entry;
    }
    if read.len() < MIN_SONGS {
        entry.status = "too_few".into();
        entry.reason = format!(
            "Only {} song{}: too few to recognise by their lengths.",
            read.len(),
            if read.len() == 1 { "" } else { "s" }
        );
        return entry;
    }
    let folder = Folder {
        parents: parents(dir, root),
        files: read,
    };
    let mut proposals: Vec<Proposal> = Vec::new();
    let mut problem: Option<String> = None;
    let mut method = "";
    if let Some(toc) = folder.toc() {
        match musicbrainz_get(
            &musicbrainz::toc_search_url(&settings.musicbrainz.base_url, &toc),
            settings,
            state,
        ) {
            Ok(Some(body)) => match parse_releases(&body) {
                Ok(releases) => proposals = credible(rank(&folder, &releases)),
                Err(message) => problem = Some(message),
            },
            Ok(None) => {}
            Err((_, message)) => problem = Some(message),
        }
    }
    if !proposals.is_empty() {
        method = "disc layout";
    }
    if proposals.is_empty() && problem.is_none() {
        method = "names";
        match search_by_name(&folder, settings, state) {
            Ok(releases) => proposals = credible(rank(&folder, &releases)),
            Err((_, message)) => problem = Some(message),
        }
    }
    if let Some(message) = problem {
        entry.status = "error".into();
        entry.reason = message;
        return entry;
    }
    entry.candidates = candidates(&proposals);
    entry.method = method.to_owned();
    entry.year = most_common_year(&folder);
    entry.proposals = slim(&proposals);
    if let Some(top) = proposals.first() {
        entry.artist = top.artist.clone();
        entry.album = top.album.clone();
    }
    set_verdict(&mut entry, judge(&folder, &proposals));
    entry
}

/// The scan job: every album folder not yet answered (or changed since), one MusicBrainz question at a time.
pub fn scan(
    root: &Path,
    store: &Store,
    settings: &MetadataSettings,
    state: &MetadataState,
    again: bool,
    stop: &AtomicBool,
    progress: &ScanState,
    emit: &dyn Fn(&ScanState),
) -> Result<Value, String> {
    let folders = crate::tag_repair::album_folders(root);
    let mut entries = store.load();
    let keep: std::collections::HashSet<String> = folders
        .iter()
        .map(|(dir, _)| dir.to_string_lossy().into_owned())
        .collect();
    entries.retain(|path, _| keep.contains(path));
    for entry in entries
        .values_mut()
        .filter(|e| e.rules != RULES && reusable(e))
    {
        rejudge(entry);
        if entry.rules != RULES && matches!(entry.status.as_str(), "has_ids" | "too_few" | "review")
        {
            entry.rules = RULES;
        }
    }
    let todo: Vec<(PathBuf, Vec<PathBuf>, String)> = folders
        .into_iter()
        .filter_map(|(dir, files)| {
            let sig = signature(&files);
            let key = dir.to_string_lossy().into_owned();
            let fresh = entries.get(&key).is_some_and(|e| {
                e.sig == sig
                    && reusable(e)
                    && e.status != "error"
                    && !(again && e.status != "dismissed")
            });
            (!fresh).then_some((dir, files, sig))
        })
        .collect();
    progress.total.store(todo.len(), Ordering::Relaxed);
    emit(progress);
    let mut stopped = false;
    for (dir, files, sig) in todo {
        if stop.load(Ordering::Relaxed) {
            stopped = true;
            break;
        }
        if let Ok(mut current) = progress.current.lock() {
            *current = dir
                .strip_prefix(root)
                .unwrap_or(&dir)
                .to_string_lossy()
                .into_owned();
        }
        let entry = std::panic::catch_unwind(std::panic::AssertUnwindSafe(|| {
            identify(&dir, &files, root, sig.clone(), settings, state)
        }))
        .unwrap_or_else(|_| Entry {
            sig,
            rules: RULES,
            status: "error".into(),
            reason: "Reading this folder failed unexpectedly.".into(),
            ..Default::default()
        });
        match entry.status.as_str() {
            "ready" | "album_only" | "has_ids" => {
                progress.identified.fetch_add(1, Ordering::Relaxed)
            }
            _ => progress.unmatched.fetch_add(1, Ordering::Relaxed),
        };
        entries.insert(dir.to_string_lossy().into_owned(), entry);
        let done = progress.done.fetch_add(1, Ordering::Relaxed) + 1;
        if done % 10 == 0 {
            store.save(&entries)?;
        }
        emit(progress);
    }
    store.save(&entries)?;
    Ok(
        json!({ "stopped": stopped, "done": progress.done.load(Ordering::Relaxed), "counts": counts(&entries) }),
    )
}

pub fn counts(entries: &BTreeMap<String, Entry>) -> Value {
    let mut map: BTreeMap<&str, usize> = BTreeMap::new();
    for entry in entries.values() {
        *map.entry(entry.status.as_str()).or_default() += 1;
    }
    json!({
        "ready": map.get("ready").copied().unwrap_or(0), "album_only": map.get("album_only").copied().unwrap_or(0), "review": map.get("review").copied().unwrap_or(0),
        "has_ids": map.get("has_ids").copied().unwrap_or(0), "too_few": map.get("too_few").copied().unwrap_or(0), "applied": map.get("applied").copied().unwrap_or(0), "dismissed": map.get("dismissed").copied().unwrap_or(0),
        "error": map.get("error").copied().unwrap_or(0), "total": entries.len(),
    })
}

/// The evidence behind an answer, as Fix tags shows it: the chosen release's (or the closest one's) reasons, each good or warning.
fn evidence_of(entry: &Entry) -> Value {
    let chosen = entry
        .proposals
        .iter()
        .find(|p| !entry.release_id.is_empty() && p["release_id"] == entry.release_id.as_str())
        .or_else(|| entry.proposals.first());
    chosen.map_or(json!([]), |p| p["evidence"].clone())
}

/// The counts and a page of the albums set aside (`filter` "review"), or every answer of a kind.
pub fn list(store: &Store, root: &Path, filter: &str, offset: usize, limit: usize) -> Value {
    let entries = store.load();
    let rows: Vec<Value> = entries
        .iter()
        .filter(|(_, e)| e.status == filter)
        .skip(offset)
        .take(limit)
        .map(|(path, e)| {
            let name = Path::new(path).strip_prefix(root).unwrap_or(Path::new(path)).to_string_lossy().into_owned();
            json!({ "path": path, "name": name, "reason": e.reason, "songs": e.songs, "artist": e.artist, "album": e.album, "candidates": e.candidates.iter().map(Candidate::to_json).collect::<Vec<_>>(), "edition": e.edition,
                "method": e.method, "release_id": e.release_id, "release_group_id": e.release_group_id, "evidence": evidence_of(e) })
        })
        .collect();
    let total = entries.values().filter(|e| e.status == filter).count();
    json!({ "counts": counts(&entries), "filter": filter, "total": total, "rows": rows })
}

/// Marks an album as one to leave alone ("not on MusicBrainz", "I will fix it myself").
pub fn dismiss(store: &Store, path: &str, undo: bool) -> Result<(), String> {
    let mut entries = store.load();
    let entry = entries
        .get_mut(path)
        .ok_or("This album is no longer in the results.")?;
    entry.status = if undo {
        "review".into()
    } else {
        "dismissed".into()
    };
    store.save(&entries)
}

/// What to write into one folder: both IDs for `Ready` / a chosen release, the album's alone for `album_only`.
fn wanted(entry: &Entry, chosen: Option<&Candidate>) -> Vec<(TagField, String)> {
    let (release, group) = match chosen {
        Some(c) => (c.release_id.clone(), c.release_group_id.clone()),
        None if entry.status == "ready" => {
            (entry.release_id.clone(), entry.release_group_id.clone())
        }
        None => (String::new(), entry.release_group_id.clone()),
    };
    let mut fields = Vec::new();
    if !release.is_empty() {
        fields.push((TagField::MusicBrainzReleaseId, release));
    }
    if !group.is_empty() {
        fields.push((TagField::MusicBrainzReleaseGroupId, group));
    }
    fields
}

/// Writes the IDs into the albums asked for (`only`: those folders, with an optional chosen release; otherwise every
/// `ready` and `album_only` album). Only songs without that ID get it. Each tag written is journalled in `batch`.
pub fn apply(
    store: &Store,
    batch: &str,
    only: Option<&[(String, Option<Candidate>)]>,
    stop: &AtomicBool,
    progress: &dyn Fn(usize, usize),
) -> Result<Value, String> {
    let mut entries = store.load();
    let jobs: Vec<(String, Option<Candidate>)> = match only {
        Some(list) => list.to_vec(),
        None => entries
            .iter()
            .filter(|(_, e)| matches!(e.status.as_str(), "ready" | "album_only"))
            .map(|(p, _)| (p.clone(), None))
            .collect(),
    };
    let journal_dir = store.journal_dir(batch);
    std::fs::create_dir_all(&journal_dir)
        .map_err(|e| format!("could not make the undo folder: {e}"))?;
    let mut journal = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(journal_dir.join("journal.jsonl"))
        .map_err(|e| e.to_string())?;
    let (mut albums, mut songs, mut skipped, mut problems) =
        (0usize, 0usize, Vec::new(), Vec::new());
    let total = jobs.len();
    for (done, (path, chosen)) in jobs.iter().enumerate() {
        if stop.load(Ordering::Relaxed) {
            break;
        }
        progress(done, total);
        let Some(entry) = entries.get(path).cloned() else {
            continue;
        };
        let files = audio_files(Path::new(path));
        if chosen.is_none() && signature(&files) != entry.sig {
            skipped.push(json!({ "path": path, "message": "Its songs changed after they were checked; scan again." }));
            continue;
        }
        let fields = wanted(&entry, chosen.as_ref());
        if fields.is_empty() {
            continue;
        }
        let mut wrote = false;
        for file in &files {
            let have = match read_tag_fields(file, &ID_FIELDS) {
                Ok(have) => have,
                Err(e) => {
                    problems
                        .push(json!({ "path": file.to_string_lossy(), "message": e.to_string() }));
                    continue;
                }
            };
            // A chosen release is the person's decision, so it replaces; an automatic one fills gaps only.
            let changes: Vec<(TagField, Option<String>)> = fields
                .iter()
                .filter(|(field, value)| {
                    let current = have
                        .iter()
                        .find(|(f, _)| f == field)
                        .and_then(|(_, v)| v.clone());
                    current.as_deref() != Some(value.as_str())
                        && (chosen.is_some() || current.is_none())
                })
                .map(|(field, value)| (*field, Some(value.clone())))
                .collect();
            if changes.is_empty() {
                continue;
            }
            match patch_track_metadata(file, &changes) {
                Ok(before) => {
                    for ((field, new), (_, old)) in changes.iter().zip(before) {
                        let line = json!({ "path": file.to_string_lossy(), "field": field.name(), "old": old, "new": new });
                        writeln!(journal, "{line}").map_err(|e| {
                            format!("a tag was written but could not be journalled: {e}")
                        })?;
                    }
                    songs += 1;
                    wrote = true;
                }
                Err(e) => problems
                    .push(json!({ "path": file.to_string_lossy(), "message": e.to_string() })),
            }
        }
        if wrote {
            albums += 1;
        }
        if let Some(e) = entries.get_mut(path) {
            if problems.is_empty() || wrote {
                e.status = "applied".into();
                e.sig = signature(&audio_files(Path::new(path)));
                if let Some(c) = chosen {
                    e.release_id = c.release_id.clone();
                    e.release_group_id = c.release_group_id.clone();
                    e.edition = c.edition.clone();
                }
            }
        }
    }
    store.save(&entries)?;
    progress(total, total);
    Ok(
        json!({ "batch": if songs > 0 { json!(batch) } else { Value::Null }, "albums": albums, "songs": songs, "skipped": skipped, "problems": problems, "counts": counts(&entries) }),
    )
}

/// Puts every tag a batch added back as it was (absent), unless the song's value has been changed again since.
pub fn undo(store: &Store, batch: &str) -> Result<Value, String> {
    let text = std::fs::read_to_string(store.journal_dir(batch).join("journal.jsonl"))
        .map_err(|_| "That batch was not found.".to_owned())?;
    let (mut restored, mut left, mut problems) = (0usize, 0usize, Vec::new());
    for line in text
        .lines()
        .filter_map(|l| serde_json::from_str::<Value>(l).ok())
    {
        let (Some(path), Some(field)) = (
            line["path"].as_str(),
            line["field"].as_str().and_then(TagField::from_name),
        ) else {
            continue;
        };
        let new = line["new"].as_str();
        let old = line["old"].as_str().map(str::to_owned);
        let Ok(now) = read_tag_fields(Path::new(path), &[field]) else {
            problems.push(json!({ "path": path, "message": "The song could not be read." }));
            continue;
        };
        if now[0].1.as_deref() != new {
            left += 1;
            continue;
        }
        match patch_track_metadata(Path::new(path), &[(field, old)]) {
            Ok(_) => restored += 1,
            Err(e) => problems.push(json!({ "path": path, "message": e.to_string() })),
        }
    }
    // The albums are looked at again by the next scan (their songs changed, so their signatures differ).
    let mut entries = store.load();
    for entry in entries.values_mut().filter(|e| e.status == "applied") {
        entry.sig.clear();
    }
    store.save(&entries)?;
    Ok(json!({ "restored": restored, "left_alone": left, "problems": problems }))
}

#[cfg(test)]
mod tests {
    use super::*;

    /// A real MP3: four valid MPEG-1 layer III frames.
    fn mp3(path: &Path) {
        let mut bytes = Vec::new();
        for _ in 0..4 {
            bytes.extend_from_slice(&[0xFF, 0xFB, 0x90, 0x00]);
            bytes.extend(std::iter::repeat_n(0u8, 413));
        }
        std::fs::write(path, bytes).unwrap();
        patch_track_metadata(path, &[(TagField::Title, Some("Song".into()))]).unwrap();
    }

    #[test]
    fn ids_are_written_into_songs_that_lack_them_journalled_and_undone() {
        let temp = std::env::temp_dir().join(format!("mv-mbids-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        let album = temp.join("lib").join("AFI").join("Crash Love");
        std::fs::create_dir_all(&album).unwrap();
        let songs: Vec<PathBuf> = (1..=3).map(|n| album.join(format!("{n:02}.mp3"))).collect();
        songs.iter().for_each(|s| mp3(s));
        // One song already carries a different release id: an automatic write leaves it alone.
        patch_track_metadata(
            &songs[0],
            &[(TagField::MusicBrainzReleaseId, Some("old-release".into()))],
        )
        .unwrap();

        let store = Store::new(&temp.join("data"));
        let mut entries = BTreeMap::new();
        entries.insert(
            album.to_string_lossy().into_owned(),
            Entry {
                sig: signature(&audio_files(&album)),
                status: "ready".into(),
                release_id: "rel-1".into(),
                release_group_id: "grp-1".into(),
                songs: 3,
                ..Default::default()
            },
        );
        store.save(&entries).unwrap();

        let stop = AtomicBool::new(false);
        let result = apply(&store, "b1", None, &stop, &|_, _| {}).unwrap();
        assert_eq!(result["songs"], 3);
        let ids = |p: &Path| {
            read_tag_fields(p, &ID_FIELDS)
                .unwrap()
                .into_iter()
                .map(|(_, v)| v)
                .collect::<Vec<_>>()
        };
        assert_eq!(
            ids(&songs[0]),
            vec![Some("old-release".to_owned()), Some("grp-1".to_owned())]
        );
        assert_eq!(
            ids(&songs[1]),
            vec![Some("rel-1".to_owned()), Some("grp-1".to_owned())]
        );
        assert_eq!(store.load().values().next().unwrap().status, "applied");
        // Title and the rest of the tag survive.
        assert_eq!(
            read_tag_fields(&songs[1], &[TagField::Title]).unwrap()[0]
                .1
                .as_deref(),
            Some("Song")
        );

        let undone = undo(&store, "b1").unwrap();
        assert_eq!(undone["restored"], 5);
        assert_eq!(ids(&songs[0]), vec![Some("old-release".to_owned()), None]);
        assert_eq!(ids(&songs[2]), vec![None, None]);
        let _ = std::fs::remove_dir_all(&temp);
    }

    #[test]
    fn saved_evidence_is_judged_again_without_asking_musicbrainz() {
        use mediaverse_tag_repair::{Evidence, EvidenceKind, FileProposal};
        let proposal = Proposal {
            release_id: "r1".into(),
            release_group_id: "g1".into(),
            medium: 1,
            artist: "AFI".into(),
            album: "Crash Love".into(),
            edition: "2009 · Interscope · US · CD".into(),
            barcode: String::new(),
            catalog_number: String::new(),
            source: "musicbrainz".into(),
            url: String::new(),
            confidence: 96,
            evidence: vec![Evidence {
                kind: EvidenceKind::Good,
                text: "Titles agree 11 of 12".into(),
            }],
            files: (0..12)
                .map(|i| FileProposal {
                    path: i.to_string(),
                    track: i + 1,
                    changes: vec![],
                    differences: vec![],
                    fit: 90,
                })
                .collect(),
        };
        let mut entry = Entry {
            status: "review".into(),
            reason: "old rules".into(),
            songs: 12,
            rules: 1,
            proposals: slim(&[proposal]),
            ..Default::default()
        };
        assert!(reusable(&entry));
        rejudge(&mut entry);
        assert_eq!(
            (
                entry.status.as_str(),
                entry.release_id.as_str(),
                entry.rules
            ),
            ("ready", "r1", RULES)
        );
        // It survives the file round trip.
        let again = Entry::from_json(&entry.to_json());
        assert_eq!(again.proposals.len(), 1);
        assert_eq!(again.songs, 12);
    }

    #[test]
    fn an_album_changed_since_the_scan_is_not_written() {
        let temp = std::env::temp_dir().join(format!("mv-mbids2-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&temp);
        let album = temp.join("lib").join("A").join("B");
        std::fs::create_dir_all(&album).unwrap();
        mp3(&album.join("01.mp3"));
        let store = Store::new(&temp.join("data"));
        let mut entries = BTreeMap::new();
        entries.insert(
            album.to_string_lossy().into_owned(),
            Entry {
                sig: "old".into(),
                status: "ready".into(),
                release_id: "r".into(),
                release_group_id: "g".into(),
                ..Default::default()
            },
        );
        store.save(&entries).unwrap();
        let result = apply(&store, "b2", None, &AtomicBool::new(false), &|_, _| {}).unwrap();
        assert_eq!(result["songs"], 0);
        assert_eq!(result["skipped"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&temp);
    }
}
