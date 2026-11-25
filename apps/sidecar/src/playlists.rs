//! Playlists (D74): named lists of library songs, made and arranged in the desktop app (Library > Playlists, or
//! right-click > Add to playlist), as in Windows Media Player. Kept in `<data dir>/playlists.json`, written
//! atomically, on this computer only. A song is identified by its file in the music library, like favorites.
//! The page sends a whole playlist on every change (add, remove, move, rename), which keeps this simple.

use serde_json::{Value, json};
use std::path::{Path, PathBuf};

const MAX_PLAYLISTS: usize = 2_000;
const MAX_SONGS: usize = 20_000;
const MAX_NAME: usize = 200;

pub struct Playlists {
    path: PathBuf,
}

impl Playlists {
    pub fn new(data_dir: &Path) -> Self {
        Self {
            path: data_dir.join("playlists.json"),
        }
    }

    fn load(&self) -> Vec<Value> {
        std::fs::read(&self.path)
            .ok()
            .and_then(|bytes| serde_json::from_slice::<Value>(&bytes).ok())
            .and_then(|value| value.as_array().cloned())
            .unwrap_or_default()
    }

    fn save(&self, playlists: &[Value]) -> Result<(), String> {
        let write = || -> std::io::Result<()> {
            if let Some(parent) = self.path.parent() {
                std::fs::create_dir_all(parent)?;
            }
            let temp = self.path.with_extension("json.tmp");
            std::fs::write(
                &temp,
                serde_json::to_vec_pretty(playlists).map_err(std::io::Error::other)?,
            )?;
            std::fs::rename(temp, &self.path)
        };
        write().map_err(|e| format!("could not save the playlists: {e}"))
    }

    pub fn list(&self) -> Value {
        json!({ "playlists": self.load() })
    }

    /// `{id?, name, paths}`: creates a playlist (no `id`) or replaces one. `in_library` says whether a path is a
    /// library file; others (a song deleted or moved since) are left out and counted in `dropped`.
    pub fn save_one(
        &self,
        args: &Value,
        now_secs: u64,
        in_library: impl Fn(&str) -> bool,
    ) -> Result<Value, String> {
        let name = args["name"].as_str().unwrap_or("").trim().to_owned();
        if name.is_empty() {
            return Err("Give the playlist a name.".to_owned());
        }
        if name.chars().count() > MAX_NAME {
            return Err("That name is too long.".to_owned());
        }
        let requested = args["paths"].as_array().ok_or("'paths' must be a list")?;
        if requested.len() > MAX_SONGS {
            return Err(format!("A playlist can hold up to {MAX_SONGS} songs."));
        }
        let mut paths = Vec::with_capacity(requested.len());
        let mut dropped = 0;
        for path in requested {
            match path.as_str() {
                Some(text) if in_library(text) => paths.push(Value::from(text)),
                _ => dropped += 1,
            }
        }
        let mut playlists = self.load();
        let id = args["id"].as_str().map(str::to_owned);
        let same_name = |p: &Value, own: Option<&str>| {
            p["name"]
                .as_str()
                .is_some_and(|n| n.to_lowercase() == name.to_lowercase())
                && own != p["id"].as_str()
        };
        if playlists.iter().any(|p| same_name(p, id.as_deref())) {
            return Err(format!("There is already a playlist called “{name}”."));
        }
        let saved = match id {
            Some(id) => {
                let entry = playlists
                    .iter_mut()
                    .find(|p| p["id"] == id.as_str())
                    .ok_or("That playlist no longer exists.")?;
                entry["name"] = Value::from(name);
                entry["paths"] = Value::from(paths);
                entry["updated_at"] = Value::from(now_secs);
                entry.clone()
            }
            None => {
                if playlists.len() >= MAX_PLAYLISTS {
                    return Err("There are too many playlists.".to_owned());
                }
                let mut n = playlists.len() as u64;
                let id = loop {
                    let candidate = format!("pl-{now_secs}-{n}");
                    if !playlists.iter().any(|p| p["id"] == candidate.as_str()) {
                        break candidate;
                    }
                    n += 1;
                };
                let entry = json!({ "id": id, "name": name, "paths": paths, "created_at": now_secs, "updated_at": now_secs });
                playlists.push(entry.clone());
                entry
            }
        };
        self.save(&playlists)?;
        Ok(json!({ "playlist": saved, "dropped": dropped, "playlists": playlists }))
    }

    pub fn delete(&self, id: &str) -> Result<Value, String> {
        let mut playlists = self.load();
        let before = playlists.len();
        playlists.retain(|p| p["id"] != id);
        if playlists.len() != before {
            self.save(&playlists)?;
        }
        Ok(json!({ "playlists": playlists }))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fresh(name: &str) -> (PathBuf, Playlists) {
        let dir = std::env::temp_dir().join(format!("mv-playlists-{name}-{}", std::process::id()));
        let _ = std::fs::remove_dir_all(&dir);
        let lists = Playlists::new(&dir);
        (dir, lists)
    }

    #[test]
    fn playlists_are_made_changed_renamed_and_deleted() {
        let (dir, lists) = fresh("basic");
        let ok = |_: &str| true;
        assert_eq!(lists.list()["playlists"], json!([]));
        let made = lists
            .save_one(
                &json!({ "name": " Road trip ", "paths": ["C:\\m\\a.mp3", "C:\\m\\b.mp3"] }),
                10,
                ok,
            )
            .unwrap();
        let id = made["playlist"]["id"].as_str().unwrap().to_owned();
        assert_eq!(made["playlist"]["name"], "Road trip");
        let other = lists
            .save_one(&json!({ "name": "Chill", "paths": [] }), 11, ok)
            .unwrap();
        assert_ne!(other["playlist"]["id"], made["playlist"]["id"]);
        assert!(
            lists
                .save_one(&json!({ "name": "road TRIP", "paths": [] }), 12, ok)
                .unwrap_err()
                .contains("already"),
            "names are unique"
        );
        let changed = lists.save_one(&json!({ "id": id, "name": "Road trip 2", "paths": ["C:\\m\\b.mp3", "C:\\m\\a.mp3"] }), 20, ok).unwrap();
        assert_eq!(
            changed["playlist"]["paths"],
            json!(["C:\\m\\b.mp3", "C:\\m\\a.mp3"]),
            "the order is kept"
        );
        assert_eq!(changed["playlist"]["created_at"], 10);
        assert_eq!(
            Playlists::new(&dir).list()["playlists"]
                .as_array()
                .unwrap()
                .len(),
            2,
            "remembered"
        );
        assert_eq!(
            lists.delete(&id).unwrap()["playlists"]
                .as_array()
                .unwrap()
                .len(),
            1
        );
        assert!(
            lists
                .save_one(&json!({ "id": id, "name": "Gone", "paths": [] }), 30, ok)
                .is_err()
        );
        assert!(
            lists
                .save_one(&json!({ "name": "  ", "paths": [] }), 30, ok)
                .is_err()
        );
        std::fs::write(dir.join("playlists.json"), b"junk").unwrap();
        assert_eq!(Playlists::new(&dir).list()["playlists"], json!([]));
    }

    #[test]
    fn songs_outside_the_library_are_left_out() {
        let (_dir, lists) = fresh("outside");
        let saved = lists
            .save_one(
                &json!({ "name": "Mixed", "paths": ["C:\\m\\a.mp3", "C:\\Windows\\x.dll", 5] }),
                1,
                |p| p.starts_with("C:\\m\\"),
            )
            .unwrap();
        assert_eq!(saved["playlist"]["paths"], json!(["C:\\m\\a.mp3"]));
        assert_eq!(saved["dropped"], 2);
    }
}
