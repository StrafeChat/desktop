// games.json: the one list both shells recognise games by (the Tauri shell builds it in with
// include_str!). It lives at the repository root; a package carries it as a resource
// (electron-builder.yml extraResources). See the file's own "about" for what each list means.

const fs = require('node:fs');
const path = require('node:path');
const { cleanName } = require('./text');

const OSES = new Set(['win32', 'darwin', 'linux']);
/** The only processes whose command line is ever read for a curated rule (privacy: a command
 * line can carry tokens, and only a Java game needs one to be told apart). */
const JAVA = new Set(['java', 'javaw', 'java.exe', 'javaw.exe']);

/** Where games.json is: beside the app in a package, at the repository root in development. */
function gamesFile({ packaged, resourcesPath }) {
  return packaged ? path.join(resourcesPath, 'games.json') : path.resolve(__dirname, '..', '..', '..', 'games.json');
}

/** Forward slashes, whatever the OS wrote. */
function normPath(p) {
  return String(p).replace(/\\/g, '/');
}

/** The file name of a path in either separator. */
function baseName(p) {
  const n = normPath(p);
  const i = n.lastIndexOf('/');
  return i < 0 ? n : n.slice(i + 1);
}

const escapeRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');

/**
 * A list of patterns (launchers, helpers, interpreters), compared case-insensitively: without
 * '/', an executable's file name where '*' is any run of characters; with '/', a piece of the
 * path ('\' read as '/').
 */
function compilePatterns(list) {
  const names = new Set();
  const globs = [];
  const segments = [];
  for (const raw of Array.isArray(list) ? list : []) {
    if (typeof raw !== 'string' || !raw) continue;
    const p = normPath(raw).toLowerCase();
    if (p.includes('/')) segments.push(p);
    else if (p.includes('*')) globs.push(new RegExp(`^${p.split('*').map(escapeRe).join('.*')}$`));
    else names.add(p);
  }
  return {
    /** Whether a program at this path matches. */
    test(p) {
      if (!p) return false;
      const lower = normPath(p).toLowerCase();
      const base = baseName(lower);
      return names.has(base) || globs.some((r) => r.test(base)) || segments.some((s) => lower.includes(s));
    },
  };
}

/** A curated rule list, checked: an unknown OS or an empty exe drops the rule, and a command-line
 * test on anything but Java drops it too, so no other process's command line is ever read. */
function compileCurated(list) {
  const out = [];
  const ids = new Set();
  for (const entry of Array.isArray(list) ? list : []) {
    if (!entry || typeof entry !== 'object') continue;
    const id = typeof entry.id === 'string' ? entry.id : '';
    const name = cleanName(entry.name);
    if (!/^[a-z0-9][a-z0-9-]{0,63}$/.test(id) || !name || ids.has(id)) continue;
    const match = [];
    for (const r of Array.isArray(entry.match) ? entry.match : []) {
      if (!r || typeof r !== 'object' || !OSES.has(r.os) || typeof r.exe !== 'string' || !r.exe) continue;
      const exe = r.exe.toLowerCase();
      const rule = { os: r.os, exe, pathContains: null, cmdlineAny: null };
      if (typeof r.pathContains === 'string' && r.pathContains) rule.pathContains = normPath(r.pathContains).toLowerCase();
      if (r.cmdlineAny !== undefined) {
        const any = Array.isArray(r.cmdlineAny) ? r.cmdlineAny.filter((s) => typeof s === 'string' && s) : [];
        if (!JAVA.has(exe) || !any.length) continue;
        rule.cmdlineAny = any;
      }
      match.push(rule);
    }
    if (!match.length) continue;
    ids.add(id);
    out.push({ id, name, match });
  }
  return out;
}

/** games.json as the matcher uses it. */
function compileGames(raw) {
  const v = raw && typeof raw === 'object' ? raw : {};
  const lowerSet = (list) => new Set((Array.isArray(list) ? list : []).filter((s) => typeof s === 'string' && s).map((s) => s.toLowerCase()));
  const curated = compileCurated(v.curated);
  return {
    version: v.version,
    launchers: compilePatterns(v.launchers),
    helpers: compilePatterns(v.helpers),
    interpreters: compilePatterns(v.interpreters),
    wineLoaders: lowerSet(v.wineLoaders),
    launcherLabels: lowerSet(v.launcherLabels),
    steamToolAppids: new Set((Array.isArray(v.steamToolAppids) ? v.steamToolAppids : []).map(String)),
    steamToolNamePrefixes: (Array.isArray(v.steamToolNamePrefixes) ? v.steamToolNamePrefixes : [])
      .filter((s) => typeof s === 'string' && s)
      .map((s) => s.toLowerCase()),
    curated,
    curatedById: new Map(curated.map((c) => [c.id, c])),
  };
}

function loadGames(file) {
  return compileGames(JSON.parse(fs.readFileSync(file, 'utf8')));
}

module.exports = { JAVA, gamesFile, normPath, baseName, compilePatterns, compileCurated, compileGames, loadGames };
