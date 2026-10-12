// The launcher build/afterPack.js puts in front of the Electron binary, run under sh in fake
// install trees with a stub `unshare`: it may drop Chromium's sandbox only for this app's own
// AppImage on a system that refuses user namespaces - never for a deb or rpm install, even
// one started from inside some other AppImage (whose APPIMAGE/APPDIR it inherits).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const { launcher } = require('../build/afterPack');

function tree(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'strafe-launcher-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const install = (dir) => {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'strafe-desktop'), launcher('strafe-desktop.bin'), { mode: 0o755 });
    fs.writeFileSync(path.join(dir, 'strafe-desktop.bin'), '#!/bin/sh\necho "$*"\n', { mode: 0o755 });
    return path.join(dir, 'strafe-desktop');
  };
  const stub = (name, code) => {
    const dir = path.join(root, name);
    fs.mkdirSync(dir);
    fs.writeFileSync(path.join(dir, 'unshare'), `#!/bin/sh\nexit ${code}\n`, { mode: 0o755 });
    return dir;
  };
  const deb = install(path.join(root, 'opt', 'Strafe'));
  fs.mkdirSync(path.join(root, 'opt', 'Strafe', 'resources'));
  fs.writeFileSync(path.join(root, 'opt', 'Strafe', 'resources', 'package-type'), 'deb');
  const mount = path.join(root, 'mnt');
  const appimage = install(mount);
  return { root, deb, appimage, mount, refuse: stub('refuse', 1), allow: stub('allow', 0) };
}

function run(script, env, args = ['--x']) {
  return execFileSync(script, args, { env: { PATH: process.env.PATH, ...env }, stdio: ['ignore', 'pipe', 'ignore'] })
    .toString()
    .trim();
}

test('an AppImage on a system without user namespaces starts without the sandbox', (t) => {
  const f = tree(t);
  const env = { PATH: `${f.refuse}:${process.env.PATH}`, APPIMAGE: path.join(f.root, 'S.AppImage'), APPDIR: f.mount };
  assert.equal(run(f.appimage, env), '--no-sandbox --x');
  // Not twice.
  assert.equal(run(f.appimage, env, ['--no-sandbox']), '--no-sandbox');
});

test('an AppImage where user namespaces work keeps the sandbox', (t) => {
  const f = tree(t);
  assert.equal(run(f.appimage, { PATH: `${f.allow}:${process.env.PATH}`, APPIMAGE: path.join(f.root, 'S.AppImage'), APPDIR: f.mount }), '--x');
});

test('a deb install never drops the sandbox, even with an inherited APPIMAGE', (t) => {
  const f = tree(t);
  const env = { PATH: `${f.refuse}:${process.env.PATH}`, APPIMAGE: '/home/u/Editor.AppImage', APPDIR: f.mount };
  assert.equal(run(f.deb, env), '--x');
  // Through the /usr/bin link, too.
  const link = path.join(f.root, 'strafe-desktop-link');
  fs.symlinkSync(f.deb, link);
  assert.equal(run(link, env), '--x');
});
