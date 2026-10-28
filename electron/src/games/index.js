// Game activity for the Linux shell: recognises the game being played on this device and
// tells the main window what to share - its name and when it started, or null - and nothing
// else. The process list never leaves this module: no process data is logged, kept past the
// scan that read it, or handed to the page (critique #12, #16).
//
// Sharing is off until the person turns it on, for one desktop account at a time (critique
// #17); while it is off for the account signed in now, no process is looked at. The contract
// with the page is web.strafe.chat/src/desktop/native.ts (games section), over the bridge's
// `games` member (preload.js) and strafe:games:* (ipc.js). The Tauri shell does the same in
// src-tauri/src/games.
//
// No Electron here (app.js passes in the push and the power events), so the tests load it
// directly.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const proc = require('./proc');
const prefsStore = require('./prefs');
const store = require('../store');
const { Indexes, defaultRoots } = require('./indexes');
const { classify, needs, ownTree, programOf } = require('./matcher');
const { Tracker } = require('./tracker');
const { cleanName, validName, NAME_MAX } = require('./text');
const { baseName } = require('./data');

/** How often to look while sharing is on. */
const SCAN_INTERVAL_MS = 15_000;
/** How long an id from runningPrograms() can be added from. */
const OFFER_TTL_MS = 5 * 60_000;
const OFFER_CAP = 1000;
/** The most programs "Add it" lists. */
const RUNNING_CAP = 200;
const CONCURRENCY = 32;

/** Not games, and not worth offering: the system's own programs and the session around them. */
const SYSTEM_DIRS = ['/usr/lib/', '/usr/lib32/', '/usr/lib64/', '/usr/libexec/', '/lib/', '/lib64/', '/usr/sbin/', '/sbin/', '/usr/share/', '/proc/', '/snap/core'];
const SYSTEM_NAMES = new Set([
  'sh', 'bash', 'zsh', 'fish', 'dash', 'ksh', 'tcsh', 'csh', 'nu', 'sudo', 'su', 'login', 'tmux', 'screen',
  'systemd', 'dbus-daemon', 'dbus-broker', 'dbus-broker-launch', 'pipewire', 'pipewire-pulse', 'wireplumber', 'pulseaudio',
  'xwayland', 'xorg', 'gnome-shell', 'plasmashell', 'kwin_wayland', 'kwin_x11', 'ssh-agent', 'gpg-agent', 'bwrap',
  'xdg-desktop-portal', 'xdg-document-portal', 'xdg-permission-store', 'flatpak-portal',
]);

const sameActivity = (a, b) => (!a || !b ? !a && !b : a.name === b.name && a.started_at === b.started_at);
const sourceOf = (key) => key.slice(0, key.indexOf(':'));

class Games {
  /**
   * @param {object} o
   * @param {string} o.configDir activity.json and accounts.json are here
   * @param {object} o.data compiled games.json (data.js)
   * @param {(activity: { name: string, started_at: number } | null) => void} [o.onActivity]
   *   the push to the main window, on change only
   * @param {(msg: string) => void} [o.debug] names rules and sources, never process data
   * @param {string} [o.procRoot] @param {number|null} [o.uid] @param {number} [o.selfPid]
   * @param {string} [o.home] @param {object} [o.env] @param {object} [o.roots] launcher folders
   * @param {number} [o.intervalMs] @param {() => number} [o.now]
   * @param {object} [o.io] the /proc readers (tests count what is read)
   */
  constructor({
    configDir,
    data,
    onActivity = () => {},
    debug = () => {},
    procRoot = '/proc',
    uid = process.getuid?.() ?? null,
    selfPid = process.pid,
    home = os.homedir(),
    env = process.env,
    roots,
    intervalMs = SCAN_INTERVAL_MS,
    now = Date.now,
    io = proc,
  }) {
    this.configDir = configDir;
    this.data = data;
    this.onActivity = onActivity;
    this.debug = debug;
    this.procRoot = procRoot;
    this.uid = uid;
    this.selfPid = selfPid;
    this.home = home;
    this.intervalMs = intervalMs;
    this.now = now;
    this.io = io;
    this.indexes = new Indexes({ roots: roots || defaultRoots({ home, env }), data, home, now });
    this.tracker = new Tracker();
    this.prefs = prefsStore.emptyActivityPrefs();
    /** The desktop account signed in now (accounts.json `active`). */
    this.active = null;
    /** Whether the scanner is on: sharing is on for the active account. */
    this.scanning = false;
    /** Bumped whenever scanning stops, so a scan in flight then changes nothing. */
    this.gen = 0;
    this.timer = null;
    this.inFlight = null;
    this.again = false;
    this.stopped = false;
    /** `${pid}:${start}:${exe}` -> verdict (null: not a game). The only thing kept between scans. */
    this.verdicts = new Map();
    /** Set when the person's own list changed: the verdicts are then stale. */
    this.verdictsStale = false;
    /** The launcher index's generation the verdicts were made against. Whoever rebuilt the
     * index (this scan or getState's look for names), verdicts from before it are dropped:
     * a game installed since must not stay "not a game" for as long as its process runs. */
    this.verdictsGen = -1;
    this.btime = 0;
    /** What the page was last told, and the same with its key (getState's `current`). */
    this.lastSent = null;
    this.current = null;
    /** Names of games seen running this run, for the Settings list once they have stopped. */
    this.names = new Map();
    /** runningPrograms() ids -> { path, name, expires } */
    this.offers = new Map();
    this.wine = {
      home,
      resolveDrive: (prefix, letter) => {
        const link = path.join(prefix, 'dosdevices', `${letter}:`);
        try {
          return path.resolve(path.dirname(link), fs.readlinkSync(link));
        } catch {
          return null;
        }
      },
    };
  }

  // ---- lifecycle ----------------------------------------------------------------------------

  start() {
    this.prefs = prefsStore.loadActivityPrefs(this.configDir);
    this.active = this.readActive();
    this.apply();
  }

  stop() {
    this.stopped = true;
    this.halt();
  }

  /** Back from sleep: look at once rather than share a game that ended hours ago. */
  resume() {
    if (this.scanning) void this.scanNow();
  }

  /** The account signed in now changed: sharing follows the account. */
  setActiveAccount(id) {
    this.active = prefsStore.validAccount(id) ? id : null;
    this.apply();
  }

  /**
   * The page saved accounts.json (strafe:accounts:save; the shape is web src/desktop/accounts.ts,
   * { version, active, accounts: [{ id, ... }] }). Sharing follows the account signed in, and an
   * account no longer in the list is no longer shared for: kept, it would start sharing again
   * the day the same account was added back. One write, and only when something was dropped.
   */
  accountsSaved(value) {
    const file = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
    const ids = new Set();
    for (const a of Array.isArray(file.accounts) ? file.accounts : []) {
      if (a && typeof a === 'object' && typeof a.id === 'string') ids.add(a.id);
    }
    const keep = this.prefs.shareAccounts.filter((id) => ids.has(id));
    if (keep.length !== this.prefs.shareAccounts.length) {
      try {
        this.save({ ...this.prefs, shareAccounts: keep });
      } catch (e) {
        // The accounts were saved; this must not fail their save. Off in memory at least.
        this.prefs = { ...this.prefs, shareAccounts: keep };
        this.debug(`games: could not update activity.json (${e && e.message})`);
      }
    }
    this.setActiveAccount(file.active ?? null);
  }

  readActive() {
    const file = store.loadAccounts(this.configDir);
    const a = file && typeof file === 'object' ? file.active : null;
    return prefsStore.validAccount(a) ? a : null;
  }

  sharing() {
    return !this.stopped && !!this.active && this.prefs.shareAccounts.includes(this.active);
  }

  /** Start or stop the scanner to match sharing(). */
  apply() {
    const want = this.sharing();
    if (want && !this.scanning) {
      this.scanning = true;
      this.debug('games: sharing on, looking');
      void this.scanNow();
    } else if (!want && this.scanning) {
      this.debug('games: sharing off, not looking');
      this.halt();
      this.publish();
    }
  }

  halt() {
    this.scanning = false;
    this.gen++;
    clearTimeout(this.timer);
    this.timer = null;
    this.tracker.reset();
    this.verdicts.clear();
  }

  schedule(ms) {
    clearTimeout(this.timer);
    this.timer = setTimeout(() => void this.scanNow(), ms);
    // Looking for games is no reason to keep the process alive.
    this.timer.unref?.();
  }

  /** Scan now (coalesced with one in flight); resolves when the result is in. */
  scanNow() {
    if (!this.scanning) return Promise.resolve();
    if (this.inFlight) {
      this.again = true;
      return this.inFlight;
    }
    clearTimeout(this.timer);
    this.timer = null;
    this.inFlight = (async () => {
      try {
        do {
          this.again = false;
          await this.scanOnce();
        } while (this.again && this.scanning);
      } catch (e) {
        this.debug(`games: scan failed (${e && e.message})`);
      } finally {
        this.inFlight = null;
        if (this.scanning) this.schedule(this.intervalMs);
      }
    })();
    return this.inFlight;
  }

  // ---- the scan ------------------------------------------------------------------------------

  ctx() {
    return { os: 'linux', data: this.data, index: this.indexes, user: this.prefs.user, wine: this.wine };
  }

  async verdictFor(pid, exe) {
    const req = needs(exe, 'linux', this.data);
    const cmdline = req.cmdline ? await this.io.readCmdline(this.procRoot, pid) : null;
    const environ = req.environ ? await this.io.readEnviron(this.procRoot, pid) : null;
    if (req.cmdline && !cmdline) return null;
    return classify({ exe, cmdline, environ }, this.ctx());
  }

  async scanOnce() {
    const gen = this.gen;
    await this.indexes.refresh();
    // By generation, not by what this call returned: getState may have been the one to rebuild.
    // A rebuild during this scan leaves verdictsGen behind, so the next scan drops what this one
    // made from a mix of the two.
    if (this.verdictsStale || this.verdictsGen !== this.indexes.generation) {
      this.verdictsStale = false;
      this.verdicts.clear();
      this.verdictsGen = this.indexes.generation;
    }
    if (!this.btime) this.btime = await this.io.readBtime(this.procRoot);
    const list = await this.io.listProcesses({ procRoot: this.procRoot, uid: this.uid });
    if (gen !== this.gen) return;
    const own = ownTree(list, this.selfPid);
    const others = list.filter((p) => !own.has(p.pid));
    // The program is read every time: a wrapper script that execs the game keeps its pid and
    // start time, so those alone do not say the process is still what it was.
    const rows = await proc.pool(others, CONCURRENCY, async (p) => {
      const exe = await this.io.readExe(this.procRoot, p.pid);
      if (!exe) return null;
      const id = `${p.pid}:${p.startTicks}:${exe}`;
      const v = this.verdicts.has(id) ? this.verdicts.get(id) : await this.verdictFor(p.pid, exe);
      return { id, v, p };
    });
    if (gen !== this.gen) return;
    const verdicts = new Map();
    const matches = [];
    for (const r of rows) {
      if (!r) continue;
      verdicts.set(r.id, r.v);
      if (r.v) matches.push({ ...r.v, start_ms: proc.startMs(this.btime, r.p.startTicks) });
    }
    // Only processes still running are remembered.
    this.verdicts = verdicts;
    const before = this.tracker.currentKey;
    this.tracker.update(matches, new Set(this.prefs.hidden));
    for (const s of this.tracker.running()) this.names.set(s.key, s.name);
    if (this.tracker.currentKey !== before) {
      const s = this.tracker.currentKey ? this.tracker.sessions.get(this.tracker.currentKey) : null;
      this.debug(s ? `games: now sharing a ${s.source} game` : 'games: now sharing nothing');
    }
    this.publish();
  }

  /** Tell the page when what it should share changed. */
  publish() {
    const key = this.scanning ? this.tracker.currentKey : null;
    const s = key ? this.tracker.sessions.get(key) : null;
    this.current = s && !this.prefs.hidden.includes(s.key) ? { key: s.key, name: this.prefs.renames[s.key] || s.name, started_at: s.startedAt || 0 } : null;
    const payload = this.current ? { name: this.current.name, started_at: this.current.started_at } : null;
    if (sameActivity(payload, this.lastSent)) return;
    this.lastSent = payload;
    try {
      this.onActivity(payload);
    } catch (e) {
      this.debug(`games: could not tell the page (${e && e.message})`);
    }
  }

  // ---- what the page asks ----------------------------------------------------------------------

  /** The name a game was recognised by, from wherever it is known. */
  detectedName(key, session) {
    if (session) return session.name;
    const src = sourceOf(key);
    const id = key.slice(src.length + 1);
    let name = null;
    if (src === 'user') name = this.prefs.user.find((u) => u.id === id)?.name;
    else if (src === 'curated') name = this.data.curatedById.get(id)?.name;
    else if (src === 'steam') name = this.indexes.steamApp(id)?.name;
    else if (src === 'lutris') name = this.indexes.lutrisName(id);
    else if (src === 'heroic') {
      const at = id.indexOf(':');
      if (at > 0) name = this.indexes.heroicApp(id.slice(0, at), id.slice(at + 1))?.name;
    }
    return name || this.names.get(key) || cleanName(id) || key;
  }

  row(key, session) {
    const detected = this.detectedName(key, session);
    const rename = this.prefs.renames[key];
    return {
      key,
      name: rename || detected,
      detected_name: detected,
      source: sourceOf(key),
      hidden: this.prefs.hidden.includes(key),
      renamed: !!rename,
      running: !!session,
    };
  }

  rows() {
    const running = new Map(this.scanning ? this.tracker.running().map((s) => [s.key, s]) : []);
    const keys = new Set([...this.prefs.user.map((u) => `user:${u.id}`), ...this.prefs.hidden, ...Object.keys(this.prefs.renames), ...running.keys()]);
    const rows = [...keys].map((k) => this.row(k, running.get(k)));
    return rows.sort((a, b) => Number(b.running) - Number(a.running) || a.name.localeCompare(b.name) || (a.key < b.key ? -1 : 1));
  }

  /** { share, account, current, games }. `share` is for `account`, the desktop account signed in
   * as the shell knows it (accounts.json `active`; null when none): a page signed in as another
   * must not take it for its own. Never scans: `current` is what the page was last told (with its
   * key), so a page that loads late starts from it. */
  async getState() {
    // Names for customised launcher games that are not running: from the launcher's files
    // (never the process list), looked at once a minute at most.
    if ([...this.prefs.hidden, ...Object.keys(this.prefs.renames)].some((k) => ['steam', 'heroic', 'lutris'].includes(sourceOf(k)) && !this.names.has(k))) {
      try {
        await this.indexes.refresh();
      } catch {
        // The names fall back below. A rebuild here is seen by the next scan (its generation).
      }
    }
    return { share: this.sharing(), account: this.active, current: this.current ? { ...this.current } : null, games: this.rows() };
  }

  save(next) {
    this.prefs = prefsStore.saveActivityPrefs(this.configDir, next);
  }

  async setShare(on, account) {
    if (typeof on !== 'boolean') throw new Error('Sharing is either on or off.');
    if (!prefsStore.validAccount(account)) throw new Error('Sign in to an account first.');
    const list = new Set(this.prefs.shareAccounts);
    if (on) list.add(account);
    else list.delete(account);
    if (list.size > prefsStore.LIMITS.accounts) throw new Error('Sharing is on for as many accounts as Strafe can keep.');
    this.save({ ...this.prefs, shareAccounts: [...list] });
    // The page names the account signed in now; the shell's own record of that is accounts.json.
    this.active = this.readActive() || this.active;
    this.apply();
    if (this.scanning) await this.scanNow();
  }

  async setHidden(key, hidden) {
    if (!prefsStore.validKey(key)) throw new Error('Strafe does not know that game.');
    if (typeof hidden !== 'boolean') throw new Error('A game is either hidden or not.');
    const set = new Set(this.prefs.hidden);
    if (hidden) set.add(key);
    else set.delete(key);
    if (set.size > prefsStore.LIMITS.hidden) throw new Error(`Strafe can hide at most ${prefsStore.LIMITS.hidden} games.`);
    this.save({ ...this.prefs, hidden: [...set] });
    this.tracker.reselect(new Set(this.prefs.hidden));
    this.publish();
  }

  async rename(key, name) {
    if (!prefsStore.validKey(key)) throw new Error('Strafe does not know that game.');
    const renames = { ...this.prefs.renames };
    if (name === null || name === undefined) {
      delete renames[key];
    } else {
      const n = validName(name);
      if (!n) throw new Error(`A game's name needs 1 to ${NAME_MAX} characters, and something visible.`);
      const session = this.tracker.sessions.get(key);
      // Renaming back to the detected name is no rename.
      if (n === this.detectedName(key, session)) delete renames[key];
      else renames[key] = n;
    }
    if (Object.keys(renames).length > prefsStore.LIMITS.renames) throw new Error(`Strafe can keep at most ${prefsStore.LIMITS.renames} renamed games.`);
    this.save({ ...this.prefs, renames });
    this.publish();
  }

  /** Programs running now, for "Add it": [{ id, name }] - an opaque id (good for five minutes)
   * and the file name. Never a path, command line or environment. Looked up on request only. */
  async runningPrograms() {
    const list = await this.io.listProcesses({ procRoot: this.procRoot, uid: this.uid });
    const own = ownTree(list, this.selfPid);
    const found = new Map();
    await proc.pool(
      list.filter((p) => !own.has(p.pid)),
      CONCURRENCY,
      async (p) => {
        const exe = await this.io.readExe(this.procRoot, p.pid);
        if (!exe) return;
        let file = exe;
        if (this.data.wineLoaders.has(baseName(exe).toLowerCase())) {
          // A Wine program is offered as the Windows program it runs.
          const cmdline = await this.io.readCmdline(this.procRoot, p.pid);
          const environ = await this.io.readEnviron(this.procRoot, p.pid);
          const prog = cmdline ? programOf({ exe, cmdline, environ }, 'linux', this.data, this.wine) : null;
          if (!prog || !prog.path || !prog.path.startsWith('/')) return;
          file = prog.path;
        }
        if (!this.offerable(file) || found.has(file)) return;
        const name = cleanName(baseName(file));
        if (name) found.set(file, name);
      },
    );
    this.pruneOffers();
    const out = [];
    const sorted = [...found].sort((a, b) => a[1].localeCompare(b[1]) || (a[0] < b[0] ? -1 : 1)).slice(0, RUNNING_CAP);
    for (const [file, name] of sorted) {
      const id = crypto.randomBytes(12).toString('base64url');
      this.offers.set(id, { path: file, name, expires: this.now() + OFFER_TTL_MS });
      out.push({ id, name });
    }
    while (this.offers.size > OFFER_CAP) this.offers.delete(this.offers.keys().next().value);
    return out;
  }

  offerable(file) {
    const d = this.data;
    if (d.launchers.test(file) || d.helpers.test(file) || d.interpreters.test(file)) return false;
    if (SYSTEM_DIRS.some((dir) => file.startsWith(dir))) return false;
    return !SYSTEM_NAMES.has(baseName(file).toLowerCase());
  }

  pruneOffers() {
    const now = this.now();
    for (const [id, o] of this.offers) if (o.expires <= now) this.offers.delete(id);
  }

  /** Make a program from runningPrograms() a game with this name. */
  async add(id, name) {
    if (typeof id !== 'string') throw new Error('Pick a program from the list.');
    this.pruneOffers();
    const offer = this.offers.get(id);
    if (!offer) throw new Error('That program is not in the list any more. Open the list again.');
    const n = validName(name);
    if (!n) throw new Error(`A game's name needs 1 to ${NAME_MAX} characters, and something visible.`);
    const user = this.prefs.user.slice();
    const at = user.findIndex((u) => u.path === offer.path);
    let entry;
    if (at >= 0) {
      entry = { ...user[at], name: n };
      user[at] = entry;
    } else {
      if (user.length >= prefsStore.LIMITS.user) throw new Error(`Strafe can keep at most ${prefsStore.LIMITS.user} games you added.`);
      entry = { id: crypto.randomBytes(6).toString('hex'), path: offer.path, name: n };
      user.push(entry);
    }
    this.save({ ...this.prefs, user });
    this.verdictsStale = true;
    if (this.scanning) await this.scanNow();
    const key = `user:${entry.id}`;
    return this.row(key, this.scanning ? this.tracker.sessions.get(key) : undefined);
  }

  /** Forget a game the person added. */
  async remove(key) {
    if (typeof key !== 'string' || !key.startsWith('user:') || !prefsStore.validKey(key)) throw new Error('Only a game you added can be removed.');
    const id = key.slice('user:'.length);
    const renames = { ...this.prefs.renames };
    delete renames[key];
    this.save({ ...this.prefs, user: this.prefs.user.filter((u) => u.id !== id), hidden: this.prefs.hidden.filter((k) => k !== key), renames });
    this.verdictsStale = true;
    this.tracker.forget(key);
    this.tracker.reselect(new Set(this.prefs.hidden));
    this.publish();
    // Its processes may well be another game by the other rules.
    if (this.scanning) await this.scanNow();
  }
}

module.exports = { SCAN_INTERVAL_MS, OFFER_TTL_MS, Games };
