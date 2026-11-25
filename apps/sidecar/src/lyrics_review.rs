//! Lyrics to review (owner, 2026-11-06): when the automatic lyrics find only likely matches (another version, the
//! same song by another artist, a song whose length could not be compared), the candidates are kept as their own
//! files, `<data dir>/lyrics-review/<key>.json`, one per song, and nothing is written into the song. The person plays
//! the song with each candidate, adjusts the timing, and confirms (the page then saves the lyrics into the song and
//! removes the entry) or rejects candidates one by one. A song whose candidates are all rejected leaves the list but
//! its file stays, so the automatic lyrics do not offer the same candidates again.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const MAX_CANDIDATES: usize = 8;
const MAX_LYRICS_CHARS: usize = 60_000;

pub struct LyricsReview {
    dir: PathBuf,
}

/// A short, file-name-safe key for a song path (FNV-1a, 64 bits).
pub fn key_of(path: &str) -> String {
    let mut hash: u64 = 0xcbf2_9ce4_8422_2325;
    for byte in path.bytes() {
        hash ^= u64::from(byte);
        hash = hash.wrapping_mul(0x0100_0000_01b3);
    }
    format!("{hash:016x}")
}

fn valid_key(key: &str) -> bool {
    key.len() == 16 && key.bytes().all(|b| b.is_ascii_hexdigit())
}

fn clip(value: &Value, limit: usize) -> Value {
    match value.as_str() {
        Some(text) if !text.trim().is_empty() => Value::String(
            text.chars()
                .filter(|c| *c == '\n' || *c == '\r' || !c.is_control())
                .take(limit)
                .collect(),
        ),
        _ => Value::Null,
    }
}

fn number(value: &Value) -> Value {
    value
        .as_f64()
        .filter(|n| n.is_finite())
        .map_or(Value::Null, |n| json!(n))
}

impl LyricsReview {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            dir: data_dir.join("lyrics-review"),
        }
    }

    fn file(&self, key: &str) -> PathBuf {
        self.dir.join(format!("{key}.json"))
    }

    fn load(&self, key: &str) -> Option<Value> {
        std::fs::read(self.file(key))
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
    }

    fn write(&self, key: &str, entry: &Value) -> Result<(), String> {
        std::fs::create_dir_all(&self.dir)
            .map_err(|e| format!("could not make the lyrics review folder: {e}"))?;
        let temp = self.dir.join(format!("{key}.json.tmp"));
        std::fs::write(
            &temp,
            serde_json::to_vec_pretty(entry).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("could not save the lyrics to review: {e}"))?;
        std::fs::rename(&temp, self.file(key))
            .map_err(|e| format!("could not save the lyrics to review: {e}"))
    }

    /// `save_lyrics_review {path, title, artist, album, duration, candidates}`: keeps the candidates of one song (the
    /// path already checked to be in the library). Candidates without words are dropped; at most eight, best first.
    /// Candidates the person rejected before are not offered again.
    pub fn save(&self, path: &str, args: &Value, now_secs: u64) -> Result<Value, String> {
        let key = key_of(path);
        // Which original artist an album's songs were recognised as covers of (set by the Lyric AI), kept when the entry is saved again.
        let cover_of = self
            .load(&key)
            .map_or(Value::Null, |old| old["cover_of"].clone());
        let rejected: Vec<Value> = self
            .load(&key)
            .and_then(|old| old["candidates"].as_array().cloned())
            .unwrap_or_default()
            .into_iter()
            .filter(|c| c["rejected"] == true)
            .collect();
        let same = |a: &Value, b: &Value| {
            (a["id"].is_number() && a["id"] == b["id"])
                || (a["plain"] == b["plain"] && a["synced"] == b["synced"])
        };
        let mut candidates: Vec<Value> = args["candidates"]
            .as_array()
            .map(|list| {
                list.iter()
                    .map(|c| {
                        json!({
                            "id": c["id"].as_i64(),
                            "track": clip(&c["track"], 200),
                            "artist": clip(&c["artist"], 200),
                            "album": clip(&c["album"], 200),
                            "duration": number(&c["duration"]),
                            "plain": clip(&c["plain"], MAX_LYRICS_CHARS),
                            "synced": clip(&c["synced"], MAX_LYRICS_CHARS),
                            "confidence": c["confidence"].as_u64().unwrap_or(0).min(100),
                            "source": clip(&c["source"], 20),
                            "other_version": c["other_version"] == true,
                            "other_artist": c["other_artist"] == true,
                            "length_unknown": c["length_unknown"] == true,
                            // The timing step's result for the band's own words: approving it replaces only the timing (D169).
                            "band_words": c["band_words"] == true,
                            "rejected": false,
                        })
                    })
                    .filter(|c| c["plain"].is_string() || c["synced"].is_string())
                    .filter(|c| !rejected.iter().any(|r| same(r, c)))
                    .collect()
            })
            .unwrap_or_default();
        candidates.sort_by(|a, b| b["confidence"].as_u64().cmp(&a["confidence"].as_u64()));
        candidates.truncate(MAX_CANDIDATES);
        if candidates.is_empty() {
            return Ok(json!({ "key": key, "kept": 0 }));
        }
        let kept = candidates.len();
        candidates.extend(rejected);
        let entry = json!({
            "key": key,
            "path": path,
            "title": clip(&args["title"], 200),
            "artist": clip(&args["artist"], 200),
            "album": clip(&args["album"], 200),
            "duration": number(&args["duration"]),
            "added": now_secs,
            "cover_of": cover_of,
            "candidates": candidates,
        });
        self.write(&key, &entry)?;
        Ok(json!({ "key": key, "kept": kept }))
    }

    /// `list_lyrics_review`: every song with a candidate still open, without the words (the list is compact; the
    /// words come with `get_lyrics_review`). Best confidence first.
    pub fn list(&self) -> Value {
        let mut items: Vec<Value> = std::fs::read_dir(&self.dir)
            .map(|entries| entries.filter_map(Result::ok).map(|e| e.path()).filter(|p| p.extension().is_some_and(|x| x == "json")).collect::<Vec<_>>())
            .unwrap_or_default()
            .into_iter()
            .filter_map(|file| std::fs::read(file).ok().and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok()))
            .filter_map(|entry| {
                let open: Vec<Value> = entry["candidates"]
                    .as_array()?
                    .iter()
                    .filter(|c| c["rejected"] != true)
                    .map(|c| json!({ "track": c["track"], "artist": c["artist"], "album": c["album"], "duration": c["duration"], "confidence": c["confidence"], "source": c["source"], "synced": c["synced"].is_string(), "other_version": c["other_version"], "other_artist": c["other_artist"], "length_unknown": c["length_unknown"], "band_words": c["band_words"] == true }))
                    .collect();
                if open.is_empty() {
                    return None;
                }
                Some(json!({ "key": entry["key"], "path": entry["path"], "title": entry["title"], "artist": entry["artist"], "album": entry["album"], "duration": entry["duration"], "added": entry["added"], "cover_of": entry["cover_of"], "candidates": open }))
            })
            .collect();
        items.sort_by(|a, b| {
            let best = |v: &Value| v["candidates"][0]["confidence"].as_u64().unwrap_or(0);
            best(b)
                .cmp(&best(a))
                .then_with(|| a["artist"].as_str().cmp(&b["artist"].as_str()))
                .then_with(|| a["title"].as_str().cmp(&b["title"].as_str()))
        });
        json!({ "items": items })
    }

    /// `get_lyrics_review {key}`: one song with the words of its open candidates.
    pub fn get(&self, key: &str) -> Result<Value, String> {
        if !valid_key(key) {
            return Err("unknown entry".to_owned());
        }
        let mut entry = self.load(key).ok_or("this song is no longer in the list")?;
        let open: Vec<Value> = entry["candidates"]
            .as_array()
            .cloned()
            .unwrap_or_default()
            .into_iter()
            .filter(|c| c["rejected"] != true)
            .collect();
        entry["candidates"] = Value::Array(open);
        Ok(entry)
    }

    /// `reject_lyrics_candidate {key, index}`: the open candidate at `index` is not this song's lyrics.
    pub fn reject(&self, key: &str, index: usize) -> Result<Value, String> {
        if !valid_key(key) {
            return Err("unknown entry".to_owned());
        }
        let mut entry = self.load(key).ok_or("this song is no longer in the list")?;
        let list = entry["candidates"]
            .as_array_mut()
            .ok_or("the entry is damaged")?;
        let at = list
            .iter()
            .enumerate()
            .filter(|(_, c)| c["rejected"] != true)
            .nth(index)
            .map(|(i, _)| i)
            .ok_or("no such candidate")?;
        list[at]["rejected"] = json!(true);
        let left = list.iter().filter(|c| c["rejected"] != true).count();
        self.write(key, &entry)?;
        Ok(json!({ "left": left }))
    }

    /// The Lyric AI recognised this song's album as songs of `original` played by someone else: shown in the list as "Cover of ...".
    pub fn mark_cover(&self, key: &str, original: &str) -> Result<(), String> {
        let Some(mut entry) = self.load(key) else {
            return Ok(());
        };
        entry["cover_of"] = clip(&json!(original), 200);
        self.write(key, &entry)
    }

    /// `remove_lyrics_review {key}`: the lyrics were confirmed and saved into the song.
    pub fn remove(&self, key: &str) -> Result<Value, String> {
        if !valid_key(key) {
            return Err("unknown entry".to_owned());
        }
        match std::fs::remove_file(self.file(key)) {
            Ok(()) => Ok(json!({ "removed": true })),
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(json!({ "removed": false })),
            Err(e) => Err(format!("could not remove the entry: {e}")),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> (LyricsReview, PathBuf) {
        let dir = std::env::temp_dir().join(format!(
            "mv-lyrics-review-{}-{}",
            std::process::id(),
            std::thread::current()
                .name()
                .unwrap_or("t")
                .replace("::", "-")
        ));
        let _ = std::fs::remove_dir_all(&dir);
        (LyricsReview::new(&dir), dir)
    }

    fn candidate(id: i64, confidence: u64) -> Value {
        json!({ "id": id, "track": "Song", "artist": "Band", "plain": format!("words {id}"), "synced": null, "confidence": confidence })
    }

    #[test]
    fn candidates_are_kept_best_first_and_listed_without_words() {
        let (review, _dir) = store();
        let args = json!({ "title": "Song", "artist": "Band", "candidates": [candidate(1, 60), candidate(2, 80), json!({ "id": 3, "plain": " ", "confidence": 99 })] });
        let saved = review.save("C:\\m\\a.mp3", &args, 5).unwrap();
        assert_eq!(saved["kept"], 2, "a candidate without words is dropped");
        let list = review.list();
        assert_eq!(list["items"][0]["candidates"][0]["confidence"], 80);
        assert!(
            list["items"][0]["candidates"][0].get("plain").is_none(),
            "the list is compact"
        );
        let key = saved["key"].as_str().unwrap();
        assert_eq!(
            review.get(key).unwrap()["candidates"][0]["plain"],
            "words 2"
        );
    }

    #[test]
    fn rejected_candidates_are_not_offered_again() {
        let (review, _dir) = store();
        let args = json!({ "title": "Song", "artist": "Band", "candidates": [candidate(1, 70), candidate(2, 60)] });
        let key = review.save("C:\\m\\b.mp3", &args, 5).unwrap()["key"]
            .as_str()
            .unwrap()
            .to_owned();
        assert_eq!(review.reject(&key, 0).unwrap()["left"], 1);
        assert_eq!(review.get(&key).unwrap()["candidates"][0]["id"], 2);
        assert_eq!(review.reject(&key, 0).unwrap()["left"], 0);
        assert_eq!(
            review.list()["items"],
            json!([]),
            "all rejected: off the list"
        );
        // Looked up again later: the same candidates stay rejected.
        assert_eq!(review.save("C:\\m\\b.mp3", &args, 6).unwrap()["kept"], 0);
        assert_eq!(review.list()["items"], json!([]));
        assert!(review.reject("../x", 0).is_err());
        assert_eq!(review.remove(&key).unwrap()["removed"], true);
        assert_eq!(review.remove(&key).unwrap()["removed"], false);
    }

    #[test]
    fn a_cover_mark_is_listed_and_survives_the_entry_being_saved_again() {
        let (review, _dir) = store();
        let args = json!({ "title": "Song", "artist": "Band", "candidates": [candidate(1, 70)] });
        let key = review.save("C:\\m\\c.mp3", &args, 5).unwrap()["key"]
            .as_str()
            .unwrap()
            .to_owned();
        assert!(review.list()["items"][0]["cover_of"].is_null());
        review.mark_cover(&key, "Operation Ivy").unwrap();
        assert_eq!(review.list()["items"][0]["cover_of"], "Operation Ivy");
        // the AI puts its own pick first and saves the entry again
        let again = json!({ "title": "Song", "artist": "Band", "candidates": [candidate(2, 100), candidate(1, 70)] });
        review.save("C:\\m\\c.mp3", &again, 9).unwrap();
        assert_eq!(review.list()["items"][0]["cover_of"], "Operation Ivy");
        assert!(
            review.mark_cover("0000000000000000", "X").is_ok(),
            "an entry that is gone is not an error"
        );
    }
}
