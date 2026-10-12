// Where the main window was: window-state.json in the config directory, read once at start
// and written as the window moves. No Electron here, so the tests can load it.

const path = require('node:path');
const { readJson, writeJsonAtomic } = require('./store');

const STATE_FILE = 'window-state.json';
/** What the Tauri shell's window-state plugin keeps in the same directory, in physical pixels. */
const TAURI_STATE_FILE = '.window-state.json';

const LIMITS = Object.freeze({ width: 1280, height: 820, minWidth: 900, minHeight: 560 });

/** How much of the window must overlap a display for its old position to be worth keeping:
 * enough to grab the title bar and drag it back. */
const MIN_VISIBLE = 64;

function overlap(a, b) {
  const w = Math.min(a.x + a.width, b.x + b.width) - Math.max(a.x, b.x);
  const h = Math.min(a.y + a.height, b.y + b.height) - Math.max(a.y, b.y);
  return w >= MIN_VISIBLE && h >= MIN_VISIBLE ? w * h : 0;
}

const isInt = (n) => Number.isSafeInteger(n);

/**
 * Turn whatever was saved into bounds that are safe to open with on the displays there are
 * now (each display's work area: {x, y, width, height}).
 *
 * The size is kept, no smaller than the window's minimum. The position is kept only when
 * the window would still meaningfully overlap a display - a monitor that has since been
 * unplugged must not leave the window off-screen - and is then nudged so the whole window
 * fits on that display, title bar included (the client draws it, at the very top). With no
 * usable position, x and y are left out and the window opens centred.
 */
function validateWindowState(saved, workAreas = [], limits = LIMITS) {
  /** @type {{ x?: number, y?: number, width: number, height: number, maximized: boolean }} */
  const out = { width: limits.width, height: limits.height, maximized: false };
  if (!saved || typeof saved !== 'object') return out;
  out.maximized = saved.maximized === true;
  if (isInt(saved.width) && isInt(saved.height) && saved.width > 0 && saved.height > 0) {
    out.width = Math.max(limits.minWidth, saved.width);
    out.height = Math.max(limits.minHeight, saved.height);
  }
  if (!isInt(saved.x) || !isInt(saved.y)) return out;

  const rect = { x: saved.x, y: saved.y, width: out.width, height: out.height };
  let best = null;
  let bestArea = 0;
  for (const wa of workAreas) {
    const a = overlap(rect, wa);
    if (a > bestArea) {
      best = wa;
      bestArea = a;
    }
  }
  if (!best) return out;
  // A window bigger than the display it lands on is shrunk to fit (not below the minimum).
  out.width = Math.max(limits.minWidth, Math.min(out.width, best.width));
  out.height = Math.max(limits.minHeight, Math.min(out.height, best.height));
  out.x = Math.max(best.x, Math.min(saved.x, best.x + best.width - out.width));
  out.y = Math.max(best.y, Math.min(saved.y, best.y + best.height - out.height));
  return out;
}

/**
 * The saved state, or - the first time, on a machine that ran the Tauri shell - that shell's,
 * so moving to this app keeps the window where it was. Tauri saved physical pixels; `scale`
 * (the display scale factor) turns them into the logical ones Electron positions with.
 */
function readWindowState(dir, scale = 1) {
  const own = readJson(path.join(dir, STATE_FILE));
  if (own) return own;
  const tauri = readJson(path.join(dir, TAURI_STATE_FILE));
  const m = tauri && typeof tauri === 'object' ? tauri.main : null;
  if (!m || typeof m !== 'object') return null;
  const s = Number.isFinite(scale) && scale > 0 ? scale : 1;
  const logical = (v) => (Number.isFinite(v) ? Math.round(v / s) : undefined);
  return { x: logical(m.x), y: logical(m.y), width: logical(m.width), height: logical(m.height), maximized: m.maximized === true };
}

/** `bounds` are the window's normal (unmaximised) bounds, so a maximised window comes back
 * maximised and still remembers the size to restore to. */
function writeWindowState(dir, bounds, maximized) {
  const { x, y, width, height } = bounds;
  writeJsonAtomic(path.join(dir, STATE_FILE), { x, y, width, height, maximized: !!maximized });
}

module.exports = { STATE_FILE, TAURI_STATE_FILE, LIMITS, validateWindowState, readWindowState, writeWindowState };
