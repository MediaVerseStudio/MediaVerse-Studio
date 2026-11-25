//! The organiser's apply step and its undo (issue #9). Moves each song to the place the rule gave it, taking with it the lyrics file beside it and, when its
//! whole folder moves, the folder's cover pictures; then rewrites every saved reference to the songs' paths (`path_move`), removes folders left empty, and
//! writes a journal so the whole batch can be undone. Rules that keep the library safe:
//! - a song is only moved to a place that is free (nothing is ever overwritten) and inside the library folder, with the same file extension;
//! - a song that cannot be moved is left exactly where it was, with its lyrics file, and reported;
//! - a folder is removed only when it is completely empty;
//! - nothing is deleted: cover pictures that have to be in two places are copied, and the journal can put it all back.

use crate::path_move::{Rewriter, key, rewrite_all};
use serde_json::{Value, json};
use std::collections::{BTreeMap, BTreeSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const AUDIO: [&str; 7] = ["aac", "flac", "m4a", "mp3", "ogg", "opus", "wav"];
const ART: [&str; 10] = [
    "cover.jpg",
    "cover.png",
    "folder.jpg",
    "folder.png",
    "front.jpg",
    "front.png",
    "back.jpg",
    "back.png",
    "artist.jpg",
    "artist.png",
];
const KEEP_BATCHES: usize = 5;

type Pair = (String, String);

fn is_audio(path: &Path) -> bool {
    path.extension()
        .and_then(|e| e.to_str())
        .is_some_and(|e| AUDIO.contains(&e.to_ascii_lowercase().as_str()))
}

fn text(path: &Path) -> String {
    path.to_string_lossy().into_owned()
}

fn inside(root: &Path, path: &Path) -> bool {
    key(&text(path)).starts_with(&format!("{}/", key(&text(root)).trim_end_matches('/')))
}

/// A batch of moves as it was done, kept so it can be undone.
#[derive(Debug, Clone, Default)]
pub struct Batch {
    pub id: u64,
    pub at: u64,
    pub pattern: String,
    pub moves: Vec<Pair>,
    pub lyrics: Vec<Pair>,
    pub art_moved: Vec<Pair>,
    pub art_copied: Vec<String>,
    pub folders: Vec<Pair>,
    pub made_dirs: Vec<String>,
}

fn pairs(list: &[Pair]) -> Value {
    Value::Array(list.iter().map(|(a, b)| json!([a, b])).collect())
}

fn read_pairs(value: &Value) -> Vec<Pair> {
    value
        .as_array()
        .into_iter()
        .flatten()
        .filter_map(|p| {
            Some((
                p.get(0)?.as_str()?.to_owned(),
                p.get(1)?.as_str()?.to_owned(),
            ))
        })
        .collect()
}

impl Batch {
    fn to_json(&self) -> Value {
        json!({ "id": self.id, "at": self.at, "pattern": self.pattern, "moves": pairs(&self.moves), "lyrics": pairs(&self.lyrics), "art_moved": pairs(&self.art_moved),
                "art_copied": self.art_copied, "folders": pairs(&self.folders), "made_dirs": self.made_dirs })
    }

    fn from_json(v: &Value) -> Option<Batch> {
        Some(Batch {
            id: v.get("id")?.as_u64()?,
            at: v.get("at")?.as_u64()?,
            pattern: v.get("pattern")?.as_str()?.to_owned(),
            moves: read_pairs(v.get("moves")?),
            lyrics: read_pairs(v.get("lyrics")?),
            art_moved: read_pairs(v.get("art_moved")?),
            art_copied: v
                .get("art_copied")?
                .as_array()?
                .iter()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect(),
            folders: read_pairs(v.get("folders")?),
            made_dirs: v
                .get("made_dirs")?
                .as_array()?
                .iter()
                .filter_map(|s| s.as_str().map(str::to_owned))
                .collect(),
        })
    }
}

fn journal_path(data_dir: &Path) -> PathBuf {
    data_dir.join("organize-journal.json")
}

pub fn read_journal(data_dir: &Path) -> Vec<Batch> {
    std::fs::read_to_string(journal_path(data_dir))
        .ok()
        .and_then(|t| serde_json::from_str::<Value>(&t).ok())
        .and_then(|v| {
            v.get("batches")
                .and_then(Value::as_array)
                .map(|a| a.iter().filter_map(Batch::from_json).collect())
        })
        .unwrap_or_default()
}

fn write_journal(data_dir: &Path, batches: &[Batch]) -> std::io::Result<()> {
    std::fs::create_dir_all(data_dir)?;
    let kept = &batches[batches.len().saturating_sub(KEEP_BATCHES)..];
    std::fs::write(
        journal_path(data_dir),
        json!({ "batches": kept.iter().map(Batch::to_json).collect::<Vec<_>>() }).to_string(),
    )
}

/// What the last batch was, for the page's Undo button: (when, songs moved), or None.
pub fn last_batch(data_dir: &Path) -> Option<(u64, usize)> {
    read_journal(data_dir).last().map(|b| (b.at, b.moves.len()))
}

#[derive(Debug, Default)]
pub struct Outcome {
    pub batch: u64,
    pub moved: usize,
    pub failed: Vec<(String, String)>,
    pub lyrics: usize,
    pub art_moved: usize,
    pub art_copied: usize,
    pub folders_removed: usize,
    pub references: Vec<(String, usize)>,
}

impl Outcome {
    pub fn json(&self) -> Value {
        json!({
            "batch": self.batch, "moved": self.moved, "lyrics": self.lyrics, "art_moved": self.art_moved, "art_copied": self.art_copied, "folders_removed": self.folders_removed,
            "failed_total": self.failed.len(), "failed": self.failed.iter().take(200).map(|(p, why)| json!({ "path": p, "why": why })).collect::<Vec<_>>(),
            "references": self.references.iter().map(|(what, n)| json!({ "what": what, "changed": n })).collect::<Vec<_>>(),
        })
    }
}

fn now() -> u64 {
    std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map_or(0, |d| d.as_secs())
}

/// Creates the folders a file needs; returns the ones that did not exist before (deepest last).
fn make_parents(file: &Path, made: &mut Vec<String>) -> std::io::Result<()> {
    let Some(parent) = file.parent() else {
        return Ok(());
    };
    let mut missing = Vec::new();
    let mut at = parent;
    while !at.exists() {
        missing.push(at.to_path_buf());
        match at.parent() {
            Some(p) => at = p,
            None => break,
        }
    }
    std::fs::create_dir_all(parent)?;
    missing.reverse();
    made.extend(missing.iter().map(|p| text(p)));
    Ok(())
}

fn move_file(from: &Path, to: &Path, made: &mut Vec<String>) -> Result<(), String> {
    if !from.is_file() {
        return Err("the file is no longer there".to_owned());
    }
    if to.exists() {
        return Err("another file is already at the new place".to_owned());
    }
    make_parents(to, made).map_err(|e| format!("could not make the folder: {e}"))?;
    std::fs::rename(from, to).map_err(|e| format!("could not move it: {e}"))
}

fn remove_if_empty_up_to(root: &Path, dir: &Path) -> usize {
    let mut removed = 0;
    let mut at = dir.to_path_buf();
    while inside(root, &at)
        && at.is_dir()
        && std::fs::read_dir(&at).is_ok_and(|mut d| d.next().is_none())
    {
        if std::fs::remove_dir(&at).is_err() {
            break;
        }
        removed += 1;
        match at.parent() {
            Some(p) => at = p.to_path_buf(),
            None => break,
        }
    }
    removed
}

/// Moves the songs of `plan`, then everything that goes with them. `progress(done, total)` is called now and then; `stop` ends it between songs (what is done stays done and is journaled).
pub fn execute(
    root: &Path,
    plan: &[Pair],
    data_dir: &Path,
    pattern: &str,
    progress: &dyn Fn(usize, usize),
    stop: &AtomicBool,
) -> Outcome {
    let mut batch = Batch {
        id: now(),
        at: now(),
        pattern: pattern.to_owned(),
        ..Batch::default()
    };
    let mut out = Outcome {
        batch: batch.id,
        ..Outcome::default()
    };
    let mut by_source: BTreeMap<String, BTreeSet<String>> = BTreeMap::new();
    for (n, (from, to)) in plan.iter().enumerate() {
        if stop.load(Ordering::SeqCst) {
            break;
        }
        if n % 100 == 0 {
            progress(n, plan.len());
        }
        let (f, t) = (PathBuf::from(from), PathBuf::from(to));
        let same_kind = f.extension().map(|e| e.to_ascii_lowercase())
            == t.extension().map(|e| e.to_ascii_lowercase());
        if !inside(root, &f) || !inside(root, &t) || !is_audio(&f) || !same_kind {
            out.failed.push((
                from.clone(),
                "this move is outside the library or not a song, so it was not made".to_owned(),
            ));
            continue;
        }
        let lrc_from = f.with_extension("lrc");
        let lrc_to = t.with_extension("lrc");
        if let Err(why) = move_file(&f, &t, &mut batch.made_dirs) {
            out.failed.push((from.clone(), why));
            continue;
        }
        batch.moves.push((from.clone(), to.clone()));
        out.moved += 1;
        if lrc_from.is_file() && !lrc_to.exists() {
            match std::fs::rename(&lrc_from, &lrc_to) {
                Ok(()) => {
                    batch.lyrics.push((text(&lrc_from), text(&lrc_to)));
                    out.lyrics += 1;
                }
                Err(e) => out.failed.push((
                    text(&lrc_from),
                    format!("the lyrics file could not follow the song: {e}"),
                )),
            }
        }
        if let (Some(a), Some(b)) = (f.parent(), t.parent()) {
            by_source.entry(text(a)).or_default().insert(text(b));
        }
    }
    // Cover pictures kept in the song's folder: moved when the whole folder moves to one place, otherwise copied to where the songs went.
    for (source, targets) in &by_source {
        let source = Path::new(source);
        let audio_left =
            std::fs::read_dir(source).is_ok_and(|d| d.flatten().any(|e| is_audio(&e.path())));
        for name in ART {
            let from = source.join(name);
            if !from.is_file() {
                continue;
            }
            for target in targets {
                let to = Path::new(target).join(name);
                if to.exists() {
                    continue;
                }
                let only_target = targets.len() == 1;
                if only_target && !audio_left {
                    if std::fs::rename(&from, &to).is_ok() {
                        batch.art_moved.push((text(&from), text(&to)));
                        out.art_moved += 1;
                    }
                } else if std::fs::copy(&from, &to).is_ok() {
                    batch.art_copied.push(text(&to));
                    out.art_copied += 1;
                }
            }
        }
        if !audio_left && targets.len() == 1 {
            batch.folders.push((
                text(source),
                targets.iter().next().cloned().unwrap_or_default(),
            ));
        }
    }
    for source in by_source.keys() {
        out.folders_removed += remove_if_empty_up_to(root, Path::new(source));
    }
    out.references = rewrite_all(data_dir, &Rewriter::new(&batch.moves, &batch.folders));
    progress(plan.len(), plan.len());
    if !batch.moves.is_empty() {
        let mut journal = read_journal(data_dir);
        journal.push(batch);
        let _ = write_journal(data_dir, &journal);
    }
    out
}

/// Puts the last batch back: songs, lyrics files, moved pictures; removes copied pictures and the folders the batch made if they are empty; and rewrites the
/// references the other way. A file that is not where the journal says (moved again by hand) is left alone and reported.
pub fn undo(root: &Path, data_dir: &Path) -> Result<Outcome, String> {
    let mut journal = read_journal(data_dir);
    let Some(batch) = journal.pop() else {
        return Err("There is nothing to undo.".to_owned());
    };
    let mut out = Outcome {
        batch: batch.id,
        ..Outcome::default()
    };
    let mut scratch = Vec::new();
    for copy in &batch.art_copied {
        let _ = std::fs::remove_file(copy);
    }
    // The songs first (that makes their folders again), then what went with them.
    let mut restored = Vec::new();
    for (from, to) in batch.moves.iter().rev() {
        match move_file(Path::new(to), Path::new(from), &mut scratch) {
            Ok(()) => {
                restored.push((from.clone(), to.clone()));
                out.moved += 1;
            }
            Err(why) => out
                .failed
                .push((to.clone(), format!("could not be put back: {why}"))),
        }
    }
    for (from, to) in batch.lyrics.iter().rev() {
        if Path::new(to).is_file() && !Path::new(from).exists() {
            let _ = make_parents(Path::new(from), &mut scratch);
            if std::fs::rename(to, from).is_ok() {
                out.lyrics += 1;
            }
        }
    }
    for (from, to) in batch.art_moved.iter().rev() {
        if Path::new(to).is_file() && !Path::new(from).exists() {
            let _ = make_parents(Path::new(from), &mut scratch);
            if std::fs::rename(to, from).is_ok() {
                out.art_moved += 1;
            }
        }
    }
    for dir in batch.made_dirs.iter().rev() {
        out.folders_removed += remove_if_empty_up_to(root, Path::new(dir)).min(1);
    }
    // Only what really went back has its references put back.
    let folder_moves: Vec<Pair> = if out.failed.is_empty() {
        batch.folders.clone()
    } else {
        Vec::new()
    };
    out.references = rewrite_all(data_dir, &Rewriter::inverse(&restored, &folder_moves));
    if out.failed.is_empty() {
        write_journal(data_dir, &journal).map_err(|e| e.to_string())?;
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn tree() -> (PathBuf, PathBuf) {
        static N: std::sync::atomic::AtomicUsize = std::sync::atomic::AtomicUsize::new(0);
        let base = std::env::temp_dir().join(format!(
            "mv-organize-{}-{}",
            std::process::id(),
            N.fetch_add(1, Ordering::SeqCst)
        ));
        let _ = std::fs::remove_dir_all(&base);
        let (root, data) = (base.join("Music"), base.join("data"));
        std::fs::create_dir_all(root.join("misc")).unwrap();
        std::fs::create_dir_all(&data).unwrap();
        (root, data)
    }

    fn file(path: &Path, body: &str) {
        std::fs::create_dir_all(path.parent().unwrap()).unwrap();
        std::fs::write(path, body).unwrap();
    }

    #[test]
    fn songs_move_with_their_lyrics_and_cover_and_every_reference_follows_and_it_can_be_undone() {
        let (root, data) = tree();
        let one = root.join("misc").join("one.mp3");
        let two = root.join("misc").join("two.mp3");
        file(&one, "ONE");
        file(&two, "TWO");
        file(&root.join("misc").join("one.lrc"), "[00:01.00]words");
        file(&root.join("misc").join("cover.jpg"), "PICTURE");
        let plan = vec![
            (
                text(&one),
                text(&root.join("Band").join("Record").join("01 - One.mp3")),
            ),
            (
                text(&two),
                text(&root.join("Band").join("Record").join("02 - Two.mp3")),
            ),
        ];
        file(
            &data.join("favorites.json"),
            &json!({ "favorites": [{ "path": text(&one) }] }).to_string(),
        );
        file(
            &data.join("playlists.json"),
            &json!({ "playlists": [{ "paths": [text(&one), text(&two)] }] }).to_string(),
        );

        let out = execute(
            &root,
            &plan,
            &data,
            "{albumartist}/{album}/{track} - {title}",
            &|_, _| {},
            &AtomicBool::new(false),
        );
        assert_eq!(
            (out.moved, out.lyrics, out.art_moved, out.failed.len()),
            (2, 1, 1, 0),
            "{out:?}"
        );
        assert!(
            root.join("Band/Record/01 - One.mp3").is_file()
                && root.join("Band/Record/01 - One.lrc").is_file()
                && root.join("Band/Record/cover.jpg").is_file()
        );
        assert!(!root.join("misc").exists(), "the emptied folder is gone");
        assert_eq!(
            std::fs::read_to_string(root.join("Band/Record/02 - Two.mp3")).unwrap(),
            "TWO"
        );
        let favorites = std::fs::read_to_string(data.join("favorites.json")).unwrap();
        assert!(favorites.contains("01 - One.mp3") && !favorites.contains("one.mp3"));
        assert!(
            std::fs::read_to_string(data.join("playlists.json"))
                .unwrap()
                .contains("02 - Two.mp3")
        );
        assert_eq!(last_batch(&data).map(|b| b.1), Some(2));

        let back = undo(&root, &data).unwrap();
        assert_eq!(
            (back.moved, back.lyrics, back.art_moved),
            (2, 1, 1),
            "{back:?}"
        );
        assert!(
            one.is_file()
                && two.is_file()
                && root.join("misc/one.lrc").is_file()
                && root.join("misc/cover.jpg").is_file()
        );
        assert!(
            !root.join("Band").exists(),
            "the folders the batch made are gone"
        );
        assert!(
            std::fs::read_to_string(data.join("favorites.json"))
                .unwrap()
                .contains("one.mp3")
        );
        assert_eq!(last_batch(&data), None);
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn nothing_is_overwritten_and_a_song_that_cannot_move_stays_with_its_lyrics() {
        let (root, data) = tree();
        let one = root.join("misc").join("one.mp3");
        file(&one, "ONE");
        file(&root.join("misc").join("one.lrc"), "words");
        let taken = root.join("Band").join("01.mp3");
        file(&taken, "OTHER");
        let outside = std::env::temp_dir().join("mv-outside.mp3");
        let plan = vec![(text(&one), text(&taken)), (text(&one), text(&outside))];
        let out = execute(
            &root,
            &plan,
            &data,
            "x",
            &|_, _| {},
            &AtomicBool::new(false),
        );
        assert_eq!(out.moved, 0);
        assert_eq!(out.failed.len(), 2);
        assert_eq!(std::fs::read_to_string(&taken).unwrap(), "OTHER");
        assert!(one.is_file() && root.join("misc/one.lrc").is_file());
        assert_eq!(last_batch(&data), None, "nothing moved, nothing to undo");
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn a_folder_that_keeps_other_songs_keeps_its_cover_and_the_cover_is_copied() {
        let (root, data) = tree();
        let stay = root.join("misc").join("stay.mp3");
        let go = root.join("misc").join("go.mp3");
        file(&stay, "S");
        file(&go, "G");
        file(&root.join("misc").join("folder.jpg"), "PIC");
        let target = root.join("New").join("go.mp3");
        let out = execute(
            &root,
            &[(text(&go), text(&target))],
            &data,
            "x",
            &|_, _| {},
            &AtomicBool::new(false),
        );
        assert_eq!((out.moved, out.art_copied, out.art_moved), (1, 1, 0));
        assert!(root.join("misc/folder.jpg").is_file() && root.join("New/folder.jpg").is_file());
        undo(&root, &data).unwrap();
        assert!(
            go.is_file() && !root.join("New").exists(),
            "the copy and the made folder are gone"
        );
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }

    #[test]
    fn a_stop_ends_the_batch_between_songs_and_what_is_done_can_still_be_undone() {
        let (root, data) = tree();
        let a = root.join("misc").join("a.mp3");
        file(&a, "A");
        let stop = AtomicBool::new(true);
        let out = execute(
            &root,
            &[(text(&a), text(&root.join("X").join("a.mp3")))],
            &data,
            "x",
            &|_, _| {},
            &stop,
        );
        assert_eq!(out.moved, 0);
        assert!(a.is_file());
        assert!(undo(&root, &data).is_err());
        let _ = std::fs::remove_dir_all(root.parent().unwrap());
    }
}
