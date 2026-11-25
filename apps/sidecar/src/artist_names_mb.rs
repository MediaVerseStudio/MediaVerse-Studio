//! The official spelling of artist names (D101). For each artist name in the library, MusicBrainz is asked for the
//! artist with that name (an exact match when punctuation, spacing, accents and capitals are ignored, and a high
//! search score); its own spelling ("AFI", "P!nk", "Guns N' Roses") is kept as the canonical one. Answers, including
//! "MusicBrainz does not know this name", are remembered in `<data>/artist-names/canonical.json` keyed by the exact
//! spelling asked about, so nothing is asked twice and a stray space is its own question. The Review page uses the
//! answers to suggest the right spelling and to find single names that are not spelt the way MusicBrainz spells them.

use crate::lookup::MetadataState;
use crate::tag_repair::{ScanState, musicbrainz_get, url_encode};
use mediaverse_disc_metadata::settings::MetadataSettings;
use mediaverse_tag_repair::names::normalise;
use serde_json::{Value, json};
use std::collections::BTreeMap;
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};

const SKIP: [&str; 4] = ["unknown artist", "various artists", "various", "unknown"];

fn file(data_dir: &Path) -> PathBuf {
    data_dir.join("artist-names").join("canonical.json")
}

fn load(data_dir: &Path) -> BTreeMap<String, String> {
    let value: Value = std::fs::read_to_string(file(data_dir))
        .ok()
        .and_then(|t| serde_json::from_str(&t).ok())
        .unwrap_or(Value::Null);
    value
        .as_object()
        .into_iter()
        .flatten()
        .map(|(k, v)| (k.clone(), v.as_str().unwrap_or_default().to_owned()))
        .collect()
}

fn save(data_dir: &Path, answers: &BTreeMap<String, String>) -> Result<(), String> {
    let path = file(data_dir);
    std::fs::create_dir_all(path.parent().unwrap_or(Path::new("."))).map_err(|e| e.to_string())?;
    let partial = path.with_extension("json.tmp");
    std::fs::write(
        &partial,
        serde_json::to_vec(&Value::Object(
            answers.iter().map(|(k, v)| (k.clone(), json!(v))).collect(),
        ))
        .map_err(|e| e.to_string())?,
    )
    .map_err(|e| e.to_string())?;
    std::fs::rename(&partial, path).map_err(|e| e.to_string())
}

/// Names compared the way the Review page groups them: no punctuation, spacing, capitals, accents, "&" against "and" or leading "The".
fn loose(name: &str) -> String {
    let key: String = normalise(name)
        .chars()
        .filter(|c| c.is_alphanumeric())
        .collect();
    key.strip_prefix("the")
        .filter(|rest| !rest.is_empty() && normalise(name).starts_with("the "))
        .map_or(key.clone(), str::to_owned)
}

/// What the search answer says: the official name of the artist this name means, or None.
pub fn canonical_from(search_reply: &Value, asked: &str) -> Option<String> {
    let wanted = loose(asked);
    search_reply["artists"]
        .as_array()?
        .iter()
        .filter(|a| {
            a["score"].as_u64().unwrap_or(0) >= 90
                && loose(a["name"].as_str().unwrap_or_default()) == wanted
        })
        .max_by_key(|a| a["score"].as_u64().unwrap_or(0))
        .and_then(|a| a["name"].as_str().map(str::to_owned))
}

fn ask(
    name: &str,
    settings: &MetadataSettings,
    state: &MetadataState,
) -> Result<Option<String>, String> {
    let cleaned = name.split_whitespace().collect::<Vec<_>>().join(" ");
    let query = url_encode(&format!("artist:\"{}\"", cleaned.replace('"', "")));
    let url = format!(
        "{}/ws/2/artist/?query={query}&limit=5&fmt=json",
        settings.musicbrainz.base_url.trim_end_matches('/')
    );
    let Some(body) = musicbrainz_get(&url, settings, state).map_err(|(_, m)| m)? else {
        return Ok(None);
    };
    let reply: Value = serde_json::from_str(&body).map_err(|e| e.to_string())?;
    Ok(canonical_from(&reply, &cleaned))
}

/// The job: `names` is a list of exact spellings. Returns `{stopped, asked, known, trouble}`.
pub fn check(
    args: &Value,
    data_dir: &Path,
    settings: &MetadataSettings,
    state: &MetadataState,
    stop: &AtomicBool,
    progress: &ScanState,
    emit: &dyn Fn(&ScanState),
) -> Result<Value, String> {
    let names = args["names"].as_array().ok_or("'names' must be a list.")?;
    let mut answers = load(data_dir);
    let todo: Vec<&str> = names
        .iter()
        .filter_map(Value::as_str)
        .filter(|n| {
            !n.trim().is_empty()
                && !SKIP.contains(&n.trim().to_lowercase().as_str())
                && !answers.contains_key(*n)
        })
        .collect();
    progress.total.store(todo.len(), Ordering::Relaxed);
    emit(progress);
    let (mut stopped, mut trouble) = (false, 0usize);
    for name in todo {
        if stop.load(Ordering::Relaxed) {
            stopped = true;
            break;
        }
        if let Ok(mut current) = progress.current.lock() {
            *current = name.trim().to_owned();
        }
        match ask(name, settings, state) {
            Ok(found) => {
                if found.is_some() {
                    progress.identified.fetch_add(1, Ordering::Relaxed);
                } else {
                    progress.unmatched.fetch_add(1, Ordering::Relaxed);
                }
                answers.insert(name.to_owned(), found.unwrap_or_default());
            }
            Err(_) => trouble += 1,
        }
        let done = progress.done.fetch_add(1, Ordering::Relaxed) + 1;
        if done % 10 == 0 {
            save(data_dir, &answers)?;
            emit(progress);
        }
    }
    save(data_dir, &answers)?;
    Ok(
        json!({ "stopped": stopped, "known": answers.values().filter(|v| !v.is_empty()).count(), "asked": answers.len(), "trouble": trouble }),
    )
}

/// `canonical_artist_names`: every remembered answer, `{names: {asked spelling: official spelling or ""}}`.
pub fn answers(data_dir: &Path) -> Value {
    json!({ "names": load(data_dir) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn the_official_spelling_is_the_exact_loose_match_with_a_high_score() {
        let reply = json!({ "artists": [
            { "name": "AFI", "score": 100 },
            { "name": "’Afi Sulaiman", "score": 78 },
            { "name": "Afi", "score": 77 },
        ]});
        assert_eq!(canonical_from(&reply, "A.F.I.").as_deref(), Some("AFI"));
        assert_eq!(canonical_from(&reply, "AFI").as_deref(), Some("AFI"));
        assert_eq!(canonical_from(&reply, "Something Else"), None);
        let weak = json!({ "artists": [{ "name": "P!nk", "score": 60 }] });
        assert_eq!(
            canonical_from(&weak, "Pink"),
            None,
            "a weak score is not trusted"
        );
        let pink = json!({ "artists": [{ "name": "P!nk", "score": 100 }] });
        assert_eq!(canonical_from(&pink, "P!nk").as_deref(), Some("P!nk"));
        assert_eq!(
            canonical_from(&pink, "Pink"),
            None,
            "the ! is a letter's stand-in, not punctuation"
        );
    }
}
