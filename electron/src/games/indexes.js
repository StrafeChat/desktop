// What the launchers on this device say is installed, and where: Steam's library manifests,
// Heroic's installed lists and Lutris's per-game files (research-detection-sources §2-5, §13).
// Read only from these local files - nothing is fetched - and rebuilt only when one of them
// changes, checked at most once a minute.
//
// Only what recognising a game needs is kept: an app's id, its name and its install folder.
// Account names and the like in the same files are never read out of them.

const fsp = require('node:fs/promises');
const path = require('node:path');
const { appManifest, libraryPaths } = require('./vdf');
const { cleanName } = require('./text');
const { normPath } = require('./data');

/** How often the launcher files are looked at for changes. */
const CHECK_INTERVAL_MS = 60_000;
/** No launcher file comes near this; a bigger one is skipped. */
const FILE_CAP = 8 * 1024 * 1024;
/** Lutris keeps one file per game; past this many something is wrong. */
const LUTRIS_FILES_CAP = 2000;

/** Where the launchers keep their files for this user, on Linux (native, Flatpak, Snap). */
function defaultRoots({ home, env = {} }) {
  const xdg = (name, fallback) => (env[name] && path.isAbsolute(env[name]) ? env[name] : path.join(home, fallback));
  const data = xdg('XDG_DATA_HOME', '.local/share');
  const config = xdg('XDG_CONFIG_HOME', '.config');
  const flatSteam = path.join(home, '.var/app/com.valvesoftware.Steam');
  return {
    steam: [
      path.join(data, 'Steam'),
      path.join(home, '.steam/steam'),
      path.join(home, '.steam/root'),
      path.join(home, '.steam/debian-installation'),
      path.join(flatSteam, '.local/share/Steam'),
      path.join(flatSteam, '.steam/steam'),
      path.join(home, 'snap/steam/common/.local/share/Steam'),
    ],
    heroic: [path.join(config, 'heroic'), path.join(home, '.var/app/com.heroicgameslauncher.hgl/config/heroic')],
    lutris: [path.join(data, 'lutris'), path.join(config, 'lutris'), path.join(home, '.var/app/net.lutris.Lutris/data/lutris')],
  };
}

async function readText(file) {
  try {
    const st = await fsp.stat(file);
    if (!st.isFile() || st.size > FILE_CAP) return null;
    return await fsp.readFile(file, 'utf8');
  } catch {
    return null;
  }
}

async function readJsonFile(file) {
  const text = await readText(file);
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

async function realpathOr(p) {
  try {
    return await fsp.realpath(p);
  } catch {
    return p;
  }
}

async function listDir(dir) {
  try {
    return await fsp.readdir(dir);
  } catch {
    return [];
  }
}

/** [path, mtime, size] of each, or [path] when missing: the signature a rebuild is decided by. */
async function signature(paths) {
  const out = [];
  for (const p of paths) {
    try {
      const st = await fsp.stat(p);
      out.push(`${p}\0${st.mtimeMs}\0${st.size}`);
    } catch {
      out.push(`${p}\0-`);
    }
  }
  return out.join('\n');
}

/** Same comparison everywhere: '/' separators, case-folded (Windows programs under Wine may
 * spell a folder in another case than the disk does). */
const fold = (p) => normPath(p).replace(/\/+$/, '').toLowerCase();

/** The lookups an index is made of, empty. */
function emptyMaps() {
  return {
    /** appid -> { appid, name } */
    steamApps: new Map(),
    /** installdir (lower case) -> verdict, or null when two libraries disagree */
    steamByInstalldir: new Map(),
    /** `${runner}:${app}` -> { name } */
    heroicApps: new Map(),
    /** slug -> name, and folded name -> slug */
    lutrisBySlug: new Map(),
    lutrisByName: new Map(),
    /** folded exact program path -> verdict */
    exact: new Map(),
    /** [{ dir (folded), verdict }], longest first */
    prefixes: [],
  };
}

class Indexes {
  /**
   * @param {object} o
   * @param {{ steam: string[], heroic: string[], lutris: string[] }} o.roots
   * @param {object} o.data compiled games.json (steam tool ids, launcher labels)
   * @param {string} [o.home] a folder this broad is never an install folder
   * @param {() => number} [o.now]
   */
  constructor({ roots, data, home = '', now = Date.now }) {
    this.roots = roots;
    this.data = data;
    this.home = home ? fold(home) : '';
    this.now = now;
    /** Bumped each time a rebuild is swapped in: a verdict made before it may be stale. */
    this.generation = 0;
    this.lastCheck = -Infinity;
    this.sig = null;
    this.watched = [];
    /** The look in flight; whoever asks meanwhile waits on it rather than looking again. */
    this.refreshing = null;
    Object.assign(this, emptyMaps());
  }

  /** The files a rebuild depends on that exist whatever was found last time. */
  rootFiles() {
    const out = [];
    for (const r of this.roots.steam) out.push(path.join(r, 'steamapps', 'libraryfolders.vdf'), path.join(r, 'config', 'libraryfolders.vdf'), path.join(r, 'steamapps'));
    for (const r of this.roots.heroic) {
      out.push(
        path.join(r, 'legendaryConfig', 'legendary', 'installed.json'),
        path.join(r, 'gog_store', 'installed.json'),
        path.join(r, 'store_cache', 'gog_library.json'),
        path.join(r, 'nile_config', 'nile', 'installed.json'),
        path.join(r, 'nile_config', 'nile', 'library.json'),
        path.join(r, 'store_cache', 'nile_library.json'),
        path.join(r, 'sideload_apps', 'library.json'),
      );
    }
    for (const r of this.roots.lutris) out.push(path.join(r, 'games'));
    return out;
  }

  /**
   * Rebuild if a launcher file changed. Looks at most once a minute unless forced. Resolves
   * true when the index changed; `generation` says the same to anyone who did not ask (a
   * caller's per-process verdicts are stale once it moved). One look at a time: a call while
   * one is in flight shares it, and a forced one then looks again after it.
   */
  refresh({ force = false } = {}) {
    if (this.refreshing) {
      if (!force) return this.refreshing;
      return this.refreshing.catch(() => {}).then(() => this.refresh({ force: true }));
    }
    const p = this.look(force).finally(() => {
      if (this.refreshing === p) this.refreshing = null;
    });
    this.refreshing = p;
    return p;
  }

  async look(force) {
    const now = this.now();
    if (!force && now - this.lastCheck < CHECK_INTERVAL_MS) return false;
    this.lastCheck = now;
    const sig = await signature([...this.rootFiles(), ...this.watched]);
    if (!force && sig === this.sig) return false;
    const next = await this.build();
    // The watched set may have grown with what the build found (library folders, game files).
    const after = await signature([...this.rootFiles(), ...next.watched]);
    // Swapped in whole, at once: a lookup meanwhile sees the old index, never half a new one.
    Object.assign(this, next.maps);
    this.watched = next.watched;
    this.sig = after;
    this.generation++;
    return true;
  }

  /** A whole new index, built aside: { maps, watched }. The live one is not touched. */
  async build() {
    const maps = emptyMaps();
    const watched = [];
    await this.buildSteam(maps, watched);
    await this.buildHeroic(maps);
    await this.buildLutris(maps, watched);
    maps.prefixes.sort((a, b) => b.dir.length - a.dir.length);
    return { maps, watched };
  }

  /** Whether a folder is too broad to stand for one game ('/', the home folder, its parents). */
  tooBroad(dir) {
    const segs = dir.split('/').filter(Boolean);
    if (segs.length < 2) return true;
    return !!this.home && (this.home === dir || this.home.startsWith(`${dir}/`));
  }

  async addPrefix(maps, dir, verdict) {
    for (const d of new Set([fold(dir), fold(await realpathOr(dir))])) {
      if (!d.startsWith('/') || this.tooBroad(d)) continue;
      maps.prefixes.push({ dir: d, verdict });
    }
  }

  async addExact(maps, file, verdict) {
    for (const f of new Set([fold(file), fold(await realpathOr(file))])) {
      if (f.startsWith('/') && !maps.exact.has(f)) maps.exact.set(f, verdict);
    }
  }

  isSteamTool(appid, name) {
    if (this.data.steamToolAppids.has(appid)) return true;
    const lower = name.toLowerCase();
    return this.data.steamToolNamePrefixes.some((p) => lower.startsWith(p));
  }

  async buildSteam(maps, watched) {
    const roots = new Set();
    for (const r of this.roots.steam) {
      try {
        if ((await fsp.stat(path.join(r, 'steamapps'))).isDirectory()) roots.add(await realpathOr(r));
      } catch {
        // No Steam there.
      }
    }
    const libraries = new Set();
    for (const root of roots) {
      libraries.add(root);
      const vdf = (await readText(path.join(root, 'steamapps', 'libraryfolders.vdf'))) ?? (await readText(path.join(root, 'config', 'libraryfolders.vdf')));
      // Windows paths in a copied file mean nothing here; libraryPaths keeps them, the stat below drops them.
      for (const lib of vdf ? libraryPaths(vdf) : []) if (path.isAbsolute(lib)) libraries.add(await realpathOr(lib));
    }
    const seenDirs = new Map();
    for (const lib of libraries) {
      const apps = path.join(lib, 'steamapps');
      const files = (await listDir(apps)).filter((f) => /^appmanifest_\d+\.acf$/.test(f));
      if (!files.length) continue;
      watched.push(apps);
      for (const f of files.sort()) {
        const text = await readText(path.join(apps, f));
        const m = text && appManifest(text);
        if (!m) continue;
        const name = cleanName(m.name);
        if (!name || this.isSteamTool(m.appid, name) || m.installdir.includes('/') || m.installdir.includes('\\')) continue;
        const app = { appid: m.appid, name };
        maps.steamApps.set(m.appid, app);
        const verdict = { key: `steam:${m.appid}`, name, source: 'steam', rank: 4 };
        await this.addPrefix(maps, path.join(apps, 'common', m.installdir), verdict);
        const dir = m.installdir.toLowerCase();
        const prev = seenDirs.get(dir);
        if (prev === undefined) seenDirs.set(dir, verdict);
        else if (prev && prev.key !== verdict.key) seenDirs.set(dir, null);
      }
    }
    maps.steamByInstalldir = seenDirs;
  }

  async buildHeroic(maps) {
    const runnerEntry = async (runner, appName, title, dir, exact) => {
      const name = cleanName(title);
      if (typeof appName !== 'string' || !appName || !name) return;
      const key = `${runner}:${appName}`;
      if (maps.heroicApps.has(key)) return;
      maps.heroicApps.set(key, { name });
      const verdict = { key: `heroic:${key}`, name, source: 'heroic', rank: 4 };
      if (typeof dir === 'string' && path.isAbsolute(dir)) await this.addPrefix(maps, dir, verdict);
      if (typeof exact === 'string' && path.isAbsolute(exact)) await this.addExact(maps, exact, verdict);
    };
    const list = (v, key) => (Array.isArray(v) ? v : v && Array.isArray(v[key]) ? v[key] : []);

    for (const root of this.roots.heroic) {
      // Epic, through legendary: { <app_name>: { title, install_path, is_dlc, ... } }
      const legendary = await readJsonFile(path.join(root, 'legendaryConfig', 'legendary', 'installed.json'));
      if (legendary && typeof legendary === 'object' && !Array.isArray(legendary)) {
        for (const [appName, e] of Object.entries(legendary)) {
          if (!e || typeof e !== 'object' || e.is_dlc === true) continue;
          await runnerEntry('legendary', e.app_name || appName, e.title, e.install_path);
        }
      }
      // GOG: installed list, titles from the library cache.
      const gogTitles = new Map();
      for (const g of list(await readJsonFile(path.join(root, 'store_cache', 'gog_library.json')), 'games')) {
        if (g && typeof g.app_name === 'string' && typeof g.title === 'string') gogTitles.set(g.app_name, g.title);
      }
      for (const g of list(await readJsonFile(path.join(root, 'gog_store', 'installed.json')), 'installed')) {
        if (!g || typeof g !== 'object' || g.is_dlc === true) continue;
        const appName = typeof g.appName === 'string' ? g.appName : g.app_name;
        await runnerEntry('gog', appName, gogTitles.get(appName), g.install_path);
      }
      // Amazon, through nile.
      const nileTitles = new Map();
      for (const g of list(await readJsonFile(path.join(root, 'nile_config', 'nile', 'library.json')), 'library')) {
        const title = g?.product?.title ?? g?.title;
        if (g && typeof g.id === 'string' && typeof title === 'string') nileTitles.set(g.id, title);
      }
      for (const g of list(await readJsonFile(path.join(root, 'store_cache', 'nile_library.json')), 'library')) {
        if (g && typeof g.app_name === 'string' && typeof g.title === 'string' && !nileTitles.has(g.app_name)) nileTitles.set(g.app_name, g.title);
      }
      for (const g of list(await readJsonFile(path.join(root, 'nile_config', 'nile', 'installed.json')), 'installed')) {
        if (!g || typeof g !== 'object') continue;
        await runnerEntry('nile', g.id, nileTitles.get(g.id), g.path);
      }
      // Sideloaded: the person's own entries. Their exact program only - its folder could be
      // anything (/usr/bin).
      for (const g of list(await readJsonFile(path.join(root, 'sideload_apps', 'library.json')), 'games')) {
        if (!g || typeof g !== 'object') continue;
        await runnerEntry('sideload', g.app_name, g.title, undefined, g.install?.executable);
      }
    }
  }

  async buildLutris(maps, watched) {
    const labels = this.data.launcherLabels;
    for (const root of this.roots.lutris) {
      const dir = path.join(root, 'games');
      const files = (await listDir(dir)).filter((f) => f.endsWith('.yml')).sort().slice(0, LUTRIS_FILES_CAP);
      for (const f of files) {
        const file = path.join(dir, f);
        watched.push(file);
        const text = await readText(file);
        const g = text && lutrisGame(text);
        if (!g || !g.name) continue;
        const name = cleanName(g.name);
        // A launcher installed as a Lutris "game" (EA App, Battle.net) is a whole Wine prefix,
        // never one game.
        if (!name || labels.has(name.toLowerCase())) continue;
        const slug = g.slug || f.replace(/\.yml$/, '').replace(/-\d+$/, '');
        if (!slug) continue;
        if (!maps.lutrisBySlug.has(slug)) maps.lutrisBySlug.set(slug, name);
        if (!maps.lutrisByName.has(name.toLowerCase())) maps.lutrisByName.set(name.toLowerCase(), slug);
        // Only the exact program: a Lutris game's folder may be a launcher's whole prefix.
        if (g.exe && path.isAbsolute(g.exe)) await this.addExact(maps, g.exe, { key: `lutris:${slug}`, name, source: 'lutris', rank: 4 });
      }
    }
  }

  // ---- lookups ------------------------------------------------------------------------------

  steamApp(appid) {
    return this.steamApps.get(String(appid)) || null;
  }

  heroicApp(runner, app) {
    return this.heroicApps.get(`${runner}:${app}`) || null;
  }

  lutrisSlugForName(name) {
    return this.lutrisByName.get(String(name).toLowerCase()) || null;
  }

  lutrisName(slug) {
    return this.lutrisBySlug.get(slug) || null;
  }

  /** The game a program path belongs to: an exact program, then the longest install folder
   * it is in, then a `/steamapps/common/<installdir>/` piece of the path (a library seen
   * through another mount point, as in Steam's containers). */
  lookupPath(p) {
    if (!p) return null;
    const f = fold(p);
    const exact = this.exact.get(f);
    if (exact) return exact;
    for (const { dir, verdict } of this.prefixes) if (f.startsWith(`${dir}/`)) return verdict;
    const at = f.indexOf('/steamapps/common/');
    if (at >= 0) {
      const rest = f.slice(at + '/steamapps/common/'.length);
      const slash = rest.indexOf('/');
      if (slash > 0) {
        const v = this.steamByInstalldir.get(rest.slice(0, slash));
        if (v) return v;
      }
    }
    return null;
  }
}

/**
 * The few things in a Lutris game file that matter: its name and slug (top level, written by
 * an installer) and the program (the `exe` directly under the top-level `game:`). An installer
 * script copied into the same file has `game: exe:` of its own, deeper down; that one is not
 * the game's. A small reader for this one shape, not a YAML parser.
 */
function lutrisGame(text) {
  const out = { name: '', slug: '', exe: '' };
  let inGame = false;
  let childIndent = -1;
  for (const raw of String(text).split(/\r?\n/)) {
    if (!raw.trim() || raw.trimStart().startsWith('#')) continue;
    const indent = raw.length - raw.trimStart().length;
    const m = /^(\s*)([A-Za-z_][\w-]*):(?:\s+(.*))?$/.exec(raw);
    if (indent === 0) {
      inGame = false;
      childIndent = -1;
      if (!m) continue;
      const [, , key, value = ''] = m;
      if (key === 'game' && !value) inGame = true;
      else if (key === 'name') out.name = yamlScalar(value);
      else if (key === 'game_slug') out.slug = yamlScalar(value);
      continue;
    }
    if (!inGame || !m) continue;
    if (childIndent < 0) childIndent = indent;
    if (indent !== childIndent) continue;
    if (m[2] === 'exe') out.exe = yamlScalar(m[3] || '');
  }
  return out;
}

/** A one-line YAML scalar: quotes removed, a trailing comment dropped. */
function yamlScalar(v) {
  const s = String(v).trim();
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'");
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try {
      return JSON.parse(s);
    } catch {
      return s.slice(1, -1);
    }
  }
  return s.replace(/\s+#.*$/, '');
}

module.exports = { CHECK_INTERVAL_MS, defaultRoots, Indexes, lutrisGame, yamlScalar, fold };
