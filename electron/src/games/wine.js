// What a Wine (or Proton) process is running. Its /proc/<pid>/exe is always Wine's preloader,
// never the game; the Windows program it runs is its first argument, as a Unix path or a DOS
// one (research-detection-sources §2.6):
//
//   Z:\home\me\Games\Foo\Foo.exe   ->  /home/me/Games/Foo/Foo.exe       (Z: is /)
//   C:\Games\Foo\Foo.exe           ->  <prefix>/drive_c/Games/Foo/Foo.exe
//   D:\Foo.exe                     ->  wherever <prefix>/dosdevices/d: points
//
// where <prefix> is $WINEPREFIX, else Proton's $STEAM_COMPAT_DATA_PATH/pfx, else ~/.wine.

const path = require('node:path');

/**
 * The Unix path of a Wine program from its argv[0], or null when it cannot be told (a bare
 * file name, an unknown prefix, a drive that is not mapped). The caller still has the file
 * name to match curated rules by.
 * @param {string} argv0
 * @param {{ WINEPREFIX?: string, STEAM_COMPAT_DATA_PATH?: string }} [env]
 * @param {{ home?: string, resolveDrive?: (prefix: string, letter: string) => string | null }} [opts]
 */
function winePath(argv0, env = {}, opts = {}) {
  if (typeof argv0 !== 'string' || !argv0) return null;
  let p = argv0.trim();
  // \\?\C:\... and \??\C:\... are the same path.
  p = p.replace(/^(\\\\\?\\|\\\?\?\\)/, '');
  const unix = p.replace(/\\/g, '/');
  if (unix.startsWith('/')) return path.posix.normalize(unix);
  const m = /^([A-Za-z]):\/(.*)$/.exec(unix);
  if (!m) return null;
  const letter = m[1].toLowerCase();
  const rest = m[2];
  if (letter === 'z') return path.posix.normalize(`/${rest}`);
  const prefix = winePrefix(env, opts.home);
  if (!prefix) return null;
  if (letter === 'c') return path.posix.normalize(`${prefix}/drive_c/${rest}`);
  const target = typeof opts.resolveDrive === 'function' ? opts.resolveDrive(prefix, letter) : null;
  if (!target || !target.startsWith('/')) return null;
  return path.posix.normalize(`${target}/${rest}`);
}

/** The Wine prefix a process runs in, from its environment. */
function winePrefix(env = {}, home) {
  const abs = (v) => (typeof v === 'string' && v.startsWith('/') ? v.replace(/\/+$/, '') : '');
  return abs(env.WINEPREFIX) || (abs(env.STEAM_COMPAT_DATA_PATH) && `${abs(env.STEAM_COMPAT_DATA_PATH)}/pfx`) || (abs(home) && `${abs(home)}/.wine`) || '';
}

module.exports = { winePath, winePrefix };
