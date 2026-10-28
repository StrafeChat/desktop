//! Steam's text KeyValues ("VDF"): libraryfolders.vdf and appmanifest_<appid>.acf. The port of
//! the Electron shell's electron/src/games/vdf.js.
//!
//!   "key"  "value"
//!   "key"  { ...nested... }
//!
//! Strings are double-quoted with backslash escapes (\\ \" \n \t); a few files leave a token
//! unquoted. `//` starts a comment, and `[$WIN32]`-style conditions after a token are skipped.
//! Keys are case-insensitive to Steam, so read them through `get`.

/// A parsed value: a string, or a nested object (its keys in file order; a later duplicate
/// key wins in `get`).
#[derive(Debug, Clone, PartialEq)]
pub enum Vdf {
    Str(String),
    Obj(Vec<(String, Vdf)>),
}

impl Vdf {
    /// A key of an object, case-insensitively; the last one when a key repeats.
    pub fn get(&self, key: &str) -> Option<&Vdf> {
        let Vdf::Obj(entries) = self else { return None };
        if let Some((_, v)) = entries.iter().rev().find(|(k, _)| k == key) {
            return Some(v);
        }
        let lower = key.to_lowercase();
        entries.iter().rev().find(|(k, _)| k.to_lowercase() == lower).map(|(_, v)| v)
    }

    pub fn as_str(&self) -> Option<&str> {
        match self {
            Vdf::Str(s) => Some(s),
            Vdf::Obj(_) => None,
        }
    }

    pub fn entries(&self) -> &[(String, Vdf)] {
        match self {
            Vdf::Obj(e) => e,
            Vdf::Str(_) => &[],
        }
    }
}

/// How deep objects are built; anything deeper is read past, never recursed into.
const MAX_DEPTH: usize = 16;

enum Token {
    Str(String),
    Open,
    Close,
}

struct Parser<'a> {
    s: &'a [char],
    i: usize,
}

impl Parser<'_> {
    fn skip_space(&mut self) {
        loop {
            while self.i < self.s.len() && self.s[self.i].is_whitespace() {
                self.i += 1;
            }
            if self.s.get(self.i) == Some(&'/') && self.s.get(self.i + 1) == Some(&'/') {
                while self.i < self.s.len() && self.s[self.i] != '\n' {
                    self.i += 1;
                }
                continue;
            }
            return;
        }
    }

    fn token(&mut self) -> Option<Token> {
        loop {
            self.skip_space();
            let c = *self.s.get(self.i)?;
            match c {
                '{' => {
                    self.i += 1;
                    return Some(Token::Open);
                }
                '}' => {
                    self.i += 1;
                    return Some(Token::Close);
                }
                '[' => {
                    // A platform condition: not data.
                    while self.i < self.s.len() && self.s[self.i] != ']' {
                        self.i += 1;
                    }
                    self.i += 1;
                    continue;
                }
                '"' => {
                    self.i += 1;
                    let mut out = String::new();
                    while self.i < self.s.len() && self.s[self.i] != '"' {
                        if self.s[self.i] == '\\' && self.i + 1 < self.s.len() {
                            let n = self.s[self.i + 1];
                            out.push(match n {
                                'n' => '\n',
                                't' => '\t',
                                other => other,
                            });
                            self.i += 2;
                        } else {
                            out.push(self.s[self.i]);
                            self.i += 1;
                        }
                    }
                    self.i += 1;
                    return Some(Token::Str(out));
                }
                _ => {
                    let mut out = String::new();
                    while self.i < self.s.len() && !(self.s[self.i].is_whitespace() || matches!(self.s[self.i], '{' | '}' | '"')) {
                        out.push(self.s[self.i]);
                        self.i += 1;
                    }
                    return Some(Token::Str(out));
                }
            }
        }
    }

    /// Past the rest of a block whose `{` was just read, without building it.
    fn skip_block(&mut self) {
        let mut open = 1usize;
        while open > 0 {
            match self.token() {
                None => return,
                Some(Token::Open) => open += 1,
                Some(Token::Close) => open -= 1,
                Some(Token::Str(_)) => {}
            }
        }
    }

    fn object(&mut self, depth: usize) -> Vec<(String, Vdf)> {
        let mut obj = Vec::new();
        loop {
            let key = match self.token() {
                None | Some(Token::Close) => return obj,
                Some(Token::Open) => {
                    // A brace with no key: read past it.
                    self.skip_block();
                    continue;
                }
                Some(Token::Str(k)) => k,
            };
            match self.token() {
                None | Some(Token::Close) => return obj,
                Some(Token::Str(v)) => obj.push((key, Vdf::Str(v))),
                Some(Token::Open) if depth >= MAX_DEPTH => self.skip_block(),
                Some(Token::Open) => {
                    let inner = self.object(depth + 1);
                    obj.push((key, Vdf::Obj(inner)));
                }
            }
        }
    }
}

/// The parsed file. Never fails: a broken file gives what could be read up to the break.
pub fn parse(text: &str) -> Vdf {
    let chars: Vec<char> = text.chars().collect();
    let mut p = Parser { s: &chars, i: 0 };
    Vdf::Obj(p.object(0))
}

/// The library paths in a libraryfolders.vdf (old files put the path straight under the
/// number; newer ones in a "path" key).
pub fn library_paths(text: &str) -> Vec<String> {
    let doc = parse(text);
    let Some(root @ Vdf::Obj(_)) = doc.get("libraryfolders") else { return Vec::new() };
    let mut out = Vec::new();
    for (k, v) in root.entries() {
        if k.is_empty() || !k.bytes().all(|b| b.is_ascii_digit()) {
            continue;
        }
        let p = match v {
            Vdf::Str(s) => Some(s.as_str()),
            obj => obj.get("path").and_then(Vdf::as_str),
        };
        if let Some(p) = p.filter(|p| !p.is_empty()) {
            out.push(p.to_string());
        }
    }
    out
}

/// What an appmanifest says about its app.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct AppManifest {
    pub appid: String,
    pub name: String,
    pub installdir: String,
}

/// `{appid, name, installdir}` of an appmanifest, or None when it lacks one of them.
pub fn app_manifest(text: &str) -> Option<AppManifest> {
    let doc = parse(text);
    let st = doc.get("AppState").filter(|v| matches!(v, Vdf::Obj(_)))?;
    let appid = st.get("appid")?.as_str()?;
    let name = st.get("name")?.as_str()?;
    let installdir = st.get("installdir")?.as_str()?;
    if appid.is_empty() || !appid.bytes().all(|b| b.is_ascii_digit()) || installdir.is_empty() {
        return None;
    }
    Some(AppManifest { appid: appid.to_string(), name: name.to_string(), installdir: installdir.to_string() })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn games_vdf_nesting_escapes_comments_conditions_and_case() {
        let text = [
            "\"Root\"",
            "{",
            "  // a comment",
            "  \"Path\"  \"C:\\\\Program Files (x86)\\\\Steam\"",
            "  \"label\" \"say \\\"hi\\\"\"",
            "  \"win\" \"1\" [$WIN32]",
            "  bare token",
            "  \"n\" { \"a\" \"1\" \"a\" \"2\" }",
            "}",
        ]
        .join("\n");
        let v = parse(&text);
        let root = v.get("root").unwrap();
        assert_eq!(root.get("path").and_then(Vdf::as_str), Some("C:\\Program Files (x86)\\Steam"));
        assert_eq!(root.get("label").and_then(Vdf::as_str), Some("say \"hi\""));
        assert_eq!(root.get("win").and_then(Vdf::as_str), Some("1"));
        assert_eq!(root.get("bare").and_then(Vdf::as_str), Some("token"));
        assert_eq!(root.get("n").unwrap().get("a").and_then(Vdf::as_str), Some("2"));
        // Broken input gives what was there, never a panic.
        assert_eq!(parse("\"a\" { \"b\" \"c\"").get("a").unwrap().get("b").and_then(Vdf::as_str), Some("c"));
        assert_eq!(parse("\"a\" \"b\" }}} \"c\" \"d\"").get("a").and_then(Vdf::as_str), Some("b"));
        // Deep nesting is skipped past, not recursed into without end.
        let deep = format!("\"k\" {}{} \"after\" \"1\"", "{ \"k\" ".repeat(5000), "}".repeat(5000));
        let d = parse(&deep);
        assert_eq!(d.get("after").and_then(Vdf::as_str), Some("1"));
        assert!(matches!(d.get("k"), Some(Vdf::Obj(_))));
    }

    #[test]
    fn games_vdf_the_fixture_files() {
        let dir = std::path::Path::new(env!("CARGO_MANIFEST_DIR")).join("../test/games/steam/steamapps");
        let text = std::fs::read_to_string(dir.join("libraryfolders.vdf")).unwrap();
        assert_eq!(library_paths(&text), vec!["{FIXTURES}/steam", "{FIXTURES}/steam-library2", "D:\\SteamLibrary\\Games"]);
        // An old file put the path straight under the number.
        assert_eq!(
            library_paths("\"LibraryFolders\" { \"TimeNextStatsReport\" \"1\" \"1\" \"/mnt/games/SteamLibrary\" }"),
            vec!["/mnt/games/SteamLibrary"]
        );
        let m = app_manifest(&std::fs::read_to_string(dir.join("appmanifest_900001.acf")).unwrap()).unwrap();
        assert_eq!(m, AppManifest { appid: "900001".into(), name: "Fixture Game".into(), installdir: "Fixture Game".into() });
        assert_eq!(app_manifest("\"AppState\" { \"appid\" \"abc\" \"name\" \"x\" \"installdir\" \"x\" }"), None);
    }
}
