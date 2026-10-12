// window.strafeDesktop: what the web client may ask of the Linux shell, and nothing more.
//
// The contract is web.strafe.chat/src/desktop/electronBridge.ts; change both together (and
// bump `version` when a member changes meaning). Runs sandboxed, so 'electron' is the only
// module there is. Every member is a plain function over a named IPC channel - the page never
// gets ipcRenderer itself, so it cannot send anything the main process does not expect.

const { contextBridge, ipcRenderer } = require('electron');

// Answered by the main process only for the app's own pages; anything else gets null, and
// no bridge.
const info = ipcRenderer.sendSync('strafe:info');

/** invoke(), with the main process's { value } / { error } answer turned back into a value or
 * a rejection whose message is readable as it stands. */
async function call(channel, ...args) {
  const r = await ipcRenderer.invoke(channel, ...args);
  if (r && typeof r === 'object' && typeof r.error === 'string') throw new Error(r.error);
  return r ? r.value : undefined;
}

const send = (channel, ...args) => ipcRenderer.send(channel, ...args);

function deepFreeze(o) {
  for (const v of Object.values(o)) if (v && typeof v === 'object') deepFreeze(v);
  return Object.freeze(o);
}

/** Only sizes and a title cross: the rest of the window is the shell's call. */
function popupOptions(opts) {
  const o = opts && typeof opts === 'object' ? opts : {};
  const out = {};
  if (typeof o.width === 'number') out.width = o.width;
  if (typeof o.height === 'number') out.height = o.height;
  if (typeof o.title === 'string') out.title = o.title;
  return out;
}

/** Only the presence fields cross, as plain values. */
function presenceFields(p) {
  const o = p && typeof p === 'object' ? p : {};
  const out = {};
  if (typeof o.details === 'string') out.details = o.details;
  if (typeof o.state === 'string') out.state = o.state;
  if (typeof o.since === 'number') out.since = o.since;
  return out;
}

if (info) {
  const bridge = {
    kind: 'electron',
    version: 1,
    platform: info.platform,
    appVersion: info.appVersion,
    // The main process starts popups (the OAuth consent page) with this flag.
    isPopup: process.argv.includes('--strafe-popup'),

    ready: () => send('strafe:ready'),
    show: () => send('strafe:show'),

    window: {
      minimize: () => send('strafe:window:minimize'),
      toggleMaximize: () => send('strafe:window:toggleMaximize'),
      close: () => send('strafe:window:close'),
      isMaximized: () => call('strafe:window:isMaximized'),
      isFocused: () => call('strafe:window:isFocused'),
      onMaximizeChange(cb) {
        const listener = (_event, maximized) => cb(maximized === true);
        ipcRenderer.on('strafe:window:maximized', listener);
        return () => ipcRenderer.removeListener('strafe:window:maximized', listener);
      },
      requestAttention: () => send('strafe:window:requestAttention'),
      openPopup: (path, opts) => send('strafe:window:openPopup', String(path), popupOptions(opts)),
    },

    openExternal: (url) => call('strafe:openExternal', String(url)),
    setBadgeCount: (count) => send('strafe:badge', Number(count) || 0),
    notify: (title, body) => send('strafe:notify', String(title), body == null ? undefined : String(body)),

    accounts: {
      load: () => call('strafe:accounts:load'),
      // Through JSON first: the file is JSON anyway, and anything JSON cannot hold (a
      // function, say) would otherwise make the IPC call itself fail to clone the value.
      save: (value) => call('strafe:accounts:save', value === undefined ? null : JSON.parse(JSON.stringify(value))),
    },
    prefs: {
      load: () => call('strafe:prefs:load'),
      save: (prefs) => call('strafe:prefs:save', prefs && typeof prefs === 'object' ? { ...prefs } : {}),
    },
    autostart: {
      isEnabled: () => call('strafe:autostart:isEnabled'),
      enable: () => call('strafe:autostart:enable'),
      disable: () => call('strafe:autostart:disable'),
    },
    discord: {
      set: (presence) => send('strafe:discord:set', presenceFields(presence)),
      available: () => call('strafe:discord:available'),
    },

    wipeStorageAndRestart: () => call('strafe:wipeStorage'),

    updater: {
      check: () => call('strafe:updater:check'),
      // Progress arrives as separate messages, listened to only while this download runs.
      download(onProgress) {
        const listener = (_event, percent) => {
          if (typeof onProgress === 'function') onProgress(percent);
        };
        ipcRenderer.on('strafe:updater:progress', listener);
        return call('strafe:updater:download').finally(() => ipcRenderer.removeListener('strafe:updater:progress', listener));
      },
      install: () => call('strafe:updater:install'),
    },

    screen: {
      sources: () => call('strafe:screen:sources'),
      choose: (id) => call('strafe:screen:choose', String(id)),
    },
  };

  contextBridge.exposeInMainWorld('strafeDesktop', deepFreeze(bridge));
}
