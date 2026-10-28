//! The cases both shells run (desktop/test/games/cases.json, those naming "rust"), and the
//! scanner against a fake process list - the same scenarios as the Electron shell's
//! electron/test/games.test.js, so the two provably behave alike.

use std::{
    collections::{HashMap, HashSet},
    sync::{
        atomic::{AtomicU64, Ordering},
        Arc, Mutex,
    },
    time::{Duration, Instant},
};

use serde::Deserialize;
use serde_json::Value;

use super::data::GamesData;
use super::indexes::Indexes;
use super::matcher::{classify, needs_cmdline, own_tree, Ctx, Match, Os, ProcInfo, UserGame};
use super::prefs;
use super::procs::{ProcessSource, Snapshot};
use super::service::{ActivityPayload, CurrentGame, GameRow, GamesState, Options, Service, OFFER_TTL_MS};
use super::tests_support::{copy_fixtures, fixture_roots, fixtures_dir, placeholder, TempDir};
use super::tracker::Tracker;

// ---- cases.json ------------------------------------------------------------------------------------

#[derive(Debug, Deserialize)]
struct CaseProc {
    pid: u32,
    ppid: u32,
    start_ms: u64,
    exe: String,
    cmdline: Vec<String>,
    #[allow(dead_code)]
    environ: HashMap<String, String>,
}

#[derive(Debug, Deserialize, PartialEq)]
struct Expect {
    key: String,
    name: String,
    started_at: u64,
}

#[derive(Debug, Deserialize)]
struct Scan {
    processes: Vec<CaseProc>,
    expect: Option<Expect>,
}

#[derive(Debug, Deserialize)]
struct Case {
    name: String,
    os: String,
    shells: Vec<String>,
    #[serde(default)]
    self_pid: Option<u32>,
    #[serde(default)]
    user: Vec<UserGame>,
    #[serde(default)]
    hidden: Vec<String>,
    #[serde(default)]
    renames: HashMap<String, String>,
    #[serde(default)]
    processes: Option<Vec<CaseProc>>,
    #[serde(default)]
    expect: Option<Expect>,
    #[serde(default)]
    scans: Option<Vec<Scan>>,
}

/// Every matched process of a snapshot. The command line is passed on only where the scanner
/// would have read it (Java), and the environment never, so a case cannot pass on data this
/// shell never sees.
fn match_snapshot(processes: &[CaseProc], ctx: &Ctx<'_>, self_pid: Option<u32>) -> Vec<Match> {
    let infos: Vec<ProcInfo> = processes.iter().map(|p| ProcInfo { pid: p.pid, ppid: p.ppid, start_ms: p.start_ms, exe: p.exe.clone(), name: String::new() }).collect();
    let own = own_tree(&infos, self_pid.unwrap_or(0));
    let mut out = Vec::new();
    for p in processes.iter().filter(|p| !own.contains(&p.pid)) {
        let cmdline = needs_cmdline(&p.exe).then_some(p.cmdline.as_slice());
        if let Some(verdict) = classify(&p.exe, "", cmdline, ctx) {
            out.push(Match { verdict, start_ms: p.start_ms });
        }
    }
    out
}

fn load_cases(placeholder_value: &str) -> Vec<Case> {
    let text = std::fs::read_to_string(fixtures_dir().join("cases.json")).unwrap();
    serde_json::from_str(&text.replace("{FIXTURES}", placeholder_value)).unwrap()
}

#[test]
fn games_cases_every_case_for_the_rust_shell() {
    let data = GamesData::bundled().unwrap();
    let tmp = copy_fixtures();
    let dir = tmp.path();
    let indexes = Indexes::new(fixture_roots(dir), "/home/someone", Os::Linux);
    assert!(indexes.refresh(&data, 0, true));
    let index = indexes.current();
    let cases = load_cases(&placeholder(dir));
    let mine: Vec<&Case> = cases.iter().filter(|c| c.shells.iter().any(|s| s == "rust")).collect();
    assert!(mine.len() >= 37, "only {} rust cases", mine.len());
    let mut failures = Vec::new();
    for c in &mine {
        let os = Os::parse(&c.os).unwrap_or_else(|| panic!("{}: os {}", c.name, c.os));
        let ctx = Ctx { os, data: &data, index: &index, user: &c.user };
        let hidden: HashSet<String> = c.hidden.iter().cloned().collect();
        let scans: Vec<(&[CaseProc], Option<&Expect>)> = match &c.scans {
            Some(s) => s.iter().map(|s| (s.processes.as_slice(), s.expect.as_ref())).collect(),
            None => vec![(c.processes.as_deref().unwrap_or(&[]), c.expect.as_ref())],
        };
        let mut tracker = Tracker::default();
        for (i, (procs, want)) in scans.iter().enumerate() {
            let s = tracker.update(&match_snapshot(procs, &ctx, c.self_pid), &hidden);
            let got = s.map(|s| Expect { key: s.key.clone(), name: c.renames.get(&s.key).cloned().unwrap_or_else(|| s.name.clone()), started_at: s.started_at });
            if got.as_ref() != *want {
                let at = if scans.len() > 1 { format!(" (scan {})", i + 1) } else { String::new() };
                failures.push(format!("{}{at}: got {got:?}, want {want:?}", c.name));
            }
        }
    }
    assert!(failures.is_empty(), "{} of {} cases failed:\n{}", failures.len(), mine.len(), failures.join("\n"));
}

#[test]
fn games_cases_well_formed_and_the_shared_ones_named_for_both() {
    let cases = load_cases("{FIXTURES}");
    let mut names = HashSet::new();
    let mut rust_only = 0;
    for c in &cases {
        assert!(names.insert(c.name.clone()), "duplicate case name: {}", c.name);
        assert!(Os::parse(&c.os).is_some(), "{}", c.name);
        assert!(!c.shells.is_empty() && c.shells.iter().all(|s| s == "node" || s == "rust"), "{}", c.name);
        assert!(c.processes.is_some() != c.scans.is_some(), "{}: processes or scans", c.name);
        if c.shells == ["rust"] {
            rust_only += 1;
            // Rust's own cases are its Windows and macOS sources.
            assert_ne!(c.os, "linux", "{}", c.name);
        }
    }
    assert!(rust_only >= 2, "the Epic cases");
}

// ---- the scanner, against a fake process list ------------------------------------------------------

#[derive(Default)]
struct Reads {
    list: usize,
    cmdline: Vec<u32>,
}

/// A process and its arguments.
type FakeProc = (ProcInfo, Vec<String>);

#[derive(Clone, Default)]
struct Fake {
    procs: Arc<Mutex<Vec<FakeProc>>>,
    reads: Arc<Mutex<Reads>>,
}

struct FakeSnap {
    list: Vec<ProcInfo>,
    cmds: HashMap<u32, Vec<String>>,
    reads: Arc<Mutex<Reads>>,
}

impl Snapshot for FakeSnap {
    fn processes(&self) -> &[ProcInfo] {
        &self.list
    }
    fn cmdline(&mut self, pid: u32) -> Option<Vec<String>> {
        self.reads.lock().unwrap().cmdline.push(pid);
        self.cmds.get(&pid).cloned().filter(|a| !a.is_empty())
    }
}

impl ProcessSource for Fake {
    fn snapshot(&self) -> Box<dyn Snapshot> {
        self.reads.lock().unwrap().list += 1;
        let procs = self.procs.lock().unwrap().clone();
        Box::new(FakeSnap { list: procs.iter().map(|(p, _)| p.clone()).collect(), cmds: procs.into_iter().map(|(p, c)| (p.pid, c)).collect(), reads: Arc::clone(&self.reads) })
    }
}

const START: u64 = 1_761_000_000_000;

fn proc_(pid: u32, ppid: u32, start_ms: u64, exe: &str, cmd: &[&str]) -> FakeProc {
    (ProcInfo { pid, ppid, start_ms, exe: exe.to_string(), name: String::new() }, cmd.iter().map(|s| s.to_string()).collect())
}

/// Strafe and its child, a Steam game (with a secret in its arguments), a shell, a Java tool
/// and a Wine system process.
fn sample(dir: &str) -> Vec<FakeProc> {
    vec![
        proc_(4000, 1, START, "/opt/Strafe/strafe-desktop.bin", &[]),
        proc_(4001, 4000, START + 100, "/app/bin/sober", &[]),
        proc_(500, 1, START + 20_000, &format!("{dir}/steam/steamapps/common/Fixture Game/bin/fixturegame"), &["fixturegame", "--token=SECRET"]),
        proc_(501, 1, START + 9_000, "/usr/bin/fish", &["fish", "-c", "SECRET"]),
        proc_(502, 1, START + 9_500, "/usr/lib/jvm/x/bin/java", &["java", "-jar", "tool.jar"]),
        proc_(503, 1, START + 9_600, "/usr/lib/wine/x86_64-unix/wine64-preloader", &["C:\\windows\\system32\\services.exe"]),
    ]
}

struct Setup {
    fixtures: TempDir,
    config: TempDir,
    svc: Arc<Service>,
    events: Arc<Mutex<Vec<Option<ActivityPayload>>>>,
    fake: Fake,
    now: Arc<AtomicU64>,
}

impl Setup {
    fn dir(&self) -> String {
        placeholder(self.fixtures.path())
    }
    fn last(&self) -> Option<Option<ActivityPayload>> {
        self.events.lock().unwrap().last().cloned()
    }
    fn count(&self) -> usize {
        self.events.lock().unwrap().len()
    }
    fn lists(&self) -> usize {
        self.fake.reads.lock().unwrap().list
    }
    fn activity_json(&self) -> Value {
        serde_json::from_slice(&std::fs::read(self.config.path().join("activity.json")).unwrap()).unwrap()
    }
}

impl Drop for Setup {
    fn drop(&mut self) {
        self.svc.stop();
    }
}

fn setup_with(procs: impl Fn(&str) -> Vec<FakeProc>, active: Option<&str>, interval: Duration, worker: bool) -> Setup {
    let fixtures = copy_fixtures();
    let config = TempDir::new("config");
    let dir = placeholder(fixtures.path());
    if let Some(a) = active {
        std::fs::write(config.path().join("accounts.json"), serde_json::json!({ "version": 1, "active": a, "accounts": [] }).to_string()).unwrap();
    }
    let fake = Fake::default();
    *fake.procs.lock().unwrap() = procs(&dir);
    let events: Arc<Mutex<Vec<Option<ActivityPayload>>>> = Arc::default();
    let now = Arc::new(AtomicU64::new(5_000_000));
    let (ev, clock) = (Arc::clone(&events), Arc::clone(&now));
    let svc = Service::new(Options {
        os: Os::Linux,
        data: GamesData::bundled().unwrap(),
        config_dir: config.path().to_path_buf(),
        roots: fixture_roots(fixtures.path()),
        home: "/home/someone".into(),
        self_pid: 4000,
        interval,
        source: Box::new(fake.clone()),
        emit: Box::new(move |p| ev.lock().unwrap().push(p)),
        now: Box::new(move || clock.load(Ordering::SeqCst)),
    });
    svc.start(worker);
    Setup { fixtures, config, svc, events, fake, now }
}

fn setup(procs: impl Fn(&str) -> Vec<FakeProc>) -> Setup {
    setup_with(procs, Some("a.local:1"), Duration::from_secs(600), false)
}

fn fixture_game(started_at: u64) -> Option<ActivityPayload> {
    Some(ActivityPayload { name: "Fixture Game".into(), started_at })
}

#[test]
fn games_scanner_nothing_is_looked_at_until_sharing_is_on_for_the_account_signed_in() {
    let t = setup(sample);
    t.svc.scan_now();
    assert_eq!(t.lists(), 0);
    assert_eq!(t.svc.get_state(), GamesState { share: false, account: Some("a.local:1".into()), current: None, games: vec![] });
    assert_eq!(t.lists(), 0);
    // Another account's switch does nothing for this one.
    t.svc.set_share(true, "b.local:2").unwrap();
    assert_eq!(t.lists(), 0);
    assert!(!t.svc.get_state().share);
    assert_eq!(t.count(), 0);
    assert!(t.svc.set_share(true, "has space").unwrap_err().contains("Sign in"));
}

#[test]
fn games_scanner_shares_the_game_from_its_own_start_and_reads_no_one_elses_arguments() {
    let t = setup(sample);
    t.svc.set_share(true, "a.local:1").unwrap();
    assert!(t.lists() >= 1);
    assert_eq!(*t.events.lock().unwrap(), vec![fixture_game(START + 20_000)]);
    let state = t.svc.get_state();
    assert!(state.share);
    assert_eq!(state.current, Some(CurrentGame { key: "steam:900001".into(), name: "Fixture Game".into(), started_at: START + 20_000 }));
    assert_eq!(
        state.games,
        vec![GameRow { key: "steam:900001".into(), name: "Fixture Game".into(), detected_name: "Fixture Game".into(), source: "steam".into(), hidden: false, renamed: false, running: true }]
    );
    // Arguments only of Java (not Strafe's own, the game's, the shell's or Wine's).
    assert_eq!(t.fake.reads.lock().unwrap().cmdline, vec![502]);
    // A second scan reads nothing it already knows, and an unchanged game is not told again.
    t.fake.reads.lock().unwrap().cmdline.clear();
    t.svc.scan_now();
    assert!(t.fake.reads.lock().unwrap().cmdline.is_empty());
    assert_eq!(t.count(), 1);
    // The choice is in activity.json, and prefs.json is not touched.
    assert_eq!(t.activity_json()["shareAccounts"], serde_json::json!(["a.local:1"]));
    assert!(!t.config.path().join("prefs.json").exists());
}

#[test]
fn games_scanner_hide_rename_and_sharing_off_are_told_to_the_page_at_once() {
    let t = setup(sample);
    t.svc.set_share(true, "a.local:1").unwrap();
    t.svc.rename("steam:900001", Some("  My  Fixture ")).unwrap();
    assert_eq!(t.last(), Some(Some(ActivityPayload { name: "My Fixture".into(), started_at: START + 20_000 })));
    assert!(t.svc.rename("steam:900001", Some(&"x".repeat(129))).unwrap_err().contains("128"));
    assert!(t.svc.rename("/home/me/game", Some("x")).unwrap_err().contains("know"));
    // Back to the detected name, by typing it (or by null).
    t.svc.rename("steam:900001", Some("Fixture Game")).unwrap();
    assert_eq!(t.last(), Some(fixture_game(START + 20_000)));
    assert!(!t.svc.get_state().games[0].renamed);
    t.svc.rename("steam:900001", Some("Again")).unwrap();
    t.svc.rename("steam:900001", None).unwrap();
    assert_eq!(t.last(), Some(fixture_game(START + 20_000)));
    t.svc.set_hidden("steam:900001", true).unwrap();
    assert_eq!(t.last(), Some(None));
    let state = t.svc.get_state();
    assert_eq!(state.current, None);
    assert!(state.games[0].hidden && state.games[0].running);
    t.svc.set_hidden("steam:900001", false).unwrap();
    assert_eq!(t.last(), Some(fixture_game(START + 20_000)));
    // Off: null, and no more looking.
    t.svc.set_share(false, "a.local:1").unwrap();
    assert_eq!(t.last(), Some(None));
    let state = t.svc.get_state();
    assert!(!state.share);
    assert_eq!(state.current, None);
    let lists = t.lists();
    t.svc.scan_now();
    assert_eq!(t.lists(), lists);
}

#[test]
fn games_scanner_sharing_follows_the_desktop_account_signed_in() {
    let t = setup(sample);
    t.svc.set_share(true, "a.local:1").unwrap();
    assert_eq!(t.count(), 1);
    assert_eq!(t.svc.get_state().account.as_deref(), Some("a.local:1"));
    t.svc.set_active_account(Some("b.local:2"));
    assert_eq!(t.last(), Some(None));
    // `share` is said for the account it is about, so a page signed in as another cannot take
    // it for its own.
    assert_eq!(t.svc.get_state(), GamesState { share: false, account: Some("b.local:2".into()), current: None, games: vec![] });
    t.svc.set_active_account(Some("a.local:1"));
    t.svc.scan_now();
    assert_eq!(t.last(), Some(fixture_game(START + 20_000)));
    t.svc.set_active_account(None);
    assert_eq!(t.last(), Some(None));
    assert_eq!(t.svc.get_state(), GamesState { share: false, account: None, current: None, games: vec![] });
}

#[test]
fn games_scanner_with_nobody_signed_in_get_state_names_no_account() {
    let t = setup_with(sample, None, Duration::from_secs(600), false);
    assert_eq!(t.svc.get_state(), GamesState { share: false, account: None, current: None, games: vec![] });
    assert!(t.svc.set_share(true, "").unwrap_err().contains("Sign in"));
}

/// accounts.json as the page writes it (web src/desktop/accounts.ts).
fn accounts_file(active: &str, ids: &[&str]) -> Value {
    serde_json::json!({
        "version": 1,
        "active": active,
        "accounts": ids.iter().map(|id| serde_json::json!({ "id": id, "token": "t", "userId": "1", "username": "u" })).collect::<Vec<_>>(),
    })
}

#[test]
fn games_scanner_an_account_removed_from_the_desktop_app_stops_being_shared_for_in_one_write() {
    let t = setup(sample);
    for a in ["a.local:1", "b.local:2", "c.local:3"] {
        t.svc.set_share(true, a).unwrap();
    }
    assert_eq!(*t.events.lock().unwrap(), vec![fixture_game(START + 20_000)]);
    let writes = t.svc.saves();
    let share_and_account = |s: GamesState| (s.share, s.account);
    // A switch with every account still there writes nothing, and sharing follows it.
    t.svc.accounts_saved(&accounts_file("b.local:2", &["a.local:1", "b.local:2", "c.local:3"]));
    assert_eq!(t.svc.saves(), writes);
    assert_eq!(share_and_account(t.svc.get_state()), (true, Some("b.local:2".into())));
    // Two removed at once: one write drops both.
    t.svc.accounts_saved(&accounts_file("b.local:2", &["b.local:2"]));
    assert_eq!(t.svc.saves(), writes + 1);
    assert_eq!(t.activity_json()["shareAccounts"], serde_json::json!(["b.local:2"]));
    // Added back later, a removed account starts with sharing off.
    t.svc.accounts_saved(&accounts_file("a.local:1", &["a.local:1", "b.local:2"]));
    assert_eq!(t.svc.saves(), writes + 1);
    assert_eq!(share_and_account(t.svc.get_state()), (false, Some("a.local:1".into())));
    assert_eq!(t.last(), Some(None));
    // A value without a list keeps nobody.
    t.svc.accounts_saved(&Value::Null);
    assert_eq!(t.svc.saves(), writes + 2);
    assert_eq!(t.activity_json()["shareAccounts"], serde_json::json!([]));
    assert_eq!(t.svc.get_state().account, None);
}

#[test]
fn games_scanner_an_accounts_save_still_stops_sharing_when_activity_json_cannot_be_written() {
    let t = setup(sample);
    t.svc.set_share(true, "a.local:1").unwrap();
    assert_eq!(t.count(), 1);
    // activity.json can no longer be replaced (a folder in its place).
    let file = t.config.path().join("activity.json");
    std::fs::remove_file(&file).unwrap();
    std::fs::create_dir_all(file.join("in-the-way")).unwrap();
    // The account is gone from the app: no longer shared for, if only in memory, and the save
    // itself goes on (accounts_saved cannot fail it).
    t.svc.accounts_saved(&accounts_file("a.local:1", &[]));
    assert_eq!(t.last(), Some(None));
    assert_eq!(share_and_account_of(&t), (false, Some("a.local:1".into())));
    assert!(t.svc.set_share(true, "a.local:1").is_err(), "and nothing is turned on that cannot be kept");
    assert_eq!(share_and_account_of(&t), (false, Some("a.local:1".into())));
}

fn share_and_account_of(t: &Setup) -> (bool, Option<String>) {
    let s = t.svc.get_state();
    (s.share, s.account)
}

/// The Electron shell's "a game installed while its program runs is seen, whoever noticed the
/// launcher files change": here get_state is the one to rebuild the index, and the next scan
/// does not keep the "not a game" it had for the running process.
#[test]
fn games_scanner_a_game_installed_while_its_program_runs_is_seen_whoever_noticed_the_launcher_files_change() {
    let t = setup(|dir| vec![proc_(4000, 1, START, "/opt/Strafe/strafe-desktop.bin", &[]), proc_(800, 1, START + 50_000, &format!("{dir}/steam-library2/steamapps/common/New/new.x86_64"), &[])]);
    // A hidden launcher game that is not running: get_state looks in the launcher files for its name.
    t.svc.set_hidden("steam:900003", true).unwrap();
    t.svc.set_share(true, "a.local:1").unwrap();
    assert_eq!(t.count(), 0, "not a game yet");
    // Steam finishes writing the manifest of the game being played.
    std::fs::write(
        t.fixtures.path().join("steam-library2/steamapps/appmanifest_900005.acf"),
        "\"AppState\" { \"appid\" \"900005\" \"name\" \"Newly Installed\" \"installdir\" \"New\" }",
    )
    .unwrap();
    t.now.fetch_add(super::indexes::CHECK_INTERVAL_MS, Ordering::SeqCst);
    // Settings opens first, and it is get_state that rebuilds the index.
    let gen = t.svc.index_generation();
    let state = t.svc.get_state();
    assert_eq!(state.games.iter().find(|g| g.key == "steam:900003").map(|g| g.name.as_str()), Some("Fixture Proton Game"));
    assert_eq!(t.svc.index_generation(), gen + 1);
    // The next scan does not keep the "not a game" it had for that process.
    t.svc.scan_now();
    assert_eq!(*t.events.lock().unwrap(), vec![Some(ActivityPayload { name: "Newly Installed".into(), started_at: START + 50_000 })]);
}

#[test]
fn games_scanner_a_game_that_ends_is_gone_after_two_scans_and_a_wrapper_that_execs_the_game_is_seen() {
    let t = setup(sample);
    t.svc.set_share(true, "a.local:1").unwrap();
    t.fake.procs.lock().unwrap().retain(|(p, _)| p.pid != 500);
    t.svc.scan_now();
    assert_eq!(t.count(), 1);
    t.svc.scan_now();
    assert_eq!(t.last(), Some(None));
    // Same pid and start, a new program (`exec ./game` from a launch script).
    let second = format!("{}/steam-library2/steamapps/common/SecondGame/SecondGame.x86_64", t.dir());
    for (p, _) in t.fake.procs.lock().unwrap().iter_mut().filter(|(p, _)| p.pid == 501) {
        p.exe = second.clone();
    }
    t.svc.scan_now();
    assert_eq!(t.last(), Some(Some(ActivityPayload { name: "Second Library Game\u{2122}".into(), started_at: START + 9_000 })));
}

#[test]
fn games_scanner_add_it_offers_file_names_under_opaque_ids_and_adds_by_id_only() {
    let indie = |dir: &str| format!("{dir}/games/indie/indie");
    let t = setup_with(
        |dir| {
            let mut v = sample(dir);
            v.push(proc_(600, 1, START + 30_000, &indie(dir), &[]));
            v.push(proc_(601, 1, START + 30_000, &indie(dir), &[]));
            v.push(proc_(602, 1, START + 30_000, "/usr/lib/systemd/systemd", &[]));
            v.push(proc_(603, 1, START + 30_000, &format!("{dir}/steam/ubuntu12_32/steam"), &[]));
            v.push(proc_(606, 1, START + 30_000, "/usr/bin/python3.13", &[]));
            v
        },
        Some("a.local:1"),
        Duration::from_secs(600),
        false,
    );
    let list = t.svc.running_programs().unwrap();
    assert_eq!(list.iter().map(|p| p.name.as_str()).collect::<Vec<_>>(), vec!["fixturegame", "indie"]);
    for p in &list {
        assert!(p.id.len() >= 12 && p.id.bytes().all(|b| b.is_ascii_hexdigit()));
    }
    let wire = serde_json::to_value(&list[0]).unwrap();
    assert_eq!(wire.as_object().unwrap().keys().cloned().collect::<Vec<_>>(), vec!["id", "name"]);
    let indie_id = list.iter().find(|p| p.name == "indie").unwrap().id.clone();
    assert!(t.svc.add("not-an-id", "X").unwrap_err().contains("list"));
    assert!(t.svc.add(&indie_id, "   ").unwrap_err().contains("characters"));
    let row = t.svc.add(&indie_id, "Indie Fixture").unwrap();
    let id = row.key.strip_prefix("user:").unwrap().to_string();
    assert!(id.len() == 12 && id.bytes().all(|b| b.is_ascii_hexdigit()), "{}", row.key);
    assert_eq!(
        row,
        GameRow { key: row.key.clone(), name: "Indie Fixture".into(), detected_name: "Indie Fixture".into(), source: "user".into(), hidden: false, renamed: false, running: false }
    );
    assert_eq!(t.activity_json()["user"], serde_json::json!([{ "id": id, "path": indie(&t.dir()), "name": "Indie Fixture" }]));
    // Adding the same program again renames it rather than adding a second.
    let again = t.svc.add(&indie_id, "Indie Renamed").unwrap();
    assert_eq!(again.key, row.key);
    // Sharing on now: the added game started last, so it is the one shared.
    t.svc.set_share(true, "a.local:1").unwrap();
    assert_eq!(t.last(), Some(Some(ActivityPayload { name: "Indie Renamed".into(), started_at: START + 30_000 })));
    assert!(t.svc.get_state().games.iter().find(|g| g.key == row.key).unwrap().running);
    // Ids expire.
    t.now.fetch_add(OFFER_TTL_MS + 1, Ordering::SeqCst);
    assert!(t.svc.add(&indie_id, "Late").unwrap_err().contains("list"));
    // Only added games can be removed; removing the shared one moves on to the next.
    assert!(t.svc.remove("steam:900001").unwrap_err().contains("added"));
    t.svc.remove(&row.key).unwrap();
    assert_eq!(t.last(), Some(fixture_game(START + 20_000)));
    assert_eq!(t.activity_json()["user"], serde_json::json!([]));
    assert!(prefs::load(t.config.path()).user.is_empty());
}

#[test]
fn games_scanner_the_worker_looks_when_sharing_comes_on_and_then_every_interval_until_stopped() {
    let t = setup_with(sample, Some("b.local:2"), Duration::from_millis(40), true);
    // Sharing is on for a, but b is signed in: nothing.
    t.svc.set_share(true, "a.local:1").unwrap();
    std::thread::sleep(Duration::from_millis(150));
    assert_eq!(t.lists(), 0);
    // Switching to a wakes the worker, which looks at once (nothing here scans by itself).
    t.svc.set_active_account(Some("a.local:1"));
    let deadline = Instant::now() + Duration::from_secs(10);
    while t.count() == 0 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert_eq!(t.last(), Some(fixture_game(START + 20_000)));
    // ...and keeps looking.
    let first = t.lists();
    while t.lists() < first + 3 && Instant::now() < deadline {
        std::thread::sleep(Duration::from_millis(10));
    }
    assert!(t.lists() >= first + 3, "the worker kept looking");
    // Stopped: no more.
    t.svc.stop();
    std::thread::sleep(Duration::from_millis(100));
    let after = t.lists();
    std::thread::sleep(Duration::from_millis(200));
    assert_eq!(t.lists(), after);
}

#[test]
fn games_scanner_the_payloads_are_snake_case_on_the_wire() {
    let state = GamesState {
        share: true,
        account: Some("strafe.chat:1".into()),
        current: Some(CurrentGame { key: "curated:factorio".into(), name: "Factorio".into(), started_at: 1 }),
        games: vec![GameRow { key: "curated:factorio".into(), name: "Factorio".into(), detected_name: "Factorio".into(), source: "curated".into(), hidden: false, renamed: false, running: true }],
    };
    assert_eq!(
        serde_json::to_value(&state).unwrap(),
        serde_json::json!({
            "share": true,
            "account": "strafe.chat:1",
            "current": { "key": "curated:factorio", "name": "Factorio", "started_at": 1 },
            "games": [{ "key": "curated:factorio", "name": "Factorio", "detected_name": "Factorio", "source": "curated", "hidden": false, "renamed": false, "running": true }],
        })
    );
    assert_eq!(serde_json::to_value(Some(ActivityPayload { name: "X".into(), started_at: 2 })).unwrap(), serde_json::json!({ "name": "X", "started_at": 2 }));
    assert_eq!(serde_json::to_value(None::<ActivityPayload>).unwrap(), Value::Null);
}
