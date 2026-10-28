//! games.json: the one list both shells recognise games by. It lives at the repository root
//! (desktop/games.json, owned by the Electron side) and is built into this binary with
//! `include_str!`, so a release always carries the list it was tested with. See the file's own
//! "about" for what each list means. The port of electron/src/games/data.js.

use std::collections::{HashMap, HashSet};

use serde_json::Value;

use super::matcher::Os;
use super::text::clean_name;

/// The list, as built into this binary.
pub const BUNDLED: &str = include_str!("../../../games.json");

/// The only processes whose command line is ever read for a curated rule (privacy: a command
/// line can carry tokens, and only a Java game needs one to be told apart).
pub const JAVA: [&str; 4] = ["java", "javaw", "java.exe", "javaw.exe"];

pub fn is_java(base_lower: &str) -> bool {
    JAVA.contains(&base_lower)
}

/// Forward slashes, whatever the OS wrote.
pub fn norm_path(p: &str) -> String {
    p.replace('\\', "/")
}

/// The file name of a path in either separator.
pub fn base_name(p: &str) -> &str {
    match p.rfind(['/', '\\']) {
        Some(i) => &p[i + 1..],
        None => p,
    }
}

/// A list of patterns (launchers, helpers, interpreters), compared case-insensitively: without
/// '/', an executable's file name where '*' is any run of characters; with '/', a piece of the
/// path ('\' read as '/').
#[derive(Debug, Default, Clone)]
pub struct Patterns {
    names: HashSet<String>,
    globs: Vec<Vec<String>>,
    segments: Vec<String>,
}

fn glob_match(parts: &[String], s: &str) -> bool {
    let (Some(first), Some(last)) = (parts.first(), parts.last()) else { return false };
    if parts.len() == 1 {
        return s == first;
    }
    if !s.starts_with(first.as_str()) || s.len() < first.len() + last.len() || !s.ends_with(last.as_str()) {
        return false;
    }
    let mut rest = &s[first.len()..s.len() - last.len()];
    for mid in &parts[1..parts.len() - 1] {
        match rest.find(mid.as_str()) {
            Some(at) => rest = &rest[at + mid.len()..],
            None => return false,
        }
    }
    true
}

impl Patterns {
    pub fn compile(list: Option<&Value>) -> Self {
        let mut out = Self::default();
        for raw in list.and_then(Value::as_array).into_iter().flatten() {
            let Some(raw) = raw.as_str().filter(|s| !s.is_empty()) else { continue };
            let p = norm_path(raw).to_lowercase();
            if p.contains('/') {
                out.segments.push(p);
            } else if p.contains('*') {
                out.globs.push(p.split('*').map(str::to_string).collect());
            } else {
                out.names.insert(p);
            }
        }
        out
    }

    /// Whether a program at this path (or with this file name) matches.
    pub fn test(&self, p: &str) -> bool {
        if p.is_empty() {
            return false;
        }
        let lower = norm_path(p).to_lowercase();
        let base = base_name(&lower);
        self.names.contains(base) || self.globs.iter().any(|g| glob_match(g, base)) || self.segments.iter().any(|s| lower.contains(s.as_str()))
    }
}

/// One curated rule, checked and lower-cased.
#[derive(Debug, Clone)]
pub struct Rule {
    pub os: Os,
    /// File name, lower case.
    pub exe: String,
    /// A piece of the path, lower case with '/' separators.
    pub path_contains: Option<String>,
    /// Substrings of one argument, case-sensitive. Only ever on a Java rule.
    pub cmdline_any: Option<Vec<String>>,
}

#[derive(Debug, Clone)]
pub struct Curated {
    pub id: String,
    pub name: String,
    pub rules: Vec<Rule>,
}

fn valid_curated_id(id: &str) -> bool {
    let b = id.as_bytes();
    !b.is_empty()
        && b.len() <= 64
        && (b[0].is_ascii_lowercase() || b[0].is_ascii_digit())
        && b.iter().all(|&c| c.is_ascii_lowercase() || c.is_ascii_digit() || c == b'-')
}

/// A curated list, checked: an unknown OS or an empty exe drops the rule, and a command-line
/// test on anything but Java drops it too, so no other process's command line is ever read.
fn compile_curated(list: Option<&Value>) -> Vec<Curated> {
    let mut out = Vec::new();
    let mut ids = HashSet::new();
    for entry in list.and_then(Value::as_array).into_iter().flatten() {
        let Some(entry) = entry.as_object() else { continue };
        let id = entry.get("id").and_then(Value::as_str).unwrap_or("");
        let Some(name) = entry.get("name").and_then(Value::as_str).and_then(clean_name) else { continue };
        if !valid_curated_id(id) || ids.contains(id) {
            continue;
        }
        let mut rules = Vec::new();
        for r in entry.get("match").and_then(Value::as_array).into_iter().flatten() {
            let Some(r) = r.as_object() else { continue };
            let Some(os) = r.get("os").and_then(Value::as_str).and_then(Os::parse) else { continue };
            let Some(exe) = r.get("exe").and_then(Value::as_str).filter(|s| !s.is_empty()) else { continue };
            let exe = exe.to_lowercase();
            let path_contains = r.get("pathContains").and_then(Value::as_str).filter(|s| !s.is_empty()).map(|s| norm_path(s).to_lowercase());
            let mut cmdline_any = None;
            if let Some(any) = r.get("cmdlineAny") {
                let any: Vec<String> = any.as_array().into_iter().flatten().filter_map(Value::as_str).filter(|s| !s.is_empty()).map(str::to_string).collect();
                if !is_java(&exe) || any.is_empty() {
                    continue;
                }
                cmdline_any = Some(any);
            }
            rules.push(Rule { os, exe, path_contains, cmdline_any });
        }
        if rules.is_empty() {
            continue;
        }
        ids.insert(id.to_string());
        out.push(Curated { id: id.to_string(), name, rules });
    }
    out
}

/// games.json as the matcher uses it. Its Linux-only lists (wineLoaders, launcherLabels) are
/// the Electron shell's business: no rule here reads Wine or Lutris.
#[derive(Debug, Clone, Default)]
pub struct GamesData {
    pub launchers: Patterns,
    pub helpers: Patterns,
    pub interpreters: Patterns,
    pub steam_tool_appids: HashSet<String>,
    pub steam_tool_name_prefixes: Vec<String>,
    pub curated: Vec<Curated>,
    curated_by_id: HashMap<String, usize>,
}

impl GamesData {
    pub fn compile(v: &Value) -> Self {
        let curated = compile_curated(v.get("curated"));
        let curated_by_id = curated.iter().enumerate().map(|(i, c)| (c.id.clone(), i)).collect();
        Self {
            launchers: Patterns::compile(v.get("launchers")),
            helpers: Patterns::compile(v.get("helpers")),
            interpreters: Patterns::compile(v.get("interpreters")),
            steam_tool_appids: v
                .get("steamToolAppids")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(|id| match id {
                    Value::String(s) => Some(s.clone()),
                    Value::Number(n) => Some(n.to_string()),
                    _ => None,
                })
                .collect(),
            steam_tool_name_prefixes: v
                .get("steamToolNamePrefixes")
                .and_then(Value::as_array)
                .into_iter()
                .flatten()
                .filter_map(Value::as_str)
                .filter(|s| !s.is_empty())
                .map(str::to_lowercase)
                .collect(),
            curated,
            curated_by_id,
        }
    }

    pub fn parse(text: &str) -> Result<Self, String> {
        let v: Value = serde_json::from_str(text).map_err(|e| e.to_string())?;
        if !v.is_object() {
            return Err("games.json is not an object".into());
        }
        Ok(Self::compile(&v))
    }

    /// The list built into this binary.
    pub fn bundled() -> Result<Self, String> {
        Self::parse(BUNDLED)
    }

    pub fn curated_by_id(&self, id: &str) -> Option<&Curated> {
        self.curated_by_id.get(id).and_then(|&i| self.curated.get(i))
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn games_data_the_bundled_list_compiles_whole() {
        let raw: Value = serde_json::from_str(BUNDLED).unwrap();
        let data = GamesData::bundled().unwrap();
        assert_eq!(raw["version"], 1);
        // Every curated entry survives (nothing malformed was dropped quietly), with all its rules.
        let entries = raw["curated"].as_array().unwrap();
        assert_eq!(data.curated.len(), entries.len());
        for (c, e) in data.curated.iter().zip(entries) {
            assert_eq!(c.rules.len(), e["match"].as_array().unwrap().len(), "{}", c.id);
            assert_eq!(Some(c.name.as_str()), e["name"].as_str(), "name not clean: {}", c.id);
        }
        assert!(data.curated_by_id("minecraft-java").is_some());
        assert!(data.steam_tool_appids.contains("228980"));
        assert!(data.launchers.test("C:\\Program Files (x86)\\Steam\\steam.exe"));
        assert!(data.launchers.test("/home/me/.local/share/Steam/ubuntu12_32/steam"));
        assert!(data.helpers.test("D:\\Games\\X\\_CommonRedist\\vcredist\\VC_redist.x64.exe"));
        assert!(data.helpers.test("vc_redist.x86.exe"));
        assert!(data.helpers.test("C:/Games/X/EOSOverlayRenderer-Win64-Shipping.exe"));
        assert!(!data.helpers.test("C:/Games/X/Game.exe"));
        assert!(data.interpreters.test("/usr/bin/python3.13"));
    }

    #[test]
    fn games_data_a_command_line_rule_on_anything_but_java_is_dropped() {
        let v: Value = serde_json::json!({ "curated": [
            { "id": "x", "name": "X", "match": [{ "os": "win32", "exe": "x.exe", "cmdlineAny": ["--token"] }] },
            { "id": "y", "name": "Y", "match": [{ "os": "moon", "exe": "y" }] },
            { "id": "Bad Id", "name": "Z", "match": [{ "os": "win32", "exe": "z.exe" }] },
            { "id": "j", "name": "J", "match": [{ "os": "win32", "exe": "JAVAW.EXE", "cmdlineAny": ["a.Main"] }] },
        ] });
        let d = GamesData::compile(&v);
        assert_eq!(d.curated.len(), 1);
        assert_eq!(d.curated[0].id, "j");
        assert_eq!(d.curated[0].rules[0].exe, "javaw.exe");
    }

    #[test]
    fn games_data_globs() {
        let parts = |p: &str| p.split('*').map(str::to_string).collect::<Vec<_>>();
        assert!(glob_match(&parts("vc_redist*.exe"), "vc_redist.x64.exe"));
        assert!(glob_match(&parts("steam-runtime-*"), "steam-runtime-launcher-service"));
        assert!(!glob_match(&parts("steam-runtime-*"), "steam-runtime"));
        assert!(glob_match(&parts("a*b*c"), "a-b-c"));
        assert!(!glob_match(&parts("a*b*c"), "a-c-b"));
        assert!(!glob_match(&parts("ab*ba"), "aba"));
        assert!(glob_match(&parts("*"), "anything"));
    }
}
