// The development-only switches, and where the app's own files are.

const fs = require('node:fs');
const path = require('node:path');
const { app } = require('electron');
const { ORIGIN, isAppUrl: isAppUrlFor } = require('./origin');

/**
 * Development knobs, read once. A packaged build ignores every one of them, so nothing in a
 * user's environment can point the app at another page, open a debugging port or swap the
 * update feed.
 *
 *   STRAFE_URL             load this instead of the bundled client (the Vite dev server)
 *   STRAFE_PROFILE         keep accounts, prefs and Chromium's data here instead
 *   STRAFE_DEBUG_PORT      open the Chrome DevTools Protocol on 127.0.0.1:<port>
 *   STRAFE_SHARE_SOURCE    share this screen-share source unprompted on X11 ("self" = the
 *                          app's own window, for tests that must not capture a real screen)
 *   STRAFE_UPDATE_FEED     read this latest.json instead of the release's
 *   STRAFE_UPDATE_PUBKEY   verify updates with this (test) key instead of the release key
 *   STRAFE_DISCORD_APP_ID  another Discord application; empty turns presence off
 */
const dev = app.isPackaged
  ? {}
  : {
      url: process.env.STRAFE_URL || '',
      profile: process.env.STRAFE_PROFILE || '',
      debugPort: process.env.STRAFE_DEBUG_PORT || '',
      shareSource: process.env.STRAFE_SHARE_SOURCE || '',
      updateFeed: process.env.STRAFE_UPDATE_FEED || '',
      discordAppId: process.env.STRAFE_DISCORD_APP_ID,
    };

let devOrigin = '';
if (dev.url) {
  try {
    devOrigin = new URL(dev.url).origin;
  } catch {
    console.error(`STRAFE_URL is not a URL, ignoring it: ${dev.url}`);
    dev.url = '';
  }
}

/** The origin the app's pages are on. */
function appOrigin() {
  return devOrigin || ORIGIN;
}

/** A path in the app (`/oauth2/authorize?...`) as a URL to load. */
function appUrl(p = '/') {
  return devOrigin ? new URL(p, dev.url).toString() : `${ORIGIN}${p}`;
}

/** Whether a URL (or origin) is one of the app's own pages. */
function isAppUrl(url) {
  return isAppUrlFor(url, devOrigin);
}

/** The icons: shipped beside the app in a package, the Tauri shell's set in dev. */
function iconsDir() {
  return app.isPackaged ? path.join(process.resourcesPath, 'icons') : path.resolve(__dirname, '..', '..', 'src-tauri', 'icons');
}

/** The first of these icon files that exists, or undefined (Electron then uses its own). */
function iconPath(names) {
  const dir = iconsDir();
  for (const name of names) {
    const p = path.join(dir, name);
    if (fs.existsSync(p)) return p;
  }
  return undefined;
}

/** Window and notification icon: big enough for any launcher or panel to scale down. */
const appIconPath = () => iconPath(['256x256.png', 'icon.png', '128x128.png', '32x32.png']);

module.exports = { dev, appOrigin, appUrl, isAppUrl, iconsDir, iconPath, appIconPath };
