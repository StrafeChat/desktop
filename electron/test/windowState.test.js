const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { validateWindowState, readWindowState, writeWindowState } = require('../src/windowState');

const LAPTOP = { x: 0, y: 0, width: 1920, height: 1050 };
const RIGHT = { x: 1920, y: 0, width: 2560, height: 1410 };

test('nothing saved: the default size, centred', () => {
  assert.deepEqual(validateWindowState(null, [LAPTOP]), { width: 1280, height: 820, maximized: false });
  assert.deepEqual(validateWindowState('junk', [LAPTOP]), { width: 1280, height: 820, maximized: false });
});

test('a position on a display is kept', () => {
  assert.deepEqual(validateWindowState({ x: 100, y: 50, width: 1400, height: 900, maximized: true }, [LAPTOP, RIGHT]), {
    x: 100,
    y: 50,
    width: 1400,
    height: 900,
    maximized: true,
  });
  assert.equal(validateWindowState({ x: 2000, y: 100, width: 1400, height: 900 }, [LAPTOP, RIGHT]).x, 2000);
});

test('a display that is gone: the size stays, the position goes', () => {
  // Saved on the right-hand monitor, which has since been unplugged.
  assert.deepEqual(validateWindowState({ x: 2200, y: 100, width: 1400, height: 900 }, [LAPTOP]), {
    width: 1400,
    height: 900,
    maximized: false,
  });
  // A sliver on screen is as good as gone.
  const sliver = validateWindowState({ x: 1900, y: 100, width: 1400, height: 900 }, [LAPTOP]);
  assert.equal(sliver.x, undefined);
});

test('partly off a display: pulled fully onto it, title bar first', () => {
  const s = validateWindowState({ x: 1000, y: -40, width: 1400, height: 900 }, [LAPTOP]);
  assert.deepEqual(s, { x: 520, y: 0, width: 1400, height: 900, maximized: false });
});

test('too small or too big for the display it lands on', () => {
  assert.deepEqual(validateWindowState({ x: 10, y: 10, width: 200, height: 100 }, [LAPTOP]), {
    x: 10,
    y: 10,
    width: 900,
    height: 560,
    maximized: false,
  });
  const big = validateWindowState({ x: 0, y: 0, width: 2560, height: 1400 }, [LAPTOP]);
  assert.deepEqual(big, { x: 0, y: 0, width: 1920, height: 1050, maximized: false });
});

test('nonsense values are ignored, not trusted', () => {
  const s = validateWindowState({ x: 'left', y: 10, width: Infinity, height: -5, maximized: 'yes' }, [LAPTOP]);
  assert.deepEqual(s, { width: 1280, height: 820, maximized: false });
  assert.equal(validateWindowState({ x: 1.5, y: 2, width: 1000, height: 700 }, [LAPTOP]).x, undefined);
});

test('written and read back', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strafe-ws-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  assert.equal(readWindowState(dir), null);
  writeWindowState(dir, { x: 5, y: 6, width: 1000, height: 700, extra: 1 }, true);
  assert.deepEqual(readWindowState(dir), { x: 5, y: 6, width: 1000, height: 700, maximized: true });
});

test("the Tauri shell's .window-state.json is used the first time, in logical pixels", () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strafe-ws-tauri-'));
  try {
    // What tauri-plugin-window-state wrote at a 1.25 display scale.
    fs.writeFileSync(
      path.join(dir, '.window-state.json'),
      JSON.stringify({ main: { width: 1600, height: 1025, x: 520, y: 482, prev_x: 0, prev_y: 0, maximized: true, visible: true, decorated: false, fullscreen: false } }),
    );
    assert.deepEqual(readWindowState(dir, 1.25), { x: 416, y: 386, width: 1280, height: 820, maximized: true });
    // Once this shell has saved its own, that is what counts.
    writeWindowState(dir, { x: 10, y: 20, width: 1000, height: 700 }, false);
    assert.deepEqual(readWindowState(dir, 1.25), { x: 10, y: 20, width: 1000, height: 700, maximized: false });
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
