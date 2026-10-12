// Discord Rich Presence: while Strafe is open, Discord shows "Playing Strafe" on the person's
// profile, with whether they are in a call. A port of the Tauri shell's src-tauri/src/discord.rs,
// same behaviour and constants.
//
// Discord learns about it over its local IPC socket, the way games do, so nothing leaves the
// machine except what Discord itself publishes to that person's friends. Discord may not be
// running when Strafe starts, may start later, or restart mid-session, so this looks for it
// again at intervals and re-sends the current activity whenever it (re)connects. Nothing
// here can block the UI: every call below only records what is wanted and schedules the work.
//
// No Electron here: the application ID comes in from app.js.

const crypto = require('node:crypto');
const fs = require('node:fs');
const net = require('node:net');
const path = require('node:path');

/** The Discord application whose name Discord shows ("Playing **Strafe**"): the "Strafe" app in
 * the StrafeChat developer account. A public identifier, not a secret. */
const DISCORD_APP_ID = '1160242168393388132';

/** The art beside the activity. Discord fetches image URLs itself, so no asset has to be
 * uploaded to the application; the app icon from this repository will do. */
const LARGE_IMAGE = 'https://raw.githubusercontent.com/StrafeChat/desktop/main/branding/icon-1024.png';
const LARGE_TEXT = 'Strafe';
/** Shown to other people under the activity (Discord hides buttons from their owner). */
const BUTTON_LABEL = 'Get Strafe';
const BUTTON_URL = 'https://strafe.chat/download';

/** How long to wait before looking for Discord again when it is not running. */
const RETRY_NOT_RUNNING_MS = 20_000;
/** ...and when it is running but refused us (a wrong application ID): nothing will change
 * soon, so keep the log quiet. */
const RETRY_REFUSED_MS = 10 * 60_000;
/** Discord answers at once; a socket that stays silent this long is not Discord. */
const REPLY_TIMEOUT_MS = 10_000;
/** No reply of Discord's comes near this; anything bigger is not a frame from Discord. */
const MAX_FRAME = 1 << 20;

const OP_HANDSHAKE = 0;
const OP_FRAME = 1;
const OP_CLOSE = 2;

// ---- the wire format (pure) ---------------------------------------------------------------

/** One IPC frame: u32 LE opcode, u32 LE length, then that many bytes of JSON. */
function encodeFrame(op, payload) {
  const body = Buffer.from(JSON.stringify(payload), 'utf8');
  const head = Buffer.alloc(8);
  head.writeUInt32LE(op, 0);
  head.writeUInt32LE(body.length, 4);
  return Buffer.concat([head, body]);
}

/**
 * Split a byte buffer into whole frames. Returns { frames: [{op, data}], rest } where `rest`
 * is an incomplete frame to keep for the next chunk. Throws on a frame no Discord would send.
 */
function decodeFrames(buffer) {
  const frames = [];
  let off = 0;
  while (buffer.length - off >= 8) {
    const op = buffer.readUInt32LE(off);
    const len = buffer.readUInt32LE(off + 4);
    if (len > MAX_FRAME) throw new Error(`frame of ${len} bytes`);
    if (buffer.length - off - 8 < len) break;
    const text = buffer.subarray(off + 8, off + 8 + len).toString('utf8');
    let data;
    try {
      data = len ? JSON.parse(text) : {};
    } catch {
      throw new Error('frame is not JSON');
    }
    frames.push({ op, data });
    off += 8 + len;
  }
  return { frames, rest: buffer.subarray(off) };
}

/** Subdirectories of a base where a sandboxed or alternative Discord puts its socket, in the
 * order discord.rs's client library looks. */
const SUBPATHS = [
  '',
  'app/com.discordapp.Discord/',
  'app/dev.vencord.Vesktop/',
  '.flatpak/com.discordapp.Discord/xdg-run/',
  '.flatpak/dev.vencord.Vesktop/xdg-run/',
  'snap.discord-canary/',
  'snap.discord/',
];

/** Every path Discord's socket might be at, most likely first. */
function socketCandidates(env = process.env) {
  const bases = [];
  for (const key of ['XDG_RUNTIME_DIR', 'TMPDIR', 'TMP', 'TEMP']) {
    let v = env[key];
    if (!v) continue;
    // Inside a snap, XDG_RUNTIME_DIR is the snap's own subdirectory of the real one.
    if (env.SNAP && key === 'XDG_RUNTIME_DIR') v = path.dirname(v);
    bases.push(v);
  }
  bases.push('/tmp');
  const out = [];
  for (const base of [...new Set(bases)]) {
    for (let i = 0; i < 10; i++) {
      for (const sub of SUBPATHS) out.push(path.join(base, sub, `discord-ipc-${i}`));
    }
  }
  return out;
}

function nonEmpty(s) {
  if (typeof s !== 'string') return null;
  const t = s.trim();
  return t ? t : null;
}

/** Only what the client may set: two short lines and a start time. */
function normalizePresence(p) {
  const v = p && typeof p === 'object' ? p : {};
  const out = {};
  if (nonEmpty(v.details)) out.details = nonEmpty(v.details);
  if (nonEmpty(v.state)) out.state = nonEmpty(v.state);
  if (Number.isFinite(v.since) && v.since >= 0) out.since = Math.floor(v.since);
  return out;
}

function samePresence(a, b) {
  return !!a && !!b && a.details === b.details && a.state === b.state && a.since === b.since;
}

/** The activity Discord shows ("Playing" is type 0), from what the client asked for. */
function buildActivity(presence, launched) {
  const p = normalizePresence(presence);
  const activity = {
    type: 0,
    timestamps: { start: p.since ?? launched },
    assets: { large_image: LARGE_IMAGE, large_text: LARGE_TEXT },
    buttons: [{ label: BUTTON_LABEL, url: BUTTON_URL }],
  };
  if (p.details) activity.details = p.details;
  if (p.state) activity.state = p.state;
  return activity;
}

// ---- one connection ---------------------------------------------------------------------------

/** A connected socket that reads Discord's replies one at a time. */
class Connection {
  constructor(socket, onClose) {
    this.socket = socket;
    this.buffer = Buffer.alloc(0);
    this.queue = [];
    this.waiter = null;
    this.closed = false;
    socket.on('data', (chunk) => {
      this.buffer = Buffer.concat([this.buffer, chunk]);
      try {
        const { frames, rest } = decodeFrames(this.buffer);
        this.buffer = rest;
        this.queue.push(...frames);
      } catch (e) {
        socket.destroy(e);
        return;
      }
      this.deliver();
    });
    socket.on('error', () => {});
    socket.on('close', () => {
      this.closed = true;
      this.deliver();
      onClose(this);
    });
  }

  deliver() {
    if (!this.waiter) return;
    const w = this.waiter;
    if (this.queue.length) {
      this.waiter = null;
      w.resolve(this.queue.shift());
    } else if (this.closed) {
      this.waiter = null;
      w.reject(new Error('socket closed'));
    }
  }

  send(op, payload) {
    if (this.closed) throw new Error('socket closed');
    this.socket.write(encodeFrame(op, payload));
  }

  /** The next frame from Discord. */
  recv() {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.waiter = null;
        reject(new Error('no reply'));
      }, REPLY_TIMEOUT_MS);
      this.waiter = {
        resolve: (f) => (clearTimeout(timer), resolve(f)),
        reject: (e) => (clearTimeout(timer), reject(e)),
      };
      this.deliver();
    });
  }

  close() {
    if (this.closed) return;
    try {
      this.send(OP_CLOSE, {});
    } catch {
      // Already gone.
    }
    this.socket.end();
  }
}

function openSocket(file) {
  return new Promise((resolve, reject) => {
    const s = net.createConnection(file);
    s.once('connect', () => {
      s.removeListener('error', reject);
      resolve(s);
    });
    s.once('error', reject);
  });
}

class NotRunning extends Error {}
class Refused extends Error {}
class Rejected extends Error {}

// ---- the presence keeper ------------------------------------------------------------------------

/**
 * What the rest of the app talks to: setPresence (the client), setEnabled (the Settings
 * toggle), setVisible (the window). Discord is only connected while the toggle is on AND the
 * window is on screen - a Strafe hidden in the tray is not being used, so it is not "playing"
 * either.
 */
class Discord {
  /**
   * @param {object} [o]
   * @param {string} [o.appId] the Discord application; empty: this build has none, every
   *   call is a no-op and Settings says so.
   * @param {boolean} [o.enabled] the Settings toggle at start-up.
   * @param {(msg: string) => void} [o.debug] routine chatter (development builds only:
   *   Discord not running is the normal case on most machines).
   * @param {object} [o.env] where to look for the socket (tests).
   */
  constructor({ appId = DISCORD_APP_ID, enabled = true, debug = () => {}, env = process.env } = {}) {
    this.appId = appId;
    this.enabled = enabled;
    // The window starts hidden; it tells us when it is shown.
    this.visible = false;
    /** What the client last asked for. */
    this.wanted = {};
    /** What Discord currently shows, if we are connected and have sent anything. */
    this.shown = null;
    this.conn = null;
    this.nextTry = 0;
    /** Launch time, the default start of the "elapsed" counter. */
    this.launched = Date.now();
    this.debug = debug;
    this.env = env;
    this.scheduled = false;
    this.running = false;
    this.dirty = false;
    this.retryTimer = null;
    this.stopped = false;
  }

  configured() {
    return !!this.appId;
  }

  setPresence(presence) {
    this.wanted = normalizePresence(presence);
    this.schedule();
  }

  setEnabled(on) {
    this.enabled = !!on;
    this.schedule();
  }

  setVisible(visible) {
    this.visible = !!visible;
    this.schedule();
  }

  /** At quit: clear the activity and let go of the socket. */
  stop() {
    this.stopped = true;
    clearTimeout(this.retryTimer);
    this.disconnect();
  }

  active() {
    return this.configured() && !this.stopped && this.enabled && this.visible;
  }

  /** A burst of updates (a call connecting, the language changing) becomes one write: the
   * work runs once, after everything already queued has been recorded. */
  schedule() {
    if (!this.configured() || this.stopped) return;
    if (this.running) {
      this.dirty = true;
      return;
    }
    if (this.scheduled) return;
    this.scheduled = true;
    setImmediate(() => {
      this.scheduled = false;
      this.run();
    });
  }

  async run() {
    this.running = true;
    try {
      do {
        this.dirty = false;
        await this.reconcile();
      } while (this.dirty && !this.stopped);
    } catch (e) {
      console.error(`discord: ${e.message}`);
    } finally {
      this.running = false;
    }
  }

  retryIn(ms) {
    this.nextTry = Date.now() + ms;
    clearTimeout(this.retryTimer);
    this.retryTimer = setTimeout(() => {
      // Timers may fire a hair before the wall clock agrees; the wait is over either way.
      this.nextTry = 0;
      this.schedule();
    }, ms);
    // Waiting for Discord is no reason to keep the process alive.
    this.retryTimer.unref?.();
  }

  /** Make Discord match `wanted`: connect if needed, send if something changed, let go when
   * the activity should not show at all. */
  async reconcile() {
    if (!this.active()) {
      this.disconnect();
      return;
    }
    if (!this.conn) {
      if (Date.now() < this.nextTry) return;
      try {
        this.conn = await this.connect();
        this.shown = null;
      } catch (e) {
        if (e instanceof Refused) {
          console.error(`discord: handshake refused - is the Discord application ID a real one? ${e.message}`);
          this.retryIn(RETRY_REFUSED_MS);
        } else {
          this.debug(`discord: not connected (${e.message})`);
          this.retryIn(RETRY_NOT_RUNNING_MS);
        }
        return;
      }
      // Things may have changed while connecting.
      if (!this.active()) {
        this.disconnect();
        return;
      }
    }
    if (samePresence(this.shown, this.wanted)) return;
    const wanted = this.wanted;
    try {
      await this.push(wanted);
      this.shown = wanted;
    } catch (e) {
      if (e instanceof Rejected) {
        // Discord did not like the payload itself; sending it again would not help.
        console.error(`discord: activity rejected: ${e.message}`);
        this.shown = wanted;
      } else {
        // Discord quit or restarted under us: drop the socket and look again later.
        this.debug(`discord: connection lost (${e.message})`);
        this.disconnect();
        this.retryIn(RETRY_NOT_RUNNING_MS);
      }
    }
  }

  /** Find the socket and shake hands. A wrong application ID is answered with a CLOSE frame
   * ({"code":4000,"message":"Invalid Client ID"}) rather than an error, so the reply is read
   * to tell "refused" from "not running". */
  async connect() {
    let socket = null;
    let lastError = 'no socket';
    for (const file of socketCandidates(this.env)) {
      if (!fs.existsSync(file)) continue;
      try {
        socket = await openSocket(file);
        break;
      } catch (e) {
        // A socket file left behind by a Discord that crashed: try the next one.
        lastError = e.message;
      }
    }
    if (!socket) throw new NotRunning(lastError);
    const conn = new Connection(socket, (c) => this.lost(c));
    try {
      conn.send(OP_HANDSHAKE, { v: 1, client_id: this.appId });
      const reply = await conn.recv();
      if (reply.op === OP_FRAME && reply.data && reply.data.evt === 'READY') return conn;
      conn.close();
      throw new Refused(JSON.stringify(reply.data));
    } catch (e) {
      if (e instanceof Refused) throw e;
      conn.socket.destroy();
      throw new NotRunning(e.message);
    }
  }

  /** Send the activity and read Discord's answer, which both confirms it and keeps the
   * socket drained. */
  async push(presence) {
    const conn = this.conn;
    conn.send(OP_FRAME, {
      cmd: 'SET_ACTIVITY',
      args: { pid: process.pid, activity: buildActivity(presence, this.launched) },
      nonce: crypto.randomUUID(),
    });
    const reply = await conn.recv();
    if (reply.op === OP_CLOSE) throw new Error(`closed by Discord: ${JSON.stringify(reply.data)}`);
    if (reply.data && reply.data.evt === 'ERROR') throw new Rejected(JSON.stringify(reply.data));
    // The reply echoes the activity as Discord will show it, name included.
    const name = (reply.data && reply.data.data && reply.data.data.name) || '?';
    this.debug(`discord: showing "Playing ${name}" (${presence.details || '-'})`);
  }

  /** Discord closed the socket by itself (it quit or restarted): look for it again later, so
   * the activity comes back when Discord does. */
  lost(conn) {
    if (this.conn !== conn) return;
    this.conn = null;
    this.shown = null;
    this.debug('discord: connection lost');
    if (this.active()) this.retryIn(RETRY_NOT_RUNNING_MS);
  }

  disconnect() {
    const conn = this.conn;
    this.conn = null;
    if (conn) {
      if (this.shown) {
        try {
          conn.send(OP_FRAME, { cmd: 'SET_ACTIVITY', args: { pid: process.pid, activity: null }, nonce: crypto.randomUUID() });
        } catch {
          // Already gone, and the activity with it.
        }
      }
      conn.close();
      this.debug('discord: activity cleared, socket closed');
    }
    this.shown = null;
  }
}

module.exports = {
  DISCORD_APP_ID,
  LARGE_IMAGE,
  LARGE_TEXT,
  BUTTON_LABEL,
  BUTTON_URL,
  RETRY_NOT_RUNNING_MS,
  RETRY_REFUSED_MS,
  SUBPATHS,
  encodeFrame,
  decodeFrames,
  socketCandidates,
  normalizePresence,
  buildActivity,
  Discord,
};
