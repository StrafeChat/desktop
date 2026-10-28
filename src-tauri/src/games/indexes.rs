//! What the launchers on this device say is installed, and where: Steam's library manifests
//! (every OS) and the Epic Games Launcher's `.item` manifests (Windows, macOS). Read only from
//! these local files - nothing is fetched - and rebuilt only when one of them changes, checked
//! at most once a minute. The Electron shell's electron/src/games/indexes.js does the same on
//! Linux, plus Heroic and Lutris.
//!
//! Only what recognising a game needs is kept: an app's id, its name and its install folder.
//! Account names and the like in the same files are never read out of them.

use std::{
    collections::{HashMap, HashSet},
    fs,
    path::{Path, PathBuf},
    sync::{Arc, Condvar, Mutex, MutexGuard, RwLock},
    time::UNIX_EPOCH,
};

use serde_json::Value;

use super::data::{norm_path, GamesData};
use super::matcher::{Os, Source, Verdict, RANK_INDEX};
use super::text::clean_name;
use super::vdf::{app_manifest, library_paths};

/// How often the launcher files are looked at for changes.
pub const CHECK_INTERVAL_MS: u64 = 60_000;
/// No launcher file comes near this; a bigger one is skipped.
const FILE_CAP: u64 = 8 * 1024 * 1024;
/// More manifests than any real library has; past this something is wrong.
const MANIFESTS_CAP: usize = 5000;
/// Programs listed per Steam install folder for the Windows name-only fallback.
const TOP_LEVEL_CAP: usize = 64;

/// Where the launchers keep their files.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct Roots {
    /// Steam roots (each with a `steamapps` folder).
    pub steam: Vec<PathBuf>,
    /// Folders of Epic `.item` manifests.
    pub epic: Vec<PathBuf>,
}

/// The usual places for this user on each OS. `env` reads an environment variable.
pub fn default_roots(os: Os, home: &Path, env: &dyn Fn(&str) -> Option<String>) -> Roots {
    let var = |name: &str| env(name).filter(|v| !v.is_empty());
    match os {
        Os::Win32 => {
            let mut steam = Vec::new();
            for (name, fallback) in [("ProgramFiles(x86)", "C:\\Program Files (x86)"), ("ProgramFiles", "C:\\Program Files")] {
                let p = PathBuf::from(var(name).unwrap_or_else(|| fallback.to_string())).join("Steam");
                if !steam.contains(&p) {
                    steam.push(p);
                }
            }
            let program_data = var("ProgramData").unwrap_or_else(|| "C:\\ProgramData".to_string());
            Roots { steam, epic: vec![PathBuf::from(program_data).join("Epic").join("EpicGamesLauncher").join("Data").join("Manifests")] }
        }
        Os::Darwin => {
            let support = home.join("Library").join("Application Support");
            Roots { steam: vec![support.join("Steam")], epic: vec![support.join("Epic").join("EpicGamesLauncher").join("Data").join("Manifests")] }
        }
        Os::Linux => {
            let data = var("XDG_DATA_HOME").map(PathBuf::from).filter(|p| p.is_absolute()).unwrap_or_else(|| home.join(".local/share"));
            let flat = home.join(".var/app/com.valvesoftware.Steam");
            Roots {
                steam: vec![
                    data.join("Steam"),
                    home.join(".steam/steam"),
                    home.join(".steam/root"),
                    home.join(".steam/debian-installation"),
                    flat.join(".local/share/Steam"),
                    flat.join(".steam/steam"),
                    home.join("snap/steam/common/.local/share/Steam"),
                ],
                epic: Vec::new(),
            }
        }
    }
}

/// Same comparison everywhere: '/' separators, no trailing '/', no Windows `\\?\` prefix,
/// case-folded (Windows and macOS paths may be spelled in another case than the disk has).
pub fn fold(p: &str) -> String {
    let mut s = norm_path(p);
    if let Some(rest) = s.strip_prefix("//?/UNC/").or_else(|| s.strip_prefix("//?/unc/")) {
        s = format!("//{rest}");
    } else if let Some(rest) = s.strip_prefix("//?/").or_else(|| s.strip_prefix("//./")) {
        s = rest.to_string();
    }
    while s.len() > 1 && s.ends_with('/') {
        s.pop();
    }
    s.to_lowercase()
}

/// A folded path that names a place on its own: `/...`, `c:/...` or `//server/...`.
fn folded_absolute(d: &str) -> bool {
    let b = d.as_bytes();
    d.starts_with('/') || (b.len() >= 3 && b[0].is_ascii_alphabetic() && b[1] == b':' && b[2] == b'/')
}

fn path_str(p: &Path) -> String {
    p.to_string_lossy().into_owned()
}

fn realpath_or(p: &Path) -> PathBuf {
    fs::canonicalize(p).unwrap_or_else(|_| p.to_path_buf())
}

fn read_text(file: &Path) -> Option<String> {
    let meta = fs::metadata(file).ok()?;
    if !meta.is_file() || meta.len() > FILE_CAP {
        return None;
    }
    let bytes = fs::read(file).ok()?;
    Some(String::from_utf8_lossy(&bytes).into_owned())
}

fn list_dir(dir: &Path) -> Vec<String> {
    let Ok(rd) = fs::read_dir(dir) else { return Vec::new() };
    rd.filter_map(|e| e.ok()).filter_map(|e| e.file_name().into_string().ok()).collect()
}

/// `path \0 mtime \0 size` of each, or `path \0 -` when missing: what a rebuild is decided by.
fn signature(paths: &[PathBuf]) -> String {
    let mut out = String::new();
    for p in paths {
        out.push_str(&path_str(p));
        match fs::metadata(p) {
            Ok(m) => {
                let mtime = m.modified().ok().and_then(|t| t.duration_since(UNIX_EPOCH).ok()).map(|d| d.as_nanos()).unwrap_or(0);
                out.push_str(&format!("\0{mtime}\0{}", m.len()));
            }
            Err(_) => out.push_str("\0-"),
        }
        out.push('\n');
    }
    out
}

#[derive(Debug, Clone)]
struct Prefix {
    /// Folded.
    dir: String,
    verdict: Verdict,
}

/// One built index: what the lookups read. Never changed once built - a rebuild makes a whole
/// new one beside it and swaps it in (`Indexes::refresh`), so a lookup always sees one complete
/// index, never half of a new one.
#[derive(Debug, Default)]
pub struct Index {
    /// appid -> name
    steam_apps: HashMap<String, String>,
    /// folded installdir -> verdict, or None when two libraries disagree
    steam_by_installdir: HashMap<String, Option<Verdict>>,
    /// AppName -> name
    epic_apps: HashMap<String, String>,
    /// [{dir (folded), verdict}], longest first
    prefixes: Vec<Prefix>,
    /// Windows only: folded program file name -> verdict, or None when two games share it.
    /// For a process whose path Windows will not give (an elevated game).
    by_basename: HashMap<String, Option<Verdict>>,
}

impl Index {
    pub fn steam_app(&self, appid: &str) -> Option<&str> {
        self.steam_apps.get(appid).map(String::as_str)
    }

    pub fn epic_app(&self, app_name: &str) -> Option<&str> {
        self.epic_apps.get(app_name).map(String::as_str)
    }

    /// The game a program path belongs to: the longest install folder it is in, then a
    /// `/steamapps/common/<installdir>/` piece of the path (a library seen through another
    /// mount point).
    pub fn lookup_path(&self, p: &str) -> Option<&Verdict> {
        if p.is_empty() {
            return None;
        }
        let f = fold(p);
        for pre in &self.prefixes {
            if f.len() > pre.dir.len() && f.starts_with(pre.dir.as_str()) && f.as_bytes()[pre.dir.len()] == b'/' {
                return Some(&pre.verdict);
            }
        }
        const COMMON: &str = "/steamapps/common/";
        let at = f.find(COMMON)?;
        let rest = &f[at + COMMON.len()..];
        let slash = rest.find('/').filter(|&s| s > 0)?;
        self.steam_by_installdir.get(&rest[..slash]).and_then(Option::as_ref)
    }

    /// Windows, a process with no path: a game whose launcher installed a program of this file
    /// name (Epic's launch program, or one at the top of a Steam install folder), when only one
    /// game has it.
    pub fn lookup_basename(&self, base: &str) -> Option<&Verdict> {
        self.by_basename.get(&fold(base)).and_then(Option::as_ref)
    }
}

/// Whether a folder (folded) is too broad to stand for one game: '/', a drive, `home` (folded)
/// or one of its parents.
fn too_broad(home: &str, dir: &str) -> bool {
    if dir.split('/').filter(|s| !s.is_empty()).count() < 2 {
        return true;
    }
    !home.is_empty() && (home == dir || home.starts_with(&format!("{dir}/")))
}

/// The Steam roots to read: the usual ones, then any a running Steam client named.
fn steam_roots(usual: &[PathBuf], found: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = usual.to_vec();
    for r in found {
        if !out.contains(r) {
            out.push(r.clone());
        }
    }
    out
}

/// The files a rebuild depends on that exist whatever was found last time.
fn root_files(steam: &[PathBuf], epic: &[PathBuf]) -> Vec<PathBuf> {
    let mut out = Vec::new();
    for r in steam {
        out.push(r.join("steamapps").join("libraryfolders.vdf"));
        out.push(r.join("config").join("libraryfolders.vdf"));
        out.push(r.join("steamapps"));
    }
    out.extend(epic.iter().cloned());
    out
}

/// A poisoned lock only follows a panic, and a release build aborts on one; carry on in tests.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

/// Between looks: what the next one is decided by, and whether one is in flight.
#[derive(Debug, Default)]
struct Looks {
    /// Steam roots learnt from a running Steam client (a Windows Steam installed elsewhere
    /// than Program Files): its program's folder.
    found_steam: Vec<PathBuf>,
    last_check: Option<u64>,
    sig: Option<String>,
    /// What the last build found to watch (library folders, Epic manifests).
    watched: Vec<PathBuf>,
    force_next: bool,
    /// A look is in flight: whoever asks meanwhile waits for it rather than looking again.
    in_flight: bool,
    /// Looks finished so far, and what the last one said.
    finished: u64,
    last_result: bool,
    /// Tests: callers waiting for a look in flight.
    #[cfg(test)]
    waiting: usize,
}

/// The launcher indexes: one built `Index` that lookups read, and the looks that rebuild it.
/// Shared by the scanner and get_state, each on its own thread, and never under the scanner's
/// own lock - a rebuild reads the disk, and must hold up nothing while it does.
pub struct Indexes {
    roots: Roots,
    /// Folded; a folder this broad (or broader) is never an install folder.
    home: String,
    os: Os,
    looks: Mutex<Looks>,
    look_done: Condvar,
    /// The index lookups read, with its generation (bumped by each rebuild swapped in): the
    /// two change together, so a verdict is never made with one index and filed under the
    /// other's generation.
    live: RwLock<(u64, Arc<Index>)>,
    /// Tests: run just before a rebuilt index is swapped in.
    #[cfg(test)]
    before_swap: Mutex<Option<Box<dyn FnMut() + Send>>>,
}

/// Ends a look however it ends: no longer in flight, and those waiting for it are told.
struct Finish<'a> {
    ix: &'a Indexes,
    result: bool,
}

impl Drop for Finish<'_> {
    fn drop(&mut self) {
        let mut st = lock(&self.ix.looks);
        st.in_flight = false;
        st.finished += 1;
        st.last_result = self.result;
        drop(st);
        self.ix.look_done.notify_all();
    }
}

impl Indexes {
    /// `home` is the person's home folder, used only to refuse install folders as broad as it.
    pub fn new(roots: Roots, home: &str, os: Os) -> Self {
        Self {
            roots,
            home: if home.is_empty() { String::new() } else { fold(home) },
            os,
            looks: Mutex::new(Looks::default()),
            look_done: Condvar::new(),
            live: RwLock::new((0, Arc::new(Index::default()))),
            #[cfg(test)]
            before_swap: Mutex::new(None),
        }
    }

    /// The index lookups read now. A rebuild swaps in a new one; this one stays whole.
    pub fn current(&self) -> Arc<Index> {
        Arc::clone(&self.live.read().unwrap_or_else(|e| e.into_inner()).1)
    }

    /// The index lookups read now, with its generation.
    pub fn snapshot(&self) -> (u64, Arc<Index>) {
        let live = self.live.read().unwrap_or_else(|e| e.into_inner());
        (live.0, Arc::clone(&live.1))
    }

    /// How many rebuilds have been swapped in (the scanner reads it with its index, through
    /// `snapshot`).
    #[cfg(test)]
    pub fn generation(&self) -> u64 {
        self.live.read().unwrap_or_else(|e| e.into_inner()).0
    }

    /// A Steam client seen running from this folder (Windows: `<root>\steam.exe`). Looked at
    /// on the next refresh when it is a root not known yet.
    pub fn found_steam_root(&self, dir: PathBuf) {
        let mut st = lock(&self.looks);
        let known = steam_roots(&self.roots.steam, &st.found_steam);
        if st.found_steam.len() >= 8 || known.iter().any(|r| fold(&path_str(r)) == fold(&path_str(&dir))) {
            return;
        }
        st.found_steam.push(dir);
        st.force_next = true;
    }

    /// Rebuild if a launcher file changed. Looks at most once a minute unless forced (or a new
    /// Steam root turned up). True when the index changed; `generation` says the same to anyone
    /// who did not ask. One look at a time: a call while one is in flight waits for it and
    /// returns what it found, and a forced one then looks again after it. The disk is read with
    /// no lock held, and the new index is built aside and swapped in whole, so a lookup
    /// meanwhile sees the old one.
    pub fn refresh(&self, data: &GamesData, now_ms: u64, force: bool) -> bool {
        let mut st = lock(&self.looks);
        if st.in_flight {
            #[cfg(test)]
            {
                st.waiting += 1;
            }
            let finished = st.finished;
            st = self.look_done.wait_while(st, |s| s.in_flight && s.finished == finished).unwrap_or_else(|e| e.into_inner());
            #[cfg(test)]
            {
                st.waiting -= 1;
            }
            if !force {
                return st.last_result;
            }
            st = self.look_done.wait_while(st, |s| s.in_flight).unwrap_or_else(|e| e.into_inner());
        }
        let force = force || std::mem::take(&mut st.force_next);
        if !force && st.last_check.is_some_and(|t| now_ms.saturating_sub(t) < CHECK_INTERVAL_MS) {
            return false;
        }
        st.last_check = Some(now_ms);
        st.in_flight = true;
        let steam = steam_roots(&self.roots.steam, &st.found_steam);
        let epic = self.roots.epic.clone();
        let mut watch = root_files(&steam, &epic);
        watch.extend(st.watched.iter().cloned());
        let prev = st.sig.clone();
        drop(st);
        let mut finish = Finish { ix: self, result: false };

        if !force && prev.as_deref() == Some(signature(&watch).as_str()) {
            return false;
        }
        let mut build = Build { home: &self.home, os: self.os, index: Index::default(), watched: Vec::new() };
        build.steam(data, &steam);
        build.epic(&epic);
        build.index.prefixes.sort_by(|a, b| b.dir.len().cmp(&a.dir.len()));
        let Build { index, watched, .. } = build;
        // The watched set may have grown with what the build found (library folders).
        let mut watch = root_files(&steam, &epic);
        watch.extend(watched.iter().cloned());
        let sig = signature(&watch);
        #[cfg(test)]
        if let Some(hook) = lock(&self.before_swap).as_mut() {
            hook();
        }
        {
            let mut live = self.live.write().unwrap_or_else(|e| e.into_inner());
            *live = (live.0 + 1, Arc::new(index));
        }
        let mut st = lock(&self.looks);
        st.sig = Some(sig);
        st.watched = watched;
        drop(st);
        finish.result = true;
        true
    }
}

/// One rebuild, made aside from the live index.
struct Build<'a> {
    home: &'a str,
    os: Os,
    index: Index,
    watched: Vec<PathBuf>,
}

impl Build<'_> {
    fn add_prefix(&mut self, dir: &Path, verdict: &Verdict) {
        let mut seen = HashSet::new();
        for d in [fold(&path_str(dir)), fold(&path_str(&realpath_or(dir)))] {
            if !seen.insert(d.clone()) || !folded_absolute(&d) || too_broad(self.home, &d) {
                continue;
            }
            self.index.prefixes.push(Prefix { dir: d, verdict: verdict.clone() });
        }
    }

    fn add_basename(&mut self, file_name: &str, verdict: &Verdict) {
        let b = fold(file_name);
        if b.is_empty() || b.contains('/') {
            return;
        }
        match self.index.by_basename.get(&b) {
            None => {
                self.index.by_basename.insert(b, Some(verdict.clone()));
            }
            Some(Some(prev)) if prev.key != verdict.key => {
                self.index.by_basename.insert(b, None);
            }
            Some(_) => {}
        }
    }

    fn is_steam_tool(data: &GamesData, appid: &str, name: &str) -> bool {
        if data.steam_tool_appids.contains(appid) {
            return true;
        }
        let lower = name.to_lowercase();
        data.steam_tool_name_prefixes.iter().any(|p| lower.starts_with(p.as_str()))
    }

    fn steam(&mut self, data: &GamesData, steam_roots: &[PathBuf]) {
        // Each folder as Steam (or the default) names it, told apart by where it really is: a
        // program's path may come with either spelling (a symlink, a mapped drive), and
        // add_prefix indexes both.
        let mut roots: Vec<PathBuf> = Vec::new();
        let mut root_keys = HashSet::new();
        for r in steam_roots {
            if fs::metadata(r.join("steamapps")).is_ok_and(|m| m.is_dir()) && root_keys.insert(fold(&path_str(&realpath_or(r)))) {
                roots.push(r.clone());
            }
        }
        let mut libraries: Vec<PathBuf> = Vec::new();
        let mut lib_keys = HashSet::new();
        for root in &roots {
            if lib_keys.insert(fold(&path_str(&realpath_or(root)))) {
                libraries.push(root.clone());
            }
            let vdf = read_text(&root.join("steamapps").join("libraryfolders.vdf")).or_else(|| read_text(&root.join("config").join("libraryfolders.vdf")));
            // Another OS's paths in a copied file mean nothing here: not absolute, or absent.
            for lib in vdf.as_deref().map(library_paths).unwrap_or_default() {
                let lib = PathBuf::from(lib);
                if lib.is_absolute() && lib_keys.insert(fold(&path_str(&realpath_or(&lib)))) {
                    libraries.push(lib);
                }
            }
        }
        let mut seen_dirs: HashMap<String, Option<Verdict>> = HashMap::new();
        let mut count = 0usize;
        for lib in libraries {
            let apps = lib.join("steamapps");
            let mut files: Vec<String> = list_dir(&apps).into_iter().filter(|f| is_manifest_name(f)).collect();
            if files.is_empty() {
                continue;
            }
            self.watched.push(apps.clone());
            files.sort();
            for f in files {
                count += 1;
                if count > MANIFESTS_CAP {
                    break;
                }
                let Some(m) = read_text(&apps.join(&f)).as_deref().and_then(app_manifest) else { continue };
                let Some(name) = clean_name(&m.name) else { continue };
                if Self::is_steam_tool(data, &m.appid, &name) || m.installdir.contains('/') || m.installdir.contains('\\') || m.installdir == ".." || m.installdir == "." {
                    continue;
                }
                self.index.steam_apps.insert(m.appid.clone(), name.clone());
                let verdict = Verdict { key: format!("steam:{}", m.appid), name, source: Source::Steam, rank: RANK_INDEX };
                let dir = apps.join("common").join(&m.installdir);
                self.add_prefix(&dir, &verdict);
                if self.os == Os::Win32 {
                    for file in list_dir(&dir).into_iter().filter(|n| n.to_lowercase().ends_with(".exe")).take(TOP_LEVEL_CAP) {
                        self.add_basename(&file, &verdict);
                    }
                }
                let key = m.installdir.to_lowercase();
                match seen_dirs.get(&key) {
                    None => {
                        seen_dirs.insert(key, Some(verdict));
                    }
                    Some(Some(prev)) if prev.key != verdict.key => {
                        seen_dirs.insert(key, None);
                    }
                    Some(_) => {}
                }
            }
        }
        self.index.steam_by_installdir = seen_dirs;
    }

    /// Epic's manifests: one JSON file per install. DLC (its main game is another app),
    /// unfinished installs, engines and add-ons are skipped.
    fn epic(&mut self, dirs: &[PathBuf]) {
        for dir in dirs {
            let mut files: Vec<String> = list_dir(dir).into_iter().filter(|f| f.to_lowercase().ends_with(".item")).collect();
            files.sort();
            files.truncate(MANIFESTS_CAP);
            for f in files {
                let file = dir.join(&f);
                self.watched.push(file.clone());
                let Some(v) = read_text(&file).and_then(|t| serde_json::from_str::<Value>(&t).ok()) else { continue };
                let Some(e) = epic_entry(&v) else { continue };
                if self.index.epic_apps.contains_key(&e.app_name) {
                    continue;
                }
                self.index.epic_apps.insert(e.app_name.clone(), e.name.clone());
                let verdict = Verdict { key: format!("epic:{}", e.app_name), name: e.name, source: Source::Epic, rank: RANK_INDEX };
                if let Some(loc) = e.install_location.filter(|l| Path::new(l).is_absolute()) {
                    self.add_prefix(Path::new(&loc), &verdict);
                }
                if self.os == Os::Win32 {
                    if let Some(exe) = e.launch_executable {
                        let base = super::data::base_name(&exe).to_string();
                        self.add_basename(&base, &verdict);
                    }
                }
            }
        }
    }
}

fn is_manifest_name(f: &str) -> bool {
    f.strip_prefix("appmanifest_")
        .and_then(|r| r.strip_suffix(".acf"))
        .is_some_and(|id| !id.is_empty() && id.bytes().all(|b| b.is_ascii_digit()))
}

struct EpicEntry {
    app_name: String,
    name: String,
    install_location: Option<String>,
    launch_executable: Option<String>,
}

fn valid_epic_app_name(s: &str) -> bool {
    !s.is_empty() && s.len() <= 128 && s.bytes().all(|b| b.is_ascii_alphanumeric() || matches!(b, b'_' | b'-' | b'.'))
}

/// What one `.item` manifest says, when it is an installed game.
fn epic_entry(v: &Value) -> Option<EpicEntry> {
    let s = |k: &str| v.get(k).and_then(Value::as_str).unwrap_or("");
    if v.get("bIsIncompleteInstall").and_then(Value::as_bool) == Some(true) {
        return None;
    }
    let app_name = s("AppName");
    if !valid_epic_app_name(app_name) {
        return None;
    }
    // DLC names its game as the main one.
    let main = s("MainGameAppName");
    if !main.is_empty() && main != app_name {
        return None;
    }
    let categories: Vec<String> = v.get("AppCategories").and_then(Value::as_array).into_iter().flatten().filter_map(Value::as_str).map(str::to_lowercase).collect();
    if categories.iter().any(|c| c == "addons" || c == "engines" || c == "plugins") {
        return None;
    }
    let name = clean_name(s("DisplayName"))?;
    let loc = s("InstallLocation");
    let exe = s("LaunchExecutable");
    Some(EpicEntry {
        app_name: app_name.to_string(),
        name,
        install_location: (!loc.is_empty()).then(|| loc.to_string()),
        launch_executable: (!exe.is_empty()).then(|| exe.to_string()),
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::games::tests_support::{copy_fixtures, fixture_roots};

    #[test]
    fn games_indexes_tools_and_dlc_left_out_nothing_too_broad_rebuilt_only_on_change() {
        let data = GamesData::bundled().unwrap();
        let tmp = copy_fixtures();
        let dir = tmp.path();
        let index = Indexes::new(fixture_roots(dir), &path_str(dir), Os::Linux);
        let mut now = 1_000_000u64;
        assert_eq!(index.generation(), 0);
        assert!(index.refresh(&data, now, false));
        assert_eq!(index.generation(), 1);
        let built = index.current();
        assert_eq!(built.steam_app("900001"), Some("Fixture Game"));
        assert_eq!(built.steam_app("900004"), Some("Second Library Game\u{2122}"));
        assert_eq!(built.steam_app("228980"), None, "a tool by its id");
        assert_eq!(built.steam_app("431960"), None, "an always-on application by its id");
        assert_eq!(built.steam_app("900002"), None, "a tool by its name");
        assert_eq!(built.epic_app("FixtureEpicApp"), Some("Epic Fixture"));
        assert_eq!(built.epic_app("FixtureEpicDlc"), None, "DLC");
        assert_eq!(built.epic_app("FixtureIncomplete"), None, "unfinished");
        // Looked at no more than once a minute, and rebuilt only when a file changed.
        now += 1000;
        assert!(!index.refresh(&data, now, false));
        now += CHECK_INTERVAL_MS;
        assert!(!index.refresh(&data, now, false));
        assert_eq!(index.generation(), 1, "nothing changed, nothing rebuilt");
        fs::write(dir.join("steam-library2/steamapps/appmanifest_900005.acf"), "\"AppState\" { \"appid\" \"900005\" \"name\" \"Newly Installed\" \"installdir\" \"New\" }").unwrap();
        now += CHECK_INTERVAL_MS;
        assert!(index.refresh(&data, now, false));
        assert_eq!(index.current().steam_app("900005"), Some("Newly Installed"));
        assert_eq!(built.steam_app("900005"), None, "an index once built never changes");
        // A new Epic manifest is noticed too.
        fs::write(
            dir.join("epic/NEW.item"),
            r#"{"AppName":"NewEpic","MainGameAppName":"NewEpic","DisplayName":"New Epic","InstallLocation":"/nowhere/NewEpic","bIsIncompleteInstall":false}"#,
        )
        .unwrap();
        now += CHECK_INTERVAL_MS;
        assert!(index.refresh(&data, now, false));
        assert_eq!(index.current().epic_app("NewEpic"), Some("New Epic"));
        // An install folder as broad as the home folder (or above it) is ignored.
        fs::write(
            dir.join("epic/BROAD.item"),
            format!(r#"{{"AppName":"Broad","DisplayName":"Broad","InstallLocation":{}}}"#, serde_json::to_string(&path_str(dir)).unwrap()),
        )
        .unwrap();
        now += CHECK_INTERVAL_MS;
        assert!(index.refresh(&data, now, false));
        assert_eq!(index.current().epic_app("Broad"), Some("Broad"));
        assert_eq!(index.current().lookup_path(&path_str(&dir.join("anything/x"))), None);
        assert_eq!(index.current().lookup_path("/x"), None);
        // Forced: rebuilt whatever the clock says.
        assert!(index.refresh(&data, now, true));
    }

    /// The Electron shell's "a rebuild is built aside and swapped in whole, one look at a time":
    /// a lookup during a rebuild sees the whole old index, a refresh asked for meanwhile waits
    /// for the one in flight and says what it found, and a forced one looks again after it.
    #[test]
    fn games_indexes_a_rebuild_is_built_aside_and_swapped_in_whole_one_look_at_a_time() {
        use std::sync::mpsc;
        let data = Arc::new(GamesData::bundled().unwrap());
        let tmp = copy_fixtures();
        let dir = tmp.path().to_path_buf();
        let index = Arc::new(Indexes::new(fixture_roots(&dir), "/home/someone", Os::Linux));
        assert!(index.refresh(&data, 0, true));
        assert_eq!(index.generation(), 1);
        let before = index.current();
        let game = path_str(&dir.join("steam/steamapps/common/Fixture Game/bin/fixturegame"));
        fs::write(dir.join("steam-library2/steamapps/appmanifest_900005.acf"), "\"AppState\" { \"appid\" \"900005\" \"name\" \"Newly Installed\" \"installdir\" \"New\" }").unwrap();
        // Every rebuild stops just before its swap until `go` is dropped.
        let (reached_tx, reached_rx) = mpsc::channel::<()>();
        let (go_tx, go_rx) = mpsc::channel::<()>();
        *lock(&index.before_swap) = Some(Box::new(move || {
            let _ = reached_tx.send(());
            let _ = go_rx.recv();
        }));
        let refresh = |now: u64, force: bool| {
            let (index, data) = (Arc::clone(&index), Arc::clone(&data));
            std::thread::spawn(move || index.refresh(&data, now, force))
        };
        let first = refresh(1, true);
        reached_rx.recv().unwrap();
        // Built, not yet swapped in: whatever asks meanwhile (a scan, get_state) sees the whole
        // old index.
        let live = index.current();
        assert_eq!(live.steam_app("900001"), Some("Fixture Game"));
        assert_eq!(live.lookup_path(&game).map(|v| v.key.as_str()), Some("steam:900001"));
        assert_eq!(live.steam_app("900005"), None);
        assert_eq!(index.generation(), 1);
        // A look asked for now shares the one in flight (alone, it would say "looked a moment
        // ago, nothing new"), and a forced one waits for it, then looks again.
        let shared = refresh(2, false);
        let forced = refresh(3, true);
        let deadline = std::time::Instant::now() + std::time::Duration::from_secs(10);
        while lock(&index.looks).waiting < 2 && std::time::Instant::now() < deadline {
            std::thread::sleep(std::time::Duration::from_millis(5));
        }
        assert_eq!(lock(&index.looks).waiting, 2);
        assert_eq!(index.generation(), 1);
        drop(go_tx);
        assert!(first.join().unwrap());
        assert!(shared.join().unwrap(), "the shared look says what the one in flight found");
        assert!(forced.join().unwrap());
        assert_eq!(index.generation(), 3, "one generation per rebuild: the first and the forced one");
        assert_eq!(index.current().steam_app("900005"), Some("Newly Installed"));
        assert_eq!(index.current().lookup_path(&game).map(|v| v.key.as_str()), Some("steam:900001"));
        // The old index stayed whole for whoever still holds it.
        assert_eq!(before.steam_app("900001"), Some("Fixture Game"));
        assert_eq!(before.steam_app("900005"), None);
        // Snapshots name the index with its own generation.
        let (gen, snap) = index.snapshot();
        assert_eq!(gen, 3);
        assert!(Arc::ptr_eq(&snap, &index.current()));
    }

    #[test]
    fn games_indexes_lookups_longest_prefix_and_the_steamapps_segment() {
        let data = GamesData::bundled().unwrap();
        let tmp = copy_fixtures();
        let dir = tmp.path();
        let indexes = Indexes::new(fixture_roots(dir), "/home/someone", Os::Linux);
        indexes.refresh(&data, 0, true);
        let index = indexes.current();
        let key = |p: &str| index.lookup_path(p).map(|v| v.key.clone());
        let common = path_str(&dir.join("steam/steamapps/common"));
        assert_eq!(key(&format!("{common}/Fixture Game/bin/fixturegame")).as_deref(), Some("steam:900001"));
        // The folder itself, or a sibling that starts the same, is not inside it.
        assert_eq!(key(&format!("{common}/Fixture Game")), None);
        assert_eq!(key(&format!("{common}/Fixture Gamer/x")), None);
        // Through another mount point; Windows spelling and case.
        assert_eq!(key("/run/host/mnt/x/steamapps/common/Fixture Game/x").as_deref(), Some("steam:900001"));
        assert_eq!(key("D:\\SteamLibrary\\steamapps\\common\\FIXTURE GAME\\Game.exe").as_deref(), Some("steam:900001"));
        assert_eq!(key("/x/steamapps/common/Unknown/x"), None);
        assert_eq!(key(""), None);
    }

    /// A library reached through a symlink: a program's path matches by either spelling.
    #[cfg(unix)]
    #[test]
    fn games_indexes_both_spellings_of_a_linked_library() {
        let data = GamesData::bundled().unwrap();
        let tmp = copy_fixtures();
        let dir = tmp.path();
        fs::create_dir_all(dir.join("steam/steamapps/common/Fixture Game")).unwrap();
        std::os::unix::fs::symlink(dir.join("steam"), dir.join("steam-alias")).unwrap();
        let roots = Roots { steam: vec![dir.join("steam-alias"), dir.join("steam")], epic: vec![] };
        let indexes = Indexes::new(roots, "", Os::Linux);
        indexes.refresh(&data, 0, true);
        let index = indexes.current();
        for root in ["steam-alias", "steam"] {
            let p = path_str(&dir.join(root).join("steamapps/common/Fixture Game/game"));
            assert_eq!(index.lookup_path(&p).map(|v| v.key.as_str()), Some("steam:900001"), "{root}");
        }
        // One root, however many names it has: each library is read once.
        assert_eq!(index.prefixes.iter().filter(|p| p.verdict.key == "steam:900001").count(), 2);
    }

    #[test]
    fn games_indexes_windows_names_for_processes_without_a_path() {
        let data = GamesData::bundled().unwrap();
        let tmp = copy_fixtures();
        let dir = tmp.path();
        // Programs at the top of the Steam install folders (the fixtures have only manifests).
        fs::create_dir_all(dir.join("steam/steamapps/common/Fixture Game")).unwrap();
        fs::write(dir.join("steam/steamapps/common/Fixture Game/FixtureGame.exe"), b"").unwrap();
        fs::write(dir.join("steam/steamapps/common/Fixture Game/Shared.exe"), b"").unwrap();
        fs::create_dir_all(dir.join("steam-library2/steamapps/common/SecondGame")).unwrap();
        fs::write(dir.join("steam-library2/steamapps/common/SecondGame/Shared.exe"), b"").unwrap();
        let indexes = Indexes::new(fixture_roots(dir), "", Os::Win32);
        indexes.refresh(&data, 0, true);
        let index = indexes.current();
        let key = |b: &str| index.lookup_basename(b).map(|v| v.key.clone());
        assert_eq!(key("fixturegame.exe").as_deref(), Some("steam:900001"));
        assert_eq!(key("EpicFixture-Win64-Shipping.exe").as_deref(), Some("epic:FixtureEpicApp"));
        assert_eq!(key("shared.exe"), None, "two games have one");
        assert_eq!(key("unknown.exe"), None);
        // Only Windows builds this.
        let linux = Indexes::new(fixture_roots(dir), "", Os::Linux);
        linux.refresh(&data, 0, true);
        assert_eq!(linux.current().lookup_basename("fixturegame.exe"), None);
    }

    #[test]
    fn games_indexes_a_running_steam_client_adds_its_root() {
        let data = GamesData::bundled().unwrap();
        let tmp = copy_fixtures();
        let dir = tmp.path();
        let index = Indexes::new(Roots::default(), "", Os::Win32);
        index.refresh(&data, 0, false);
        assert_eq!(index.current().steam_app("900001"), None);
        index.found_steam_root(dir.join("steam"));
        // Noticed at once, not a minute later.
        assert!(index.refresh(&data, 1, false));
        assert_eq!(index.current().steam_app("900001"), Some("Fixture Game"));
        // The same root again changes nothing.
        index.found_steam_root(dir.join("steam"));
        assert!(!index.refresh(&data, 2, false));
    }

    #[test]
    fn games_indexes_default_roots_per_os() {
        let env = |k: &str| match k {
            "ProgramFiles(x86)" => Some("E:\\Apps (x86)".to_string()),
            "ProgramData" => Some("D:\\ProgramData".to_string()),
            "XDG_DATA_HOME" => Some("relative/data".to_string()),
            _ => None,
        };
        let win = default_roots(Os::Win32, Path::new("C:\\Users\\someone"), &env);
        assert_eq!(win.steam, vec![PathBuf::from("E:\\Apps (x86)").join("Steam"), PathBuf::from("C:\\Program Files").join("Steam")]);
        assert_eq!(win.epic, vec![PathBuf::from("D:\\ProgramData").join("Epic").join("EpicGamesLauncher").join("Data").join("Manifests")]);
        let mac = default_roots(Os::Darwin, Path::new("/Users/someone"), &env);
        assert_eq!(mac.steam, vec![PathBuf::from("/Users/someone/Library/Application Support/Steam")]);
        assert_eq!(mac.epic, vec![PathBuf::from("/Users/someone/Library/Application Support/Epic/EpicGamesLauncher/Data/Manifests")]);
        // A relative XDG_DATA_HOME is ignored, as the spec says.
        let linux = default_roots(Os::Linux, Path::new("/home/someone"), &env);
        assert_eq!(linux.steam[0], PathBuf::from("/home/someone/.local/share/Steam"));
        assert!(linux.epic.is_empty());
    }

    #[test]
    fn games_indexes_fold() {
        assert_eq!(fold("C:\\Program Files\\Steam\\"), "c:/program files/steam");
        assert_eq!(fold("\\\\?\\C:\\Games\\X"), "c:/games/x");
        assert_eq!(fold("\\\\?\\UNC\\server\\share\\X"), "//server/share/x");
        assert_eq!(fold("/"), "/");
        assert!(folded_absolute("c:/x") && folded_absolute("/x") && folded_absolute("//s/x"));
        assert!(!folded_absolute("x/y") && !folded_absolute("c:x"));
        let home = fold("C:\\Users\\someone");
        assert!(too_broad(&home, "c:"));
        assert!(too_broad(&home, "c:/users"));
        assert!(too_broad(&home, "c:/users/someone"));
        assert!(!too_broad(&home, "c:/users/someone/games"));
        assert!(!too_broad(&home, "d:/fortnite"));
    }
}
