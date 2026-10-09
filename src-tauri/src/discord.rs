//! Discord Rich Presence: while Strafe is open, Discord shows "Playing Strafe" on the
//! person's profile, with whether they are in a call. Discord learns about it over its local
//! IPC socket, the way games do, so nothing leaves the machine except what Discord itself
//! publishes to that person's friends.
//!
//! One background thread owns the socket. Discord may not be running when Strafe starts, may
//! start later, or restart mid-session, so the thread looks for it again at intervals and
//! re-sends the current activity whenever it (re)connects. The rest of the app only ever
//! posts messages to the thread; nothing here can block the UI.

use std::{
    sync::mpsc::{self, Receiver, RecvTimeoutError, Sender},
    time::{Duration, Instant, SystemTime, UNIX_EPOCH},
};

use discord_rich_presence::{activity, DiscordIpc, DiscordIpcClient};
use serde::{Deserialize, Serialize};
use serde_json::{json, Value};

/// The Discord application whose name Discord shows ("Playing **Strafe**"): the "Strafe" app
/// in the StrafeChat developer account at <https://discord.com/developers/applications>. It
/// is a public identifier, not a secret. `STRAFE_DISCORD_APP_ID` at build time overrides it
/// (a fork with its own application, say); empty turns the feature off in that build - the
/// thread is never started and Settings says so.
pub const DISCORD_APP_ID: &str = match option_env!("STRAFE_DISCORD_APP_ID") {
    Some(id) => id,
    None => "1160242168393388132",
};

/// The art beside the activity. Discord fetches image URLs itself, so no asset has to be
/// uploaded to the application; the app icon from this repository will do.
const LARGE_IMAGE: &str = "https://raw.githubusercontent.com/StrafeChat/desktop/main/branding/icon-1024.png";
const LARGE_TEXT: &str = "Strafe";
/// Shown to other people under the activity (Discord hides buttons from their owner).
const BUTTON_LABEL: &str = "Get Strafe";
const BUTTON_URL: &str = "https://strafe.chat/download";

/// How long to wait before looking for Discord again when it is not running.
const RETRY_NOT_RUNNING: Duration = Duration::from_secs(20);
/// ...and when it is running but refused us (a wrong application ID): nothing will change
/// soon, so keep the log quiet.
const RETRY_REFUSED: Duration = Duration::from_secs(10 * 60);
/// Nothing to do: sleep until the app says otherwise.
const IDLE: Duration = Duration::from_secs(60 * 60);

/// What the frontend wants shown beneath the "Playing Strafe" line.
#[derive(Clone, Debug, Default, PartialEq, Eq, Serialize, Deserialize)]
#[serde(default, rename_all = "camelCase")]
pub struct Presence {
    /// First line ("In a voice call"). Empty or absent: no line.
    pub details: Option<String>,
    /// Second line.
    pub state: Option<String>,
    /// Unix milliseconds the shown activity started (a call's start), so Discord's
    /// "elapsed" counter counts from the right moment; the app's launch when absent.
    pub since: Option<u64>,
}

enum Msg {
    Presence(Presence),
    /// The Settings toggle.
    Enabled(bool),
    /// Whether the main window is on screen. A Strafe hidden in the tray is not being used,
    /// so it is not "playing" either - Discord stops showing it until the window comes back.
    Visible(bool),
}

/// The handle the rest of the app talks to. Dropping it ends the thread, which clears the
/// activity on its way out.
pub struct Discord {
    tx: Sender<Msg>,
}

impl Discord {
    /// Whether this build carries an application ID at all.
    pub fn configured() -> bool {
        !DISCORD_APP_ID.is_empty()
    }

    pub fn start(enabled: bool) -> Self {
        let (tx, rx) = mpsc::channel();
        if Self::configured() {
            std::thread::Builder::new()
                .name("discord-presence".into())
                .spawn(move || run(rx, enabled))
                .expect("spawn the Discord presence thread");
        }
        // Not configured: the receiver is dropped here and every send below is a no-op.
        Self { tx }
    }

    pub fn set_presence(&self, presence: Presence) {
        let _ = self.tx.send(Msg::Presence(presence));
    }

    pub fn set_enabled(&self, enabled: bool) {
        let _ = self.tx.send(Msg::Enabled(enabled));
    }

    pub fn set_visible(&self, visible: bool) {
        let _ = self.tx.send(Msg::Visible(visible));
    }
}

// ---- the thread ------------------------------------------------------------------------------

struct Worker {
    enabled: bool,
    visible: bool,
    /// What the frontend last asked for.
    wanted: Presence,
    /// What Discord currently shows, if we are connected and have sent anything.
    shown: Option<Presence>,
    client: Option<DiscordIpcClient>,
    next_try: Instant,
    /// Launch time, the default start of the "elapsed" counter.
    launched: u64,
}

fn run(rx: Receiver<Msg>, enabled: bool) {
    let mut w = Worker {
        enabled,
        visible: false,
        wanted: Presence::default(),
        shown: None,
        client: None,
        next_try: Instant::now(),
        launched: now_ms(),
    };
    loop {
        // Wait for news - or, while Discord is wanted but absent, for the next look.
        let timeout = if w.active() && w.client.is_none() {
            w.next_try.saturating_duration_since(Instant::now())
        } else {
            IDLE
        };
        match rx.recv_timeout(timeout) {
            Ok(msg) => w.apply(msg),
            Err(RecvTimeoutError::Timeout) => {}
            Err(RecvTimeoutError::Disconnected) => break,
        }
        // A burst of updates (a call connecting, the language changing) becomes one write.
        while let Ok(msg) = rx.try_recv() {
            w.apply(msg);
        }
        w.reconcile();
    }
    w.disconnect();
}

impl Worker {
    fn active(&self) -> bool {
        self.enabled && self.visible
    }

    fn apply(&mut self, msg: Msg) {
        match msg {
            Msg::Presence(p) => self.wanted = p,
            Msg::Enabled(on) => self.enabled = on,
            Msg::Visible(v) => self.visible = v,
        }
    }

    /// Make Discord match `wanted`: connect if needed, send if something changed, let go
    /// when the activity should not show at all.
    fn reconcile(&mut self) {
        if !self.active() {
            self.disconnect();
            return;
        }
        if self.client.is_none() {
            if Instant::now() < self.next_try {
                return;
            }
            match connect() {
                Ok(c) => {
                    self.client = Some(c);
                    self.shown = None;
                }
                Err(ConnectError::NotRunning(e)) => {
                    debug(&format!("discord: not connected ({e})"));
                    self.next_try = Instant::now() + RETRY_NOT_RUNNING;
                    return;
                }
                Err(ConnectError::Refused(reply)) => {
                    eprintln!("discord: handshake refused - is DISCORD_APP_ID a real application ID? {reply}");
                    self.next_try = Instant::now() + RETRY_REFUSED;
                    return;
                }
            }
        }
        if self.shown.as_ref() == Some(&self.wanted) {
            return;
        }
        let client = self.client.as_mut().expect("connected above");
        match push(client, &self.wanted, self.launched) {
            Ok(()) => self.shown = Some(self.wanted.clone()),
            Err(PushError::Rejected(reply)) => {
                // Discord did not like the payload itself; sending it again would not help.
                eprintln!("discord: activity rejected: {reply}");
                self.shown = Some(self.wanted.clone());
            }
            Err(PushError::Transport(e)) => {
                // Discord quit or restarted under us: drop the socket and look again later.
                debug(&format!("discord: connection lost ({e})"));
                self.disconnect();
                self.next_try = Instant::now() + RETRY_NOT_RUNNING;
            }
        }
    }

    fn disconnect(&mut self) {
        if let Some(mut c) = self.client.take() {
            if self.shown.is_some() {
                let _ = c.clear_activity();
            }
            let _ = c.close();
            debug("discord: activity cleared, socket closed");
        }
        self.shown = None;
    }
}

enum ConnectError {
    /// No socket, or nobody listening on it.
    NotRunning(String),
    /// Discord answered the handshake with a close frame.
    Refused(String),
}

/// Open the socket and shake hands. The crate's own `connect()` discards Discord's reply, and
/// a wrong application ID is answered with a CLOSE frame (`{"code":4000,"message":"Invalid
/// Client ID"}`) rather than an error, so the handshake is done by hand here to tell the
/// two apart.
fn connect() -> Result<DiscordIpcClient, ConnectError> {
    let mut c = DiscordIpcClient::new(DISCORD_APP_ID);
    c.connect_ipc().map_err(|e| ConnectError::NotRunning(e.to_string()))?;
    let handshake = json!({ "v": 1, "client_id": DISCORD_APP_ID });
    if let Err(e) = c.send(handshake, 0) {
        return Err(ConnectError::NotRunning(e.to_string()));
    }
    match c.recv() {
        Ok((1, reply)) if evt(&reply) == Some("READY") => Ok(c),
        Ok((_, reply)) => {
            let _ = c.close();
            Err(ConnectError::Refused(reply.to_string()))
        }
        Err(e) => Err(ConnectError::NotRunning(e.to_string())),
    }
}

enum PushError {
    Transport(String),
    Rejected(String),
}

/// Send the activity and read Discord's answer, which both confirms it and keeps the socket
/// drained (the crate never reads replies; left unread they would pile up in the socket).
fn push(c: &mut DiscordIpcClient, p: &Presence, launched: u64) -> Result<(), PushError> {
    let mut a = activity::Activity::new()
        .activity_type(activity::ActivityType::Playing)
        .assets(activity::Assets::new().large_image(LARGE_IMAGE).large_text(LARGE_TEXT))
        .timestamps(activity::Timestamps::new().start(p.since.unwrap_or(launched) as i64))
        .buttons(vec![activity::Button::new(BUTTON_LABEL, BUTTON_URL)]);
    if let Some(d) = nonempty(&p.details) {
        a = a.details(d);
    }
    if let Some(s) = nonempty(&p.state) {
        a = a.state(s);
    }
    c.set_activity(a).map_err(|e| PushError::Transport(e.to_string()))?;
    match c.recv() {
        Ok((2, reply)) => Err(PushError::Transport(format!("closed by Discord: {reply}"))),
        Ok((_, reply)) if evt(&reply) == Some("ERROR") => Err(PushError::Rejected(reply.to_string())),
        Ok((_, reply)) => {
            // The reply echoes the activity as Discord will show it, name included.
            let name = reply.pointer("/data/name").and_then(Value::as_str).unwrap_or("?");
            let details = nonempty(&p.details).unwrap_or("-");
            debug(&format!("discord: showing \"Playing {name}\" ({details})"));
            Ok(())
        }
        Err(e) => Err(PushError::Transport(e.to_string())),
    }
}

fn evt(reply: &Value) -> Option<&str> {
    reply.get("evt").and_then(Value::as_str)
}

fn nonempty(s: &Option<String>) -> Option<&str> {
    s.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

fn now_ms() -> u64 {
    SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map(|d| d.as_millis() as u64)
        .unwrap_or(0)
}

/// Routine chatter (Discord not running is the normal case on most machines) only in
/// development builds.
fn debug(msg: &str) {
    if cfg!(debug_assertions) {
        eprintln!("{msg}");
    }
}
