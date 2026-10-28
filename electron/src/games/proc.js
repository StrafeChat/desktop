// Reading Linux's /proc for the scanner, and only what it needs.
//
// For every process: whose it is (the /proc/<pid> directory's owner; anyone else's is skipped
// before anything else is read), its parent and start time (/proc/<pid>/stat), and the
// program (the /proc/<pid>/exe link). The command line is read only for Java, Wine and
// Steam's reaper, and the environment only for Wine, and from that only the few launcher tags
// in ENV_KEYS (critique #16): both can hold other programs' secrets. Nothing read here is
// kept beyond the scan that read it, logged or written anywhere.

const fsp = require('node:fs/promises');
const path = require('node:path');

/** USER_HZ: what /proc counts start times in. 100 on every Linux architecture Strafe ships for. */
const CLK_TCK = 100;
/** The environment variables a Wine process's launcher tags are in; nothing else is kept. */
const ENV_KEYS = Object.freeze([
  'SteamAppId',
  'SteamGameId',
  'HEROIC_APP_NAME',
  'HEROIC_APP_RUNNER',
  'LUTRIS_GAME_UUID',
  'GAME_NAME',
  'WINEPREFIX',
  'STEAM_COMPAT_DATA_PATH',
]);
const ENV_KEY_SET = new Set(ENV_KEYS);
/** Larger than any real command line or environment; a bigger one is cut here. */
const CMDLINE_CAP = 256 * 1024;
const ENVIRON_CAP = 256 * 1024;
/** Directories read at once while listing. */
const CONCURRENCY = 32;

/**
 * Parent pid and start time (in clock ticks since boot) from a /proc/<pid>/stat line. The
 * program name in parentheses may hold spaces and parentheses itself, so the fields are
 * counted from the last ')'. Null when the line is not one.
 */
function parseStat(text) {
  const s = String(text);
  const close = s.lastIndexOf(')');
  if (close < 0) return null;
  // Field 3 (state) onwards; ppid is field 4, starttime field 22.
  const f = s.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(f[1]);
  const start = Number(f[19]);
  if (!Number.isInteger(ppid) || !Number.isFinite(start) || start < 0) return null;
  return { ppid, startTicks: start };
}

/** The boot time, in seconds since the epoch, from /proc/stat's btime line; 0 when unknown. */
async function readBtime(procRoot = '/proc') {
  try {
    const text = await fsp.readFile(path.join(procRoot, 'stat'), 'utf8');
    const m = /^btime\s+(\d+)\s*$/m.exec(text);
    return m ? Number(m[1]) : 0;
  } catch {
    return 0;
  }
}

/** Unix ms a process started, from its start ticks and the boot time. */
function startMs(btime, startTicks) {
  return btime > 0 ? Math.round(btime * 1000 + (startTicks * 1000) / CLK_TCK) : 0;
}

/** Up to `cap` bytes of a file, or null when it cannot be read. */
async function readCapped(file, cap) {
  let fh;
  try {
    fh = await fsp.open(file, 'r');
    const chunks = [];
    let total = 0;
    while (total < cap) {
      const buf = Buffer.alloc(Math.min(64 * 1024, cap - total));
      const { bytesRead } = await fh.read(buf, 0, buf.length, null);
      if (bytesRead === 0) break;
      chunks.push(buf.subarray(0, bytesRead));
      total += bytesRead;
    }
    return Buffer.concat(chunks);
  } catch {
    return null;
  } finally {
    await fh?.close().catch(() => {});
  }
}

/** Map fn over items with at most `n` running at once. */
async function pool(items, n, fn) {
  const out = new Array(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const i = next++;
      out[i] = await fn(items[i]);
    }
  };
  await Promise.all(Array.from({ length: Math.min(n, items.length) }, worker));
  return out;
}

/**
 * The processes of one user: [{ pid, ppid, startTicks }]. Kernel threads and processes that
 * end mid-listing drop out by themselves.
 * @param {{ procRoot?: string, uid?: number | null }} [o] uid null: everyone's (tests only).
 */
async function listProcesses({ procRoot = '/proc', uid = process.getuid?.() ?? null } = {}) {
  let names;
  try {
    names = await fsp.readdir(procRoot);
  } catch {
    return [];
  }
  const pids = names.filter((n) => /^\d+$/.test(n));
  const rows = await pool(pids, CONCURRENCY, async (name) => {
    const dir = path.join(procRoot, name);
    try {
      if (uid !== null) {
        const st = await fsp.stat(dir);
        if (st.uid !== uid) return null;
      }
      const stat = parseStat(await fsp.readFile(path.join(dir, 'stat'), 'utf8'));
      return stat ? { pid: Number(name), ...stat } : null;
    } catch {
      return null;
    }
  });
  return rows.filter(Boolean);
}

/** The program a process runs (resolved, as the kernel knows it), or '' when unreadable. */
async function readExe(procRoot, pid) {
  try {
    const p = await fsp.readlink(path.join(procRoot, String(pid), 'exe'));
    // A program replaced or removed while running.
    return p.endsWith(' (deleted)') ? p.slice(0, -' (deleted)'.length) : p;
  } catch {
    return '';
  }
}

/** argv without the trailing empty arguments Wine leaves; null when unreadable. */
async function readCmdline(procRoot, pid) {
  const buf = await readCapped(path.join(procRoot, String(pid), 'cmdline'), CMDLINE_CAP);
  if (!buf) return null;
  return splitArgs(buf.toString('utf8'));
}

function splitArgs(text) {
  const args = text.split('\0');
  while (args.length && args[args.length - 1] === '') args.pop();
  return args;
}

/** Only ENV_KEYS of an environment; everything else is dropped as it is read. */
function pickEnv(env) {
  const out = {};
  if (!env || typeof env !== 'object') return out;
  for (const k of ENV_KEYS) if (typeof env[k] === 'string') out[k] = env[k];
  return out;
}

/** ENV_KEYS from a process's environment, or null when unreadable. */
async function readEnviron(procRoot, pid) {
  const buf = await readCapped(path.join(procRoot, String(pid), 'environ'), ENVIRON_CAP);
  if (!buf) return null;
  const out = {};
  for (const entry of buf.toString('utf8').split('\0')) {
    const eq = entry.indexOf('=');
    if (eq <= 0) continue;
    const k = entry.slice(0, eq);
    if (ENV_KEY_SET.has(k)) out[k] = entry.slice(eq + 1);
  }
  return out;
}

module.exports = {
  CLK_TCK,
  ENV_KEYS,
  pool,
  parseStat,
  readBtime,
  startMs,
  listProcesses,
  readExe,
  readCmdline,
  readEnviron,
  splitArgs,
  pickEnv,
};
