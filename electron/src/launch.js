// How this app is started again: at login (autostart.js) and after an update or a storage
// wipe (relaunch below).

const fs = require('node:fs');
const path = require('node:path');

/** The wrapper script packaging puts next to the Electron binary (it picks the sandbox mode
 * for the system before starting it), when there is one. */
const LAUNCHER = 'strafe-desktop';

/**
 * This app's AppImage file, or null when it is not running from one. An AppImage's runtime
 * sets APPIMAGE and APPDIR, and everything it starts inherits them - so a deb or rpm Strafe
 * opened from the terminal of some other program that is an AppImage sees that program's
 * values. They only count when this binary really runs from inside the mount APPDIR names;
 * trusting the variable alone would update over, relaunch and start at login someone else's
 * AppImage.
 */
function ownAppImage({ env = process.env, execPath = process.execPath, realpath = fs.realpathSync } = {}) {
  if (!env.APPIMAGE || !env.APPDIR) return null;
  try {
    const rel = path.relative(realpath(env.APPDIR), realpath(execPath));
    return rel && !rel.startsWith('..') && !path.isAbsolute(rel) ? env.APPIMAGE : null;
  } catch {
    return null;
  }
}

/**
 * What to run to start Strafe again. An AppImage runs from a temporary mount that vanishes
 * with the process, so the AppImage file itself (APPIMAGE, set by its runtime) is the only
 * path that still works later. deb and rpm installs go through the launcher when there is
 * one, so a restart is started the same way the menu entry starts it.
 */
function launchTarget({ env = process.env, execPath = process.execPath, exists = fs.existsSync, realpath } = {}) {
  const appImage = ownAppImage({ env, execPath, realpath });
  if (appImage) return appImage;
  const launcher = path.join(path.dirname(execPath), LAUNCHER);
  if (launcher !== execPath && exists(launcher)) return launcher;
  return execPath;
}

/**
 * Start a fresh copy once this one has exited (the caller exits right after). `--minimized`
 * is dropped: the person asked for this restart, so the window should come back.
 */
function relaunch() {
  const { app } = require('electron');
  const args = process.argv.slice(1).filter((a) => a !== '--minimized');
  app.relaunch({ execPath: launchTarget(), args });
}

module.exports = { LAUNCHER, ownAppImage, launchTarget, relaunch };
