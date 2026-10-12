const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const updater = require('../src/updater');
const UPDATE_PUBKEY = require('../src/updateKey');
const { parsePublicKey } = require('../src/minisign');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));

test('the release key is the one the Tauri shell carries', () => {
  const conf = JSON.parse(fs.readFileSync(path.join(__dirname, '..', '..', 'src-tauri', 'tauri.conf.json'), 'utf8'));
  assert.equal(UPDATE_PUBKEY, conf.plugins.updater.pubkey);
  // ...and it is a key, not just a string.
  assert.equal(parsePublicKey(UPDATE_PUBKEY).keyId.length, 8);
});

test('compareVersions: numbers compare as numbers', () => {
  const c = updater.compareVersions;
  assert.equal(c('1.3.2', '1.3.2'), 0);
  assert.equal(c('1.3.3', '1.3.2'), 1);
  assert.equal(c('1.3.2', '1.4.0'), -1);
  assert.equal(c('1.10.0', '1.9.9'), 1);
  assert.equal(c('2.0.0', '1.99.99'), 1);
  assert.equal(c('v1.4.0', '1.4.0'), 0);
  assert.equal(c('1.4.0+build.7', '1.4.0'), 0);
});

test('compareVersions: a prerelease sorts before its release', () => {
  const c = updater.compareVersions;
  assert.equal(c('1.4.0-beta.1', '1.4.0'), -1);
  assert.equal(c('1.4.0', '1.4.0-beta.1'), 1);
  assert.equal(c('1.4.0-beta.1', '1.3.9'), 1);
  assert.equal(c('1.4.0-alpha', '1.4.0-beta'), -1);
  assert.equal(c('1.4.0-beta.2', '1.4.0-beta.10'), -1);
  assert.equal(c('1.4.0-beta', '1.4.0-beta.1'), -1);
  assert.equal(c('1.4.0-1', '1.4.0-alpha'), -1);
});

test('compareVersions refuses what is not a version', () => {
  assert.throws(() => updater.compareVersions('1.3', '1.3.0'));
  assert.throws(() => updater.compareVersions('latest', '1.3.0'));
  assert.equal(updater.parseVersion('1.2.3.4'), null);
});

test('entryKey names the platform the way latest.json does', () => {
  assert.equal(updater.entryKey('x64', 'appimage'), 'linux-x86_64-appimage');
  assert.equal(updater.entryKey('x64', 'deb'), 'linux-x86_64-deb');
  assert.equal(updater.entryKey('arm64', 'rpm'), 'linux-aarch64-rpm');
  assert.equal(updater.entryKey('ia32', 'deb'), null);
  assert.equal(updater.entryKey('x64', 'tarball'), null);
});

const SIG = 'c2ln';
const feed = {
  version: '1.4.0',
  notes: 'Calls on Linux',
  platforms: {
    'linux-x86_64': { url: 'https://example.invalid/Strafe_1.4.0_amd64.AppImage', signature: SIG },
    'linux-x86_64-deb': { url: 'https://example.invalid/Strafe_1.4.0_amd64.deb', signature: SIG },
    'windows-x86_64': { url: 'https://example.invalid/Strafe_1.4.0_x64-setup.exe', signature: SIG },
  },
};

test('pickEntry takes the exact entry, and the plain one only for an AppImage', () => {
  assert.deepEqual(updater.pickEntry(feed, 'x64', 'deb'), {
    key: 'linux-x86_64-deb',
    url: 'https://example.invalid/Strafe_1.4.0_amd64.deb',
    signature: SIG,
  });
  assert.equal(updater.pickEntry(feed, 'x64', 'appimage').key, 'linux-x86_64');
  // A deb install must never be handed the AppImage.
  assert.equal(updater.pickEntry(feed, 'x64', 'rpm'), null);
  assert.equal(updater.pickEntry(feed, 'arm64', 'appimage'), null);
  const exact = { platforms: { ...feed.platforms, 'linux-x86_64-appimage': { url: 'https://example.invalid/a', signature: SIG } } };
  assert.equal(updater.pickEntry(exact, 'x64', 'appimage').key, 'linux-x86_64-appimage');
});

test('pickEntry refuses malformed entries and plain http', () => {
  const bad = {
    platforms: {
      'linux-x86_64-deb': { url: 'http://example.invalid/a.deb', signature: SIG },
      'linux-x86_64-rpm': { url: 'https://example.invalid/a.rpm' },
      'linux-x86_64-appimage': { url: 42, signature: SIG },
    },
  };
  assert.equal(updater.pickEntry(bad, 'x64', 'deb'), null);
  assert.equal(updater.pickEntry(bad, 'x64', 'deb', { allowHttp: true }).key, 'linux-x86_64-deb');
  assert.equal(updater.pickEntry(bad, 'x64', 'rpm'), null);
  assert.equal(updater.pickEntry(bad, 'x64', 'appimage'), null);
  assert.equal(updater.pickEntry(null, 'x64', 'deb'), null);
  assert.equal(updater.pickEntry({ platforms: { __proto__: null } }, 'x64', 'deb'), null);
  // Not an own property: nothing inherited counts.
  assert.equal(updater.pickEntry({ platforms: Object.create({ 'linux-x86_64-deb': feed.platforms['linux-x86_64-deb'] }) }, 'x64', 'deb'), null);
});

test('installKind: deb/rpm from the package-type file, AppImage only from its own mount', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strafe-kind-'));
  const realpath = (p) => p;
  const own = { APPIMAGE: '/home/u/Strafe.AppImage', APPDIR: '/tmp/.mount_s' };
  try {
    assert.equal(updater.installKind(own, dir, '/tmp/.mount_s/strafe-desktop.bin', realpath), 'appimage');
    assert.equal(updater.installKind({}, dir, '/opt/Strafe/strafe-desktop.bin', realpath), null);
    // Inherited from another AppImage (its terminal, say): not ours.
    const inherited = { APPIMAGE: '/home/u/Editor.AppImage', APPDIR: '/tmp/.mount_ed' };
    assert.equal(updater.installKind(inherited, dir, '/opt/Strafe/strafe-desktop.bin', realpath), null);
    assert.equal(updater.installKind({ APPIMAGE: '/home/u/Editor.AppImage' }, dir, '/opt/Strafe/strafe-desktop.bin', realpath), null);
    fs.writeFileSync(path.join(dir, 'package-type'), 'deb\n');
    assert.equal(updater.installKind({}, dir), 'deb');
    // The package's own word wins over anything in the environment.
    assert.equal(updater.installKind(inherited, dir, '/opt/Strafe/strafe-desktop.bin', realpath), 'deb');
    fs.writeFileSync(path.join(dir, 'package-type'), 'rpm');
    assert.equal(updater.installKind({}, dir), 'rpm');
    fs.writeFileSync(path.join(dir, 'package-type'), 'pacman');
    assert.equal(updater.installKind({}, dir, '/opt/x', realpath), null);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('bundleName: the release file names, x64 only', () => {
  assert.equal(updater.bundleName('appimage', '1.4.0', 'x64'), 'Strafe_1.4.0_amd64.AppImage');
  assert.equal(updater.bundleName('deb', '1.4.0', 'x64'), 'Strafe_1.4.0_amd64.deb');
  assert.equal(updater.bundleName('rpm', '1.4.0', 'x64'), 'Strafe-1.4.0-1.x86_64.rpm');
  assert.equal(updater.bundleName('deb', '1.4.0', 'arm64'), null);
});

test('verifyUpdate with a bundle: the signature must name that very file and version', () => {
  const pub = fixture('test-only.key.pub').toString('utf8');
  const versioned = { signature: fixture('update-versioned.txt.sig').toString('utf8') };
  const plain = { signature: fixture('update.txt.sig').toString('utf8') };
  const data = fixture('update-versioned.txt');
  assert.equal(updater.signedField(versioned.signature, 'file'), 'update-versioned.txt');
  assert.equal(updater.verifyUpdate(data, versioned, '9.8.7', pub, 'update-versioned.txt'), true);
  // The same signed bytes offered as another kind of bundle (a deb install handed the
  // AppImage, say) are refused.
  assert.equal(updater.verifyUpdate(data, versioned, '9.8.7', pub, 'Strafe_9.8.7_amd64.deb'), false);
  assert.equal(updater.verifyUpdate(data, versioned, '9.9.0', pub, 'update-versioned.txt'), false);
  // No version in the trusted comment: fine for the loose check, refused for an update.
  assert.equal(updater.verifyUpdate(fixture('update.txt'), plain, '1.4.0', pub), true);
  assert.equal(updater.verifyUpdate(fixture('update.txt'), plain, '1.4.0', pub, 'update.txt'), false);
});

test('verifyUpdate: signature by the key, and the signed version when there is one', () => {
  const pub = fixture('test-only.key.pub').toString('utf8');
  const plain = { signature: fixture('update.txt.sig').toString('utf8') };
  const versioned = { signature: fixture('update-versioned.txt.sig').toString('utf8') };

  assert.equal(updater.signedVersion(plain.signature), null);
  assert.equal(updater.signedVersion(versioned.signature), '9.8.7');

  // No version in the signature: the signature alone decides.
  assert.equal(updater.verifyUpdate(fixture('update.txt'), plain, '1.4.0', pub), true);
  // A version in the signature must be the one the feed announced.
  assert.equal(updater.verifyUpdate(fixture('update-versioned.txt'), versioned, '9.8.7', pub), true);
  assert.equal(updater.verifyUpdate(fixture('update-versioned.txt'), versioned, '9.9.0', pub), false);
  // Wrong file, wrong key, garbage: all false, none throw.
  assert.equal(updater.verifyUpdate(fixture('update-versioned.txt'), plain, '1.4.0', pub), false);
  assert.equal(updater.verifyUpdate(fixture('update.txt'), plain, '1.4.0', fixture('other-test-only.key.pub').toString('utf8')), false);
  assert.equal(updater.verifyUpdate(fixture('update.txt'), { signature: 'junk' }, '1.4.0', pub), false);
  // And never against anything but the release key by default.
  assert.equal(updater.verifyUpdate(fixture('update.txt'), plain, '1.4.0'), false);
});
