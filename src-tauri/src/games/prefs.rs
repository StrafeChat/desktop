//! activity.json: what the person chose about game sharing on this device, in the shell's
//! config directory beside prefs.json (critique #4, #17). The same file, in the same shape, as
//! the Electron shell's (electron/src/games/prefs.js):
//!
//!   { version: 1,
//!     shareAccounts: [<desktop account id>, ...],   sharing is on for these accounts only
//!     hidden: [<key>, ...],                          never shared
//!     renames: { <key>: <name> },                    shared under this name
//!     user: [{ id, path, name }] }                   programs the person added as games
//!
//! Its own file, never part of prefs.json: the page saves prefs.json whole from Settings ->
//! Desktop (`desktop_prefs_save` replaces the whole Prefs), and would otherwise wipe a hide list
//! it never loaded. Only the games commands read and write it. Owner-only, written whole
//! (`write_json`: write-then-rename, 0600).

use std::{
    collections::{BTreeMap, HashSet},
    path::{Path, PathBuf},
};

use serde::Serialize;
use serde_json::Value;

use super::matcher::UserGame;
use super::text::{is_space, valid_name};

pub const ACTIVITY_FILE: &str = "activity.json";

/// How much the file keeps; past these, Settings refuses more.
pub const LIMIT_ACCOUNTS: usize = 50;
pub const LIMIT_HIDDEN: usize = 500;
pub const LIMIT_RENAMES: usize = 500;
pub const LIMIT_USER: usize = 100;

const SOURCES: [&str; 6] = ["user", "steam", "epic", "heroic", "lutris", "curated"];

/// A game's key: `<source>:<id>`, never a path (critique #7, #12).
pub fn valid_key(k: &str) -> bool {
    let Some((source, rest)) = k.split_once(':') else { return false };
    let n = rest.chars().count();
    SOURCES.contains(&source) && (1..=256).contains(&n) && !rest.chars().any(char::is_control)
}

fn valid_user_id(id: &str) -> bool {
    (1..=64).contains(&id.len()) && id.bytes().all(|b| b.is_ascii_alphanumeric() || b == b'_' || b == b'-')
}

/// `${domain}:${userId}`, as the client's accounts.ts names a desktop account.
pub fn valid_account(a: &str) -> bool {
    let n = a.chars().count();
    (1..=300).contains(&n) && !a.chars().any(|c| c.is_control() || is_space(c))
}

#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActivityPrefs {
    pub version: u32,
    #[serde(rename = "shareAccounts")]
    pub share_accounts: Vec<String>,
    pub hidden: Vec<String>,
    pub renames: BTreeMap<String, String>,
    pub user: Vec<UserGame>,
}

impl Default for ActivityPrefs {
    fn default() -> Self {
        Self { version: 1, share_accounts: Vec::new(), hidden: Vec::new(), renames: BTreeMap::new(), user: Vec::new() }
    }
}

fn uniq(list: Option<&Value>, ok: fn(&str) -> bool, cap: usize) -> Vec<String> {
    let mut seen = HashSet::new();
    let mut out = Vec::new();
    for s in list.and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str) {
        if out.len() >= cap {
            break;
        }
        if ok(s) && seen.insert(s.to_string()) {
            out.push(s.to_string());
        }
    }
    out
}

/// The file as this version keeps it: anything malformed is dropped, not trusted.
pub fn normalize(value: &Value) -> ActivityPrefs {
    let mut out = ActivityPrefs::default();
    let Some(v) = value.as_object() else { return out };
    out.share_accounts = uniq(v.get("shareAccounts"), valid_account, LIMIT_ACCOUNTS);
    out.hidden = uniq(v.get("hidden"), valid_key, LIMIT_HIDDEN);
    if let Some(renames) = v.get("renames").and_then(Value::as_object) {
        for (k, name) in renames {
            if out.renames.len() >= LIMIT_RENAMES {
                break;
            }
            if let Some(n) = name.as_str().and_then(valid_name) {
                if valid_key(k) {
                    out.renames.insert(k.clone(), n);
                }
            }
        }
    }
    let mut ids = HashSet::new();
    let mut paths = HashSet::new();
    for u in v.get("user").and_then(Value::as_array).into_iter().flatten() {
        if out.user.len() >= LIMIT_USER {
            break;
        }
        let Some(u) = u.as_object() else { continue };
        let (Some(id), Some(path), Some(name)) = (
            u.get("id").and_then(Value::as_str),
            u.get("path").and_then(Value::as_str),
            u.get("name").and_then(Value::as_str).and_then(valid_name),
        ) else {
            continue;
        };
        if !valid_user_id(id) || ids.contains(id) {
            continue;
        }
        if !Path::new(path).is_absolute() || path.encode_utf16().count() > 4096 || paths.contains(path) {
            continue;
        }
        ids.insert(id.to_string());
        paths.insert(path.to_string());
        out.user.push(UserGame { id: id.to_string(), path: path.to_string(), name });
    }
    out
}

pub fn file(dir: &Path) -> PathBuf {
    dir.join(ACTIVITY_FILE)
}

pub fn load(dir: &Path) -> ActivityPrefs {
    std::fs::read(file(dir)).ok().and_then(|raw| serde_json::from_slice::<Value>(&raw).ok()).map(|v| normalize(&v)).unwrap_or_default()
}

/// Writes and returns the normalised prefs.
pub fn save(dir: &Path, prefs: &ActivityPrefs) -> Result<ActivityPrefs, String> {
    let v = serde_json::to_value(prefs).map_err(|e| e.to_string())?;
    let clean = normalize(&v);
    let v = serde_json::to_value(&clean).map_err(|e| e.to_string())?;
    std::fs::create_dir_all(dir).map_err(|e| e.to_string())?;
    crate::write_json(&file(dir), &v)?;
    Ok(clean)
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::tests_support::TempDir;
    use serde_json::json;

    #[test]
    fn games_prefs_activity_json_keeps_only_what_is_well_formed_owner_only() {
        let tmp = TempDir::new("prefs");
        let dir = tmp.path();
        assert_eq!(load(dir), ActivityPrefs::default());
        // An absolute path on this OS ("/home/me/g" is not one on Windows).
        let abs = |p: &str| if cfg!(windows) { format!("C:{}", p.replace('/', "\\")) } else { p.to_string() };
        // The same input as the Electron shell's prefs test, and the same result.
        let input = json!({
            "version": 7,
            "share": true,
            "shareAccounts": ["a.local:1", "a.local:1", 42, "has space"],
            "hidden": ["steam:1", "/home/me/game", "steam:1", "bogus"],
            "renames": { "curated:x": "  New   Name ", "curated:y": "", "nope": "x", "curated:z": "x".repeat(129) },
            "user": [
                { "id": "abc", "path": abs("/home/me/g"), "name": "G" },
                { "id": "abc", "path": abs("/home/me/h"), "name": "dup id" },
                { "id": "def", "path": "relative/g", "name": "relative" },
                { "id": "ghi", "path": abs("/home/me/g"), "name": "dup path" },
                { "id": "b a d", "path": abs("/x"), "name": "bad id" },
            ],
        });
        let clean = normalize(&input);
        let want = ActivityPrefs {
            version: 1,
            share_accounts: vec!["a.local:1".into()],
            hidden: vec!["steam:1".into()],
            renames: [("curated:x".to_string(), "New Name".to_string())].into(),
            user: vec![UserGame { id: "abc".into(), path: abs("/home/me/g"), name: "G".into() }],
        };
        assert_eq!(clean, want);
        assert_eq!(save(dir, &clean).unwrap(), want);
        let raw: Value = serde_json::from_slice(&std::fs::read(file(dir)).unwrap()).unwrap();
        assert_eq!(
            raw,
            json!({ "version": 1, "shareAccounts": ["a.local:1"], "hidden": ["steam:1"], "renames": { "curated:x": "New Name" }, "user": [{ "id": "abc", "path": abs("/home/me/g"), "name": "G" }] })
        );
        #[cfg(unix)]
        {
            use std::os::unix::fs::PermissionsExt;
            assert_eq!(std::fs::metadata(file(dir)).unwrap().permissions().mode() & 0o777, 0o600);
        }
        assert_eq!(load(dir), want);
        std::fs::write(file(dir), "[1]").unwrap();
        assert_eq!(load(dir), ActivityPrefs::default());
        std::fs::write(file(dir), "not json").unwrap();
        assert_eq!(load(dir), ActivityPrefs::default());
    }

    #[test]
    fn games_prefs_keys_and_accounts() {
        assert!(valid_key("steam:730"));
        assert!(valid_key("heroic:legendary:Fortnite"));
        assert!(valid_key("epic:FixtureEpicApp"));
        assert!(!valid_key("steam:"));
        assert!(!valid_key("gog:1"));
        assert!(!valid_key("/home/me/game"));
        assert!(!valid_key("curated:a\nb"));
        assert!(!valid_key(&format!("curated:{}", "x".repeat(257))));
        assert!(valid_account("strafe.chat:123456"));
        assert!(!valid_account("has space"));
        assert!(!valid_account(""));
    }

    #[test]
    fn games_prefs_live_beside_prefs_json_not_in_it() {
        // A Desktop-settings save replaces prefs.json whole; game choices are never in it.
        assert_ne!(ACTIVITY_FILE, crate::PREFS_FILE);
        let prefs = serde_json::to_value(crate::Prefs::default()).unwrap();
        for k in ["shareAccounts", "hidden", "renames", "user", "share"] {
            assert!(prefs.get(k).is_none(), "{k} in prefs.json");
        }
    }
}
