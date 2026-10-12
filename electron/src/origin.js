// What counts as the app, and what counts as a link out of it.
//
// No Electron here, so the tests can load it under plain Node.

// The bundled client is served as tauri://localhost: the origin every instance already
// admits for the desktop app (equinox internal/weborigin, nebula's middleware), so moving the
// Linux app to Chromium needs no server change anywhere in the federation.
const SCHEME = 'tauri';
const HOST = 'localhost';
const ORIGIN = `${SCHEME}://${HOST}`;

/**
 * True when `url` belongs to the app: tauri://localhost, or the dev server's origin when one
 * is in use (`devOrigin`, development builds only). Everything that grants something - IPC,
 * permissions, navigation - asks this first.
 */
function isAppUrl(url, devOrigin) {
  let u;
  try {
    u = new URL(String(url));
  } catch {
    return false;
  }
  if (devOrigin) return u.origin === devOrigin;
  // Node's URL does not know the scheme is registered as standard, so its .origin is "null"
  // here: compare the parts. `host` includes any port, so tauri://localhost:1 is not us.
  return u.protocol === `${SCHEME}:` && u.host === HOST;
}

const EXTERNAL_PROTOCOLS = new Set(['http:', 'https:', 'mailto:']);

/** Links the system browser or mail client may open. Anything else (file:, a custom handler
 * some other program registered, javascript:) is refused rather than handed to the desktop. */
function isExternalUrl(url) {
  try {
    return EXTERNAL_PROTOCOLS.has(new URL(String(url)).protocol);
  } catch {
    return false;
  }
}

module.exports = { SCHEME, HOST, ORIGIN, isAppUrl, isExternalUrl };
