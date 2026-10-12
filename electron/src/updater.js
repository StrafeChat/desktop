// In-app updates for the Linux app.
//
// One feed for both shells: the latest.json the Tauri updater reads on Windows and macOS,
// whose Linux entries point at this shell's builds. Every file is checked against the
// release key (updateKey.js) before anything is replaced - whoever can upload to the release
// page still cannot ship an update without the private key.
//
// How an update is installed depends on how Strafe was: an AppImage replaces itself; a deb
// or rpm goes through the package manager, as root, via pkexec (the system's own password
// prompt). Anything else (a tarball, a distribution's own package) is updated the way it was
// installed, and check() says so.

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const minisign = require('./minisign');
const UPDATE_PUBKEY = require('./updateKey');
const { ownAppImage } = require('./launch');

const FEED_URL = 'https://github.com/StrafeChat/desktop/releases/latest/download/latest.json';
const CHECK_TIMEOUT_MS = 15_000;

/** latest.json names architectures the way Rust does. */
const ARCH = { x64: 'x86_64', arm64: 'aarch64' };
const KINDS = new Set(['appimage', 'deb', 'rpm']);

const BAD_SIGNATURE = "The update's signature did not verify, so it was not installed.";

// ---- pure helpers --------------------------------------------------------------------------

/** x.y.z with an optional -prerelease and +build; a leading "v" is tolerated. Null otherwise. */
function parseVersion(v) {
  const m = /^v?(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+[0-9A-Za-z.-]+)?$/.exec(String(v).trim());
  if (!m) return null;
  return { nums: [Number(m[1]), Number(m[2]), Number(m[3])], pre: m[4] ? m[4].split('.') : [] };
}

/**
 * Semver order: -1, 0 or 1. Numbers compare as numbers (1.10.0 is newer than 1.9.0) and a
 * prerelease sorts before its release (1.4.0-beta.1 < 1.4.0). Throws on something that is
 * not a version, rather than guessing.
 */
function compareVersions(a, b) {
  const pa = parseVersion(a);
  const pb = parseVersion(b);
  if (!pa || !pb) throw new Error(`not a version: ${!pa ? a : b}`);
  for (let i = 0; i < 3; i++) {
    if (pa.nums[i] !== pb.nums[i]) return pa.nums[i] < pb.nums[i] ? -1 : 1;
  }
  if (!pa.pre.length || !pb.pre.length) return pa.pre.length === pb.pre.length ? 0 : pa.pre.length ? -1 : 1;
  for (let i = 0; i < Math.max(pa.pre.length, pb.pre.length); i++) {
    const x = pa.pre[i];
    const y = pb.pre[i];
    if (x === undefined) return -1;
    if (y === undefined) return 1;
    const nx = /^\d+$/.test(x);
    const ny = /^\d+$/.test(y);
    if (nx && ny) {
      if (Number(x) !== Number(y)) return Number(x) < Number(y) ? -1 : 1;
    } else if (nx !== ny) {
      return nx ? -1 : 1;
    } else if (x !== y) {
      return x < y ? -1 : 1;
    }
  }
  return 0;
}

/** The latest.json platform key for this machine and install, e.g. linux-x86_64-appimage;
 * null for an architecture no release is built for. */
function entryKey(arch, kind) {
  const a = ARCH[arch];
  return a && KINDS.has(kind) ? `linux-${a}-${kind}` : null;
}

/**
 * This install's entry in a latest.json: { key, url, signature }, or null when the release
 * has none. An AppImage may also take the plain linux-<arch> entry, which is the AppImage in
 * Tauri's feed; a deb or rpm never does - it must not be handed an AppImage. Plain http is
 * accepted only when asked for (a local test feed in development).
 */
function pickEntry(feed, arch, kind, { allowHttp = false } = {}) {
  const platforms = feed && typeof feed === 'object' ? feed.platforms : null;
  const key = entryKey(arch, kind);
  if (!platforms || typeof platforms !== 'object' || !key) return null;
  const scheme = allowHttp ? /^https?:\/\//i : /^https:\/\//i;
  const take = (k) => {
    const e = Object.prototype.hasOwnProperty.call(platforms, k) ? platforms[k] : null;
    if (!e || typeof e.url !== 'string' || typeof e.signature !== 'string' || !scheme.test(e.url)) return null;
    return { key: k, url: e.url, signature: e.signature };
  };
  return take(key) || (kind === 'appimage' ? take(`linux-${ARCH[arch]}`) : null);
}

/** How this copy was installed: 'appimage', 'deb', 'rpm', or null when it cannot update itself.
 * electron-builder leaves the package type in resources/package-type for deb and rpm, and
 * that wins: an inherited APPIMAGE only counts when this binary runs from that AppImage
 * (launch.js ownAppImage). */
function installKind(env = process.env, resourcesPath = process.resourcesPath, execPath = process.execPath, realpath) {
  try {
    const kind = fs.readFileSync(path.join(resourcesPath || '', 'package-type'), 'utf8').trim();
    if (kind === 'deb' || kind === 'rpm') return kind;
  } catch {
    // Not a deb or rpm install.
  }
  return ownAppImage({ env, execPath, realpath }) ? 'appimage' : null;
}

/** The file name each kind of release bundle has (electron-builder.yml, and the names
 * scripts/linux-update-feed.mjs insists on). Only x64 is built. */
function bundleName(kind, version, arch = process.arch) {
  if (arch !== 'x64') return null;
  if (kind === 'appimage') return `Strafe_${version}_amd64.AppImage`;
  if (kind === 'deb') return `Strafe_${version}_amd64.deb`;
  if (kind === 'rpm') return `Strafe-${version}-1.x86_64.rpm`;
  return null;
}

/** A field (`file`, `version`, ...) of a signature's trusted comment, which the signature
 * covers; null when absent or unreadable. */
function signedField(signature, name) {
  let comment;
  try {
    comment = minisign.parseSignature(signature).trustedComment;
  } catch {
    return null;
  }
  for (const field of comment.split('\t')) {
    if (field.startsWith(`${name}:`)) return field.slice(name.length + 1).trim();
  }
  return null;
}

/**
 * The version a signature is bound to, if it is: `tauri signer sign --app-version` (and
 * `tauri build`) put `version:<x>` in the trusted comment, which the signature covers. Null
 * for a signature without one.
 */
function signedVersion(signature) {
  return signedField(signature, 'version');
}

/**
 * Whether `data` is the release `entry` says it is: the signature verifies against the
 * release key, and the trusted comment it covers names the version the feed announced - so
 * a doctored latest.json cannot pass an older signed build off as an update. With `bundle`
 * (what the updater always passes) the comment must also name exactly that file, so a feed
 * cannot hand a deb install the signed AppImage, or anything else the key ever signed, and
 * a signature naming no version or file is refused outright.
 */
function verifyUpdate(data, entry, version, pubkey = UPDATE_PUBKEY, bundle = null) {
  let ok = false;
  try {
    ok = minisign.verify(data, entry.signature, pubkey);
  } catch {
    ok = false;
  }
  return ok && boundTo(entry, version, bundle);
}

/** verifyUpdate() for the downloaded file on disk, without loading it whole. */
async function verifyUpdateFile(file, entry, version, pubkey = UPDATE_PUBKEY, bundle = null) {
  let ok = false;
  try {
    ok = await minisign.verifyFile(file, entry.signature, pubkey);
  } catch {
    ok = false;
  }
  return ok && boundTo(entry, version, bundle);
}

function boundTo(entry, version, bundle) {
  const signed = signedVersion(entry.signature);
  if (bundle) return signed !== null && compareVersions(signed, version) === 0 && signedField(entry.signature, 'file') === bundle;
  return signed === null || compareVersions(signed, version) === 0;
}

// ---- the updater ---------------------------------------------------------------------------

/** What check() found: { version, notes, entry, kind }, plus `file` once downloaded. */
let pending = null;
let downloading = null;

function message(e) {
  return e && e.message ? e.message : String(e);
}

function feedUrl() {
  const { app } = require('electron');
  return (!app.isPackaged && process.env.STRAFE_UPDATE_FEED) || FEED_URL;
}

/** The release key - or, in development only, a test key for a local test feed. */
function releaseKey() {
  const { app } = require('electron');
  return (!app.isPackaged && process.env.STRAFE_UPDATE_PUBKEY) || UPDATE_PUBKEY;
}

/** Null when up to date; { version, notes } when something newer exists. */
async function check() {
  const { app, net } = require('electron');
  const kind = installKind();
  if (!kind) {
    throw new Error('This copy of Strafe cannot update itself. Update it the way you installed it.');
  }
  let feed;
  try {
    // Electron's own network stack, so the system proxy applies as it does to the client.
    const res = await net.fetch(feedUrl(), { signal: AbortSignal.timeout(CHECK_TIMEOUT_MS), cache: 'no-store' });
    if (!res.ok) throw new Error(`the release feed answered ${res.status}`);
    feed = await res.json();
  } catch (e) {
    throw new Error(`Could not check for updates: ${message(e)}`);
  }
  const version = feed && parseVersion(feed.version) ? String(feed.version).trim().replace(/^v/, '') : null;
  if (!version) throw new Error('Could not check for updates: the release feed has no valid version.');
  if (compareVersions(version, app.getVersion()) <= 0) {
    if (pending && pending.file) discard(pending.kind, pending.file);
    pending = null;
    return null;
  }
  const entry = pickEntry(feed, process.arch, kind, { allowHttp: !app.isPackaged });
  const bundle = bundleName(kind, version);
  if (!entry || !bundle) {
    throw new Error(`Strafe ${version} is out, but not as an update for this system (${entryKey(process.arch, kind) || process.arch}).`);
  }
  const notes = typeof feed.notes === 'string' ? feed.notes : '';
  // The same release again (another check, or a second window asking): keep what is already
  // on its way or on disk. Anything else replaces it.
  if (pending && pending.version === version && pending.entry.signature === entry.signature) {
    pending.notes = notes;
  } else {
    if (pending && pending.file) discard(pending.kind, pending.file);
    pending = { version, notes, entry, kind, bundle, appImage: kind === 'appimage' ? ownAppImage() : null, file: null };
  }
  return { version, notes };
}

/** Remove a downloaded file - and for a deb or rpm, the private directory made for it. */
function discard(kind, file) {
  try {
    fs.rmSync(kind === 'appimage' ? file : path.dirname(file), { recursive: kind !== 'appimage', force: true });
  } catch {
    // Left behind in a temporary directory, or beside the AppImage; nothing depends on it.
  }
}

/**
 * Where the download goes. An AppImage's goes beside it, so installing is one rename on the
 * same filesystem and a crash mid-update never leaves half an AppImage. A deb or rpm goes in
 * a fresh private directory under the system's temporary one: the package manager will run
 * it as root, so no other user may be able to put a file at that path first.
 */
function downloadPath(p) {
  if (p.kind === 'appimage') return `${p.appImage}.download`;
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strafe-update-'));
  return path.join(dir, `strafe-update-${p.version}.${p.kind}`);
}

/**
 * Fetch and verify what check() found, reporting 0-100 through `onProgress`.
 * @param {(percent: number) => void} [onProgress]
 */
function download(onProgress = () => {}) {
  if (!pending) return Promise.reject(new Error('There is no update to download. Check for updates first.'));
  if (pending.file) {
    onProgress(100);
    return Promise.resolve();
  }
  // Join a download already under way only if it is for this same release.
  if (!downloading || downloading.p !== pending) {
    const p = pending;
    const promise = fetchUpdate(p, onProgress).finally(() => {
      if (downloading && downloading.p === p) downloading = null;
    });
    downloading = { p, promise };
  }
  return downloading.promise;
}

async function fetchUpdate(p, onProgress) {
  const { net } = require('electron');
  let file;
  try {
    file = downloadPath(p);
  } catch (e) {
    throw new Error(`Could not save the update: ${message(e)}`);
  }
  let handle = null;
  try {
    const res = await net.fetch(p.entry.url, { cache: 'no-store' });
    if (!res.ok || !res.body) throw new Error(`the download answered ${res.status}`);
    const total = Number(res.headers.get('content-length')) || 0;
    handle = await fs.promises.open(file, 'w', 0o600);
    let got = 0;
    let last = -1;
    const report = (pct) => {
      if (pct === last) return;
      last = pct;
      try {
        onProgress(pct);
      } catch {
        // A progress bar that went away is no reason to stop the download.
      }
    };
    report(0);
    const reader = res.body.getReader();
    for (;;) {
      const { done, value } = await reader.read();
      if (done) break;
      await handle.write(value);
      got += value.length;
      if (total > 0) report(Math.min(99, Math.floor((got / total) * 100)));
    }
    await handle.sync();
    await handle.close();
    handle = null;
    if (!(await verifyUpdateFile(file, p.entry, p.version, releaseKey(), p.bundle))) throw new Error(BAD_SIGNATURE);
    report(100);
  } catch (/** @type {any} */ e) {
    if (handle) await handle.close().catch(() => {});
    discard(p.kind, file);
    if (e.message === BAD_SIGNATURE) throw e;
    if (e.code === 'EACCES' || e.code === 'EROFS') {
      throw new Error(`Strafe cannot write next to itself (${path.dirname(file)}), so it cannot update itself there.`);
    }
    throw new Error(`Could not download the update: ${message(e)}`);
  }
  // Only the update check() is still holding gets the file.
  if (pending === p) p.file = file;
  else discard(p.kind, file);
}

/** Run a command, resolving on exit 0 and rejecting with what it printed otherwise. */
function run(cmd, args) {
  return new Promise((resolve, reject) => {
    const child = spawn(cmd, args, { stdio: ['ignore', 'ignore', 'pipe'] });
    let stderr = '';
    child.stderr.on('data', (d) => {
      if (stderr.length < 8192) stderr += d;
    });
    child.on('error', (/** @type {NodeJS.ErrnoException} */ e) => {
      reject(e.code === 'ENOENT' ? new Error(`${cmd} is not installed`) : e);
    });
    child.on('close', (code) => {
      if (code === 0) return resolve();
      // pkexec: 126 is the password prompt dismissed, 127 not authorised.
      if (cmd === 'pkexec' && (code === 126 || code === 127)) return reject(new Error('The update was not authorised.'));
      reject(new Error(stderr.trim() || `${cmd} exited with ${code}`));
    });
  });
}

/** Install what download() fetched and start the new version. Never resolves on success. */
async function install() {
  const { app } = require('electron');
  const { relaunch } = require('./launch');
  const p = pending;
  if (!p || !p.file) throw new Error('There is no downloaded update to install.');
  // Check again: the file sat on disk since it was downloaded.
  if (!(await verifyUpdateFile(p.file, p.entry, p.version, releaseKey(), p.bundle))) {
    discard(p.kind, p.file);
    p.file = null;
    throw new Error(BAD_SIGNATURE);
  }
  if (p.kind === 'appimage') {
    const target = p.appImage;
    try {
      fs.chmodSync(p.file, 0o755);
      // Replacing the file under a running AppImage is safe: it keeps its open copy.
      fs.renameSync(p.file, target);
    } catch (e) {
      throw new Error(`Could not install the update: ${message(e)}`);
    }
  } else {
    const cmd = p.kind === 'deb' ? ['dpkg', '-i', p.file] : ['rpm', '-U', '--replacepkgs', p.file];
    try {
      await run('pkexec', cmd);
    } catch (e) {
      throw new Error(`Could not install the update: ${message(e)}`);
    }
    discard(p.kind, p.file);
  }
  pending = null;
  relaunch();
  app.exit(0);
  return new Promise(() => {});
}

module.exports = {
  FEED_URL,
  BAD_SIGNATURE,
  parseVersion,
  compareVersions,
  entryKey,
  pickEntry,
  installKind,
  signedVersion,
  verifyUpdate,
  verifyUpdateFile,
  bundleName,
  signedField,
  check,
  download,
  install,
};
