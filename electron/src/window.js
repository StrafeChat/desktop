// The main window and the popups (the OAuth consent page), and the rules every one of them
// shares: links leave for the system browser, the app never navigates away from itself.

const path = require('node:path');
const { app, BrowserWindow, Menu, screen, shell } = require('electron');
const env = require('./env');
const { isExternalUrl } = require('./origin');
const windowState = require('./windowState');

// Where the window was is decided in windowState.js, which the tests can load without Electron.
const { validateWindowState } = windowState;

const PRELOAD = path.join(__dirname, '..', 'preload.js');
const BACKGROUND = '#101216';
/** If the client never says it has painted (dev server down, a broken build), show the window
 * anyway so the failure is visible instead of a silent process. */
const FALLBACK_SHOW_MS = 8000;
/** Moving or resizing fires dozens of events a second; write the file once things settle. */
const SAVE_DELAY_MS = 500;

/** { prefs, discord }, from app.js: prefs.closeToTray decides what closing means. */
let ctx = null;
let main = null;
/** Whether the window has been shown (or deliberately kept hidden) since start-up. */
let shown = false;
/** Set once the app is really quitting, so closing stops meaning "hide to the tray". */
let quitting = false;
/** It was maximised when it was last closed. Applied when it is first shown, because
 * maximize() on a hidden window would show it - and a login launch must stay in the tray. */
let restoreMaximized = false;

function webPreferences(additionalArguments = []) {
  return {
    preload: PRELOAD,
    contextIsolation: true,
    sandbox: true,
    nodeIntegration: false,
    // Chromium's spell checker downloads its dictionaries from Google. Nothing leaves the
    // machine that the person did not send.
    spellcheck: false,
    // Calls keep running (and ringing) behind other windows and from the tray.
    backgroundThrottling: false,
    additionalArguments,
  };
}

function openExternal(url) {
  if (isExternalUrl(url)) shell.openExternal(url).catch((e) => console.error(`could not open ${url}: ${e.message}`));
}

/** The menu a right click gets where the client has no menu of its own: edit commands in a
 * text field, Copy on a selection. Chromium shows nothing at all by default. */
function contextMenu(win, params) {
  const f = params.editFlags;
  /** @type {Electron.MenuItemConstructorOptions[] | null} */
  let template = null;
  if (params.isEditable) {
    template = [
      { role: 'undo', enabled: !!f.canUndo },
      { role: 'redo', enabled: !!f.canRedo },
      { type: 'separator' },
      { role: 'cut', enabled: !!f.canCut },
      { role: 'copy', enabled: !!f.canCopy },
      { role: 'paste', enabled: !!f.canPaste },
      { type: 'separator' },
      { role: 'selectAll', enabled: !!f.canSelectAll },
    ];
  } else if (params.selectionText && params.selectionText.trim()) {
    template = [{ role: 'copy', enabled: !!f.canCopy }];
  }
  if (template) Menu.buildFromTemplate(template).popup({ window: win });
}

/** What every window gets, main or popup. */
function setUpWindow(win) {
  const wc = win.webContents;
  // window.open and target=_blank: links out go to the system browser or mail client, and no
  // page ever gets a second Electron window of its own making.
  wc.setWindowOpenHandler(({ url }) => {
    openExternal(url);
    return { action: 'deny' };
  });
  // The window only ever shows the app. A plain link to elsewhere opens outside instead of
  // doing nothing.
  wc.on('will-navigate', (event) => {
    if (env.isAppUrl(event.url)) return;
    event.preventDefault();
    openExternal(event.url);
  });
  wc.on('context-menu', (_event, params) => contextMenu(win, params));
  if (!app.isPackaged) {
    wc.on('before-input-event', (event, input) => {
      if (input.type !== 'keyDown') return;
      const key = String(input.key).toLowerCase();
      if (key === 'f12' || (input.control && input.shift && key === 'i')) {
        event.preventDefault();
        wc.toggleDevTools();
      }
    });
  }
  const tell = (maximized) => {
    if (!wc.isDestroyed()) wc.send('strafe:window:maximized', maximized);
  };
  win.on('maximize', () => tell(true));
  win.on('unmaximize', () => tell(false));
}

/** Save the window's place as it changes, and once more as it closes. */
function persistState(win, dir) {
  let timer = null;
  const save = () => {
    clearTimeout(timer);
    timer = null;
    if (win.isDestroyed()) return;
    try {
      windowState.writeWindowState(dir, win.getNormalBounds(), win.isMaximized() || restoreMaximized);
    } catch (e) {
      console.error(`could not save the window state: ${e.message}`);
    }
  };
  const later = () => {
    clearTimeout(timer);
    timer = setTimeout(save, SAVE_DELAY_MS);
  };
  for (const ev of ['move', 'resize', 'maximize', 'unmaximize']) win.on(ev, later);
  win.on('close', save);
}

function createMainWindow(context) {
  ctx = context;
  const dir = app.getPath('userData');
  const workAreas = screen.getAllDisplays().map((d) => d.workArea);
  const state = validateWindowState(windowState.readWindowState(dir, screen.getPrimaryDisplay().scaleFactor), workAreas);
  restoreMaximized = state.maximized;
  const placed = state.x !== undefined && state.y !== undefined;

  main = new BrowserWindow({
    ...(placed ? { x: state.x, y: state.y } : { center: true }),
    width: state.width,
    height: state.height,
    minWidth: windowState.LIMITS.minWidth,
    minHeight: windowState.LIMITS.minHeight,
    title: 'Strafe',
    // The client draws its own title bar (components/desktop/TitleBar).
    frame: false,
    backgroundColor: BACKGROUND,
    // Shown on the client's first paint (ready below): no blank frame while it loads.
    show: false,
    icon: env.appIconPath(),
    webPreferences: webPreferences(),
  });
  setUpWindow(main);
  persistState(main, dir);

  main.on('close', (event) => {
    if (quitting || !ctx.prefs.closeToTray) return;
    // Hide to the tray, as Discord does: a closed window still rings for calls and shows
    // notifications. A Strafe in the tray is not being used, so Discord stops showing it.
    event.preventDefault();
    main.hide();
    ctx.discord.setVisible(false);
  });
  // Really closed (close-to-tray off): that is quitting, popups and tray included.
  main.on('closed', () => {
    main = null;
    app.quit();
  });

  main.loadURL(env.appUrl('/')).catch((e) => console.error(`could not load the client: ${e.message}`));
  setTimeout(revealOnce, FALLBACK_SHOW_MS);
  return main;
}

function mainWindow() {
  return main;
}

/** Bring the main window forward: from the tray, a notification, a second launch. */
function showMain() {
  if (!main) return;
  if (restoreMaximized) {
    restoreMaximized = false;
    main.maximize();
  }
  if (!main.isVisible()) main.show();
  if (main.isMinimized()) main.restore();
  main.focus();
  ctx.discord.setVisible(true);
}

function revealOnce() {
  if (shown) return;
  shown = true;
  showMain();
}

/** The client has painted: show the window, unless this launch was asked to stay in the
 * tray (autostart passes `--minimized`, and Settings -> Desktop says to honour it). */
function ready() {
  if (process.argv.includes('--minimized') && ctx.prefs.startMinimized) {
    // Mark it shown so the fallback timer does not pop the window up later either.
    shown = true;
    return;
  }
  revealOnce();
}

function setQuitting() {
  quitting = true;
}

/**
 * An in-app page in its own window (the OAuth consent page a bot install opens): a browser
 * would open a tab, a desktop app opens a window. Only the app's own paths - never a URL
 * someone could slip in.
 * @param {string} p
 * @param {{ width?: number, height?: number, title?: string }} [opts]
 */
function openPopup(p, opts = {}) {
  if (typeof p !== 'string' || !p.startsWith('/')) return;
  const url = env.appUrl(p);
  if (!env.isAppUrl(url)) return;
  const o = opts && typeof opts === 'object' ? opts : {};
  const size = (n, fallback) => (Number.isFinite(n) ? Math.round(Math.min(Math.max(n, 320), 4096)) : fallback);
  const title = typeof o.title === 'string' && o.title.trim() ? o.title.trim().slice(0, 200) : 'Strafe';
  const win = new BrowserWindow({
    width: size(o.width, 540),
    height: size(o.height, 760),
    title,
    center: true,
    resizable: true,
    frame: true,
    autoHideMenuBar: true,
    backgroundColor: BACKGROUND,
    show: false,
    icon: env.appIconPath(),
    webPreferences: webPreferences(['--strafe-popup']),
  });
  // Keep the title the client asked for, as the Tauri shell does, not the page's <title>.
  win.on('page-title-updated', (event) => event.preventDefault());
  setUpWindow(win);
  win.once('ready-to-show', () => win.show());
  win.loadURL(url).catch((e) => console.error(`could not load the popup: ${e.message}`));
}

module.exports = {
  createMainWindow,
  mainWindow,
  showMain,
  ready,
  setQuitting,
  openPopup,
  validateWindowState,
};
