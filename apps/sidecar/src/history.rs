//! Listening history (decision D26): which library tracks were played, when, and how often. It feeds the
//! home page ("Recently played", "Most played"). It is kept only in `<data dir>/history.json` on this
//! computer, never sent anywhere, can be switched off in Settings (nothing is recorded while it is off)
//! and cleared at any time.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const MAX_ENTRIES: usize = 3000;

pub struct History {
    path: PathBuf,
}

impl History {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("history.json"),
        }
    }

    fn load(&self) -> Vec<Value> {
        std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
    }

    fn save(&self, entries: &[Value]) -> std::io::Result<()> {
        if let Some(parent) = self.path.parent() {
            std::fs::create_dir_all(parent)?;
        }
        let temp = self.path.with_extension("json.tmp");
        std::fs::write(
            &temp,
            serde_json::to_vec(entries).map_err(std::io::Error::other)?,
        )?;
        std::fs::rename(temp, &self.path)
    }

    pub fn list(&self) -> Vec<Value> {
        self.load()
    }

    pub fn clear(&self) -> std::io::Result<()> {
        self.save(&[])
    }

    /// Records one play of `path` (already checked to be a library file). Repeats of the same track
    /// raise its count and move it to the front of "recent".
    pub fn record(&self, path: &str, args: &Value, now_secs: u64) -> std::io::Result<()> {
        let mut entries = self.load();
        let count = entries
            .iter()
            .find(|e| e["path"] == path)
            .and_then(|e| e["count"].as_u64())
            .unwrap_or(0)
            + 1;
        entries.retain(|e| e["path"] != path);
        let text = |key: &str| {
            args[key].as_str().map(|s| {
                s.chars()
                    .filter(|c| !c.is_control())
                    .take(200)
                    .collect::<String>()
            })
        };
        entries.push(json!({
            "path": path,
            "title": text("title"),
            "artist": text("artist"),
            "album": text("album"),
            "last_played": now_secs,
            "count": count,
        }));
        if entries.len() > MAX_ENTRIES {
            entries.sort_by_key(|e| e["last_played"].as_u64().unwrap_or(0));
            entries.drain(..entries.len() - MAX_ENTRIES);
        }
        self.save(&entries)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn temp(name: &str) -> PathBuf {
        let dir = std::env::temp_dir().join(format!("mv-history-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        dir
    }

    #[test]
    fn plays_are_counted_ordered_and_cleared() {
        let dir = temp("basic");
        let history = History::new(&dir);
        assert!(history.list().is_empty());
        history
            .record(
                "a.mp3",
                &json!({ "title": "A", "artist": "X", "album": "LP" }),
                100,
            )
            .unwrap();
        history
            .record("b.mp3", &json!({ "title": "B" }), 200)
            .unwrap();
        history
            .record("a.mp3", &json!({ "title": "A" }), 300)
            .unwrap();
        let entries = History::new(&dir).list();
        assert_eq!(entries.len(), 2);
        assert_eq!(entries[1]["path"], "a.mp3", "the latest play is last");
        assert_eq!(entries[1]["count"], 2);
        assert_eq!(entries[1]["last_played"], 300);
        assert_eq!(entries[0]["count"], 1);
        history.clear().unwrap();
        assert!(History::new(&dir).list().is_empty());
    }

    #[test]
    fn the_list_is_capped_keeping_the_newest_and_a_damaged_file_is_ignored() {
        let dir = temp("cap");
        let history = History::new(&dir);
        let many: Vec<Value> = (0..MAX_ENTRIES)
            .map(|i| json!({ "path": format!("{i}.mp3"), "last_played": i, "count": 1 }))
            .collect();
        history.save(&many).unwrap();
        history.record("new.mp3", &json!({}), 99_999).unwrap();
        let entries = history.list();
        assert_eq!(entries.len(), MAX_ENTRIES);
        assert!(entries.iter().any(|e| e["path"] == "new.mp3"));
        assert!(
            !entries.iter().any(|e| e["path"] == "0.mp3"),
            "the oldest was dropped"
        );
        std::fs::write(dir.join("history.json"), b"nonsense").unwrap();
        assert!(History::new(&dir).list().is_empty());
    }
}
