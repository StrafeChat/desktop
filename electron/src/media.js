// Microphone, camera and screen sharing for calls.
//
// The app's own pages get the media a call needs without being asked twice: the person
// already chose to join, and the operating system still has the final say (PipeWire or
// PulseAudio for devices, the desktop portal for the screen on Wayland). Nothing else on
// any page gets anything - an embed asking for the camera or a location is refused.

const { BrowserWindow, desktopCapturer } = require('electron');
const env = require('./env');

const ALLOWED = new Set([
  'media',
  'display-capture',
  'notifications',
  'clipboard-sanitized-write',
  'fullscreen',
  // Choosing the output device in Settings -> Voice (setSinkId).
  'speaker-selection',
]);

/** A source picked in the app's own picker (X11) is good for one getDisplayMedia call, and
 * only for a minute: a stale choice must never share a screen the person has since forgotten
 * they picked. */
const CHOICE_TTL_MS = 60_000;
let choice = null;

const isWayland = () => process.env.XDG_SESSION_TYPE === 'wayland';

function takeChoice() {
  const c = choice;
  choice = null;
  return c && Date.now() < c.expires ? c.id : null;
}

/** On X11, a picker's worth of sources for the app's own picker; on Wayland, null - the
 * portal shows the system's picker when the client calls getDisplayMedia. */
async function sources() {
  if (isWayland()) return null;
  const list = await desktopCapturer.getSources({
    types: ['screen', 'window'],
    thumbnailSize: { width: 320, height: 180 },
    fetchWindowIcons: true,
  });
  return list.map((s) => {
    const out = {
      id: s.id,
      name: s.name,
      kind: s.id.startsWith('screen:') ? 'screen' : 'window',
      thumbnail: s.thumbnail && !s.thumbnail.isEmpty() ? s.thumbnail.toDataURL() : '',
    };
    if (s.appIcon && !s.appIcon.isEmpty()) out.appIcon = s.appIcon.toDataURL();
    return out;
  });
}

/** The source the next getDisplayMedia call shares (from sources() above). */
function choose(id) {
  if (typeof id !== 'string' || !/^(screen|window):/.test(id)) throw new Error('That is not a source from the list.');
  choice = { id, expires: Date.now() + CHOICE_TTL_MS };
}

/** Development only: share without a picker, for automated call tests. "self" is the app's
 * own window, so a test never captures someone's real screen. */
function devSource(request, list) {
  const want = env.dev.shareSource;
  if (!want) return null;
  if (want === 'self') {
    const own = BrowserWindow.getAllWindows().find((w) => w.webContents.mainFrame === request.frame);
    const id = own && own.getMediaSourceId();
    return list.find((s) => s.id === id) || null;
  }
  return list.find((s) => s.name.includes(want)) || null;
}

async function pickDisplaySource(request) {
  const chosen = takeChoice();
  if (chosen) {
    // Thumbnails are not needed to look the source up again.
    const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
    return list.find((s) => s.id === chosen) || null;
  }
  if (isWayland()) {
    // Listing sources on Wayland is what opens the portal's picker; it hands back the one
    // the person picked, or nothing if they cancelled.
    const list = await desktopCapturer.getSources({ types: ['screen', 'window'] });
    return list[0] || null;
  }
  // X11 without a choice from the app's picker: nothing is shared unasked.
  if (!env.dev.shareSource) return null;
  const list = await desktopCapturer.getSources({ types: ['screen', 'window'], thumbnailSize: { width: 0, height: 0 } });
  return devSource(request, list);
}

function setUpMedia(ses) {
  ses.setPermissionRequestHandler((wc, permission, callback, details) => {
    callback(ALLOWED.has(permission) && env.isAppUrl(details.requestingUrl || wc.getURL()));
  });
  ses.setPermissionCheckHandler((_wc, permission, requestingOrigin) => ALLOWED.has(permission) && env.isAppUrl(requestingOrigin));
  ses.setDisplayMediaRequestHandler(async (request, callback) => {
    let source = null;
    try {
      const fromApp = env.isAppUrl(request.securityOrigin) || (request.frame && env.isAppUrl(request.frame.url));
      if (fromApp) source = await pickDisplaySource(request);
    } catch (e) {
      console.error(`screen share: ${e.message}`);
    }
    // null is the refusal (getDisplayMedia rejects with NotAllowedError). An empty object
    // would make Electron throw "Video was requested, but no video stream was provided".
    try {
      callback(source ? { video: source } : null);
    } catch (e) {
      // The requesting frame went away while the picker was open.
      console.error(`screen share: ${e.message}`);
    }
  });
}

module.exports = { setUpMedia, sources, choose, ALLOWED };
