//! Game activity: "Playing X" on Strafe, for the Windows and macOS shell. The Electron shell
//! (Linux) does the same in electron/src/games; both read desktop/games.json and both run the
//! shared cases in desktop/test/games, so they recognise games the same way.
//!
//! The process list never leaves this module. The page is told only what to share - the game's
//! name and when it started, after the person's hides and renames, or null - through the
//! `activity-changed` event on the main window, and asks through the games_* commands below
//! (web.strafe.chat src/desktop/native.ts is the other half). Sharing is off until turned on,
//! per desktop account, and while it is off no process is looked at.
//!
//! - text.rs: the name rule (the server's, counted in code points)
//! - data.rs: games.json, built in
//! - vdf.rs: Steam's KeyValues files
//! - indexes.rs: Steam libraries (every OS) and Epic manifests (Windows, macOS)
//! - matcher.rs: the recognition order, with the OS as a parameter
//! - tracker.rs: sessions, most-recent-wins, hysteresis, the two-miss end
//! - procs.rs: this user's processes, through sysinfo
//! - prefs.rs: activity.json
//! - service.rs: the scanner and what the commands do

mod data;
mod indexes;
mod matcher;
mod prefs;
mod procs;
mod service;
mod text;
mod tracker;
mod unicode;
mod vdf;

#[cfg(test)]
mod tests;
#[cfg(test)]
mod tests_support;

use std::{sync::Arc, time::Duration};

use tauri::{AppHandle, Emitter, State, WebviewWindow};

use data::GamesData;
use matcher::Os;
use service::{GameRow, GamesState, Options, RunningProgram, Service};

/// The event the main window hears what to share by: `{name, started_at}` or null.
pub const ACTIVITY_EVENT: &str = "activity-changed";

/// Managed state. None when this build cannot detect games (no config directory, or - in a
/// development build - an unreadable STRAFE_GAMES_FILE).
pub struct Games(Option<Arc<Service>>);

impl Games {
    /// The page saved accounts.json: game sharing is per account, so it follows `active`, and
    /// an account no longer listed is no longer shared for (one write, only when one went).
    /// Never fails the accounts save.
    pub fn accounts_saved(&self, value: &serde_json::Value) {
        if let Some(s) = &self.0 {
            s.accounts_saved(value);
        }
    }

    /// The app is quitting: stop looking.
    pub fn stop(&self) {
        if let Some(s) = &self.0 {
            s.stop();
        }
    }
}

/// Development builds only, as the Electron shell's env.js: STRAFE_GAMES_FILE recognises games
/// by another list, STRAFE_GAMES_POLL_MS (at least 1000) looks that often.
fn dev_var(name: &str) -> Option<String> {
    if cfg!(debug_assertions) {
        std::env::var(name).ok().filter(|v| !v.is_empty())
    } else {
        None
    }
}

/// Start the service (it looks at nothing until sharing is on for the signed-in account).
pub fn start(app: &AppHandle) -> Games {
    let config_dir = match crate::config_dir(app) {
        Ok(d) => d,
        Err(e) => {
            eprintln!("game activity is unavailable: no config directory ({e})");
            return Games(None);
        }
    };
    let data = match dev_var("STRAFE_GAMES_FILE") {
        Some(file) => std::fs::read_to_string(&file).map_err(|e| e.to_string()).and_then(|t| GamesData::parse(&t)),
        None => GamesData::bundled(),
    };
    let data = match data {
        Ok(d) => d,
        Err(e) => {
            eprintln!("game activity is unavailable: could not read games.json ({e})");
            return Games(None);
        }
    };
    let interval = dev_var("STRAFE_GAMES_POLL_MS").and_then(|v| v.parse::<u64>().ok()).filter(|&ms| ms >= 1000).map(Duration::from_millis).unwrap_or(service::SCAN_INTERVAL);
    let os = Os::current();
    let home = dirs::home_dir().unwrap_or_default();
    let roots = indexes::default_roots(os, &home, &|k| std::env::var(k).ok());
    let push = app.clone();
    let svc = Service::new(Options {
        os,
        data,
        config_dir,
        roots,
        home: home.to_string_lossy().into_owned(),
        self_pid: std::process::id(),
        interval,
        source: Box::new(procs::SysinfoSource),
        // The main window only: popups run the whole client too, and must not report a game.
        emit: Box::new(move |payload| {
            let _ = push.emit_to(crate::MAIN_WINDOW, ACTIVITY_EVENT, payload);
        }),
        now: Box::new(service::wall_ms),
    });
    svc.start(true);
    Games(Some(svc))
}

// ---- commands --------------------------------------------------------------------------------
//
// Every one answers the main window only (popups run the whole client too, and must neither
// report a game nor read the list), and every one is async, its work on a blocking thread: a
// sync command runs on the main thread, and a scan or a file write must never hold up the UI.
// Arguments as the page passes them (critique #5): games_set_share({on, account}),
// games_set_hidden({key, hidden}), games_rename({key, name}), games_add({id, name}),
// games_remove({key}). Errors reject the page's promise with a message.

fn service(window: &WebviewWindow, games: &Games) -> Result<Arc<Service>, String> {
    if window.label() != crate::MAIN_WINDOW {
        return Err("Only the main window can do that.".into());
    }
    games.0.clone().ok_or_else(|| "This build of Strafe cannot detect games.".into())
}

async fn blocking<T, F>(f: F) -> Result<T, String>
where
    T: Send + 'static,
    F: FnOnce() -> Result<T, String> + Send + 'static,
{
    tauri::async_runtime::spawn_blocking(f).await.map_err(|e| e.to_string())?
}

/// `{share, account, current, games}`. Never scans.
#[tauri::command]
pub async fn games_get_state(window: WebviewWindow, games: State<'_, Games>) -> Result<GamesState, String> {
    let svc = service(&window, &games)?;
    blocking(move || Ok(svc.get_state())).await
}

/// Sharing on or off for one desktop account; off stops the scanner.
#[tauri::command]
pub async fn games_set_share(window: WebviewWindow, games: State<'_, Games>, on: bool, account: String) -> Result<(), String> {
    let svc = service(&window, &games)?;
    blocking(move || svc.set_share(on, &account)).await
}

#[tauri::command]
pub async fn games_set_hidden(window: WebviewWindow, games: State<'_, Games>, key: String, hidden: bool) -> Result<(), String> {
    let svc = service(&window, &games)?;
    blocking(move || svc.set_hidden(&key, hidden)).await
}

/// A null name goes back to the detected one.
#[tauri::command]
pub async fn games_rename(window: WebviewWindow, games: State<'_, Games>, key: String, name: Option<String>) -> Result<(), String> {
    let svc = service(&window, &games)?;
    blocking(move || svc.rename(&key, name.as_deref())).await
}

/// `[{id, name}]`: opaque ids and file names, looked up now; never a path.
#[tauri::command]
pub async fn games_running_programs(window: WebviewWindow, games: State<'_, Games>) -> Result<Vec<RunningProgram>, String> {
    let svc = service(&window, &games)?;
    blocking(move || svc.running_programs()).await
}

#[tauri::command]
pub async fn games_add(window: WebviewWindow, games: State<'_, Games>, id: String, name: String) -> Result<GameRow, String> {
    let svc = service(&window, &games)?;
    blocking(move || svc.add(&id, &name)).await
}

/// Games the person added (`user:` keys) only.
#[tauri::command]
pub async fn games_remove(window: WebviewWindow, games: State<'_, Games>, key: String) -> Result<(), String> {
    let svc = service(&window, &games)?;
    blocking(move || svc.remove(&key)).await
}
