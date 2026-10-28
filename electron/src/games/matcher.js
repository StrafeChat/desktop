// Which game, if any, one process is. Pure: it gets the process's program path and (only when
// needs() asked for them) its command line and launcher tags, and the indexes and lists to
// look them up in. The OS is a parameter, so the same rules are tested for Windows and macOS
// here as for Linux; desktop/test/games/cases.json holds the cases both shells must agree on.
//
// The order (spec §2, research-detection-sources §13). Strafe's own processes are skipped by
// the caller first. Then:
//   Steam's reaper (Linux)        `<steam>/ubuntu12_{32,64}/reaper SteamLaunch AppId=<n>` -> steam:<n>;
//                                 never anything else. Any other program called reaper (the
//                                 REAPER audio editor) is an ordinary program.
//   launchers, helpers            never a game
//   1 user-added                  the exact program the person picked -> user:<id>
//   3 launcher tags (Linux Wine)  Steam's SteamAppId/SteamGameId, then Heroic's, then
//                                 Lutris's (not a launcher's label) -> steam:/heroic:/lutris:
//   4 install folders             Steam libraries, Heroic installs, Lutris programs
//   5 curated                     games.json, in its order -> curated:<id>
// A Wine process is the Windows program it runs (wine.js), matched as a Windows program.

const { JAVA, baseName, normPath } = require('./data');
const { pickEnv } = require('./proc');
const { cleanName } = require('./text');
const { winePath } = require('./wine');

const RANK = Object.freeze({ user: 1, reaper: 2, env: 3, index: 4, curated: 5 });

const lower = (s) => String(s).toLowerCase();

/** Steam's reaper: the program called reaper in the Steam client's own runtime folder
 * (`<steam root>/ubuntu12_32/` or `ubuntu12_64/`, native, Flatpak and Snap alike), never one
 * that is merely called reaper. Exact case, as Steam writes it and Linux compares it. */
const STEAM_REAPER = /\/ubuntu12_(?:32|64)\/reaper$/;

function isSteamReaper(exe, os) {
  return os === 'linux' && typeof exe === 'string' && STEAM_REAPER.test(exe);
}

/** What has to be read about a process before it can be classified: the command line only for
 * Java, Wine and Steam's reaper, the environment only for Wine (critique #16). */
function needs(exe, os, data) {
  const base = lower(baseName(exe || ''));
  const wine = os === 'linux' && data.wineLoaders.has(base);
  return { cmdline: JAVA.has(base) || wine || isSteamReaper(exe, os), environ: wine };
}

/** The Steam app a reaper command line launches, or null. */
function steamLaunchAppId(argv) {
  if (!Array.isArray(argv) || !argv.includes('SteamLaunch')) return null;
  for (const a of argv) {
    if (a === '--') break;
    const m = /^AppId=(\d+)$/.exec(a);
    if (m) return m[1];
  }
  return null;
}

/** A Steam app id from a launcher tag: all digits and not 0 (Heroic sets 0 and `heroic-<id>`). */
const steamId = (v) => (typeof v === 'string' && /^[1-9]\d{0,11}$/.test(v) ? v : null);

/** Lutris's slug for a name it did not index: lower case, runs of anything else as one '-'. */
function slugify(name) {
  const ascii = String(name)
    // Symbols first (TM, (R), (C), emoji): NFKD would spell some of them out as letters.
    .replace(/\p{So}/gu, '')
    .normalize('NFKD')
    .replace(/\p{M}/gu, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '');
  return (ascii || String(name).toLowerCase().replace(/\s+/g, '-')).slice(0, 128);
}

/**
 * The program a process runs, as the rules see it: { wine, path, base } where path is the
 * full path ('' when not known) and base the lower-case file name.
 * @param {{ exe: string, cmdline?: string[] | null, environ?: object | null }} proc
 */
function programOf(proc, os, data, opts = {}) {
  const exe = proc.exe || '';
  const base = lower(baseName(exe));
  if (os === 'linux' && data.wineLoaders.has(base)) {
    const argv0 = Array.isArray(proc.cmdline) ? proc.cmdline[0] : '';
    if (!argv0) return null;
    const translated = winePath(argv0, proc.environ || {}, opts);
    return { wine: true, path: translated || normPath(argv0), base: lower(baseName(argv0)) };
  }
  return { wine: false, path: exe, base };
}

/** Whether two program paths are the same file: exact on Linux (and for Wine's translated
 * paths there), case-insensitive with either separator on Windows and macOS. */
function samePath(a, b, os) {
  if (!a || !b) return false;
  if (os === 'linux') return normPath(a) === normPath(b);
  return lower(normPath(a)) === lower(normPath(b));
}

function curatedMatch(data, os, prog, cmdline) {
  const lowerPath = lower(normPath(prog.path || ''));
  for (const entry of data.curated) {
    for (const rule of entry.match) {
      if (rule.os !== os || rule.exe !== prog.base) continue;
      if (rule.pathContains && !lowerPath.includes(rule.pathContains)) continue;
      if (rule.cmdlineAny && !(Array.isArray(cmdline) && cmdline.some((a) => rule.cmdlineAny.some((s) => a.includes(s))))) continue;
      return { key: `curated:${entry.id}`, name: entry.name, source: 'curated', rank: RANK.curated };
    }
  }
  return null;
}

/**
 * The game one process belongs to - { key, name, source, rank, reaper? } - or null.
 * @param {{ exe: string, cmdline?: string[] | null, environ?: object | null }} proc
 * @param {object} ctx
 * @param {'linux'|'win32'|'darwin'} ctx.os
 * @param {object} ctx.data compiled games.json
 * @param {object} ctx.index an Indexes (or anything with its lookups)
 * @param {Array<{ id: string, path: string, name: string }>} [ctx.user]
 * @param {object} [ctx.wine] winePath options (home, resolveDrive)
 */
function classify(proc, ctx) {
  const { os, data, index } = ctx;
  if (!proc || !proc.exe) return null;

  // Steam's reaper is the launcher, but its command line says exactly which game it runs,
  // for exactly as long as the game runs.
  if (isSteamReaper(proc.exe, os)) {
    const appid = steamLaunchAppId(proc.cmdline);
    const app = appid ? index.steamApp(appid) : null;
    return app ? { key: `steam:${app.appid}`, name: app.name, source: 'steam', rank: RANK.reaper, reaper: true } : null;
  }

  const prog = programOf(proc, os, data, ctx.wine);
  if (!prog || !prog.base) return null;
  if (data.launchers.test(prog.path || prog.base) || data.helpers.test(prog.path || prog.base)) return null;

  // 1: what the person added, by its exact program.
  for (const u of ctx.user || []) {
    if (samePath(u.path, prog.path, os)) return { key: `user:${u.id}`, name: u.name, source: 'user', rank: RANK.user };
  }

  // 3: the launcher's own tags, which every Wine process of a game inherits. Steam's first: it
  // sets them afresh for each launch, while a Steam client started from Lutris or Heroic passes
  // their tags on to every game it runs after (Heroic's own Proton runs set SteamAppId to 0).
  if (prog.wine) {
    const env = pickEnv(proc.environ);
    for (const v of [env.SteamAppId, env.SteamGameId]) {
      const id = steamId(v);
      const s = id ? index.steamApp(id) : null;
      if (s) return { key: `steam:${s.appid}`, name: s.name, source: 'steam', rank: RANK.env };
    }
    const runner = env.HEROIC_APP_RUNNER;
    const app = env.HEROIC_APP_NAME;
    if (runner && app) {
      const h = index.heroicApp(runner, app);
      if (h) return { key: `heroic:${runner}:${app}`, name: h.name, source: 'heroic', rank: RANK.env };
    }
    if (env.LUTRIS_GAME_UUID && env.GAME_NAME) {
      const name = cleanName(env.GAME_NAME);
      if (name && !data.launcherLabels.has(name.toLowerCase())) {
        const slug = index.lutrisSlugForName(name) || slugify(name);
        return { key: `lutris:${slug}`, name: index.lutrisName(slug) || name, source: 'lutris', rank: RANK.env };
      }
    }
  }

  // 4: the folder a launcher installed it in.
  const hit = prog.path ? index.lookupPath(prog.path) : null;
  if (hit) return { ...hit, rank: RANK.index };

  // 5: games.json. A Wine process is a Windows program.
  return curatedMatch(data, prog.wine ? 'win32' : os, prog, proc.cmdline);
}

/** Strafe's own pids: `selfPid` and everything under it (Chromium's helpers). */
function ownTree(processes, selfPid) {
  const own = new Set();
  if (!selfPid) return own;
  own.add(selfPid);
  const children = new Map();
  for (const p of processes) {
    if (!children.has(p.ppid)) children.set(p.ppid, []);
    children.get(p.ppid).push(p.pid);
  }
  const stack = [selfPid];
  while (stack.length) {
    for (const c of children.get(stack.pop()) || []) {
      if (own.has(c)) continue;
      own.add(c);
      stack.push(c);
    }
  }
  return own;
}

/**
 * Every matched process of a snapshot (as cases.json writes one: { pid, ppid, start_ms, exe,
 * cmdline, environ }), each with its verdict and start. The command line and environment are
 * passed on only where needs() would have read them, so a snapshot cannot test more than the
 * scanner sees.
 */
function matchSnapshot(processes, ctx, selfPid) {
  const own = ownTree(processes, selfPid);
  const out = [];
  for (const p of processes) {
    if (own.has(p.pid)) continue;
    const req = needs(p.exe, ctx.os, ctx.data);
    const v = classify({ exe: p.exe, cmdline: req.cmdline ? p.cmdline || null : null, environ: req.environ ? pickEnv(p.environ) : null }, ctx);
    if (v) out.push({ ...v, pid: p.pid, start_ms: p.start_ms || 0 });
  }
  return out;
}

module.exports = { RANK, isSteamReaper, needs, steamLaunchAppId, slugify, programOf, samePath, classify, ownTree, matchSnapshot };
