// The main-process side of window.strafeDesktop (preload.js; the contract is
// web.strafe.chat/src/desktop/electronBridge.ts).
//
// Every handler first checks that the message came from one of the app's own pages. The
// preload only runs in the app's windows, and those never navigate away - this is the second
// lock on the same door, so a page that somehow got in still cannot read the accounts file.
//
// invoke() handlers answer { value } or { error: message }, and the preload turns the
// latter back into a rejection: an exception thrown here would reach the client wrapped as
// "Error invoking remote method ...", and the client shows these messages to people.

const { app, BrowserWindow, Notification, ipcMain, session, shell } = require('electron');
const env = require('./env');
const { isExternalUrl } = require('./origin');
const store = require('./store');
const autostart = require('./autostart');
const media = require('./media');
const updater = require('./updater');
const windows = require('./window');
const { relaunch } = require('./launch');

const PLATFORMS = { linux: 'linux', win32: 'windows', darwin: 'mac' };

function fromApp(event) {
  const frame = event.senderFrame;
  return !!frame && env.isAppUrl(frame.url);
}

function message(e) {
  return e && e.message ? e.message : String(e);
}

/** A fire-and-forget message (ipcRenderer.send). */
function on(channel, fn) {
  ipcMain.on(channel, (event, ...args) => {
    if (!fromApp(event)) return;
    try {
      fn(event, ...args);
    } catch (e) {
      console.error(`${channel}: ${message(e)}`);
    }
  });
}

/** A request with an answer (ipcRenderer.invoke). */
function handle(channel, fn) {
  ipcMain.handle(channel, async (event, ...args) => {
    if (!fromApp(event)) return { error: 'Refused: not an app page.' };
    try {
      return { value: await fn(event, ...args) };
    } catch (e) {
      return { error: message(e) };
    }
  });
}

/** The window the message came from: window.* acts on the caller's own window. */
const senderWindow = (event) => BrowserWindow.fromWebContents(event.sender);

/** Popups (the OAuth consent page) run the same client start-up as the main window, badge
 * and Discord presence included; only the main window's view of those counts, or opening a
 * popup mid-call would wipe "in a voice call" from Discord. */
const fromMainWindow = (event) => senderWindow(event) === windows.mainWindow();

/** Windows flashing for attention until they are focused (one focus listener each, however
 * many mentions arrive meanwhile). */
const flashing = new WeakSet();

/** Keep shown notifications referenced until they are done with: one collected early would
 * never deliver its click. */
const notifications = new Set();

/** Notification servers on Linux read the body as markup (`<b>`, `<a href>`, `<img>`), and
 * the body is what someone else wrote. Escaped, it shows as the text it is. */
const escapeMarkup = (s) => s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

function notify(title, body) {
  if (!Notification.isSupported()) return;
  const text = body == null ? '' : String(body).slice(0, 1024);
  const n = new Notification({
    title: String(title ?? '').slice(0, 256),
    body: process.platform === 'linux' ? escapeMarkup(text) : text,
    icon: env.iconPath(['128x128.png', '256x256.png', 'icon.png', '32x32.png']),
  });
  const done = () => notifications.delete(n);
  n.on('click', () => {
    done();
    windows.showMain();
  });
  n.on('close', done);
  n.on('failed', done);
  notifications.add(n);
  // A desktop that never reports a close must not grow this forever.
  if (notifications.size > 50) notifications.delete(notifications.values().next().value);
  n.show();
}

/**
 * @param {object} ctx { prefs, discord, configDir } from app.js; prefs is replaced on save.
 */
function registerIpc(ctx) {
  // Synchronous, once, as the preload starts: the bridge's constant fields.
  ipcMain.on('strafe:info', (event) => {
    event.returnValue = fromApp(event) ? { appVersion: app.getVersion(), platform: PLATFORMS[process.platform] || 'linux' } : null;
  });

  on('strafe:ready', (event) => {
    // Popups show themselves when they have painted; this is about the main window.
    if (senderWindow(event) === windows.mainWindow()) windows.ready();
  });
  on('strafe:show', () => windows.showMain());

  on('strafe:window:minimize', (event) => senderWindow(event)?.minimize());
  on('strafe:window:toggleMaximize', (event) => {
    const win = senderWindow(event);
    if (!win) return;
    if (win.isMaximized()) win.unmaximize();
    else win.maximize();
  });
  // The main window decides for itself what closing means (window.js: hide or quit).
  on('strafe:window:close', (event) => senderWindow(event)?.close());
  handle('strafe:window:isMaximized', (event) => !!senderWindow(event)?.isMaximized());
  handle('strafe:window:isFocused', (event) => !!senderWindow(event)?.isFocused());
  on('strafe:window:requestAttention', (event) => {
    const win = senderWindow(event);
    if (!win || win.isFocused() || flashing.has(win)) return;
    flashing.add(win);
    win.flashFrame(true);
    win.once('focus', () => {
      flashing.delete(win);
      win.flashFrame(false);
    });
  });
  on('strafe:window:openPopup', (_event, p, opts) => windows.openPopup(p, opts));

  handle('strafe:openExternal', async (_event, url) => {
    if (!isExternalUrl(url)) throw new Error('Only web and mail links open outside the app.');
    await shell.openExternal(String(url));
  });
  on('strafe:badge', (event, count) => {
    if (!fromMainWindow(event)) return;
    const n = Number(count);
    app.setBadgeCount(Number.isFinite(n) && n > 0 ? Math.min(Math.floor(n), 9999) : 0);
  });
  on('strafe:notify', (_event, title, body) => notify(title, body));

  handle('strafe:accounts:load', () => store.loadAccounts(ctx.configDir));
  handle('strafe:accounts:save', (_event, value) => store.saveAccounts(ctx.configDir, value));

  handle('strafe:prefs:load', () => ({ ...ctx.prefs }));
  handle('strafe:prefs:save', (_event, value) => {
    const prefs = store.savePrefs(ctx.configDir, value);
    const was = ctx.prefs;
    ctx.prefs = prefs;
    if (was.discordPresence !== prefs.discordPresence) ctx.discord.setEnabled(prefs.discordPresence);
  });

  handle('strafe:autostart:isEnabled', () => autostart.isEnabled());
  handle('strafe:autostart:enable', () => autostart.enable({ appPath: app.isPackaged ? undefined : app.getAppPath() }));
  handle('strafe:autostart:disable', () => autostart.disable());

  on('strafe:discord:set', (event, presence) => {
    if (fromMainWindow(event)) ctx.discord.setPresence(presence);
  });
  handle('strafe:discord:available', () => ctx.discord.configured());

  // Chromium can delete its IndexedDB from the page itself (WebKit could not, which is why
  // the Tauri shell does this at the next start); the contract is the same either way.
  handle('strafe:wipeStorage', async () => {
    await session.defaultSession.clearStorageData({ origin: env.appOrigin(), storages: ['indexdb'] });
    relaunch();
    app.exit(0);
    return new Promise(() => {});
  });

  handle('strafe:updater:check', () => updater.check());
  handle('strafe:updater:download', (event) =>
    updater.download((percent) => {
      if (!event.sender.isDestroyed()) event.sender.send('strafe:updater:progress', percent);
    }),
  );
  handle('strafe:updater:install', () => updater.install());

  handle('strafe:screen:sources', () => media.sources());
  handle('strafe:screen:choose', (_event, id) => media.choose(id));
}

module.exports = { registerIpc };
