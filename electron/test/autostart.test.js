const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const autostart = require('../src/autostart');
const { launchTarget } = require('../src/launch');

function tempHome(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strafe-autostart-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return { XDG_CONFIG_HOME: dir };
}

test('the entry is where the old shell put it, under XDG_CONFIG_HOME', () => {
  assert.equal(autostart.entryPath({ XDG_CONFIG_HOME: '/home/u/.cfg' }), '/home/u/.cfg/autostart/Strafe.desktop');
  // Relative values are to be ignored (XDG Base Directory spec).
  assert.equal(autostart.entryPath({ XDG_CONFIG_HOME: 'cfg' }), path.join(os.homedir(), '.config', 'autostart', 'Strafe.desktop'));
});

test('Exec quoting follows the Desktop Entry spec', () => {
  const q = autostart.quoteExecArg;
  assert.equal(q('/opt/Strafe/strafe'), '/opt/Strafe/strafe');
  assert.equal(q('--minimized'), '--minimized');
  assert.equal(q('/home/u/My Apps/Strafe.AppImage'), '"/home/u/My Apps/Strafe.AppImage"');
  assert.equal(q('/home/u/$HOME/x'), '"/home/u/\\\\$HOME/x"');
  assert.equal(q('/a"b'), '"/a\\\\"b"');
  assert.equal(q('/a`b'), '"/a\\\\`b"');
  // A literal backslash in a quoted argument is four in the file.
  assert.equal(q('/a b\\c'), '"/a b\\\\\\\\c"');
  // % starts a field code.
  assert.equal(q('/100%/x'), '/100%%/x');
  assert.equal(q(''), '""');
});

test('the entry launches the AppImage with --minimized', () => {
  const argv = autostart.launchArgv({
    env: { APPIMAGE: '/home/u/Applications/Strafe.AppImage', APPDIR: '/tmp/.mount_x' },
    execPath: '/tmp/.mount_x/strafe',
    realpath: (p) => p,
  });
  assert.deepEqual(argv, ['/home/u/Applications/Strafe.AppImage', '--minimized']);
  const entry = autostart.buildEntry(argv);
  assert.match(entry, /^\[Desktop Entry\]\n/);
  assert.equal(autostart.entryValue(entry, 'Exec'), '/home/u/Applications/Strafe.AppImage --minimized');
  assert.equal(autostart.entryValue(entry, 'Type'), 'Application');
  assert.equal(autostart.entryValue(entry, 'Name'), 'Strafe');
  assert.equal(autostart.entryValue(entry, 'Terminal'), 'false');
});

test('launch target: AppImage, else the launcher beside the binary, else the binary', () => {
  const exists = (p) => p === '/opt/Strafe/strafe-desktop';
  const realpath = (p) => p;
  assert.equal(launchTarget({ env: { APPIMAGE: '/a/S.AppImage', APPDIR: '/tmp/.mount_s' }, execPath: '/tmp/.mount_s/strafe', exists, realpath }), '/a/S.AppImage');
  // Started from another program that is an AppImage: its APPIMAGE/APPDIR are inherited, and
  // are not ours - the deb or rpm restarts itself, not that program.
  assert.equal(
    launchTarget({ env: { APPIMAGE: '/home/u/Editor.AppImage', APPDIR: '/tmp/.mount_ed' }, execPath: '/opt/Strafe/strafe', exists, realpath }),
    '/opt/Strafe/strafe-desktop',
  );
  assert.equal(launchTarget({ env: { APPIMAGE: '/home/u/Editor.AppImage' }, execPath: '/opt/Strafe/strafe', exists, realpath }), '/opt/Strafe/strafe-desktop');
  assert.equal(launchTarget({ env: {}, execPath: '/opt/Strafe/strafe', exists }), '/opt/Strafe/strafe-desktop');
  assert.equal(launchTarget({ env: {}, execPath: '/usr/lib/strafe/strafe', exists }), '/usr/lib/strafe/strafe');
  // Development: the app directory follows the binary.
  assert.deepEqual(autostart.launchArgv({ env: {}, execPath: '/x/electron', exists, appPath: '/src/electron' }), ['/x/electron', '/src/electron', '--minimized']);
});

test('enable, isEnabled, disable', (t) => {
  const env = tempHome(t);
  const opts = { env, execPath: '/opt/Strafe/strafe', exists: () => false };
  assert.equal(autostart.isEnabled(opts), false);
  autostart.enable(opts);
  assert.equal(autostart.isEnabled(opts), true);
  const text = fs.readFileSync(autostart.entryPath(env), 'utf8');
  assert.equal(autostart.entryValue(text, 'Exec'), '/opt/Strafe/strafe --minimized');
  autostart.disable(opts);
  assert.equal(autostart.isEnabled(opts), false);
  // Disabling twice is fine.
  autostart.disable(opts);
});

test('an entry the desktop switched off counts as off', (t) => {
  const env = tempHome(t);
  const file = autostart.entryPath(env);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, '[Desktop Entry]\nType=Application\nExec=/x --minimized\nHidden=true\n');
  assert.equal(autostart.isEnabled({ env }), false);
  fs.writeFileSync(file, '[Desktop Entry]\nExec=/x\nX-GNOME-Autostart-enabled=false\n');
  assert.equal(autostart.isEnabled({ env }), false);
  // Hidden=true in some other group is not ours to read.
  fs.writeFileSync(file, '[Desktop Entry]\nExec=/x\n[Desktop Action foo]\nHidden=true\n');
  assert.equal(autostart.isEnabled({ env }), true);
});

test('refresh points a stale entry at this copy, and leaves a current or absent one alone', (t) => {
  const env = tempHome(t);
  const file = autostart.entryPath(env);
  const opts = { env: { ...env, APPIMAGE: '/home/u/New Place/Strafe.AppImage', APPDIR: '/tmp/.mount' }, execPath: '/tmp/.mount/strafe', realpath: (p) => p };
  assert.equal(autostart.refresh(opts), false);
  assert.equal(fs.existsSync(file), false);

  // What tauri-plugin-autostart wrote for the old AppImage.
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(
    file,
    '[Desktop Entry]\nType=Application\nVersion=1.0\nName=Strafe\nComment=Strafe startup script\nExec=/home/u/Old/Strafe.AppImage --minimized\nStartupNotify=false\nTerminal=false',
  );
  assert.equal(autostart.refresh(opts), true);
  assert.equal(autostart.entryValue(fs.readFileSync(file, 'utf8'), 'Exec'), '"/home/u/New Place/Strafe.AppImage" --minimized');
  assert.equal(autostart.refresh(opts), false);
});
