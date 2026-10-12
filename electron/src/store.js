// The two small files the shell keeps for the client: accounts.json and prefs.json.
//
// They live in the same directory, with the same names and shapes, as the Tauri shell keeps
// them (src-tauri/src/lib.rs), so someone moving from the old Linux app to this one keeps
// their accounts and settings without doing anything.

const fs = require('node:fs');
const path = require('node:path');

const ACCOUNTS_FILE = 'accounts.json';
const PREFS_FILE = 'prefs.json';

/** Start-up and window behaviour from Settings -> Desktop (lib.rs `Prefs`). */
const DEFAULT_PREFS = Object.freeze({
  /** Closing the window hides it to the tray instead of quitting, so a closed window still
   * rings for calls and shows notifications. */
  closeToTray: true,
  /** A login launch (`--minimized`) stays in the tray instead of opening the window. */
  startMinimized: true,
  /** "Playing Strafe" on the person's Discord profile while the window is open. */
  discordPresence: true,
});

/** The parsed file, or null when it is missing or not JSON. */
function readJson(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'));
  } catch {
    return null;
  }
}

/**
 * Write-then-rename so a crash mid-write never leaves a half file, and owner-only because
 * the accounts file holds session tokens. The temporary file is chmod-ed as well as created
 * 0600: one left behind by a crash keeps whatever mode it had.
 */
function writeJsonAtomic(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true, mode: 0o700 });
  const tmp = `${file}.tmp`;
  const text = JSON.stringify(value === undefined ? null : value, null, 2);
  const fd = fs.openSync(tmp, 'w', 0o600);
  try {
    fs.fchmodSync(fd, 0o600);
    fs.writeFileSync(fd, text);
    fs.fsyncSync(fd);
  } finally {
    fs.closeSync(fd);
  }
  fs.renameSync(tmp, file);
}

/** The accounts the client can switch between, as it stored them; null when there are none.
 * The shape is the client's business (web src/desktop/accounts.ts): this side keeps the bytes. */
function loadAccounts(dir) {
  return readJson(path.join(dir, ACCOUNTS_FILE));
}

function saveAccounts(dir, value) {
  writeJsonAtomic(path.join(dir, ACCOUNTS_FILE), value);
}

/**
 * Fill in what is missing, as `#[serde(default)]` does on the Tauri side: an older file
 * without a newer setting gets its default, and fields this version does not know are
 * dropped. A field with the wrong type falls back to its default too, rather than (as serde
 * would) throwing the whole file away.
 */
function normalizePrefs(value) {
  const v = value && typeof value === 'object' ? value : {};
  const out = {};
  for (const [key, def] of Object.entries(DEFAULT_PREFS)) {
    out[key] = typeof v[key] === 'boolean' ? v[key] : def;
  }
  return out;
}

function loadPrefs(dir) {
  return normalizePrefs(readJson(path.join(dir, PREFS_FILE)));
}

/** Writes and returns the normalised prefs. */
function savePrefs(dir, value) {
  const prefs = normalizePrefs(value);
  writeJsonAtomic(path.join(dir, PREFS_FILE), prefs);
  return prefs;
}

module.exports = {
  ACCOUNTS_FILE,
  PREFS_FILE,
  DEFAULT_PREFS,
  readJson,
  writeJsonAtomic,
  loadAccounts,
  saveAccounts,
  normalizePrefs,
  loadPrefs,
  savePrefs,
};
