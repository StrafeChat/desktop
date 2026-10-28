// activity.json: what the person chose about game sharing on this device, in the shell's
// config directory beside prefs.json (critique #4, #17).
//
//   { version: 1,
//     shareAccounts: [<desktop account id>, ...],   sharing is on for these accounts only
//     hidden: [<key>, ...],                          never shared
//     renames: { <key>: <name> },                    shared under this name
//     user: [{ id, path, name }] }                   programs the person added as games
//
// Its own file, never part of prefs.json: the page saves prefs.json whole from Settings ->
// Desktop, and would otherwise wipe a hide list it never loaded. Only src/games reads and
// writes it: the games handlers, and an accounts save, which drops from shareAccounts every
// account no longer in accounts.json. Owner-only, written whole (store.writeJsonAtomic).

const path = require('node:path');
const { readJson, writeJsonAtomic } = require('../store');
const { validName } = require('./text');

const ACTIVITY_FILE = 'activity.json';

/** How much the file keeps; past these, Settings refuses more. */
const LIMITS = Object.freeze({ accounts: 50, hidden: 500, renames: 500, user: 100 });

/** A game's key: `<source>:<id>`, never a path (critique #7, #12). */
const KEY_RE = /^(user|steam|epic|heroic|lutris|curated):[^\p{Cc}]{1,256}$/u;
const USER_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;
/** `${domain}:${userId}`, as the client's accounts.ts names a desktop account. */
const ACCOUNT_RE = /^[^\p{Cc}\s]{1,300}$/u;

const validKey = (k) => typeof k === 'string' && KEY_RE.test(k);
const validAccount = (a) => typeof a === 'string' && ACCOUNT_RE.test(a);

function emptyActivityPrefs() {
  return { version: 1, shareAccounts: [], hidden: [], renames: {}, user: [] };
}

/** The file as this version keeps it: anything malformed is dropped, not trusted. */
function normalizeActivityPrefs(value) {
  const v = value && typeof value === 'object' && !Array.isArray(value) ? value : {};
  const out = emptyActivityPrefs();
  const uniq = (list, ok, cap) => [...new Set((Array.isArray(list) ? list : []).filter(ok))].slice(0, cap);
  out.shareAccounts = uniq(v.shareAccounts, validAccount, LIMITS.accounts);
  out.hidden = uniq(v.hidden, validKey, LIMITS.hidden);
  if (v.renames && typeof v.renames === 'object' && !Array.isArray(v.renames)) {
    for (const [k, name] of Object.entries(v.renames)) {
      if (Object.keys(out.renames).length >= LIMITS.renames) break;
      const n = validName(name);
      if (validKey(k) && n) out.renames[k] = n;
    }
  }
  const ids = new Set();
  const paths = new Set();
  for (const u of Array.isArray(v.user) ? v.user : []) {
    if (out.user.length >= LIMITS.user) break;
    if (!u || typeof u !== 'object') continue;
    const name = validName(u.name);
    if (typeof u.id !== 'string' || !USER_ID_RE.test(u.id) || ids.has(u.id)) continue;
    if (typeof u.path !== 'string' || !path.isAbsolute(u.path) || u.path.length > 4096 || paths.has(u.path) || !name) continue;
    ids.add(u.id);
    paths.add(u.path);
    out.user.push({ id: u.id, path: u.path, name });
  }
  return out;
}

function loadActivityPrefs(dir) {
  return normalizeActivityPrefs(readJson(path.join(dir, ACTIVITY_FILE)));
}

/** Writes and returns the normalised prefs. */
function saveActivityPrefs(dir, value) {
  const prefs = normalizeActivityPrefs(value);
  writeJsonAtomic(path.join(dir, ACTIVITY_FILE), prefs);
  return prefs;
}

module.exports = {
  ACTIVITY_FILE,
  LIMITS,
  validKey,
  validAccount,
  emptyActivityPrefs,
  normalizeActivityPrefs,
  loadActivityPrefs,
  saveActivityPrefs,
};
