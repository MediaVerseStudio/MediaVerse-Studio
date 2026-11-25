//! Titles with a track number written in front of them ("14 Donut Dan", "1. All For Nothing"): found from the library's
//! tags, and taken off when the person presses the button. A title like that cannot match a lyrics database or any other
//! catalogue. The writing is journalled in the Fix tags journal, so "Undo it" there puts the old titles back, and a title
//! is only changed if it is still what the list showed.

use crate::tag_repair::TagRepairStore;
use mediaverse_metadata_tags::{TagField, patch_track_metadata, read_track_metadata};
use mediaverse_tag_repair::names::tidy_title_for_track;
use serde_json::{Value, json};
use std::collections::BTreeSet;
use std::path::Path;

fn collapse(text: &str) -> String {
    text.split_whitespace().collect::<Vec<_>>().join(" ")
}

/// `find_tidy_titles {tracks: [{path, title, artist, album_artist, track}]}`: the songs whose title carries a track number,
/// with the title as it would be. Reads nothing from disk.
pub fn find(tracks: &[Value]) -> Value {
    let mut items = Vec::new();
    for t in tracks {
        let text = |key: &str| t.get(key).and_then(Value::as_str).unwrap_or_default();
        let (path, title) = (text("path"), text("title"));
        let artists: Vec<&str> = [text("artist"), text("album_artist")]
            .into_iter()
            .filter(|a| !a.is_empty())
            .collect();
        let track = t
            .get("track")
            .and_then(Value::as_u64)
            .and_then(|n| u32::try_from(n).ok());
        // Only the number: the artist's name or a web address in a title is Fix tags' business.
        let Some(tidy) = tidy_title_for_track(title, &artists, track) else {
            continue;
        };
        if path.is_empty() || !title.trim_start().starts_with(|c: char| c.is_ascii_digit()) {
            continue;
        }
        items.push(json!({ "path": path, "from": title, "to": tidy }));
    }
    json!({ "items": items })
}

/// `apply_title_tidy {titles: [{path, from, to}]}`: writes each title, only for files inside `root` whose title is still
/// `from`. Returns the batch of the Fix tags journal.
pub fn apply(
    tag_store: &TagRepairStore,
    root: Option<&Path>,
    titles: &[(String, String, String)],
) -> Result<Value, (String, String)> {
    let mut journal: Vec<(String, String, Option<String>, Option<String>)> = Vec::new();
    let mut problems: Vec<Value> = Vec::new();
    let mut folders: BTreeSet<String> = BTreeSet::new();
    for (path, from, to) in titles {
        let file = Path::new(path);
        let to = to.trim();
        let refuse = |message: &str| json!({ "path": path, "message": message });
        if root.is_some_and(|r| !file.starts_with(r))
            || to.is_empty()
            || to.chars().any(char::is_control)
        {
            problems.push(refuse("That title cannot be written to that file."));
            continue;
        }
        match read_track_metadata(file) {
            Ok(now)
                if now.title.as_deref().map(collapse).as_deref()
                    == Some(collapse(from).as_str()) => {}
            Ok(_) => {
                problems.push(refuse(
                    "The song's title changed since the list was made, so it was left alone.",
                ));
                continue;
            }
            Err(e) => {
                problems.push(refuse(&e.to_string()));
                continue;
            }
        }
        match patch_track_metadata(file, &[(TagField::Title, Some(to.to_owned()))]) {
            Ok(before) => {
                journal.push((
                    path.clone(),
                    "title".to_owned(),
                    before.into_iter().next().and_then(|(_, old)| old),
                    Some(to.to_owned()),
                ));
                if let Some(folder) = file.parent() {
                    folders.insert(folder.to_string_lossy().into_owned());
                }
            }
            Err(e) => problems.push(refuse(&e.to_string())),
        }
    }
    let written = journal.len();
    let batch = tag_store
        .journal(&journal, folders.len(), written)
        .map_err(|e| {
            (
                "journal_failed".to_owned(),
                format!("The titles were written but could not be journalled: {e}"),
            )
        })?;
    Ok(json!({ "batch": batch, "files": written, "problems": problems }))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn only_titles_that_start_with_a_track_number_are_offered() {
        let tracks = vec![
            json!({ "path": "a", "title": "14 Donut Dan", "artist": "Goldfinger", "track": 14 }),
            json!({ "path": "b", "title": "99 Red Balloons", "artist": "Nena", "track": 3 }),
            json!({ "path": "c", "title": "1. All For Nothing", "artist": "Face To Face", "track": 1 }),
            json!({ "path": "d", "title": "Goldfinger - Mind's Eye", "artist": "Goldfinger", "track": 4 }),
            json!({ "path": "e", "title": "Fine", "artist": "X" }),
        ];
        let found = find(&tracks);
        let items = found["items"].as_array().unwrap();
        assert_eq!(items.len(), 2, "{found}");
        assert_eq!(
            (items[0]["path"].clone(), items[0]["to"].clone()),
            (json!("a"), json!("Donut Dan"))
        );
        assert_eq!(items[1]["to"], "All For Nothing");
    }
}
