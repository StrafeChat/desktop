// Serving the bundled web client as tauri://localhost.
//
// Files are read with fs rather than net.fetch(file://...): fs is what Electron teaches to
// read inside an asar archive, so the same code works however the build is packed.

const fs = require('node:fs');
const path = require('node:path');
const { SCHEME, HOST } = require('./origin');

/** Content types by extension. Something not listed is served as bytes, and (see
 * resolveRequest) a missing path with one of these extensions is a missing file, not a route. */
const MIME = {
  html: 'text/html; charset=utf-8',
  js: 'text/javascript; charset=utf-8',
  mjs: 'text/javascript; charset=utf-8',
  css: 'text/css; charset=utf-8',
  json: 'application/json',
  map: 'application/json',
  svg: 'image/svg+xml',
  png: 'image/png',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  gif: 'image/gif',
  webp: 'image/webp',
  ico: 'image/x-icon',
  woff: 'font/woff',
  woff2: 'font/woff2',
  ttf: 'font/ttf',
  otf: 'font/otf',
  wasm: 'application/wasm',
  txt: 'text/plain; charset=utf-8',
  webmanifest: 'application/manifest+json',
  mp3: 'audio/mpeg',
  ogg: 'audio/ogg',
  wav: 'audio/wav',
};

function mimeType(file) {
  return MIME[path.extname(file).slice(1).toLowerCase()] || 'application/octet-stream';
}

function isFile(p) {
  try {
    return fs.statSync(p).isFile();
  } catch {
    return false;
  }
}

/**
 * Which file answers `pathname` (the URL's path, still percent-encoded) under `root`.
 * Returns { file } or { status: 404 }.
 *
 * - A file is served as itself; a directory with an index.html serves that (the developer
 *   docs are built as /docs/<page>/index.html).
 * - Anything else is the client's own route and gets the app's index.html - a single-page
 *   app - unless it ends in an asset extension: a missing /assets/x.js must be a 404, or
 *   the client would get HTML where it expects a script and fail with a confusing error.
 *   Only the extensions in MIME count, because routes can contain dots too: an invite to
 *   another instance is /invite/<code>@<domain>.
 * - The resolved path must stay inside `root`: %2e%2e survives URL normalisation, and is
 *   only decoded here.
 */
function resolveRequest(root, pathname) {
  const notFound = { status: 404 };
  let decoded;
  try {
    decoded = decodeURIComponent(pathname || '/');
  } catch {
    return notFound;
  }
  if (decoded.includes('\0')) return notFound;
  const base = path.resolve(root);
  const file = path.resolve(base, `./${decoded}`);
  if (file !== base && !file.startsWith(base + path.sep)) return notFound;

  if (isFile(file)) return { file };
  const dirIndex = path.join(file, 'index.html');
  if (isFile(dirIndex)) return { file: dirIndex };
  if (MIME[path.extname(decoded).slice(1).toLowerCase()]) return notFound;
  const appIndex = path.join(base, 'index.html');
  return isFile(appIndex) ? { file: appIndex } : notFound;
}

/** Where the built client is: beside the app in a package, the submodule's dist in dev. */
function webRoot() {
  const { app } = require('electron');
  return app.isPackaged ? path.join(process.resourcesPath, 'web') : path.resolve(__dirname, '..', '..', 'web', 'dist');
}

/** Answer tauri://localhost/* from the web build. Needs the scheme registered as privileged
 * before ready (app.js), and must itself run after ready. */
function registerAppProtocol() {
  const { protocol } = require('electron');
  const root = webRoot();
  protocol.handle(SCHEME, async (request) => {
    const url = new URL(request.url);
    const found = url.host === HOST ? resolveRequest(root, url.pathname) : { status: 404 };
    if (!found.file) return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    try {
      const body = await fs.promises.readFile(found.file);
      const headers = { 'Content-Type': mimeType(found.file) };
      // The page that pulls in everything else: always revalidated, so an update's new
      // hashed assets are what the next start loads.
      if (path.basename(found.file) === 'index.html') headers['Cache-Control'] = 'no-cache';
      return new Response(body, { status: 200, headers });
    } catch {
      return new Response('Not found', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }
  });
}

module.exports = { MIME, mimeType, resolveRequest, webRoot, registerAppProtocol };
