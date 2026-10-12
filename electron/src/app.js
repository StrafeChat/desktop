// The Strafe Linux shell: the web client on Chromium.
//
// The Tauri shell renders the client with WebKitGTK on Linux, and WebKitGTK has no WebRTC
// engine fit for calls (docs/linux-voice.md). This shell runs the same client on Chromium -
// the engine Windows already gets through WebView2 - so calls run on libwebrtc with insertable
// streams for the end-to-end encryption. Windows and macOS stay on Tauri; everything here
// copies what src-tauri does, file for file where a file is involved, so moving from the old
// Linux app to this one keeps accounts, settings and start-at-login.
//
// The order below matters: paths and switches must be set before the single-instance lock
// (which lives in the profile directory) and before ready.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { app, Menu, protocol, session } = require('electron');
const env = require('./env');
const { SCHEME } = require('./origin');
const store = require('./store');
const autostart = require('./autostart');
const windows = require('./window');
const { registerAppProtocol } = require('./protocol');
const { setUpMedia } = require('./media');
const { createTray } = require('./tray');
const { registerIpc } = require('./ipc');
const { Discord, DISCORD_APP_ID } = require('./discord');

/** The Tauri app's identifier, and so the name of the directories it keeps its files in. */
const IDENTIFIER = 'chat.strafe.desktop';

/** An XDG base directory, or its default when unset or (which the spec says to ignore)
 * relative. */
function xdgDir(name, fallback) {
  const v = process.env[name];
  return v && path.isAbsolute(v) ? v : path.join(os.homedir(), fallback);
}

// ---- development only -------------------------------------------------------------------

if (!app.isPackaged) {
  // `electron .` reports this directory's package.json version; what Settings should show is
  // the desktop app's, which both shells share. (app.setVersion is missing from Electron's
  // typings but is what its own default app calls, hence the guard rather than a crash.)
  try {
    const { version } = JSON.parse(fs.readFileSync(path.resolve(__dirname, '..', '..', 'package.json'), 'utf8'));
    // @ts-ignore - see above
    if (typeof version === 'string' && version && typeof app.setVersion === 'function') app.setVersion(version);
  } catch {
    // Run from somewhere else: keep Electron's answer.
  }
  if (/^\d+$/.test(env.dev.debugPort)) {
    app.commandLine.appendSwitch('remote-debugging-port', env.dev.debugPort);
    app.commandLine.appendSwitch('remote-debugging-address', '127.0.0.1');
  }
}

// ---- paths --------------------------------------------------------------------------------

// accounts.json and prefs.json in the same directory the Tauri shell keeps them in, so they
// carry over. Chromium's own data (IndexedDB, caches, local storage) goes in a subdirectory
// of the data directory, beside the old shell's WebKit data, which it could not read anyway.
{
  const profile = env.dev.profile ? path.resolve(env.dev.profile) : '';
  const userData = profile || path.join(xdgDir('XDG_CONFIG_HOME', '.config'), IDENTIFIER);
  const sessionData = profile ? path.join(profile, 'chromium') : path.join(xdgDir('XDG_DATA_HOME', '.local/share'), IDENTIFIER, 'chromium');
  app.setPath('userData', userData);
  app.setPath('sessionData', sessionData);
  // Crash dumps stay on this machine (nothing uploads them); keep them out of the config dir.
  app.setPath('crashDumps', path.join(sessionData, 'Crashpad'));
}

// ---- switches -----------------------------------------------------------------------------

// Screen capture through xdg-desktop-portal + PipeWire: the only way on Wayland.
app.commandLine.appendSwitch('enable-features', 'WebRTCPipeWireCapturer');
// Every renderer sandboxed, whatever a window's own options say.
app.enableSandbox();

// ---- one instance ---------------------------------------------------------------------------

// A second launch (the menu entry clicked while Strafe sits in the tray, or a login launch
// racing a manual one) raises the running window instead of starting a second app with its
// own gateway session.
if (!app.requestSingleInstanceLock()) {
  app.quit();
} else {
  app.on('second-instance', () => windows.showMain());

  // tauri://localhost behaves like an https origin to the page: fetch, CORS, secure context
  // (getUserMedia needs one), streamed media.
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, codeCache: true },
    },
  ]);

  let ctx = null;

  app.whenReady().then(() => {
    // No menu bar, and none of the default menu's shortcuts (reload, devtools, zoom): the
    // client draws its own title bar.
    Menu.setApplicationMenu(null);
    const ses = session.defaultSession;
    // Chromium's spell checker would fetch dictionaries from Google; off for the whole session.
    ses.setSpellCheckerEnabled(false);
    registerAppProtocol();
    setUpMedia(ses);

    const configDir = app.getPath('userData');
    ctx = { configDir, prefs: store.loadPrefs(configDir), discord: null };
    // STRAFE_DISCORD_APP_ID (development only) swaps the application; empty turns it off.
    const appId = env.dev.discordAppId !== undefined ? env.dev.discordAppId.trim() : DISCORD_APP_ID;
    ctx.discord = new Discord({
      appId,
      enabled: ctx.prefs.discordPresence,
      debug: app.isPackaged ? () => {} : (msg) => console.error(msg),
    });

    // Before the window loads: its preload asks for strafe:info synchronously.
    registerIpc(ctx);
    windows.createMainWindow(ctx);
    createTray({ showMain: windows.showMain });

    // A login entry written for another copy (the AppImage moved, the old shell's binary) is
    // pointed at this one. Not from a development run: that would aim the installed app's
    // login entry at node_modules.
    if (app.isPackaged) {
      try {
        autostart.refresh();
      } catch (e) {
        console.error(`could not update the start-at-login entry: ${e.message}`);
      }
    }
  });

  // From here on, closing a window means it.
  app.on('before-quit', () => windows.setQuitting());
  // Leave Discord showing nothing rather than a Strafe that has gone.
  app.on('will-quit', () => ctx?.discord?.stop());
  app.on('window-all-closed', () => app.quit());
}
