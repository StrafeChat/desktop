const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const store = require('../src/store');

function tempDir(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strafe-store-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

test('the accounts file is written whole, owner-only, with no temporary left behind', (t) => {
  const dir = tempDir(t);
  const accounts = { active: 'a.local:1', accounts: { 'a.local:1': { token: 'secret' } } };
  store.saveAccounts(dir, accounts);
  const file = path.join(dir, 'accounts.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(store.loadAccounts(dir), accounts);
  assert.deepEqual(fs.readdirSync(dir), ['accounts.json']);
});

test('a leftover temporary file with loose permissions does not loosen the new file', (t) => {
  const dir = tempDir(t);
  const file = path.join(dir, 'accounts.json');
  fs.writeFileSync(`${file}.tmp`, 'half', { mode: 0o644 });
  fs.chmodSync(`${file}.tmp`, 0o644);
  store.writeJsonAtomic(file, { a: 1 });
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(store.readJson(file), { a: 1 });
});

test('the directory is created when missing (a first start)', (t) => {
  const dir = path.join(tempDir(t), 'chat.strafe.desktop');
  store.saveAccounts(dir, null);
  assert.equal(store.loadAccounts(dir), null);
  assert.ok(fs.existsSync(path.join(dir, 'accounts.json')));
});

test('no accounts file, or a broken one, is null', (t) => {
  const dir = tempDir(t);
  assert.equal(store.loadAccounts(dir), null);
  fs.writeFileSync(path.join(dir, 'accounts.json'), '{"half');
  assert.equal(store.loadAccounts(dir), null);
});

test('prefs: defaults for a missing file, a missing field, or a wrong type', (t) => {
  const dir = tempDir(t);
  assert.deepEqual(store.loadPrefs(dir), { closeToTray: true, startMinimized: true, discordPresence: true });
  // An older file, as an older Tauri app wrote it: no discordPresence yet, and an unknown field.
  fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ closeToTray: false, startMinimized: false, somethingOld: 1 }));
  assert.deepEqual(store.loadPrefs(dir), { closeToTray: false, startMinimized: false, discordPresence: true });
  fs.writeFileSync(path.join(dir, 'prefs.json'), JSON.stringify({ closeToTray: 'no' }));
  assert.equal(store.loadPrefs(dir).closeToTray, true);
  fs.writeFileSync(path.join(dir, 'prefs.json'), '[1,2]');
  assert.deepEqual(store.loadPrefs(dir), { ...store.DEFAULT_PREFS });
});

test('prefs are saved in the shape the Tauri shell reads: the three camelCase fields', (t) => {
  const dir = tempDir(t);
  const saved = store.savePrefs(dir, { closeToTray: false, discordPresence: false, extra: 'dropped' });
  assert.deepEqual(saved, { closeToTray: false, startMinimized: true, discordPresence: false });
  assert.deepEqual(JSON.parse(fs.readFileSync(path.join(dir, 'prefs.json'), 'utf8')), saved);
});
