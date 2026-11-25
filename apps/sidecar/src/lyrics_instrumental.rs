//! Songs with no words to find: LRCLIB says a recording of the same length is instrumental. The song is left out of
//! Review > Missing lyrics and listed under "Instrumental" instead, where one press puts it back. Nothing is written into
//! the song, so no other program sees a change; the list is `<data dir>/lyrics-instrumental.json`, path -> {source, marked}.
//! A person who has listened can confirm a song: its language tag is set to "zxx" (ISO 639-2, no linguistic content: TLAN in ID3, LANGUAGE in FLAC),
//! which is the standard way to say a recording is instrumental and leaves the genre alone. A confirmed song leaves the list but stays out of Missing
//! lyrics; "Not instrumental" puts the language tag back as it was.

use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};

pub struct Store {
    file: PathBuf,
}

impl Store {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            file: data_dir.join("lyrics-instrumental.json"),
        }
    }

    fn load(&self) -> BTreeMap<String, Value> {
        std::fs::read(&self.file)
            .ok()
            .and_then(|bytes| serde_json::from_slice(&bytes).ok())
            .unwrap_or_default()
    }

    fn save(&self, entries: &BTreeMap<String, Value>) -> Result<(), String> {
        let temp = self.file.with_extension("json.tmp");
        std::fs::write(
            &temp,
            serde_json::to_vec_pretty(entries).map_err(|e| e.to_string())?,
        )
        .map_err(|e| format!("could not save the instrumental list: {e}"))?;
        std::fs::rename(&temp, &self.file)
            .map_err(|e| format!("could not save the instrumental list: {e}"))
    }

    /// `mark_lyrics_instrumental`: the song at `path` has no words. `source` says who said so ("LRCLIB"). A song the person
    /// put back (see `unmark`) is not marked again by a later lookup.
    pub fn mark(&self, path: &str, source: &str, now_secs: u64) -> Result<(), String> {
        let mut entries = self.load();
        if entries.contains_key(path) {
            return Ok(());
        }
        entries.insert(
            path.to_owned(),
            json!({ "source": source.chars().take(60).collect::<String>(), "marked": now_secs }),
        );
        self.save(&entries)
    }

    /// Whether the song is on the instrumental list now (marked, and not put back by the person).
    pub fn is_instrumental(&self, path: &str) -> bool {
        self.load().get(path).is_some_and(|e| e["declined"] != true)
    }

    /// `unmark_lyrics_instrumental`: the song is not instrumental after all; it is listed as missing lyrics again. The
    /// decision is remembered, so the automatic lookup does not mark the song again.
    pub fn unmark(&self, path: &str) -> Result<bool, String> {
        let mut entries = self.load();
        let Some(entry) = entries.get_mut(path).filter(|e| e["declined"] != true) else {
            return Ok(false);
        };
        entry["declined"] = json!(true);
        entry["confirmed"] = json!(false);
        self.save(&entries)?;
        Ok(true)
    }

    /// The language tag the song had before it was confirmed (`Some(None)`: it had none); `None` when the song is not confirmed.
    pub fn confirmed_before(&self, path: &str) -> Option<Option<String>> {
        let entries = self.load();
        let entry = entries.get(path).filter(|e| e["confirmed"] == true)?;
        Some(entry["language_before"].as_str().map(str::to_owned))
    }

    /// `confirm_lyrics_instrumental`: the person (having listened) says the song is instrumental; its language tag was set to `zxx`, replacing `before`.
    /// A song not on the list yet is added.
    pub fn confirm(&self, path: &str, before: Option<&str>, now_secs: u64) -> Result<(), String> {
        let mut entries = self.load();
        let entry = entries
            .entry(path.to_owned())
            .or_insert_with(|| json!({ "source": "confirmed by you", "marked": now_secs }));
        entry["declined"] = json!(false);
        entry["confirmed"] = json!(true);
        // Confirming twice must not record `zxx` as the tag to go back to.
        if entry.get("language_before").is_none() || before.is_some_and(|b| b != "zxx") {
            entry["language_before"] = before.map_or(Value::Null, |b| json!(b));
        }
        self.save(&entries)
    }

    /// `list_lyrics_instrumental`: every marked song that is not confirmed, newest first (`items`), and the confirmed ones (`confirmed`).
    pub fn list(&self) -> Value {
        let confirmed: Vec<Value> = self
            .load()
            .into_iter()
            .filter(|(_, e)| e["declined"] != true && e["confirmed"] == true)
            .map(|(path, e)| json!({ "path": path, "source": e["source"], "marked": e["marked"] }))
            .collect();
        let mut items: Vec<(u64, Value)> = self
            .load()
            .into_iter()
            .filter(|(_, e)| e["declined"] != true && e["confirmed"] != true)
            .map(|(path, e)| {
                (
                    e["marked"].as_u64().unwrap_or(0),
                    json!({ "path": path, "source": e["source"], "marked": e["marked"] }),
                )
            })
            .collect();
        items.sort_by(|a, b| b.0.cmp(&a.0));
        json!({ "items": items.into_iter().map(|(_, v)| v).collect::<Vec<_>>(), "confirmed": confirmed })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn songs_are_marked_listed_and_put_back() {
        let dir = std::env::temp_dir().join(format!("mv-instrumental-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::new(&dir);
        assert_eq!(store.list()["items"].as_array().unwrap().len(), 0);
        store.mark("C:\\Music\\A\\01.mp3", "LRCLIB", 100).unwrap();
        store.mark("C:\\Music\\A\\02.mp3", "LRCLIB", 200).unwrap();
        store.mark("C:\\Music\\A\\01.mp3", "other", 300).unwrap();
        let listed = store.list();
        let items = listed["items"].as_array().unwrap();
        assert_eq!(items.len(), 2);
        assert_eq!(items[0]["path"], "C:\\Music\\A\\02.mp3", "newest first");
        assert_eq!(
            items[1]["marked"], 100,
            "marking twice keeps the first mark"
        );
        assert!(store.unmark("C:\\Music\\A\\01.mp3").unwrap());
        assert!(!store.unmark("C:\\Music\\A\\01.mp3").unwrap());
        assert_eq!(store.list()["items"].as_array().unwrap().len(), 1);
        store.mark("C:\\Music\\A\\01.mp3", "LRCLIB", 400).unwrap();
        assert_eq!(
            store.list()["items"].as_array().unwrap().len(),
            1,
            "a song put back is not marked again by a later lookup"
        );
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_confirmed_song_leaves_the_list_and_remembers_its_old_language() {
        let dir =
            std::env::temp_dir().join(format!("mv-instrumental-confirm-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let store = Store::new(&dir);
        store.mark("C:\\Music\\A\\01.mp3", "Lyric AI", 100).unwrap();
        assert_eq!(store.confirmed_before("C:\\Music\\A\\01.mp3"), None);
        store
            .confirm("C:\\Music\\A\\01.mp3", Some("eng"), 200)
            .unwrap();
        store
            .confirm("C:\\Music\\A\\01.mp3", Some("zxx"), 300)
            .unwrap();
        assert_eq!(
            store.confirmed_before("C:\\Music\\A\\01.mp3"),
            Some(Some("eng".to_owned()))
        );
        let listed = store.list();
        assert_eq!(listed["items"].as_array().unwrap().len(), 0);
        assert_eq!(listed["confirmed"].as_array().unwrap().len(), 1);
        // a song nobody marked can be confirmed too
        store.confirm("C:\\Music\\B\\02.mp3", None, 400).unwrap();
        assert_eq!(store.confirmed_before("C:\\Music\\B\\02.mp3"), Some(None));
        assert_eq!(store.list()["confirmed"].as_array().unwrap().len(), 2);
        assert!(store.unmark("C:\\Music\\A\\01.mp3").unwrap());
        assert_eq!(store.confirmed_before("C:\\Music\\A\\01.mp3"), None);
        assert_eq!(store.list()["confirmed"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
