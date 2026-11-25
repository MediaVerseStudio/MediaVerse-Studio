//! Discs the person wants ripped again (D111): flagged from the Album IDs comparison when a song's length is a little off
//! (a skipped or damaged section is possible) or for any reason of their own. A small list in the data folder, shown under
//! Review > Missing & copies; nothing happens to the files, and a flag is removed with one press.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};

pub struct Rerip {
    file: PathBuf,
}

impl Rerip {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            file: data_dir.join("rerip-flags.json"),
        }
    }

    fn load(&self) -> Vec<Value> {
        std::fs::read_to_string(&self.file)
            .ok()
            .and_then(|text| serde_json::from_str::<Vec<Value>>(&text).ok())
            .unwrap_or_default()
    }

    fn save(&self, list: &[Value]) -> Result<(), String> {
        if let Some(parent) = self.file.parent() {
            std::fs::create_dir_all(parent).map_err(|e| e.to_string())?;
        }
        let partial = self.file.with_extension("json.tmp");
        std::fs::write(
            &partial,
            serde_json::to_vec_pretty(list).map_err(|e| e.to_string())?,
        )
        .map_err(|e| e.to_string())?;
        std::fs::rename(&partial, &self.file).map_err(|e| e.to_string())
    }

    /// Flags an album folder (flagging again replaces the reason).
    pub fn flag(
        &self,
        path: &str,
        album: &str,
        artist: &str,
        reason: &str,
        now: u64,
    ) -> Result<(), String> {
        let mut list: Vec<Value> = self
            .load()
            .into_iter()
            .filter(|e| e["path"] != path)
            .collect();
        list.push(json!({ "path": path, "album": album, "artist": artist, "reason": reason, "flagged_at": now }));
        self.save(&list)
    }

    pub fn unflag(&self, path: &str) -> Result<bool, String> {
        let list = self.load();
        let kept: Vec<Value> = list.iter().filter(|e| e["path"] != path).cloned().collect();
        let removed = kept.len() != list.len();
        if removed {
            self.save(&kept)?;
        }
        Ok(removed)
    }

    /// The flagged albums, newest first, each with whether its folder still exists.
    pub fn list(&self) -> Value {
        let mut list = self.load();
        list.sort_by_key(|e| std::cmp::Reverse(e["flagged_at"].as_u64().unwrap_or(0)));
        let albums: Vec<Value> = list
            .into_iter()
            .map(|mut e| {
                let exists = e["path"].as_str().is_some_and(|p| Path::new(p).is_dir());
                e["exists"] = json!(exists);
                e
            })
            .collect();
        json!({ "albums": albums })
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn flags_are_kept_replaced_listed_newest_first_and_removed() {
        let dir = std::env::temp_dir().join(format!("mv-rerip-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let store = Rerip::new(&dir);
        assert_eq!(store.list()["albums"], json!([]));
        store
            .flag("C:/M/a", "Alpha", "A", "track 3 is 4 s short", 100)
            .unwrap();
        store
            .flag("C:/M/b", "Beta", "B", "my own reason", 200)
            .unwrap();
        store
            .flag("C:/M/a", "Alpha", "A", "changed my mind about why", 300)
            .unwrap();
        let listed = store.list();
        let albums = listed["albums"].as_array().unwrap();
        assert_eq!(albums.len(), 2, "flagging again replaces, not repeats");
        assert_eq!(albums[0]["path"], "C:/M/a");
        assert_eq!(albums[0]["reason"], "changed my mind about why");
        assert_eq!(albums[0]["exists"], false);
        assert!(store.unflag("C:/M/a").unwrap());
        assert!(!store.unflag("C:/M/a").unwrap(), "already gone");
        assert_eq!(store.list()["albums"].as_array().unwrap().len(), 1);
        let _ = std::fs::remove_dir_all(&dir);
    }
}
