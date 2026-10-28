//! Which game, if any, one process is. Pure: it gets the process's program path (or, on Windows,
//! only its file name when the path cannot be read) and - only when `needs` asked for it - its
//! command line, plus the indexes and lists to look them up in. The OS is a parameter, so the
//! Windows and macOS rules are tested on Linux too; desktop/test/games/cases.json holds the cases
//! both shells must agree on. The port of electron/src/games/matcher.js, without the rules only
//! Linux needs (Steam's reaper, Wine and its launcher tags), which the Electron shell has.
//!
//! The order (spec §2, research-detection-sources §13). Strafe's own processes are skipped by
//! the caller first. Then:
//!   launchers, helpers  never a game
//!   1 user-added        the exact program the person picked -> user:<id>
//!   4 install folders   Steam libraries, Epic manifests -> steam:<appid> / epic:<AppName>
//!   5 curated           games.json, in its order -> curated:<id>
//! A Windows process whose path cannot be read (an elevated game seen from a normal Strafe) is
//! matched by its file name alone: what the launchers installed under that name, then curated.

use std::collections::{HashMap, HashSet};

use super::data::{base_name, is_java, norm_path, GamesData};
use super::indexes::Index;

/// Which OS's rules apply.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Os {
    Linux,
    Win32,
    Darwin,
}

impl Os {
    pub fn parse(s: &str) -> Option<Self> {
        match s {
            "linux" => Some(Self::Linux),
            "win32" => Some(Self::Win32),
            "darwin" => Some(Self::Darwin),
            _ => None,
        }
    }

    /// The OS this binary runs on (a BSD would be closest to Linux's rules).
    pub fn current() -> Self {
        if cfg!(windows) {
            Self::Win32
        } else if cfg!(target_os = "macos") {
            Self::Darwin
        } else {
            Self::Linux
        }
    }

    /// Whether paths are compared without case (NTFS and APFS by default).
    pub fn fold_case(self) -> bool {
        self != Self::Linux
    }
}

/// Where a game was recognised from (the first half of its key).
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash)]
pub enum Source {
    User,
    Steam,
    Epic,
    Curated,
}

impl Source {
    pub fn as_str(self) -> &'static str {
        match self {
            Self::User => "user",
            Self::Steam => "steam",
            Self::Epic => "epic",
            Self::Curated => "curated",
        }
    }
}

/// How authoritative a rule is: lower wins a tie (same numbers as the Electron shell's RANK).
pub const RANK_USER: u8 = 1;
pub const RANK_INDEX: u8 = 4;
pub const RANK_CURATED: u8 = 5;

/// What a process is.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Verdict {
    pub key: String,
    pub name: String,
    pub source: Source,
    pub rank: u8,
}

/// A program the person added as a game (activity.json `user`).
#[derive(Debug, Clone, PartialEq, Eq, serde::Serialize, serde::Deserialize)]
pub struct UserGame {
    pub id: String,
    pub path: String,
    pub name: String,
}

/// What has to be read about a process before it can be classified: its command line only for
/// Java (critique #16). Never its environment: none of these rules uses one.
pub fn needs_cmdline(exe_or_name: &str) -> bool {
    is_java(&base_name(exe_or_name).to_lowercase())
}

/// Whether two program paths are the same file: exact on Linux, case-insensitive with either
/// separator on Windows and macOS.
pub fn same_path(a: &str, b: &str, os: Os) -> bool {
    if a.is_empty() || b.is_empty() {
        return false;
    }
    if os.fold_case() {
        norm_path(a).to_lowercase() == norm_path(b).to_lowercase()
    } else {
        norm_path(a) == norm_path(b)
    }
}

pub struct Ctx<'a> {
    pub os: Os,
    pub data: &'a GamesData,
    /// The launcher index as built when the scan began.
    pub index: &'a Index,
    pub user: &'a [UserGame],
}

/// The program a process runs, as the rules see it: its full path ('' when unknown) and its
/// lower-case file name. None when there is nothing to go on.
fn program(exe: &str, name: &str, os: Os) -> Option<(String, String)> {
    if !exe.is_empty() {
        return Some((exe.to_string(), base_name(exe).to_lowercase()));
    }
    // Only Windows gives a file name for a process whose path it will not give.
    if os == Os::Win32 && !name.is_empty() {
        return Some((String::new(), base_name(name).to_lowercase()));
    }
    None
}

fn curated_match(ctx: &Ctx<'_>, path: &str, base: &str, cmdline: Option<&[String]>) -> Option<Verdict> {
    let lower_path = norm_path(path).to_lowercase();
    for entry in &ctx.data.curated {
        for rule in &entry.rules {
            if rule.os != ctx.os || rule.exe != base {
                continue;
            }
            if let Some(piece) = &rule.path_contains {
                if !lower_path.contains(piece.as_str()) {
                    continue;
                }
            }
            if let Some(any) = &rule.cmdline_any {
                let hit = cmdline.is_some_and(|args| args.iter().any(|a| any.iter().any(|s| a.contains(s.as_str()))));
                if !hit {
                    continue;
                }
            }
            return Some(Verdict { key: format!("curated:{}", entry.id), name: entry.name.clone(), source: Source::Curated, rank: RANK_CURATED });
        }
    }
    None
}

/// The game one process belongs to, or None.
///
/// `exe` is the program's full path ('' when it could not be read), `name` the OS's name for
/// the process (used only on Windows, only when `exe` is ''), `cmdline` its arguments - only
/// ever given when `needs_cmdline` asked for them.
pub fn classify(exe: &str, name: &str, cmdline: Option<&[String]>, ctx: &Ctx<'_>) -> Option<Verdict> {
    let (path, base) = program(exe, name, ctx.os)?;
    if base.is_empty() {
        return None;
    }
    let probe = if path.is_empty() { base.as_str() } else { path.as_str() };
    if ctx.data.launchers.test(probe) || ctx.data.helpers.test(probe) {
        return None;
    }

    // 1: what the person added, by its exact program.
    for u in ctx.user {
        if same_path(&u.path, &path, ctx.os) {
            return Some(Verdict { key: format!("user:{}", u.id), name: u.name.clone(), source: Source::User, rank: RANK_USER });
        }
    }

    // 4: the folder a launcher installed it in (or, with no path, a program of that name
    // there).
    let hit = if path.is_empty() { ctx.index.lookup_basename(&base) } else { ctx.index.lookup_path(&path) };
    if let Some(v) = hit {
        return Some(Verdict { rank: RANK_INDEX, ..v.clone() });
    }

    // 5: games.json.
    curated_match(ctx, &path, &base, cmdline)
}

/// One process of a snapshot, as the scanner (or a cases.json case) has it.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct ProcInfo {
    pub pid: u32,
    pub ppid: u32,
    /// Unix ms the process started; 0 when the OS would not say.
    pub start_ms: u64,
    /// Full program path; '' when it could not be read.
    pub exe: String,
    /// The OS's name for the process (Windows: the image's file name).
    pub name: String,
}

/// Strafe's own pids: `self_pid` and everything under it (the webview's processes).
pub fn own_tree(processes: &[ProcInfo], self_pid: u32) -> HashSet<u32> {
    let mut own = HashSet::new();
    if self_pid == 0 {
        return own;
    }
    own.insert(self_pid);
    let mut children: HashMap<u32, Vec<u32>> = HashMap::new();
    for p in processes {
        children.entry(p.ppid).or_default().push(p.pid);
    }
    let mut stack = vec![self_pid];
    while let Some(pid) = stack.pop() {
        for &c in children.get(&pid).map(Vec::as_slice).unwrap_or(&[]) {
            if own.insert(c) {
                stack.push(c);
            }
        }
    }
    own
}

/// A process matched: what it is and when it started.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct Match {
    pub verdict: Verdict,
    pub start_ms: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn games_matcher_command_lines_only_for_java() {
        assert!(!needs_cmdline("/home/me/Games/foo/foo"));
        assert!(needs_cmdline("/usr/lib/jvm/x/bin/java"));
        assert!(needs_cmdline("C:\\Java\\bin\\javaw.exe"));
        assert!(needs_cmdline("JAVA.EXE"));
        // Not even Wine or Steam's reaper: this shell has no rule that reads theirs.
        assert!(!needs_cmdline("/usr/lib/wine/x86_64-unix/wine64-preloader"));
        assert!(!needs_cmdline("/home/me/.local/share/Steam/ubuntu12_32/reaper"));
    }

    #[test]
    fn games_matcher_a_path_is_needed_except_on_windows() {
        let data = GamesData::bundled().unwrap();
        let index = Index::default();
        let ctx = |os| Ctx { os, data: &data, index: &index, user: &[] };
        // An elevated game on Windows: no path, but its file name is enough for a curated rule.
        let v = classify("", "VALORANT-Win64-Shipping.exe", None, &ctx(Os::Win32)).unwrap();
        assert_eq!(v.key, "curated:valorant");
        // ...and a launcher is still a launcher by its name.
        assert_eq!(classify("", "EpicGamesLauncher.exe", None, &ctx(Os::Win32)), None);
        // Elsewhere a process with no readable program is not looked at.
        assert_eq!(classify("", "factorio", None, &ctx(Os::Linux)), None);
        assert_eq!(classify("/opt/factorio/bin/x64/factorio", "", None, &ctx(Os::Linux)).map(|v| v.key).as_deref(), Some("curated:factorio"));
        // A user-added game needs its path.
        let user = [UserGame { id: "u1".into(), path: "C:\\Games\\x.exe".into(), name: "X".into() }];
        let with_user = Ctx { os: Os::Win32, data: &data, index: &index, user: &user };
        assert_eq!(classify("", "x.exe", None, &with_user), None);
        assert_eq!(classify("c:/games/X.EXE", "x.exe", None, &with_user).map(|v| v.key).as_deref(), Some("user:u1"));
    }

    #[test]
    fn games_matcher_minecraft_needs_its_main_class() {
        let data = GamesData::bundled().unwrap();
        let index = Index::default();
        let ctx = Ctx { os: Os::Linux, data: &data, index: &index, user: &[] };
        let java = "/usr/lib/jvm/java-21-openjdk/bin/java";
        let args = |a: &[&str]| a.iter().map(|s| s.to_string()).collect::<Vec<_>>();
        let mc = args(&[java, "-cp", "x.jar", "net.minecraft.client.main.Main", "--version", "1.21"]);
        assert_eq!(classify(java, "java", Some(&mc), &ctx).map(|v| v.key).as_deref(), Some("curated:minecraft-java"));
        let forge = args(&[java, "-cp", "x.jar", "cpw.mods.bootstraplauncher.BootstrapLauncher"]);
        assert_eq!(classify(java, "java", Some(&forge), &ctx).map(|v| v.key).as_deref(), Some("curated:minecraft-java"));
        let rl = args(&[java, "-cp", "x.jar", "net.runelite.client.RuneLite"]);
        assert_eq!(classify(java, "java", Some(&rl), &ctx).map(|v| v.key).as_deref(), Some("curated:old-school-runescape"));
        // Case matters in a class name, and an unread command line matches nothing.
        let wrong = args(&[java, "NET.MINECRAFT.CLIENT.MAIN.MAIN"]);
        assert_eq!(classify(java, "java", Some(&wrong), &ctx), None);
        assert_eq!(classify(java, "java", None, &ctx), None);
    }

    #[test]
    fn games_matcher_own_tree() {
        let p = |pid, ppid| ProcInfo { pid, ppid, ..Default::default() };
        let list = [p(1, 0), p(10, 1), p(11, 10), p(12, 11), p(20, 1), p(13, 12)];
        let own = own_tree(&list, 10);
        assert_eq!(own, [10, 11, 12, 13].into_iter().collect());
        assert!(own_tree(&list, 0).is_empty());
        // A loop in the parents (pid reuse mid-listing) ends.
        let looped = [p(5, 6), p(6, 5)];
        assert_eq!(own_tree(&looped, 5), [5, 6].into_iter().collect());
    }

    #[test]
    fn games_matcher_same_path() {
        assert!(same_path("/a/B", "/a/B", Os::Linux));
        assert!(!same_path("/a/B", "/a/b", Os::Linux));
        assert!(same_path("C:\\Games\\A.exe", "c:/games/a.EXE", Os::Win32));
        assert!(same_path("/Applications/A.app/Contents/MacOS/A", "/applications/a.app/contents/macos/a", Os::Darwin));
        assert!(!same_path("", "", Os::Win32));
    }
}
