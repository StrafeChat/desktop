// Start at login: an XDG autostart entry that launches Strafe with `--minimized`, so it
// starts in the tray (if Settings -> Desktop says so) rather than in the person's face.
//
// The file is $XDG_CONFIG_HOME/autostart/Strafe.desktop - the name tauri-plugin-autostart
// gives it for productName "Strafe" - so someone who turned this on in the old Linux app
// still has it on here, and the switch in Settings shows the truth. No Electron here.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { launchTarget, ownAppImage } = require('./launch');

const ENTRY_NAME = 'Strafe.desktop';
const ARGS = ['--minimized'];

/** $XDG_CONFIG_HOME, or ~/.config when it is unset or (which the spec says to ignore) relative. */
function configHome(env = process.env) {
  const v = env.XDG_CONFIG_HOME;
  return v && path.isAbsolute(v) ? v : path.join(os.homedir(), '.config');
}

function entryPath(env = process.env) {
  return path.join(configHome(env), 'autostart', ENTRY_NAME);
}

// Characters that make an Exec argument need quotes (Desktop Entry spec, "The Exec key").
const RESERVED = /[\s"'\\><~|&;$*?#()`]/;

/**
 * One Exec argument, as the Desktop Entry spec wants it. In order: `%` doubled (it starts a
 * field code); quoted if it holds a reserved character, with `"`, `` ` ``, `$` and `\`
 * backslash-escaped inside the quotes; then the string-value escapes on top (`\` doubled,
 * newline/tab/return spelled out), because readers undo those first. So a backslash in a
 * quoted path really is four backslashes in the file.
 */
function quoteExecArg(arg) {
  let s = String(arg).replace(/%/g, '%%');
  if (s === '' || RESERVED.test(s)) s = `"${s.replace(/["`$\\]/g, '\\$&')}"`;
  return s.replace(/\\/g, '\\\\').replace(/\n/g, '\\n').replace(/\t/g, '\\t').replace(/\r/g, '\\r');
}

/** The Exec value for a command line (program first). */
function execLine(argv) {
  return argv.map(quoteExecArg).join(' ');
}

/** The whole entry, in the shape the old shell's autostart plugin wrote it. */
function buildEntry(argv) {
  return [
    '[Desktop Entry]',
    'Type=Application',
    'Version=1.0',
    'Name=Strafe',
    'Comment=Start Strafe in the tray at login',
    `Exec=${execLine(argv)}`,
    'StartupNotify=false',
    'Terminal=false',
    '',
  ].join('\n');
}

/** The value of `key` in the [Desktop Entry] group of an entry's text, or undefined. */
function entryValue(text, key) {
  let inMain = false;
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (line.startsWith('[')) {
      inMain = line === '[Desktop Entry]';
      continue;
    }
    if (!inMain || line.startsWith('#')) continue;
    const eq = line.indexOf('=');
    if (eq > 0 && line.slice(0, eq).trim() === key) return line.slice(eq + 1).trim();
  }
  return undefined;
}

/**
 * What runs at login. `appPath` is for development only (`electron .` needs the app's
 * directory after the binary); a packaged build passes nothing.
 * @param {{ env?: NodeJS.ProcessEnv, execPath?: string, exists?: (p: string) => boolean, appPath?: string }} [opts]
 */
function launchArgv({ env = process.env, execPath = process.execPath, exists, realpath, appPath } = {}) {
  const argv = [launchTarget({ env, execPath, exists, realpath })];
  if (appPath && !ownAppImage({ env, execPath, realpath })) argv.push(appPath);
  return [...argv, ...ARGS];
}

function readEntry(env) {
  try {
    return fs.readFileSync(entryPath(env), 'utf8');
  } catch {
    return null;
  }
}

/** On when the entry exists and the desktop has not been told to skip it: `Hidden=true` is
 * how the spec (and KDE's settings) switch an entry off, `X-GNOME-Autostart-enabled=false`
 * how GNOME's do.
 * @param {{ env?: NodeJS.ProcessEnv }} [opts] */
function isEnabled({ env } = {}) {
  const text = readEntry(env);
  if (text === null) return false;
  if (entryValue(text, 'Hidden') === 'true') return false;
  if (entryValue(text, 'X-GNOME-Autostart-enabled') === 'false') return false;
  return true;
}

function writeEntry(argv, env) {
  const file = entryPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.tmp`;
  fs.writeFileSync(tmp, buildEntry(argv), { mode: 0o644 });
  fs.renameSync(tmp, file);
}

function enable(opts = {}) {
  writeEntry(launchArgv(opts), opts.env);
}

/** @param {{ env?: NodeJS.ProcessEnv }} [opts] */
function disable({ env } = {}) {
  try {
    fs.unlinkSync(entryPath(env));
  } catch (e) {
    if (e.code !== 'ENOENT') throw e;
  }
}

/**
 * At start-up: if the entry is on but points somewhere else (the AppImage was moved, the
 * old shell wrote it for its own binary), point it at this one. Returns whether it rewrote.
 */
function refresh(opts = {}) {
  if (!isEnabled(opts)) return false;
  const argv = launchArgv(opts);
  if (entryValue(readEntry(opts.env), 'Exec') === execLine(argv)) return false;
  writeEntry(argv, opts.env);
  return true;
}

module.exports = {
  ENTRY_NAME,
  configHome,
  entryPath,
  quoteExecArg,
  execLine,
  buildEntry,
  entryValue,
  launchArgv,
  isEnabled,
  enable,
  disable,
  refresh,
};
