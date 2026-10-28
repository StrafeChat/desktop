//! Listing this user's processes for the scanner, and only what it needs: sysinfo with only its
//! `system` feature.
//!
//! First every process's owner (nothing else); anyone else's processes are dropped there, on
//! every OS (critique #16: on a shared Windows PC another signed-in person's game must never be
//! shared as yours). Then, for this user's processes only, the program's path. The command
//! line is read only when the scanner asks, and it asks only for Java (`needs_cmdline`); the
//! environment is never read. Each snapshot has its own `System`, dropped with it, so no
//! process handle is held between scans (Windows), and nothing read here outlives the scan
//! that read it, is logged or is written anywhere.

use sysinfo::{Pid, ProcessRefreshKind, ProcessesToUpdate, System, UpdateKind};

use super::matcher::ProcInfo;

/// One look at the processes.
pub trait Snapshot {
    fn processes(&self) -> &[ProcInfo];
    /// A process's arguments, read now; None when it cannot be read (or has ended).
    fn cmdline(&mut self, pid: u32) -> Option<Vec<String>>;
}

/// Where snapshots come from: sysinfo in the app, a fixed list in tests.
pub trait ProcessSource: Send + Sync {
    fn snapshot(&self) -> Box<dyn Snapshot>;
}

pub struct SysinfoSource;

struct SysinfoSnapshot {
    sys: System,
    list: Vec<ProcInfo>,
}

impl Snapshot for SysinfoSnapshot {
    fn processes(&self) -> &[ProcInfo] {
        &self.list
    }

    fn cmdline(&mut self, pid: u32) -> Option<Vec<String>> {
        let pid = Pid::from_u32(pid);
        // Only this one process, only its arguments.
        self.sys.refresh_processes_specifics(ProcessesToUpdate::Some(&[pid]), false, ProcessRefreshKind::nothing().without_tasks().with_cmd(UpdateKind::Always));
        let p = self.sys.process(pid)?;
        let args: Vec<String> = p.cmd().iter().map(|a| a.to_string_lossy().into_owned()).collect();
        (!args.is_empty()).then_some(args)
    }
}

impl ProcessSource for SysinfoSource {
    fn snapshot(&self) -> Box<dyn Snapshot> {
        let mut sys = System::new();
        // Who owns each process: nothing more is read of anyone's yet.
        sys.refresh_processes_specifics(ProcessesToUpdate::All, true, ProcessRefreshKind::nothing().without_tasks().with_user(UpdateKind::Always));
        let me = sysinfo::get_current_pid().ok().and_then(|pid| sys.process(pid)).and_then(|p| p.user_id()).cloned();
        let Some(me) = me else {
            // Without knowing who we are, nobody's processes are ours.
            return Box::new(SysinfoSnapshot { sys, list: Vec::new() });
        };
        let mine: Vec<Pid> = sys.processes().iter().filter(|(_, p)| p.user_id() == Some(&me)).map(|(pid, _)| *pid).collect();
        // The program, of this user's processes only.
        sys.refresh_processes_specifics(ProcessesToUpdate::Some(&mine), true, ProcessRefreshKind::nothing().without_tasks().with_exe(UpdateKind::Always));
        let mut list = Vec::with_capacity(mine.len());
        for pid in &mine {
            let Some(p) = sys.process(*pid) else { continue };
            // sysinfo gives an empty path (not none) when Windows refuses it.
            let exe = p.exe().map(|e| e.to_string_lossy().into_owned()).unwrap_or_default();
            list.push(ProcInfo {
                pid: pid.as_u32(),
                ppid: p.parent().map(Pid::as_u32).unwrap_or(0),
                start_ms: p.start_time().saturating_mul(1000),
                exe: strip_deleted(exe),
                name: p.name().to_string_lossy().into_owned(),
            });
        }
        Box::new(SysinfoSnapshot { sys, list })
    }
}

/// Linux marks a program replaced or removed while running.
fn strip_deleted(exe: String) -> String {
    match exe.strip_suffix(" (deleted)") {
        Some(s) if cfg!(target_os = "linux") => s.to_string(),
        _ => exe,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The real source on this machine: only this user's processes, this test's own among them,
    /// with its program. (Nothing about any process is printed.) Run on every OS the shell
    /// ships for by the release workflow's `cargo test` step, so "this user's only" is checked
    /// on Windows and macOS too.
    #[test]
    fn games_procs_lists_this_users_processes_with_their_programs() {
        let mut snap = SysinfoSource.snapshot();
        let me = std::process::id();
        let own = snap.processes().iter().find(|p| p.pid == me).cloned().expect("this process is listed");
        assert!(!own.exe.is_empty());
        assert!(own.start_ms > 1_600_000_000_000);
        assert!(snap.cmdline(me).is_some_and(|a| !a.is_empty()));
        #[cfg(unix)]
        {
            // pid 1 (init, launchd) is root's: never listed unless this is root.
            use std::os::unix::fs::MetadataExt;
            let tmp = crate::games::tests_support::TempDir::new("uid");
            let probe = tmp.path().join("mine");
            std::fs::write(&probe, b"").unwrap();
            let my_uid = std::fs::metadata(&probe).unwrap().uid();
            let init_uid = if cfg!(target_os = "linux") { std::fs::metadata("/proc/1").ok().map(|m| m.uid()) } else { Some(0) };
            if init_uid.is_some_and(|u| u != my_uid) {
                assert!(snap.processes().iter().all(|p| p.pid != 1));
            }
        }
        // Windows: the System process (pid 4) belongs to no signed-in person.
        #[cfg(windows)]
        assert!(snap.processes().iter().all(|p| p.pid != 4));
    }
}
