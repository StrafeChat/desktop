//! Game activity for the Windows and macOS shell: recognises the game being played on this
//! device and tells the main window what to share - its name and when it started, or null -
//! and nothing else. The process list never leaves this module: no process data is logged,
//! kept past the scan that read it, or handed to the page (critique #12, #16).
//!
//! Sharing is off until the person turns it on, for one desktop account at a time (critique
//! #17); while it is off for the account signed in now, no process is looked at. The same
//! behaviour as the Electron shell's electron/src/games/index.js; the Tauri commands that
//! reach it are in mod.rs.

use std::{
    collections::{hash_map::RandomState, HashMap, HashSet},
    hash::BuildHasher,
    path::{Path, PathBuf},
    sync::{
        atomic::{AtomicU64, Ordering},
        mpsc::{self, Receiver, RecvTimeoutError, Sender, TryRecvError},
        Arc, Mutex, MutexGuard,
    },
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use serde::Serialize;

use super::data::{base_name, GamesData};
use super::indexes::{fold, Index, Indexes, Roots};
use super::matcher::{classify, needs_cmdline, own_tree, Ctx, Match, Os, ProcInfo, UserGame, Verdict};
use super::prefs::{self, ActivityPrefs, LIMIT_ACCOUNTS, LIMIT_HIDDEN, LIMIT_RENAMES, LIMIT_USER};
use super::procs::ProcessSource;
use super::text::{clean_name, valid_name, NAME_MAX};
use super::tracker::{Session, Tracker};

/// How often to look while sharing is on.
pub const SCAN_INTERVAL: Duration = Duration::from_secs(15);
/// How long an id from running_programs() can be added from.
pub const OFFER_TTL_MS: u64 = 5 * 60_000;
const OFFER_CAP: usize = 1000;
/// The most programs "Add it" lists.
const RUNNING_CAP: usize = 200;
/// The worker looks at the clocks this often while sharing is on (a scan is still every
/// interval): often enough to notice a sleep soon after waking from it.
const TICK: Duration = Duration::from_secs(5);
/// Sharing off: nothing to do until a message comes.
const IDLE: Duration = Duration::from_secs(60 * 60);

const ACCOUNTS_FILE: &str = "accounts.json";

/// What the page is told to share (the `activity-changed` payload). Snake case on the wire, as
/// the Electron shell sends it.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct ActivityPayload {
    pub name: String,
    pub started_at: u64,
}

/// `games_get_state().current`: exactly the last `activity-changed` payload, with its key.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct CurrentGame {
    pub key: String,
    pub name: String,
    pub started_at: u64,
}

/// A game this device knows about: customised, added, or running now.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GameRow {
    pub key: String,
    pub name: String,
    pub detected_name: String,
    pub source: String,
    pub hidden: bool,
    pub renamed: bool,
    pub running: bool,
}

/// `games_get_state()`. `share` is said for `account`, the desktop account signed in as the
/// shell knows it (accounts.json `active`; null when none), so a page signed in as another
/// cannot take it for its own.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct GamesState {
    pub share: bool,
    pub account: Option<String>,
    pub current: Option<CurrentGame>,
    pub games: Vec<GameRow>,
}

/// A program running now, for "Add it": an opaque id and the program's file name. Never its
/// path, command line or environment.
#[derive(Debug, Clone, PartialEq, Eq, Serialize)]
pub struct RunningProgram {
    pub id: String,
    pub name: String,
}

/// How the service is put together; the app's are in mod.rs, the tests' in tests.rs.
pub struct Options {
    pub os: Os,
    pub data: GamesData,
    /// activity.json and accounts.json are here.
    pub config_dir: PathBuf,
    pub roots: Roots,
    pub home: String,
    /// Strafe's own pid: it and everything under it is never a game.
    pub self_pid: u32,
    pub interval: Duration,
    pub source: Box<dyn ProcessSource>,
    /// The push to the main window, on change only.
    pub emit: Box<dyn Fn(Option<ActivityPayload>) + Send + Sync>,
    /// Unix ms.
    pub now: Box<dyn Fn() -> u64 + Send + Sync>,
}

/// One process, as the verdict cache knows it: a wrapper script that execs the game keeps its
/// pid and start time, so the program is part of who it is.
type Identity = (u32, u64, String);

#[derive(Debug, Clone)]
struct Cached {
    verdict: Option<Verdict>,
    /// When it was first seen: its start, when the OS would not say.
    first_seen: u64,
}

#[derive(Debug, Clone)]
struct Offer {
    id: String,
    path: String,
    expires: u64,
}

struct Inner {
    prefs: ActivityPrefs,
    /// The desktop account signed in now (accounts.json `active`).
    active: Option<String>,
    /// Whether the scanner is on: sharing is on for the active account.
    scanning: bool,
    /// Bumped whenever scanning stops, so a scan in flight then changes nothing.
    gen: u64,
    stopped: bool,
    tracker: Tracker,
    /// The only thing kept between scans: what each running process is (None: not a game).
    verdicts: HashMap<Identity, Cached>,
    /// Set when the person's own list changed: the verdicts are then stale.
    verdicts_stale: bool,
    /// The launcher index's generation the verdicts were made with. Whoever rebuilt the index
    /// (a scan, or get_state looking for names), verdicts from before it are dropped: a game
    /// installed since must not stay "not a game" for as long as its process runs.
    verdicts_gen: Option<u64>,
    /// What the page was last told, and the same with its key (get_state's `current`).
    last_sent: Option<ActivityPayload>,
    current: Option<CurrentGame>,
    /// Names of games seen running this run, for the Settings list once they have stopped.
    names: HashMap<String, String>,
    offers: Vec<Offer>,
}

enum Msg {
    /// Something changed (sharing turned on): look now if a scan is due.
    Wake,
    Stop,
}

pub struct Service {
    os: Os,
    data: GamesData,
    config_dir: PathBuf,
    self_pid: u32,
    interval: Duration,
    source: Box<dyn ProcessSource>,
    emit: Box<dyn Fn(Option<ActivityPayload>) + Send + Sync>,
    now: Box<dyn Fn() -> u64 + Send + Sync>,
    /// The launcher indexes: locked on their own and rebuilt with no other lock held.
    index: Indexes,
    inner: Mutex<Inner>,
    /// Held for a whole scan, so two never interleave. Taken before `inner`, never after.
    scan_lock: Mutex<()>,
    /// When the last scan finished; None until the first since sharing came on.
    last_scan: Mutex<Option<Instant>>,
    worker: Mutex<Option<Sender<Msg>>>,
    /// Tests: activity.json writes.
    #[cfg(test)]
    saves: AtomicU64,
}

/// A poisoned lock only follows a panic, and a release build aborts on one; carry on in tests.
fn lock<T>(m: &Mutex<T>) -> MutexGuard<'_, T> {
    m.lock().unwrap_or_else(|e| e.into_inner())
}

fn debug(msg: &str) {
    if cfg!(debug_assertions) {
        eprintln!("{msg}");
    }
}

pub fn wall_ms() -> u64 {
    SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_millis() as u64).unwrap_or(0)
}

/// `bytes` random bytes as hex: the same OS-seeded keys `HashMap` uses, run over a counter and
/// the clock. Not secret - only the main window can redeem an id - just never guessable from
/// the last one.
pub fn random_hex(bytes: usize) -> String {
    static COUNTER: AtomicU64 = AtomicU64::new(0);
    let mut out = String::with_capacity(bytes * 2 + 16);
    while out.len() < bytes * 2 {
        let nanos = SystemTime::now().duration_since(UNIX_EPOCH).map(|d| d.as_nanos()).unwrap_or(0);
        let v = RandomState::new().hash_one((COUNTER.fetch_add(1, Ordering::Relaxed), nanos));
        out.push_str(&format!("{v:016x}"));
    }
    out.truncate(bytes * 2);
    out
}

fn source_of(key: &str) -> &str {
    key.split_once(':').map(|(s, _)| s).unwrap_or(key)
}

/// Whether the worker just woke from a sleep of the machine: the wall clock moved on much more
/// than the wait it slept through (the monotonic clock may not count a suspend at all).
pub fn resumed_from_sleep(waited: Duration, wall_gap: Duration, interval: Duration) -> bool {
    wall_gap > waited + interval * 2
}

/// The program a process runs, as the rules see it ('' when there is nothing to go on).
fn program_of(p: &ProcInfo, os: Os) -> &str {
    if !p.exe.is_empty() {
        &p.exe
    } else if os == Os::Win32 {
        &p.name
    } else {
        ""
    }
}

// ---- what "Add it" never offers ---------------------------------------------------------------

/// Not games, and not worth offering: the system's own programs and the session around them.
const LINUX_SYSTEM_DIRS: [&str; 11] = ["/usr/lib/", "/usr/lib32/", "/usr/lib64/", "/usr/libexec/", "/lib/", "/lib64/", "/usr/sbin/", "/sbin/", "/usr/share/", "/proc/", "/snap/core"];
const LINUX_SYSTEM_NAMES: [&str; 37] = [
    "sh", "bash", "zsh", "fish", "dash", "ksh", "tcsh", "csh", "nu", "sudo", "su", "login", "tmux", "screen", "systemd", "dbus-daemon", "dbus-broker", "dbus-broker-launch", "pipewire",
    "pipewire-pulse", "wireplumber", "pulseaudio", "xwayland", "xorg", "gnome-shell", "plasmashell", "kwin_wayland", "kwin_x11", "ssh-agent", "gpg-agent", "bwrap", "xdg-desktop-portal",
    "xdg-document-portal", "xdg-permission-store", "flatpak-portal", "strafe-desktop", "strafe-desktop.bin",
];
/// Folded; macOS's own programs.
const DARWIN_SYSTEM_DIRS: [&str; 9] = ["/system/", "/usr/bin/", "/usr/sbin/", "/usr/libexec/", "/usr/lib/", "/bin/", "/sbin/", "/library/apple/", "/private/"];
const DARWIN_SYSTEM_NAMES: [&str; 10] = ["launchd", "loginwindow", "zsh", "bash", "sh", "fish", "login", "terminal", "iterm2", "strafe"];
/// Folded pieces of a path; `<drive>:/windows/` is checked on its own.
const WIN_SYSTEM_PIECES: [&str; 4] = ["/windowsapps/microsoft.", "/microsoft/edgewebview/", "/microsoft/edge/", "/common files/microsoft shared/"];
const WIN_SYSTEM_NAMES: [&str; 31] = [
    "cmd.exe", "powershell.exe", "pwsh.exe", "windowsterminal.exe", "openconsole.exe", "conhost.exe", "msedgewebview2.exe", "msedge.exe", "runtimebroker.exe", "sihost.exe", "taskhostw.exe",
    "ctfmon.exe", "dllhost.exe", "searchhost.exe", "searchapp.exe", "startmenuexperiencehost.exe", "textinputhost.exe", "shellexperiencehost.exe", "securityhealthsystray.exe",
    "smartscreen.exe", "applicationframehost.exe", "systemsettings.exe", "widgets.exe", "widgetservice.exe", "phoneexperiencehost.exe", "lockapp.exe", "useroobebroker.exe",
    "crossdevicebroker.exe", "onedrive.exe", "strafe.exe", "strafe-desktop.exe",
];

fn offerable(file: &str, os: Os, data: &GamesData) -> bool {
    if data.launchers.test(file) || data.helpers.test(file) || data.interpreters.test(file) {
        return false;
    }
    let base = base_name(file).to_lowercase();
    match os {
        Os::Linux => !LINUX_SYSTEM_DIRS.iter().any(|d| file.starts_with(d)) && !LINUX_SYSTEM_NAMES.contains(&base.as_str()),
        Os::Darwin => {
            let f = fold(file);
            !DARWIN_SYSTEM_DIRS.iter().any(|d| f.starts_with(d)) && !DARWIN_SYSTEM_NAMES.contains(&base.as_str())
        }
        Os::Win32 => {
            let f = fold(file);
            let windows_dir = f.as_bytes().get(1) == Some(&b':') && f.get(2..).is_some_and(|r| r.starts_with("/windows/"));
            !windows_dir && !WIN_SYSTEM_PIECES.iter().any(|p| f.contains(p)) && !WIN_SYSTEM_NAMES.contains(&base.as_str())
        }
    }
}

impl Service {
    pub fn new(o: Options) -> Arc<Self> {
        let index = Indexes::new(o.roots, &o.home, o.os);
        Arc::new(Self {
            index,
            os: o.os,
            data: o.data,
            config_dir: o.config_dir,
            self_pid: o.self_pid,
            interval: o.interval,
            source: o.source,
            emit: o.emit,
            now: o.now,
            inner: Mutex::new(Inner {
                prefs: ActivityPrefs::default(),
                active: None,
                scanning: false,
                gen: 0,
                stopped: false,
                tracker: Tracker::default(),
                verdicts: HashMap::new(),
                verdicts_stale: false,
                verdicts_gen: None,
                last_sent: None,
                current: None,
                names: HashMap::new(),
                offers: Vec::new(),
            }),
            scan_lock: Mutex::new(()),
            last_scan: Mutex::new(None),
            worker: Mutex::new(None),
            #[cfg(test)]
            saves: AtomicU64::new(0),
        })
    }

    // ---- lifecycle ------------------------------------------------------------------------------

    /// Read activity.json and the signed-in account, and start looking if sharing is on for
    /// it. With `worker`, a thread then looks every interval while it stays on.
    pub fn start(self: &Arc<Self>, worker: bool) {
        if worker {
            let (tx, rx) = mpsc::channel();
            *lock(&self.worker) = Some(tx);
            let me = Arc::clone(self);
            let spawned = std::thread::Builder::new().name("game-activity".into()).spawn(move || me.run(rx));
            if spawned.is_err() {
                *lock(&self.worker) = None;
                debug("games: could not start the scanner thread");
            }
        }
        let on = {
            let mut st = lock(&self.inner);
            st.prefs = prefs::load(&self.config_dir);
            st.active = self.read_active();
            self.apply(&mut st)
        };
        if on {
            self.wake();
        }
    }

    pub fn stop(&self) {
        {
            let mut st = lock(&self.inner);
            st.stopped = true;
            self.halt(&mut st);
        }
        if let Some(tx) = lock(&self.worker).take() {
            let _ = tx.send(Msg::Stop);
        }
    }

    fn wake(&self) {
        if let Some(tx) = lock(&self.worker).as_ref() {
            let _ = tx.send(Msg::Wake);
        }
    }

    fn read_active(&self) -> Option<String> {
        let raw = std::fs::read(self.config_dir.join(ACCOUNTS_FILE)).ok()?;
        let v: serde_json::Value = serde_json::from_slice(&raw).ok()?;
        v.get("active").and_then(serde_json::Value::as_str).filter(|a| prefs::valid_account(a)).map(str::to_string)
    }

    fn sharing(st: &Inner) -> bool {
        !st.stopped && st.active.as_ref().is_some_and(|a| st.prefs.share_accounts.contains(a))
    }

    pub fn is_scanning(&self) -> bool {
        lock(&self.inner).scanning
    }

    /// Tests: the launcher index's generation, and how many times activity.json was written.
    #[cfg(test)]
    pub fn index_generation(&self) -> u64 {
        self.index.generation()
    }

    #[cfg(test)]
    pub fn saves(&self) -> u64 {
        self.saves.load(Ordering::SeqCst)
    }

    /// Start or stop the scanner to match sharing(). True when it just started (the caller
    /// wakes the worker, outside the lock).
    fn apply(&self, st: &mut Inner) -> bool {
        let want = Self::sharing(st);
        if want && !st.scanning {
            st.scanning = true;
            debug("games: sharing on, looking");
            return true;
        }
        if !want && st.scanning {
            debug("games: sharing off, not looking");
            self.halt(st);
            self.publish(st);
        }
        false
    }

    fn halt(&self, st: &mut Inner) {
        st.scanning = false;
        st.gen += 1;
        st.tracker.reset();
        st.verdicts.clear();
        *lock(&self.last_scan) = None;
    }

    /// The page saved accounts.json (desktop_accounts_save; the shape is web
    /// src/desktop/accounts.ts, `{version, active, accounts: [{id, ...}]}`). Sharing follows the
    /// account signed in, and an account no longer in the list is no longer shared for: kept, it
    /// would start sharing again the day the same account was added back. One write, and only
    /// when something was dropped; a value without an accounts list keeps nobody.
    pub fn accounts_saved(&self, value: &serde_json::Value) {
        let empty = serde_json::Map::new();
        let file = value.as_object().unwrap_or(&empty);
        let ids: HashSet<&str> = file
            .get("accounts")
            .and_then(serde_json::Value::as_array)
            .into_iter()
            .flatten()
            .filter_map(|a| a.get("id").and_then(serde_json::Value::as_str))
            .collect();
        {
            let mut st = lock(&self.inner);
            let keep: Vec<String> = st.prefs.share_accounts.iter().filter(|a| ids.contains(a.as_str())).cloned().collect();
            if keep.len() != st.prefs.share_accounts.len() {
                let next = ActivityPrefs { share_accounts: keep.clone(), ..st.prefs.clone() };
                if let Err(e) = self.save(&mut st, next) {
                    // The accounts were saved; this must not fail their save. Off in memory at least.
                    st.prefs.share_accounts = keep;
                    debug(&format!("games: could not update activity.json ({e})"));
                }
            }
        }
        self.set_active_account(file.get("active").and_then(serde_json::Value::as_str));
    }

    /// The account signed in now changed: sharing follows the account.
    pub fn set_active_account(&self, id: Option<&str>) {
        let on = {
            let mut st = lock(&self.inner);
            st.active = id.filter(|a| prefs::valid_account(a)).map(str::to_string);
            self.apply(&mut st)
        };
        if on {
            self.wake();
        }
    }

    // ---- the worker ------------------------------------------------------------------------------

    fn run(self: Arc<Self>, rx: Receiver<Msg>) {
        let tick = TICK.min(self.interval);
        let mut last_wall = SystemTime::now();
        loop {
            let scanning = self.is_scanning();
            let wait = if scanning {
                match *lock(&self.last_scan) {
                    None => Duration::ZERO,
                    Some(t) => (t + self.interval).saturating_duration_since(Instant::now()).min(tick),
                }
            } else {
                IDLE
            };
            match rx.recv_timeout(wait) {
                Ok(Msg::Wake) | Err(RecvTimeoutError::Timeout) => {}
                Ok(Msg::Stop) | Err(RecvTimeoutError::Disconnected) => return,
            }
            loop {
                match rx.try_recv() {
                    Ok(Msg::Wake) => {}
                    Ok(Msg::Stop) | Err(TryRecvError::Disconnected) => return,
                    Err(TryRecvError::Empty) => break,
                }
            }
            let wall = SystemTime::now();
            let gap = wall.duration_since(last_wall).unwrap_or(Duration::ZERO);
            last_wall = wall;
            if !self.is_scanning() {
                continue;
            }
            // Back from sleep: look at once rather than share a game that ended hours ago (Tauri
            // has no resume event; Electron uses powerMonitor's).
            let resumed = scanning && resumed_from_sleep(wait, gap, self.interval);
            let due = lock(&self.last_scan).is_none_or(|t| Instant::now() >= t + self.interval);
            if resumed || due {
                if resumed {
                    debug("games: back from sleep, looking now");
                }
                self.scan_now();
            }
        }
    }

    // ---- the scan --------------------------------------------------------------------------------

    /// Look at the processes once (when sharing is on), and tell the page if what to share
    /// changed. Blocks for the scan; never call it holding `inner`.
    pub fn scan_now(&self) {
        let _scan = lock(&self.scan_lock);
        if !self.is_scanning() {
            return;
        }
        let now = (self.now)();
        // The launcher files (at most once a minute), with no lock held: a rebuild reads the disk.
        self.index.refresh(&self.data, now, false);
        let (gen, index, known) = {
            let mut st = lock(&self.inner);
            if !st.scanning {
                return;
            }
            // By generation, not by what that refresh said: get_state may have been the one to
            // rebuild. The whole scan uses this one index; a rebuild meanwhile leaves
            // verdicts_gen behind it, so the next scan drops what this one decides.
            let (index_gen, index) = self.index.snapshot();
            if std::mem::take(&mut st.verdicts_stale) || st.verdicts_gen != Some(index_gen) {
                st.verdicts.clear();
                st.verdicts_gen = Some(index_gen);
            }
            (st.gen, index, st.verdicts.keys().cloned().collect::<HashSet<Identity>>())
        };

        // The processes, outside the lock: this is the slow part.
        let mut snap = self.source.snapshot();
        let list: Vec<ProcInfo> = snap.processes().to_vec();
        let own = own_tree(&list, self.self_pid);
        let identity = |p: &ProcInfo| -> Identity { (p.pid, p.start_ms, program_of(p, self.os).to_string()) };
        // Command lines of new Java processes only: a known process's verdict stands.
        let mut cmdlines: HashMap<u32, Option<Vec<String>>> = HashMap::new();
        for p in list.iter().filter(|p| !own.contains(&p.pid)) {
            let prog = program_of(p, self.os);
            if !prog.is_empty() && needs_cmdline(prog) && !known.contains(&identity(p)) {
                cmdlines.insert(p.pid, snap.cmdline(p.pid));
            }
        }
        drop(snap);

        let mut st = lock(&self.inner);
        if st.gen != gen || !st.scanning {
            return;
        }
        // A game added or removed while this scan ran: decide everything again.
        if std::mem::take(&mut st.verdicts_stale) {
            st.verdicts.clear();
        }
        let hidden: HashSet<String> = st.prefs.hidden.iter().cloned().collect();
        let user: Vec<UserGame> = st.prefs.user.clone();
        let mut fresh: HashMap<Identity, Cached> = HashMap::new();
        let mut matches = Vec::new();
        let mut steam_roots = Vec::new();
        for p in list.iter().filter(|p| !own.contains(&p.pid)) {
            let prog = program_of(p, self.os);
            if prog.is_empty() {
                continue;
            }
            let id = identity(p);
            let entry = match st.verdicts.get(&id) {
                Some(c) => c.clone(),
                None => {
                    let cmdline = if needs_cmdline(prog) {
                        match cmdlines.get(&p.pid) {
                            // Not read (the cache was dropped meanwhile): next scan.
                            None => continue,
                            Some(c) => c.as_deref(),
                        }
                    } else {
                        None
                    };
                    let verdict = if needs_cmdline(prog) && cmdline.is_none() {
                        // Unreadable: not something we can tell.
                        None
                    } else {
                        let ctx = Ctx { os: self.os, data: &self.data, index: &index, user: &user };
                        classify(&p.exe, &p.name, cmdline, &ctx)
                    };
                    Cached { verdict, first_seen: now }
                }
            };
            // A Steam client installed somewhere else than Program Files names its own root.
            if self.os == Os::Win32 && !p.exe.is_empty() && base_name(&p.exe).eq_ignore_ascii_case("steam.exe") {
                if let Some(dir) = Path::new(&p.exe).parent() {
                    steam_roots.push(dir.to_path_buf());
                }
            }
            if let Some(v) = &entry.verdict {
                matches.push(Match { verdict: v.clone(), start_ms: if p.start_ms > 0 { p.start_ms } else { entry.first_seen } });
            }
            fresh.insert(id, entry);
        }
        // Only processes still running are remembered.
        st.verdicts = fresh;
        for r in steam_roots {
            self.index.found_steam_root(r);
        }
        let before = st.tracker.current_key.clone();
        st.tracker.update(&matches, &hidden);
        let running: Vec<(String, String)> = st.tracker.sessions.values().map(|s| (s.key.clone(), s.name.clone())).collect();
        st.names.extend(running);
        if st.tracker.current_key != before {
            // The rule's source only, never the process.
            match st.tracker.current() {
                Some(s) => debug(&format!("games: now sharing a {} game", s.source.as_str())),
                None => debug("games: now sharing nothing"),
            }
        }
        self.publish(&mut st);
        drop(st);
        *lock(&self.last_scan) = Some(Instant::now());
    }

    /// Tell the page when what it should share changed. Under `inner`, so pushes keep their
    /// order.
    fn publish(&self, st: &mut Inner) {
        let session = if st.scanning { st.tracker.current() } else { None };
        st.current = session.filter(|s| !st.prefs.hidden.contains(&s.key)).map(|s| CurrentGame {
            key: s.key.clone(),
            name: st.prefs.renames.get(&s.key).cloned().unwrap_or_else(|| s.name.clone()),
            started_at: s.started_at,
        });
        let payload = st.current.as_ref().map(|c| ActivityPayload { name: c.name.clone(), started_at: c.started_at });
        if payload == st.last_sent {
            return;
        }
        st.last_sent = payload.clone();
        (self.emit)(payload);
    }

    // ---- what the page asks ----------------------------------------------------------------------

    /// The name a game was recognised by, from wherever it is known.
    fn detected_name(&self, st: &Inner, index: &Index, key: &str, session: Option<&Session>) -> String {
        if let Some(s) = session {
            return s.name.clone();
        }
        let (src, id) = key.split_once(':').unwrap_or((key, ""));
        let name = match src {
            "user" => st.prefs.user.iter().find(|u| u.id == id).map(|u| u.name.clone()),
            "curated" => self.data.curated_by_id(id).map(|c| c.name.clone()),
            "steam" => index.steam_app(id).map(str::to_string),
            "epic" => index.epic_app(id).map(str::to_string),
            _ => None,
        };
        name.or_else(|| st.names.get(key).cloned()).or_else(|| clean_name(id)).unwrap_or_else(|| key.to_string())
    }

    fn row(&self, st: &Inner, index: &Index, key: &str, session: Option<&Session>) -> GameRow {
        let detected = self.detected_name(st, index, key, session);
        let rename = st.prefs.renames.get(key);
        GameRow {
            key: key.to_string(),
            name: rename.cloned().unwrap_or_else(|| detected.clone()),
            detected_name: detected,
            source: source_of(key).to_string(),
            hidden: st.prefs.hidden.iter().any(|k| k == key),
            renamed: rename.is_some(),
            running: session.is_some(),
        }
    }

    fn rows(&self, st: &Inner, index: &Index) -> Vec<GameRow> {
        let running = |k: &str| if st.scanning { st.tracker.sessions.get(k) } else { None };
        let mut keys: Vec<String> = Vec::new();
        let mut seen = HashSet::new();
        let user_keys = st.prefs.user.iter().map(|u| format!("user:{}", u.id));
        let session_keys: Vec<String> = if st.scanning { st.tracker.sessions.keys().cloned().collect() } else { Vec::new() };
        for k in user_keys.chain(st.prefs.hidden.iter().cloned()).chain(st.prefs.renames.keys().cloned()).chain(session_keys) {
            if seen.insert(k.clone()) {
                keys.push(k);
            }
        }
        let mut rows: Vec<GameRow> = keys.iter().map(|k| self.row(st, index, k, running(k))).collect();
        rows.sort_by(|a, b| {
            b.running
                .cmp(&a.running)
                .then_with(|| a.name.to_lowercase().cmp(&b.name.to_lowercase()))
                .then_with(|| a.name.cmp(&b.name))
                .then_with(|| a.key.cmp(&b.key))
        });
        rows
    }

    /// `{share, account, current, games}`. Never scans: `current` is what the page was last
    /// told (with its key), so a page that loads late starts from it.
    pub fn get_state(&self) -> GamesState {
        // Names for customised launcher games that are not running: from the launcher's files
        // (never the process list), looked at once a minute at most. A rebuild here is seen by
        // the next scan (its generation).
        let wants_index = {
            let st = lock(&self.inner);
            st.prefs.hidden.iter().chain(st.prefs.renames.keys()).any(|k| matches!(source_of(k), "steam" | "epic") && !st.names.contains_key(k))
        };
        if wants_index {
            self.index.refresh(&self.data, (self.now)(), false);
        }
        let index = self.index.current();
        let st = lock(&self.inner);
        GamesState { share: Self::sharing(&st), account: st.active.clone(), current: st.current.clone(), games: self.rows(&st, &index) }
    }

    fn save(&self, st: &mut Inner, next: ActivityPrefs) -> Result<(), String> {
        #[cfg(test)]
        self.saves.fetch_add(1, Ordering::SeqCst);
        st.prefs = prefs::save(&self.config_dir, &next)?;
        Ok(())
    }

    pub fn set_share(&self, on: bool, account: &str) -> Result<(), String> {
        if !prefs::valid_account(account) {
            return Err("Sign in to an account first.".into());
        }
        let started = {
            let mut st = lock(&self.inner);
            let mut list = st.prefs.share_accounts.clone();
            if !on {
                list.retain(|a| a != account);
            } else if !list.iter().any(|a| a == account) {
                list.push(account.to_string());
            }
            if list.len() > LIMIT_ACCOUNTS {
                return Err("Sharing is on for as many accounts as Strafe can keep.".into());
            }
            let next = ActivityPrefs { share_accounts: list, ..st.prefs.clone() };
            self.save(&mut st, next)?;
            // The page names the account signed in now; the shell's own record of that is
            // accounts.json.
            st.active = self.read_active().or_else(|| st.active.clone());
            self.apply(&mut st)
        };
        if self.is_scanning() {
            self.scan_now();
        }
        if started {
            self.wake();
        }
        Ok(())
    }

    pub fn set_hidden(&self, key: &str, hidden: bool) -> Result<(), String> {
        if !prefs::valid_key(key) {
            return Err("Strafe does not know that game.".into());
        }
        let mut st = lock(&self.inner);
        let mut list = st.prefs.hidden.clone();
        list.retain(|k| k != key);
        if hidden {
            list.push(key.to_string());
        }
        if list.len() > LIMIT_HIDDEN {
            return Err(format!("Strafe can hide at most {LIMIT_HIDDEN} games."));
        }
        let next = ActivityPrefs { hidden: list, ..st.prefs.clone() };
        self.save(&mut st, next)?;
        let set: HashSet<String> = st.prefs.hidden.iter().cloned().collect();
        st.tracker.reselect(&set);
        self.publish(&mut st);
        Ok(())
    }

    /// Share a game under another name; None goes back to the detected one.
    pub fn rename(&self, key: &str, name: Option<&str>) -> Result<(), String> {
        if !prefs::valid_key(key) {
            return Err("Strafe does not know that game.".into());
        }
        let index = self.index.current();
        let mut st = lock(&self.inner);
        let mut renames = st.prefs.renames.clone();
        match name {
            None => {
                renames.remove(key);
            }
            Some(raw) => {
                let n = valid_name(raw).ok_or_else(|| format!("A game's name needs 1 to {NAME_MAX} characters, and something visible."))?;
                let detected = self.detected_name(&st, &index, key, st.tracker.sessions.get(key));
                // Renaming back to the detected name is no rename.
                if n == detected {
                    renames.remove(key);
                } else {
                    renames.insert(key.to_string(), n);
                }
            }
        }
        if renames.len() > LIMIT_RENAMES {
            return Err(format!("Strafe can keep at most {LIMIT_RENAMES} renamed games."));
        }
        let next = ActivityPrefs { renames, ..st.prefs.clone() };
        self.save(&mut st, next)?;
        self.publish(&mut st);
        Ok(())
    }

    /// Programs running now, for "Add it": an opaque id (good for five minutes) and the file
    /// name of each. Never a path, command line or environment. Looked up on request only.
    pub fn running_programs(&self) -> Result<Vec<RunningProgram>, String> {
        let list: Vec<ProcInfo> = self.source.snapshot().processes().to_vec();
        let own = own_tree(&list, self.self_pid);
        let mut seen = HashSet::new();
        let mut found: Vec<(String, String)> = Vec::new();
        for p in list.iter().filter(|p| !own.contains(&p.pid) && !p.exe.is_empty()) {
            if !offerable(&p.exe, self.os, &self.data) || seen.contains(&p.exe) {
                continue;
            }
            if let Some(name) = clean_name(base_name(&p.exe)) {
                seen.insert(p.exe.clone());
                found.push((p.exe.clone(), name));
            }
        }
        found.sort_by(|a, b| a.1.to_lowercase().cmp(&b.1.to_lowercase()).then_with(|| a.1.cmp(&b.1)).then_with(|| a.0.cmp(&b.0)));
        found.truncate(RUNNING_CAP);

        let mut st = lock(&self.inner);
        let now = (self.now)();
        st.offers.retain(|o| o.expires > now);
        let mut out = Vec::with_capacity(found.len());
        for (path, name) in found {
            let id = random_hex(12);
            st.offers.push(Offer { id: id.clone(), path, expires: now + OFFER_TTL_MS });
            out.push(RunningProgram { id, name });
        }
        let excess = st.offers.len().saturating_sub(OFFER_CAP);
        st.offers.drain(..excess);
        Ok(out)
    }

    /// Make a program from running_programs() a game with this name.
    pub fn add(&self, id: &str, name: &str) -> Result<GameRow, String> {
        let key = {
            let mut st = lock(&self.inner);
            let now = (self.now)();
            st.offers.retain(|o| o.expires > now);
            let path = st.offers.iter().find(|o| o.id == id).map(|o| o.path.clone()).ok_or("That program is not in the list any more. Open the list again.")?;
            let n = valid_name(name).ok_or_else(|| format!("A game's name needs 1 to {NAME_MAX} characters, and something visible."))?;
            let mut user = st.prefs.user.clone();
            let entry = match user.iter().position(|u| u.path == path) {
                Some(at) => {
                    user[at].name = n;
                    user[at].clone()
                }
                None => {
                    if user.len() >= LIMIT_USER {
                        return Err(format!("Strafe can keep at most {LIMIT_USER} games you added."));
                    }
                    let entry = UserGame { id: random_hex(6), path, name: n };
                    user.push(entry.clone());
                    entry
                }
            };
            let next = ActivityPrefs { user, ..st.prefs.clone() };
            self.save(&mut st, next)?;
            st.verdicts_stale = true;
            format!("user:{}", entry.id)
        };
        if self.is_scanning() {
            self.scan_now();
        }
        let index = self.index.current();
        let st = lock(&self.inner);
        let session = if st.scanning { st.tracker.sessions.get(&key) } else { None };
        Ok(self.row(&st, &index, &key, session))
    }

    /// Forget a game the person added.
    pub fn remove(&self, key: &str) -> Result<(), String> {
        let Some(id) = key.strip_prefix("user:").filter(|_| prefs::valid_key(key)) else {
            return Err("Only a game you added can be removed.".into());
        };
        {
            let mut st = lock(&self.inner);
            let mut renames = st.prefs.renames.clone();
            renames.remove(key);
            let next = ActivityPrefs {
                user: st.prefs.user.iter().filter(|u| u.id != id).cloned().collect(),
                hidden: st.prefs.hidden.iter().filter(|k| *k != key).cloned().collect(),
                renames,
                ..st.prefs.clone()
            };
            self.save(&mut st, next)?;
            st.verdicts_stale = true;
            st.tracker.forget(key);
            let set: HashSet<String> = st.prefs.hidden.iter().cloned().collect();
            st.tracker.reselect(&set);
            self.publish(&mut st);
        }
        // Its processes may well be another game by the other rules.
        if self.is_scanning() {
            self.scan_now();
        }
        Ok(())
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn games_service_sleep_is_told_from_the_clocks() {
        let i = Duration::from_secs(15);
        // A normal tick: the wall clock moved as much as the wait.
        assert!(!resumed_from_sleep(Duration::from_secs(5), Duration::from_millis(5_020), i));
        // A scan that took a while is not a sleep either.
        assert!(!resumed_from_sleep(Duration::from_secs(5), Duration::from_secs(20), i));
        // Minutes passed in a five-second wait.
        assert!(resumed_from_sleep(Duration::from_secs(5), Duration::from_secs(600), i));
        // A long idle wait is not a sleep.
        assert!(!resumed_from_sleep(IDLE, IDLE, i));
    }

    #[test]
    fn games_service_ids_are_opaque_and_distinct() {
        let a = random_hex(12);
        let b = random_hex(12);
        assert_eq!(a.len(), 24);
        assert!(a.bytes().all(|c| c.is_ascii_hexdigit()));
        assert_ne!(a, b);
        assert_eq!(random_hex(6).len(), 12);
    }

    #[test]
    fn games_service_what_add_it_never_offers() {
        let data = GamesData::bundled().unwrap();
        assert!(offerable("/home/someone/Games/indie/indie", Os::Linux, &data));
        assert!(!offerable("/usr/lib/systemd/systemd", Os::Linux, &data));
        assert!(!offerable("/usr/bin/fish", Os::Linux, &data));
        assert!(!offerable("/usr/bin/python3.13", Os::Linux, &data), "an interpreter");
        assert!(offerable("D:\\Games\\Indie\\Indie.exe", Os::Win32, &data));
        assert!(!offerable("C:\\Windows\\System32\\svchost.exe", Os::Win32, &data));
        assert!(!offerable("C:\\Windows\\explorer.exe", Os::Win32, &data));
        assert!(!offerable("C:\\Program Files\\WindowsApps\\Microsoft.WindowsTerminal_1\\WindowsTerminal.exe", Os::Win32, &data));
        assert!(!offerable("C:\\Program Files (x86)\\Steam\\steam.exe", Os::Win32, &data), "a launcher");
        assert!(!offerable("C:\\Program Files\\Java\\bin\\javaw.exe", Os::Win32, &data), "an interpreter");
        assert!(offerable("/Applications/Indie.app/Contents/MacOS/Indie", Os::Darwin, &data));
        assert!(!offerable("/System/Library/CoreServices/Finder.app/Contents/MacOS/Finder", Os::Darwin, &data));
        assert!(!offerable("/usr/bin/java", Os::Darwin, &data));
        // A program merely called reaper (the REAPER audio editor) is a program like any other;
        // only Steam's own reaper, in its Linux runtime folder, is Steam's.
        assert!(offerable("/Applications/REAPER.app/Contents/MacOS/REAPER", Os::Darwin, &data));
        assert!(offerable("C:\\Program Files\\REAPER (x64)\\reaper.exe", Os::Win32, &data));
        assert!(!offerable("/home/someone/.local/share/Steam/ubuntu12_32/reaper", Os::Linux, &data));
    }
}
