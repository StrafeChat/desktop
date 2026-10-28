const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const proc = require('../src/games/proc');
const store = require('../src/store');
const prefsStore = require('../src/games/prefs');
const { loadGames, gamesFile, compileGames } = require('../src/games/data');
const { parseVdf, get, libraryPaths, appManifest } = require('../src/games/vdf');
const { winePath } = require('../src/games/wine');
const { Indexes, lutrisGame, CHECK_INTERVAL_MS } = require('../src/games/indexes');
const { classify, isSteamReaper, matchSnapshot, needs, slugify, steamLaunchAppId } = require('../src/games/matcher');
const { Tracker } = require('../src/games/tracker');
const { cleanName, validName } = require('../src/games/text');
const { Games, OFFER_TTL_MS } = require('../src/games');

const DESKTOP = path.resolve(__dirname, '..', '..');
const FIXTURES = path.join(DESKTOP, 'test', 'games');
const GAMES_JSON = path.join(DESKTOP, 'games.json');
const cp = String.fromCodePoint;

const data = loadGames(GAMES_JSON);

function tempDir(t, prefix = 'strafe-games-') {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  return dir;
}

/** test/games copied with {FIXTURES} replaced by the copy's path (README.md, step 1). */
function copyFixtures(t) {
  const dest = tempDir(t, 'strafe-games-fixtures-');
  const walk = (from, to) => {
    for (const ent of fs.readdirSync(from, { withFileTypes: true })) {
      const a = path.join(from, ent.name);
      const b = path.join(to, ent.name);
      if (ent.isDirectory()) {
        fs.mkdirSync(b, { recursive: true });
        walk(a, b);
      } else {
        fs.writeFileSync(b, fs.readFileSync(a, 'utf8').replaceAll('{FIXTURES}', dest));
      }
    }
  };
  walk(FIXTURES, dest);
  return dest;
}

function fixtureRoots(dir) {
  return { steam: [path.join(dir, 'steam')], heroic: [path.join(dir, 'heroic')], lutris: [path.join(dir, 'lutris')] };
}

async function fixtureIndex(t) {
  const dir = copyFixtures(t);
  const index = new Indexes({ roots: fixtureRoots(dir), data, home: '/home/someone' });
  await index.refresh({ force: true });
  return { dir, index };
}

/** A fake /proc: { pid, ppid, ticks, exe, comm?, cmdline?, environ? } per process. */
function fakeProc(root, procs, btime = 1761000000) {
  fs.writeFileSync(path.join(root, 'stat'), `cpu  1 2 3 4\nintr 0\nbtime ${btime}\nprocesses 1\n`);
  for (const p of procs) {
    const dir = path.join(root, String(p.pid));
    fs.mkdirSync(dir, { recursive: true });
    const comm = p.comm || path.basename(p.exe).slice(0, 15);
    fs.writeFileSync(path.join(dir, 'stat'), `${p.pid} (${comm}) S ${p.ppid} ${p.pid} ${p.pid} 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 ${p.ticks} 1000 100 18446744073709551615\n`);
    if (p.exe) fs.symlinkSync(p.exe, path.join(dir, 'exe'));
    fs.writeFileSync(path.join(dir, 'cmdline'), p.cmdline ? `${p.cmdline.join('\0')}\0` : '');
    fs.writeFileSync(path.join(dir, 'environ'), p.environ ? `${Object.entries(p.environ).map(([k, v]) => `${k}=${v}`).join('\0')}\0` : '');
  }
}

/** The /proc readers, counting which pids had their command line or environment read. */
function countingIo() {
  const reads = { list: 0, cmdline: new Set(), environ: new Set() };
  const io = {
    ...proc,
    listProcesses: async (o) => {
      reads.list++;
      return proc.listProcesses(o);
    },
    readCmdline: async (root, pid) => {
      reads.cmdline.add(pid);
      return proc.readCmdline(root, pid);
    },
    readEnviron: async (root, pid) => {
      reads.environ.add(pid);
      return proc.readEnviron(root, pid);
    },
  };
  return { io, reads };
}

// ---- the cases both shells run ---------------------------------------------------------------

test('cases.json: every case for the node shell', async (t) => {
  const { dir, index } = await fixtureIndex(t);
  const cases = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cases.json'), 'utf8').replaceAll('{FIXTURES}', dir));
  const mine = cases.filter((c) => c.shells.includes('node'));
  assert.ok(mine.length >= 40, `only ${mine.length} node cases`);
  for (const c of mine) {
    const ctx = { os: c.os, data, index, user: c.user || [] };
    const hidden = new Set(c.hidden || []);
    const renames = c.renames || {};
    const tracker = new Tracker();
    const scans = c.scans || [{ processes: c.processes, expect: c.expect }];
    scans.forEach((scan, i) => {
      const s = tracker.update(matchSnapshot(scan.processes, ctx, c.self_pid), hidden);
      const got = s ? { key: s.key, name: renames[s.key] || s.name, started_at: s.startedAt } : null;
      assert.deepEqual(got, scan.expect, `${c.name}${scans.length > 1 ? ` (scan ${i + 1})` : ''}`);
    });
  }
});

test('cases.json: well formed, every shell named, every key in the agreed shapes', () => {
  const cases = JSON.parse(fs.readFileSync(path.join(FIXTURES, 'cases.json'), 'utf8'));
  const names = new Set();
  const keyRe = /^(user:[\w-]+|steam:\d+|epic:\w+|heroic:(legendary|gog|nile|sideload|zoom):[\w-]+|lutris:[a-z0-9-]+|curated:[a-z0-9-]+)$/;
  const groups = { both: 0, rust: 0 };
  for (const c of cases) {
    assert.ok(!names.has(c.name), `duplicate case name: ${c.name}`);
    names.add(c.name);
    assert.ok(['linux', 'win32', 'darwin'].includes(c.os), c.name);
    assert.ok(c.shells.length && c.shells.every((s) => s === 'node' || s === 'rust'), c.name);
    if (c.shells.length === 2) groups.both++;
    if (c.shells.includes('rust')) groups.rust++;
    for (const scan of c.scans || [{ processes: c.processes, expect: c.expect }]) {
      assert.ok(Array.isArray(scan.processes), c.name);
      for (const p of scan.processes) {
        assert.ok(Number.isInteger(p.pid) && Number.isInteger(p.ppid) && Number.isInteger(p.start_ms) && typeof p.exe === 'string', c.name);
        assert.ok(Array.isArray(p.cmdline) && p.environ && typeof p.environ === 'object', c.name);
      }
      if (scan.expect !== null) {
        assert.match(scan.expect.key, keyRe, c.name);
        assert.equal(typeof scan.expect.name, 'string', c.name);
        assert.ok(Number.isInteger(scan.expect.started_at), c.name);
      }
    }
  }
  // The rules both shells share are tested in both.
  assert.ok(groups.both >= 30, `${groups.both} shared cases`);
  assert.ok(groups.rust > groups.both, 'rust runs the shared cases plus its own');
});

// ---- games.json ----------------------------------------------------------------------------------

test('games.json: our own list, sound, and a command line only for Java', () => {
  const raw = JSON.parse(fs.readFileSync(GAMES_JSON, 'utf8'));
  assert.equal(raw.version, 1);
  assert.equal(raw.license, 'CC0-1.0');
  assert.ok(raw.curated.length >= 30, `${raw.curated.length} curated games`);
  const ids = new Set();
  for (const g of raw.curated) {
    assert.match(g.id, /^[a-z0-9][a-z0-9-]*$/);
    assert.ok(!ids.has(g.id), `duplicate id ${g.id}`);
    ids.add(g.id);
    assert.ok(cleanName(g.name) === g.name, `name not clean: ${g.name}`);
    assert.ok(g.match.length > 0, g.id);
    for (const r of g.match) {
      assert.ok(['win32', 'darwin', 'linux'].includes(r.os), `${g.id}: os ${r.os}`);
      assert.ok(typeof r.exe === 'string' && r.exe && !/[\\/]/.test(r.exe), `${g.id}: exe is a file name`);
      if (r.cmdlineAny) assert.ok(['java', 'javaw', 'java.exe', 'javaw.exe'].includes(r.exe.toLowerCase()), `${g.id}: cmdlineAny on ${r.exe}`);
      for (const k of Object.keys(r)) assert.ok(['os', 'exe', 'pathContains', 'cmdlineAny'].includes(k), `${g.id}: unknown field ${k}`);
    }
  }
  // Compiled, every entry survives (nothing malformed was dropped quietly).
  assert.equal(data.curated.length, raw.curated.length);
  for (const list of ['launchers', 'helpers', 'interpreters', 'wineLoaders', 'launcherLabels', 'steamToolAppids', 'steamToolNamePrefixes']) {
    assert.ok(Array.isArray(raw[list]) && raw[list].every((s) => typeof s === 'string' && s), list);
  }
  assert.ok(raw.steamToolAppids.every((id) => /^\d+$/.test(id)));
  for (const t of ['Minecraft', 'Roblox', 'League of Legends', 'VALORANT', 'Overwatch 2', 'World of Warcraft', 'Fortnite', 'Marvel Rivals', 'Old School RuneScape']) {
    assert.ok(raw.curated.some((g) => g.name === t), `missing ${t}`);
  }
});

test('games.json: a command-line rule on anything but Java is dropped when compiled', () => {
  const d = compileGames({ curated: [{ id: 'x', name: 'X', match: [{ os: 'win32', exe: 'x.exe', cmdlineAny: ['--token'] }] }, { id: 'y', name: 'Y', match: [{ os: 'moon', exe: 'y' }] }] });
  assert.equal(d.curated.length, 0);
});

test('games.json is packaged with the Linux app and found in both layouts', () => {
  const yml = fs.readFileSync(path.join(DESKTOP, 'electron', 'electron-builder.yml'), 'utf8');
  assert.match(yml, /- from: \.\.\/games\.json\n\s+to: games\.json/);
  assert.equal(gamesFile({ packaged: false }), GAMES_JSON);
  assert.equal(gamesFile({ packaged: true, resourcesPath: '/opt/Strafe/resources' }), '/opt/Strafe/resources/games.json');
});

// ---- the pieces ----------------------------------------------------------------------------------

test('vdf: nesting, escaped backslashes and quotes, comments, conditions, case-insensitive keys', () => {
  const v = parseVdf(['"Root"', '{', '  // a comment', '  "Path"  "C:\\\\Program Files (x86)\\\\Steam"', '  "label" "say \\"hi\\""', '  "win" "1" [$WIN32]', '  bare token', '  "n" { "a" "1" "a" "2" }', '}'].join('\n'));
  const root = get(v, 'root');
  assert.equal(get(root, 'path'), 'C:\\Program Files (x86)\\Steam');
  assert.equal(get(root, 'label'), 'say "hi"');
  assert.equal(get(root, 'win'), '1');
  assert.equal(get(root, 'bare'), 'token');
  assert.equal(get(get(root, 'n'), 'a'), '2');
  // Broken input gives what was there, never a throw.
  assert.equal(get(get(parseVdf('"a" { "b" "c"'), 'a'), 'b'), 'c');
  assert.equal(get(parseVdf('"a" "b" }}} "c" "d"'), 'a'), 'b');
  // A key named like a prototype is just a key.
  const odd = parseVdf('"__proto__" { "polluted" "yes" }');
  assert.equal(get(get(odd, '__proto__'), 'polluted'), 'yes');
  assert.equal({}.polluted, undefined);
  // Deep nesting is skipped past, not recursed into without end.
  const deep = `"k" ${'{ "k" '.repeat(5000)}${'}'.repeat(5000)} "after" "1"`;
  assert.equal(get(parseVdf(deep), 'after'), '1');
  assert.equal(typeof get(parseVdf(deep), 'k'), 'object');
});

test('vdf: the fixture libraryfolders.vdf and appmanifests', () => {
  const text = fs.readFileSync(path.join(FIXTURES, 'steam', 'steamapps', 'libraryfolders.vdf'), 'utf8');
  assert.deepEqual(libraryPaths(text), ['{FIXTURES}/steam', '{FIXTURES}/steam-library2', 'D:\\SteamLibrary\\Games']);
  // An old file put the path straight under the number.
  assert.deepEqual(libraryPaths('"LibraryFolders" { "TimeNextStatsReport" "1" "1" "/mnt/games/SteamLibrary" }'), ['/mnt/games/SteamLibrary']);
  const m = appManifest(fs.readFileSync(path.join(FIXTURES, 'steam', 'steamapps', 'appmanifest_900001.acf'), 'utf8'));
  assert.deepEqual(m, { appid: '900001', name: 'Fixture Game', installdir: 'Fixture Game' });
  assert.equal(appManifest('"AppState" { "appid" "abc" "name" "x" "installdir" "x" }'), null);
});

test('wine: Z:, C: and other drives to Unix paths', () => {
  const env = { WINEPREFIX: '/home/me/.local/share/wineprefixes/game' };
  assert.equal(winePath('Z:\\home\\me\\Games\\Foo\\Foo.exe', {}), '/home/me/Games/Foo/Foo.exe');
  assert.equal(winePath('z:/home/me/Games/Foo/../Bar/Bar.exe', {}), '/home/me/Games/Bar/Bar.exe');
  assert.equal(winePath('C:\\Games\\Foo\\Foo.exe', env), '/home/me/.local/share/wineprefixes/game/drive_c/Games/Foo/Foo.exe');
  assert.equal(winePath('C:\\Games\\Foo.exe', { STEAM_COMPAT_DATA_PATH: '/s/compatdata/42' }), '/s/compatdata/42/pfx/drive_c/Games/Foo.exe');
  assert.equal(winePath('C:\\Foo.exe', {}, { home: '/home/me' }), '/home/me/.wine/drive_c/Foo.exe');
  assert.equal(winePath('C:\\Foo.exe', {}), null);
  assert.equal(winePath('/home/me/Games/Foo.exe', {}), '/home/me/Games/Foo.exe');
  assert.equal(winePath('\\\\?\\Z:\\opt\\x.exe', {}), '/opt/x.exe');
  assert.equal(winePath('D:\\Game\\g.exe', env, { resolveDrive: (prefix, letter) => (letter === 'd' ? '/mnt/disc' : null) }), '/mnt/disc/Game/g.exe');
  assert.equal(winePath('E:\\g.exe', env, { resolveDrive: () => null }), null);
  assert.equal(winePath('Foo.exe', env), null);
  assert.equal(winePath('', env), null);
  // A relative WINEPREFIX is no prefix.
  assert.equal(winePath('C:\\Foo.exe', { WINEPREFIX: 'relative/pfx' }), null);
});

test('proc: the start time is read after the last ")", whatever the name holds', () => {
  const line = '4242 (my (weird) game) x) S 17 4242 4242 0 -1 4194560 100 0 0 0 1 1 0 0 20 0 1 0 123456 1000 100';
  assert.deepEqual(proc.parseStat(line), { ppid: 17, startTicks: 123456 });
  assert.deepEqual(proc.parseStat('1 (a b) R 0 1 1 0 -1 0 0 0 0 0 0 0 0 0 20 0 1 0 7 0 0'), { ppid: 0, startTicks: 7 });
  assert.equal(proc.parseStat('garbage'), null);
  assert.equal(proc.parseStat('1 (x) S'), null);
  // btime 1761000000 s + 123456 ticks of 10 ms.
  assert.equal(proc.startMs(1761000000, 123456), 1761000000000 + 1234560);
  assert.equal(proc.startMs(0, 5), 0);
});

test('proc: listing reads only the given user, and only the launcher tags of an environment', async (t) => {
  const root = tempDir(t);
  fakeProc(root, [
    { pid: 10, ppid: 1, ticks: 500, exe: '/usr/bin/a', comm: 'a) (b', environ: { SteamAppId: '42', HOME: '/home/me', SECRET_TOKEN: 'x', GAME_NAME: 'Foo' }, cmdline: ['a', '', ''] },
  ]);
  fs.mkdirSync(path.join(root, 'self'));
  assert.equal(await proc.readBtime(root), 1761000000);
  assert.deepEqual(await proc.listProcesses({ procRoot: root, uid: process.getuid() }), [{ pid: 10, ppid: 1, startTicks: 500 }]);
  assert.deepEqual(await proc.listProcesses({ procRoot: root, uid: process.getuid() + 1 }), []);
  assert.equal(await proc.readExe(root, 10), '/usr/bin/a');
  assert.equal(await proc.readExe(root, 99), '');
  assert.deepEqual(await proc.readCmdline(root, 10), ['a']);
  assert.deepEqual(await proc.readEnviron(root, 10), { SteamAppId: '42', GAME_NAME: 'Foo' });
  assert.equal(await proc.readEnviron(root, 99), null);
  assert.deepEqual(await proc.listProcesses({ procRoot: path.join(root, 'none') }), []);
});

test('matcher: the command line is wanted only for Java, Wine and the reaper; the environment only for Wine', () => {
  assert.deepEqual(needs('/home/me/Games/foo/foo', 'linux', data), { cmdline: false, environ: false });
  assert.deepEqual(needs('/usr/lib/jvm/x/bin/java', 'linux', data), { cmdline: true, environ: false });
  assert.deepEqual(needs('/usr/lib/wine/x86_64-unix/wine64-preloader', 'linux', data), { cmdline: true, environ: true });
  assert.deepEqual(needs('/home/me/.local/share/Steam/ubuntu12_32/reaper', 'linux', data), { cmdline: true, environ: false });
  assert.deepEqual(needs('/home/me/.var/app/com.valvesoftware.Steam/.local/share/Steam/ubuntu12_64/reaper', 'linux', data), { cmdline: true, environ: false });
  // Steam's reaper by where Steam keeps it, never by its name alone (the REAPER audio editor).
  for (const exe of ['/opt/REAPER/reaper', '/usr/bin/reaper', '/home/me/.local/share/Steam/reaper', '/home/me/ubuntu12_32/reaper.sh', '/home/me/ubuntu12_32/Reaper']) {
    assert.deepEqual(needs(exe, 'linux', data), { cmdline: false, environ: false }, exe);
    assert.equal(isSteamReaper(exe, 'linux'), false, exe);
  }
  assert.equal(isSteamReaper('/home/me/.steam/steam/ubuntu12_32/reaper', 'linux'), true);
  assert.equal(isSteamReaper('/Users/me/Library/Application Support/Steam/ubuntu12_32/reaper', 'darwin'), false);
  assert.deepEqual(needs('C:\\Java\\bin\\javaw.exe', 'win32', data), { cmdline: true, environ: false });
  // Only Linux runs Wine programs through a loader of that name.
  assert.deepEqual(needs('C:\\wine\\wine64-preloader', 'win32', data), { cmdline: false, environ: false });
  // A snapshot's extra data never reaches the rules: a curated java rule cannot match a
  // non-Java program's command line, and a launcher tag on a native program counts for nothing.
  const index = { steamApp: () => ({ appid: '1', name: 'Steam Game' }), heroicApp: () => null, lutrisSlugForName: () => null, lutrisName: () => null, lookupPath: () => null };
  const ctx = { os: 'linux', data, index, user: [] };
  const hits = matchSnapshot([{ pid: 1, ppid: 0, start_ms: 1, exe: '/opt/x/x', cmdline: ['net.minecraft.client.main.Main'], environ: { SteamAppId: '1' } }], ctx);
  assert.deepEqual(hits, []);
});

test('matcher: a program called reaper outside Steam\'s runtime folder is an ordinary program', async (t) => {
  const { dir, index } = await fixtureIndex(t);
  const ctx = { os: 'linux', data, index, user: [] };
  const argv = (exe) => [exe, 'SteamLaunch', 'AppId=900001', '--', 'x'];
  // Even handed Steam's arguments, it is not Steam's launch.
  assert.equal(classify({ exe: '/opt/REAPER/reaper', cmdline: argv('/opt/REAPER/reaper') }, ctx), null);
  // A game's own program of that name is the game, by its folder.
  const own = `${dir}/steam/steamapps/common/Fixture Game/bin/reaper`;
  assert.deepEqual(classify({ exe: own, cmdline: null }, ctx), { key: 'steam:900001', name: 'Fixture Game', source: 'steam', rank: 4 });
  // And one the person added is theirs.
  const user = [{ id: 'daw', path: '/opt/REAPER/reaper', name: 'My DAW' }];
  assert.equal(classify({ exe: '/opt/REAPER/reaper', cmdline: null }, { ...ctx, user }).key, 'user:daw');
  // Steam's own still names its game.
  const steam = `${dir}/steam/ubuntu12_32/reaper`;
  assert.equal(classify({ exe: steam, cmdline: argv(steam) }, ctx).key, 'steam:900001');
});

test('matcher: reaper arguments, slugs', () => {
  assert.equal(steamLaunchAppId(['reaper', 'SteamLaunch', 'AppId=730', '--', 'x']), '730');
  assert.equal(steamLaunchAppId(['reaper', 'AppId=730']), null);
  assert.equal(steamLaunchAppId(null), null);
  assert.equal(slugify('HELLDIVERS™ 2'), 'helldivers-2');
  assert.equal(slugify('Pokémon: Café'), 'pokemon-cafe');
  assert.equal(slugify('原神'), '原神');
});

test('text: one rule with the server - controls out, joiners kept, 128 code points, something visible', () => {
  assert.equal(cleanName(`  A${cp(0x202e)}B${cp(0x2028)}  C\t\n`), 'AB C');
  const family = `${cp(0x1f468)}${cp(0x200d)}${cp(0x1f469)}${cp(0x200d)}${cp(0x1f467)}`;
  assert.equal(cleanName(`Team ${family}`), `Team ${family}`);
  assert.equal(cleanName(cp(0x3164)), null);
  assert.equal(cleanName(`${cp(0x200b)}${cp(0xfe0f)}`), null);
  // Counted in code points, so 128 astral emoji fit.
  const emoji = cp(0x1f3ae).repeat(128);
  assert.equal(validName(emoji), emoji);
  assert.equal(validName(emoji + cp(0x1f3ae)), null);
  assert.equal(cleanName('x'.repeat(200)).length, 128);
  assert.equal(validName('x'.repeat(129)), null);
  assert.equal(validName(' ok '), 'ok');
  assert.equal(validName(42), null);
});

test('tracker: most recent wins, the choice sticks, two misses end it, the reaper ends it at once', () => {
  const m = (key, start, extra = {}) => ({ key, name: key, source: 'curated', rank: 5, start_ms: start, ...extra });
  const tr = new Tracker();
  assert.equal(tr.update([m('a', 100)]).key, 'a');
  assert.equal(tr.update([m('a', 100), m('b', 50)]).key, 'a', 'an older game appearing does not take over');
  assert.equal(tr.update([m('a', 100), m('b', 50), m('c', 300)]).key, 'c');
  assert.equal(tr.update([m('a', 100), m('b', 50)]).key, 'c', 'one miss is not the end');
  assert.equal(tr.update([m('a', 100), m('b', 50)]).key, 'a');
  // Hidden: the current one hidden gives the next; unhiding it does not flip back.
  assert.equal(tr.reselect(new Set(['a'])).key, 'b');
  assert.equal(tr.reselect(new Set()).key, 'b');
  // Reaper sessions end at the first miss.
  const r = new Tracker();
  assert.equal(r.update([m('steam:1', 10, { reaper: true }), m('steam:1', 20)]).startedAt, 10);
  assert.equal(r.update([]), null);
  // Forgetting the current one.
  const f = new Tracker();
  f.update([m('user:x', 1)]);
  f.forget('user:x');
  assert.equal(f.currentKey, null);
  assert.equal(f.reselect(), null);
});

test('indexes: Lutris game files - the top-level game\'s program only, quotes and all', () => {
  const g = lutrisGame(fs.readFileSync(path.join(FIXTURES, 'lutris', 'games', 'lutris-fixture-1700000000.yml'), 'utf8'));
  assert.deepEqual(g, { name: 'Lutris Fixture', slug: 'lutris-fixture', exe: '{FIXTURES}/games/lutris/fixture/fixture.x86_64' });
  assert.equal(lutrisGame("game:\n  exe: 'C:\\it''s.exe'\nname: \"A \\\"B\\\"\"\n").exe, "C:\\it's.exe");
  assert.equal(lutrisGame('name: "A \\"B\\""\n').name, 'A "B"');
  assert.deepEqual(lutrisGame('system: {}\ngame:\n  appid: \'1\'\n'), { name: '', slug: '', exe: '' });
});

test('indexes: tools and launchers are left out, DLC skipped, nothing too broad, rebuilt only on change', async (t) => {
  let now = 1_000_000;
  const dir = copyFixtures(t);
  const index = new Indexes({ roots: fixtureRoots(dir), data, home: dir, now: () => now });
  assert.equal(await index.refresh(), true);
  assert.equal(index.steamApp('900001').name, 'Fixture Game');
  assert.equal(index.steamApp('228980'), null);
  assert.equal(index.steamApp('900002'), null);
  assert.equal(index.heroicApp('legendary', 'FixtureEpicDlc'), null);
  assert.equal(index.heroicApp('gog', '1400000002'), null, 'not installed');
  assert.equal(index.lutrisSlugForName('EA App'), null);
  assert.equal(index.lutrisName('lutris-fixture'), 'Lutris Fixture');
  // Looked at no more than once a minute, and rebuilt only when a file changed.
  now += 1000;
  assert.equal(await index.refresh(), false);
  now += CHECK_INTERVAL_MS;
  assert.equal(await index.refresh(), false);
  const acf = path.join(dir, 'steam-library2', 'steamapps', 'appmanifest_900005.acf');
  fs.writeFileSync(acf, '"AppState" { "appid" "900005" "name" "Newly Installed" "installdir" "New" }');
  now += CHECK_INTERVAL_MS;
  assert.equal(await index.refresh(), true);
  assert.equal(index.steamApp('900005').name, 'Newly Installed');
  // A Heroic install folder as broad as the home folder (or above it) is ignored.
  const heroic = path.join(dir, 'heroic', 'legendaryConfig', 'legendary', 'installed.json');
  fs.writeFileSync(heroic, JSON.stringify({ Broad: { app_name: 'Broad', title: 'Broad', install_path: dir, is_dlc: false } }));
  now += CHECK_INTERVAL_MS;
  assert.equal(await index.refresh(), true);
  assert.equal(index.lookupPath(path.join(dir, 'anything', 'x')), null);
  assert.equal(index.heroicApp('legendary', 'Broad').name, 'Broad');
});

test('indexes: a rebuild is built aside and swapped in whole, one look at a time', async (t) => {
  const { dir, index } = await fixtureIndex(t);
  assert.equal(index.generation, 1);
  const game = `${dir}/steam/steamapps/common/Fixture Game/bin/fixturegame`;
  fs.writeFileSync(path.join(dir, 'steam-library2', 'steamapps', 'appmanifest_900005.acf'), '"AppState" { "appid" "900005" "name" "Newly Installed" "installdir" "New" }');
  const p = index.refresh({ force: true });
  assert.equal(index.refresh(), p, 'a look while one is in flight shares it');
  let done = false;
  p.then(() => {
    done = true;
  });
  let turns = 0;
  while (!done) {
    // Whatever asks meanwhile (a scan, getState) sees the whole old index, never a half-built one.
    assert.equal(index.steamApp('900001')?.name, 'Fixture Game');
    assert.equal(index.lookupPath(game)?.key, 'steam:900001');
    assert.equal(index.steamApp('900005'), null);
    turns++;
    await new Promise((r) => setImmediate(r));
  }
  assert.ok(turns > 1, 'the build took more than one turn');
  assert.equal(await p, true);
  assert.equal(index.generation, 2, 'one rebuild, one generation');
  assert.equal(index.steamApp('900005').name, 'Newly Installed');
  assert.equal(index.lookupPath(game).key, 'steam:900001');
  // A forced look while another is in flight looks again after it.
  await Promise.all([index.refresh({ force: true }), index.refresh({ force: true })]);
  assert.equal(index.generation, 4);
});

test('prefs: activity.json keeps only what is well formed, owner-only', (t) => {
  const dir = tempDir(t);
  assert.deepEqual(prefsStore.loadActivityPrefs(dir), { version: 1, shareAccounts: [], hidden: [], renames: {}, user: [] });
  const saved = prefsStore.saveActivityPrefs(dir, {
    version: 7,
    share: true,
    shareAccounts: ['a.local:1', 'a.local:1', 42, 'has space'],
    hidden: ['steam:1', '/home/me/game', 'steam:1', 'bogus'],
    renames: { 'curated:x': '  New   Name ', 'curated:y': '', 'nope': 'x', 'curated:z': 'x'.repeat(129) },
    user: [
      { id: 'abc', path: '/home/me/g', name: 'G' },
      { id: 'abc', path: '/home/me/h', name: 'dup id' },
      { id: 'def', path: 'relative/g', name: 'relative' },
      { id: 'ghi', path: '/home/me/g', name: 'dup path' },
      { id: 'b a d', path: '/x', name: 'bad id' },
    ],
  });
  assert.deepEqual(saved, {
    version: 1,
    shareAccounts: ['a.local:1'],
    hidden: ['steam:1'],
    renames: { 'curated:x': 'New Name' },
    user: [{ id: 'abc', path: '/home/me/g', name: 'G' }],
  });
  const file = path.join(dir, 'activity.json');
  assert.equal(fs.statSync(file).mode & 0o777, 0o600);
  assert.deepEqual(prefsStore.loadActivityPrefs(dir), saved);
  fs.writeFileSync(file, '[1]');
  assert.deepEqual(prefsStore.loadActivityPrefs(dir).user, []);
});

// ---- the scanner, against a fake /proc -------------------------------------------------------

const BTIME = 1761000000;
const msAt = (ticks) => BTIME * 1000 + ticks * 10;

async function scannerSetup(t, procs, { active = 'a.local:1', now } = {}) {
  const dir = copyFixtures(t);
  const procRoot = tempDir(t, 'strafe-proc-');
  const configDir = tempDir(t, 'strafe-config-');
  fakeProc(procRoot, procs(dir), BTIME);
  if (active) store.saveAccounts(configDir, { version: 1, active, accounts: [] });
  const events = [];
  const { io, reads } = countingIo();
  const games = new Games({
    configDir,
    data,
    procRoot,
    uid: process.getuid(),
    selfPid: 4000,
    home: '/home/someone',
    roots: fixtureRoots(dir),
    intervalMs: 10 * 60_000,
    now,
    io,
    onActivity: (a) => events.push(a),
  });
  t.after(() => games.stop());
  games.start();
  return { dir, procRoot, configDir, games, events, reads };
}

const SAMPLE = (dir) => [
  { pid: 4000, ppid: 1, ticks: 100, exe: '/opt/Strafe/strafe-desktop.bin' },
  { pid: 4001, ppid: 4000, ticks: 110, exe: '/app/bin/sober' },
  { pid: 500, ppid: 1, ticks: 2000, exe: `${dir}/steam/steamapps/common/Fixture Game/bin/fixturegame`, cmdline: ['fixturegame', '--token=SECRET'], environ: { SECRET: 'x' } },
  { pid: 501, ppid: 1, ticks: 900, exe: '/usr/bin/fish', cmdline: ['fish', '-c', 'SECRET'], environ: { SECRET: 'x' } },
  { pid: 502, ppid: 1, ticks: 950, exe: '/usr/lib/jvm/x/bin/java', cmdline: ['java', '-jar', 'tool.jar'] },
  { pid: 503, ppid: 1, ticks: 960, exe: '/usr/lib/wine/x86_64-unix/wine64-preloader', cmdline: ['C:\\windows\\system32\\services.exe'], environ: { SteamAppId: '900003', OTHER: 'SECRET' } },
];

test('scanner: nothing is looked at until sharing is on for the account signed in', async (t) => {
  const { games, events, reads } = await scannerSetup(t, SAMPLE);
  await games.scanNow();
  assert.equal(reads.list, 0);
  assert.deepEqual(await games.getState(), { share: false, account: 'a.local:1', current: null, games: [] });
  assert.equal(reads.list, 0);
  // Another account's switch does nothing for this one.
  await games.setShare(true, 'b.local:2');
  assert.equal(reads.list, 0);
  assert.equal((await games.getState()).share, false);
  assert.deepEqual(events, []);
});

test('scanner: shares the game being played, from its own start, and reads no one else\'s secrets', async (t) => {
  const { games, events, reads, configDir } = await scannerSetup(t, SAMPLE);
  await games.setShare(true, 'a.local:1');
  assert.ok(reads.list >= 1);
  assert.deepEqual(events, [{ name: 'Fixture Game', started_at: msAt(2000) }]);
  const state = await games.getState();
  assert.equal(state.share, true);
  assert.deepEqual(state.current, { key: 'steam:900001', name: 'Fixture Game', started_at: msAt(2000) });
  assert.deepEqual(state.games, [{ key: 'steam:900001', name: 'Fixture Game', detected_name: 'Fixture Game', source: 'steam', hidden: false, renamed: false, running: true }]);
  // Command lines only of Java and Wine (not Strafe's own, the game's or the shell's);
  // environments only of Wine.
  assert.deepEqual([...reads.cmdline].sort(), [502, 503]);
  assert.deepEqual([...reads.environ], [503]);
  // A second scan reads nothing it already knows.
  reads.cmdline.clear();
  reads.environ.clear();
  await games.scanNow();
  assert.deepEqual([...reads.cmdline], []);
  assert.deepEqual(events.length, 1, 'no change, no event');
  // The choice is in activity.json, and prefs.json is not touched.
  assert.deepEqual(prefsStore.loadActivityPrefs(configDir).shareAccounts, ['a.local:1']);
  assert.ok(!fs.existsSync(path.join(configDir, 'prefs.json')));
});

test('scanner: hide, rename and turning sharing off are told to the page at once', async (t) => {
  const { games, events, reads } = await scannerSetup(t, SAMPLE);
  await games.setShare(true, 'a.local:1');
  await games.rename('steam:900001', '  My  Fixture ');
  assert.deepEqual(events.at(-1), { name: 'My Fixture', started_at: msAt(2000) });
  await assert.rejects(games.rename('steam:900001', 'x'.repeat(129)), /128/);
  await assert.rejects(games.rename('/home/me/game', 'x'), /know/);
  // Back to the detected name, by null or by typing it.
  await games.rename('steam:900001', 'Fixture Game');
  assert.deepEqual(events.at(-1), { name: 'Fixture Game', started_at: msAt(2000) });
  assert.equal((await games.getState()).games[0].renamed, false);
  await games.setHidden('steam:900001', true);
  assert.equal(events.at(-1), null);
  let state = await games.getState();
  assert.equal(state.current, null);
  assert.equal(state.games[0].hidden, true);
  assert.equal(state.games[0].running, true);
  await games.setHidden('steam:900001', false);
  assert.deepEqual(events.at(-1), { name: 'Fixture Game', started_at: msAt(2000) });
  // Off: null, and no more looking.
  await games.setShare(false, 'a.local:1');
  assert.equal(events.at(-1), null);
  state = await games.getState();
  assert.equal(state.share, false);
  assert.equal(state.current, null);
  const lists = reads.list;
  await games.scanNow();
  games.resume();
  assert.equal(reads.list, lists);
});

test('scanner: sharing follows the desktop account signed in', async (t) => {
  const { games, events } = await scannerSetup(t, SAMPLE);
  await games.setShare(true, 'a.local:1');
  assert.equal(events.length, 1);
  assert.equal((await games.getState()).account, 'a.local:1');
  games.setActiveAccount('b.local:2');
  assert.equal(events.at(-1), null);
  // `share` is said for the account it is about, so a page signed in as another cannot take it
  // for its own.
  assert.deepEqual(await games.getState(), { share: false, account: 'b.local:2', current: null, games: [] });
  games.setActiveAccount('a.local:1');
  await games.scanNow();
  assert.deepEqual(events.at(-1), { name: 'Fixture Game', started_at: msAt(2000) });
  games.setActiveAccount(null);
  assert.equal(events.at(-1), null);
  assert.deepEqual(await games.getState(), { share: false, account: null, current: null, games: [] });
});

test('scanner: with nobody signed in, getState names no account', async (t) => {
  const { games } = await scannerSetup(t, SAMPLE, { active: null });
  assert.deepEqual(await games.getState(), { share: false, account: null, current: null, games: [] });
  await assert.rejects(games.setShare(true, ''), /Sign in/);
});

test('scanner: an account removed from the desktop app stops being shared for, in one write', async (t) => {
  const { games, events, configDir } = await scannerSetup(t, SAMPLE);
  for (const a of ['a.local:1', 'b.local:2', 'c.local:3']) await games.setShare(true, a);
  assert.deepEqual(events, [{ name: 'Fixture Game', started_at: msAt(2000) }]);
  let writes = 0;
  const save = games.save.bind(games);
  games.save = (next) => {
    writes++;
    return save(next);
  };
  const file = (active, ids) => ({ version: 1, active, accounts: ids.map((id) => ({ id, token: 't', userId: '1', username: 'u' })) });
  // A switch with every account still there writes nothing, and sharing follows it.
  games.accountsSaved(file('b.local:2', ['a.local:1', 'b.local:2', 'c.local:3']));
  assert.equal(writes, 0);
  assert.deepEqual(await games.getState().then((s) => [s.share, s.account]), [true, 'b.local:2']);
  // Two removed at once: one write drops both.
  games.accountsSaved(file('b.local:2', ['b.local:2']));
  assert.equal(writes, 1);
  assert.deepEqual(prefsStore.loadActivityPrefs(configDir).shareAccounts, ['b.local:2']);
  // Added back later, a removed account starts with sharing off.
  games.accountsSaved(file('a.local:1', ['a.local:1', 'b.local:2']));
  assert.equal(writes, 1);
  assert.deepEqual(await games.getState().then((s) => [s.share, s.account]), [false, 'a.local:1']);
  assert.equal(events.at(-1), null);
  // A file without a list keeps nobody.
  games.accountsSaved(null);
  assert.equal(writes, 2);
  assert.deepEqual(prefsStore.loadActivityPrefs(configDir).shareAccounts, []);
  assert.equal((await games.getState()).account, null);
});

test('scanner: a game installed while its program runs is seen, whoever noticed the launcher files change', async (t) => {
  let now = 10_000_000;
  const { games, events, dir } = await scannerSetup(
    t,
    (d) => [
      { pid: 4000, ppid: 1, ticks: 100, exe: '/opt/Strafe/strafe-desktop.bin' },
      { pid: 800, ppid: 1, ticks: 5000, exe: `${d}/steam-library2/steamapps/common/New/new.x86_64` },
    ],
    { now: () => now },
  );
  // A hidden launcher game that is not running: getState looks in the launcher files for its name.
  await games.setHidden('steam:900003', true);
  await games.setShare(true, 'a.local:1');
  assert.deepEqual(events, [], 'not a game yet');
  // Steam finishes writing the manifest of the game being played.
  fs.writeFileSync(path.join(dir, 'steam-library2', 'steamapps', 'appmanifest_900005.acf'), '"AppState" { "appid" "900005" "name" "Newly Installed" "installdir" "New" }');
  now += CHECK_INTERVAL_MS;
  // Settings opens first, and it is getState that rebuilds the index.
  const gen = games.indexes.generation;
  assert.equal((await games.getState()).games.find((g) => g.key === 'steam:900003').name, 'Fixture Proton Game');
  assert.equal(games.indexes.generation, gen + 1);
  // The next scan does not keep the "not a game" it had for that process.
  await games.scanNow();
  assert.deepEqual(events, [{ name: 'Newly Installed', started_at: msAt(5000) }]);
});

test('scanner: only Steam\'s own reaper has its command line read', async (t) => {
  const { games, events, reads } = await scannerSetup(t, (dir) => [
    { pid: 4000, ppid: 1, ticks: 100, exe: '/opt/Strafe/strafe-desktop.bin' },
    { pid: 700, ppid: 1, ticks: 3000, exe: '/opt/REAPER/reaper', cmdline: ['/opt/REAPER/reaper', 'SteamLaunch', 'AppId=900001', '/home/someone/Music/SECRET.rpp'] },
    { pid: 701, ppid: 1, ticks: 2500, exe: `${dir}/steam/ubuntu12_32/reaper`, cmdline: [`${dir}/steam/ubuntu12_32/reaper`, 'SteamLaunch', 'AppId=900004', '--', 'x'] },
  ]);
  await games.setShare(true, 'a.local:1');
  assert.deepEqual([...reads.cmdline], [701]);
  assert.deepEqual(events, [{ name: 'Second Library Game™', started_at: msAt(2500) }]);
  // The audio editor is a program like any other: it can be added; Steam's reaper cannot.
  assert.deepEqual((await games.runningPrograms()).map((p) => p.name), ['reaper']);
});

test('scanner: a game that ends is gone after two scans; a wrapper that execs the game is seen', async (t) => {
  const { games, events, procRoot, dir } = await scannerSetup(t, SAMPLE);
  await games.setShare(true, 'a.local:1');
  fs.rmSync(path.join(procRoot, '500'), { recursive: true });
  await games.scanNow();
  assert.equal(events.length, 1);
  await games.scanNow();
  assert.equal(events.at(-1), null);
  // Same pid and start, a new program (`exec ./game` from a launch script).
  fs.rmSync(path.join(procRoot, '501', 'exe'));
  fs.symlinkSync(`${dir}/steam-library2/steamapps/common/SecondGame/SecondGame.x86_64`, path.join(procRoot, '501', 'exe'));
  await games.scanNow();
  assert.deepEqual(events.at(-1), { name: 'Second Library Game™', started_at: msAt(900) });
});

test('scanner: "Add it" offers file names under opaque ids, and adds by id only', async (t) => {
  let now = 5_000_000;
  const { games, events, configDir } = await scannerSetup(
    t,
    (dir) => [
      ...SAMPLE(dir),
      { pid: 600, ppid: 1, ticks: 3000, exe: '/home/someone/Games/indie/indie' },
      { pid: 601, ppid: 1, ticks: 3000, exe: '/home/someone/Games/indie/indie' },
      { pid: 602, ppid: 1, ticks: 3000, exe: '/usr/lib/systemd/systemd' },
      { pid: 603, ppid: 1, ticks: 3000, exe: `${dir}/steam/ubuntu12_32/steam` },
      { pid: 604, ppid: 1, ticks: 3000, exe: '/usr/lib/wine/x86_64-unix/wine64-preloader', cmdline: ['C:\\Games\\Foo\\Foo.exe'], environ: { WINEPREFIX: `${dir}/games/wineprefix` } },
      { pid: 605, ppid: 1, ticks: 3000, exe: '/usr/lib/wine/x86_64-unix/wine64-preloader', cmdline: ['Foo2.exe'], environ: {} },
      { pid: 606, ppid: 1, ticks: 3000, exe: '/usr/bin/python3.13' },
    ],
    { now: () => now },
  );
  const list = await games.runningPrograms();
  assert.deepEqual(list.map((p) => p.name), ['fixturegame', 'Foo.exe', 'indie']);
  for (const p of list) {
    assert.deepEqual(Object.keys(p).sort(), ['id', 'name']);
    assert.ok(!p.id.includes('/') && p.id.length >= 12);
  }
  const indie = list.find((p) => p.name === 'indie');
  await assert.rejects(games.add('not-an-id', 'X'), /list/);
  await assert.rejects(games.add(indie.id, '   '), /characters/);
  const row = await games.add(indie.id, 'Indie Fixture');
  assert.match(row.key, /^user:[0-9a-f]{12}$/);
  assert.deepEqual({ ...row, key: undefined }, { key: undefined, name: 'Indie Fixture', detected_name: 'Indie Fixture', source: 'user', hidden: false, renamed: false, running: false });
  assert.deepEqual(prefsStore.loadActivityPrefs(configDir).user, [{ id: row.key.slice(5), path: '/home/someone/Games/indie/indie', name: 'Indie Fixture' }]);
  // Adding the same program again renames it rather than adding a second.
  const again = await games.add(indie.id, 'Indie Renamed');
  assert.equal(again.key, row.key);
  // Sharing on now: the added game started last, so it is the one shared.
  await games.setShare(true, 'a.local:1');
  assert.deepEqual(events.at(-1), { name: 'Indie Renamed', started_at: msAt(3000) });
  assert.equal((await games.getState()).games.find((g) => g.key === row.key).running, true);
  // Ids expire.
  now += OFFER_TTL_MS + 1;
  await assert.rejects(games.add(indie.id, 'Late'), /list/);
  // Only added games can be removed; removing the shared one moves on to the next.
  await assert.rejects(games.remove('steam:900001'), /added/);
  await games.remove(row.key);
  assert.deepEqual(events.at(-1), { name: 'Fixture Game', started_at: msAt(2000) });
  assert.deepEqual(prefsStore.loadActivityPrefs(configDir).user, []);
});

test('scanner: a push that throws (the window gone) does not stop the scanner', async (t) => {
  const { games } = await scannerSetup(t, SAMPLE);
  games.onActivity = () => {
    throw new Error('window gone');
  };
  await games.setShare(true, 'a.local:1');
  assert.equal((await games.getState()).current.key, 'steam:900001');
});

// ---- the bridge contract ---------------------------------------------------------------------------

test('bridge: the preload and the main process name the same strafe:games:* channels, as agreed', () => {
  const preload = fs.readFileSync(path.join(DESKTOP, 'electron', 'preload.js'), 'utf8');
  const ipc = fs.readFileSync(path.join(DESKTOP, 'electron', 'src', 'ipc.js'), 'utf8');
  const app = fs.readFileSync(path.join(DESKTOP, 'electron', 'src', 'app.js'), 'utf8');
  const channels = (s) => [...new Set([...s.matchAll(/'(strafe:games:[A-Za-z]+)'/g)].map((m) => m[1]))].sort();
  const agreed = ['strafe:games:add', 'strafe:games:getState', 'strafe:games:remove', 'strafe:games:rename', 'strafe:games:running', 'strafe:games:setHidden', 'strafe:games:setShare'];
  assert.deepEqual(channels(ipc), agreed);
  assert.deepEqual(channels(preload), [...agreed, 'strafe:games:activity'].sort());
  assert.deepEqual(channels(app), ['strafe:games:activity']);
  // Saving the accounts tells game sharing which account is signed in and which are gone.
  assert.match(ipc, /handle\('strafe:accounts:save', \(_event, value\) => \{\n\s+store\.saveAccounts\(ctx\.configDir, value\);[\s\S]*?ctx\.games\?\.accountsSaved\(value\);\n\s+\}\);/);
  for (const m of ['getState', 'setShare', 'setHidden', 'rename', 'runningPrograms', 'add', 'remove', 'onActivityChanged']) assert.match(preload, new RegExp(`\\b${m}\\b`));
});
