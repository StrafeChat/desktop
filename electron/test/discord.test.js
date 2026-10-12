// Discord Rich Presence: the wire format, where the socket is looked for, the activity, and a
// whole session against a stand-in Discord on a socket in a temporary directory. (Never the
// real one: every Discord here gets an explicit env pointing at that directory.)

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const net = require('node:net');
const os = require('node:os');
const path = require('node:path');
const discord = require('../src/discord');

test('frames round-trip, split across chunks or several to a chunk', () => {
  const a = discord.encodeFrame(0, { v: 1, client_id: '123' });
  const b = discord.encodeFrame(1, { evt: 'READY', data: { name: 'Strafe ✓' } });
  assert.equal(a.readUInt32LE(0), 0);
  assert.equal(a.readUInt32LE(4), a.length - 8);

  const both = Buffer.concat([a, b]);
  const all = discord.decodeFrames(both);
  assert.deepEqual(
    all.frames.map((f) => [f.op, f.data]),
    [
      [0, { v: 1, client_id: '123' }],
      [1, { evt: 'READY', data: { name: 'Strafe ✓' } }],
    ],
  );
  assert.equal(all.rest.length, 0);

  const partial = discord.decodeFrames(both.subarray(0, a.length + 5));
  assert.equal(partial.frames.length, 1);
  assert.equal(partial.rest.length, 5);
  const resumed = discord.decodeFrames(Buffer.concat([partial.rest, both.subarray(a.length + 5)]));
  assert.equal(resumed.frames[0].data.evt, 'READY');
});

test('a frame no Discord would send is an error', () => {
  const huge = Buffer.alloc(8);
  huge.writeUInt32LE(1, 0);
  huge.writeUInt32LE(64 << 20, 4);
  assert.throws(() => discord.decodeFrames(huge));
  const notJson = Buffer.concat([Buffer.from([1, 0, 0, 0, 3, 0, 0, 0]), Buffer.from('{{{')]);
  assert.throws(() => discord.decodeFrames(notJson));
});

test('socket candidates: each base, each slot, each sandbox subpath, /tmp last', () => {
  const c = discord.socketCandidates({ XDG_RUNTIME_DIR: '/run/user/1000', TMPDIR: '/var/tmp' });
  assert.equal(c[0], '/run/user/1000/discord-ipc-0');
  assert.equal(c[1], '/run/user/1000/app/com.discordapp.Discord/discord-ipc-0');
  assert.ok(c.includes('/run/user/1000/.flatpak/com.discordapp.Discord/xdg-run/discord-ipc-3'));
  assert.ok(c.includes('/run/user/1000/snap.discord/discord-ipc-9'));
  assert.ok(c.includes('/var/tmp/discord-ipc-0'));
  assert.equal(c[c.length - 1], '/tmp/snap.discord/discord-ipc-9');
  assert.equal(c.length, 3 * 10 * discord.SUBPATHS.length);
  // Slot 0 everywhere in a base before slot 1.
  assert.ok(c.indexOf('/run/user/1000/snap.discord/discord-ipc-0') < c.indexOf('/run/user/1000/discord-ipc-1'));
});

test('socket candidates: no duplicates, and the snap quirk', () => {
  const c = discord.socketCandidates({ TMPDIR: '/tmp', TMP: '/tmp' });
  assert.equal(new Set(c).size, c.length);
  const snap = discord.socketCandidates({ SNAP: '/snap/x', XDG_RUNTIME_DIR: '/run/user/1000/snap.x' });
  assert.equal(snap[0], '/run/user/1000/discord-ipc-0');
});

test('the activity: Playing, the art, the button, the lines that are set', () => {
  const launched = 1_700_000_000_000;
  const a = discord.buildActivity({ details: '  Securely chatting  ', state: '', since: undefined }, launched);
  assert.deepEqual(a, {
    type: 0,
    timestamps: { start: launched },
    assets: { large_image: discord.LARGE_IMAGE, large_text: 'Strafe' },
    buttons: [{ label: 'Get Strafe', url: 'https://strafe.chat/download' }],
    details: 'Securely chatting',
  });
  const inCall = discord.buildActivity({ details: 'x', state: 'a.local · In a voice call', since: 1_700_000_123_456.7 }, launched);
  assert.equal(inCall.state, 'a.local · In a voice call');
  assert.equal(inCall.timestamps.start, 1_700_000_123_456);
  assert.equal(discord.buildActivity(null, launched).details, undefined);
  assert.equal(discord.buildActivity({ since: -5 }, launched).timestamps.start, launched);
});

test('the default application is the Strafe one discord.rs uses', () => {
  assert.equal(discord.DISCORD_APP_ID, '1160242168393388132');
  assert.equal(discord.RETRY_NOT_RUNNING_MS, 20_000);
  assert.equal(discord.RETRY_REFUSED_MS, 600_000);
});

/** A stand-in Discord: answers the handshake (or refuses it) and every command. */
function fakeDiscord(dir, { refuse = false } = {}) {
  const received = [];
  const sockets = new Set();
  const server = net.createServer((socket) => {
    sockets.add(socket);
    let buf = Buffer.alloc(0);
    socket.on('data', (chunk) => {
      buf = Buffer.concat([buf, chunk]);
      const { frames, rest } = discord.decodeFrames(buf);
      buf = rest;
      for (const f of frames) {
        received.push(f);
        if (f.op === 0) {
          if (refuse) socket.write(discord.encodeFrame(2, { code: 4000, message: 'Invalid Client ID' }));
          else socket.write(discord.encodeFrame(1, { cmd: 'DISPATCH', evt: 'READY', data: { v: 1 } }));
        } else if (f.op === 1) {
          socket.write(discord.encodeFrame(1, { cmd: f.data.cmd, nonce: f.data.nonce, evt: null, data: { name: 'Strafe' } }));
        }
      }
    });
    socket.on('error', () => {});
    socket.on('close', () => sockets.delete(socket));
  });
  return new Promise((resolve) => {
    server.listen(path.join(dir, 'discord-ipc-0'), () =>
      resolve({
        received,
        activities: () => received.filter((f) => f.op === 1 && f.data.cmd === 'SET_ACTIVITY').map((f) => f.data.args.activity),
        connections: () => sockets.size,
        close: () =>
          new Promise((r) => {
            for (const s of sockets) s.destroy();
            server.close(r);
          }),
      }),
    );
  });
}

async function until(fn, ms = 3000) {
  const end = Date.now() + ms;
  while (!fn()) {
    if (Date.now() > end) throw new Error('timed out');
    await new Promise((r) => setTimeout(r, 10));
  }
}

const tick = (ms = 50) => new Promise((r) => setTimeout(r, ms));

test('a session: nothing until visible, one write per burst, cleared on hide', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strafe-discord-'));
  const fake = await fakeDiscord(dir);
  const d = new discord.Discord({ appId: '42', enabled: true, env: { XDG_RUNTIME_DIR: dir } });
  try {
    d.setPresence({ details: 'Chatting' });
    await tick();
    // The window has not been shown: not "playing".
    assert.equal(fake.received.length, 0);

    d.setVisible(true);
    await until(() => fake.activities().length === 1);
    assert.deepEqual(fake.received[0], { op: 0, data: { v: 1, client_id: '42' } });
    assert.equal(fake.activities()[0].details, 'Chatting');
    assert.equal(fake.received[1].data.args.pid, process.pid);

    // A burst becomes one write, of the last value.
    d.setPresence({ details: 'a' });
    d.setPresence({ details: 'b' });
    d.setPresence({ details: 'In a call', since: 5 });
    await until(() => fake.activities().length === 2);
    await tick();
    assert.equal(fake.activities().length, 2);
    assert.equal(fake.activities()[1].details, 'In a call');
    assert.equal(fake.activities()[1].timestamps.start, 5);

    // The same presence again changes nothing.
    d.setPresence({ details: 'In a call', since: 5 });
    await tick();
    assert.equal(fake.activities().length, 2);

    // Hidden to the tray: the activity is cleared and the socket let go.
    d.setVisible(false);
    await until(() => fake.activities().length === 3 && fake.connections() === 0);
    assert.equal(fake.activities()[2], null);
  } finally {
    d.stop();
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('the Settings toggle off lets go; on again re-sends', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strafe-discord-'));
  const fake = await fakeDiscord(dir);
  const d = new discord.Discord({ appId: '42', enabled: false, env: { XDG_RUNTIME_DIR: dir } });
  try {
    d.setVisible(true);
    d.setPresence({ details: 'x' });
    await tick();
    assert.equal(fake.received.length, 0);
    d.setEnabled(true);
    await until(() => fake.activities().length === 1);
    d.setEnabled(false);
    await until(() => fake.connections() === 0);
    d.setEnabled(true);
    await until(() => fake.activities().length === 3);
    assert.equal(fake.activities()[2].details, 'x');
  } finally {
    d.stop();
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('a refused handshake waits ten minutes, not twenty seconds', async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strafe-discord-'));
  const fake = await fakeDiscord(dir, { refuse: true });
  const errors = [];
  t.mock.method(console, 'error', (msg) => errors.push(msg));
  const d = new discord.Discord({ appId: 'not-an-app', enabled: true, env: { XDG_RUNTIME_DIR: dir } });
  try {
    const before = Date.now();
    d.setVisible(true);
    await until(() => errors.length === 1);
    assert.match(errors[0], /handshake refused/);
    assert.ok(d.nextTry - before >= discord.RETRY_REFUSED_MS);
    assert.equal(fake.activities().length, 0);
  } finally {
    d.stop();
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('Discord restarting: the activity comes back when it does', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strafe-discord-'));
  let fake = await fakeDiscord(dir);
  const d = new discord.Discord({ appId: '42', enabled: true, env: { XDG_RUNTIME_DIR: dir } });
  try {
    d.setPresence({ details: 'x' });
    d.setVisible(true);
    await until(() => fake.activities().length === 1);
    await fake.close();
    await until(() => d.conn === null);
    fake = await fakeDiscord(dir);
    // Skip the 20 s wait.
    d.nextTry = 0;
    d.schedule();
    await until(() => fake.activities().length === 1);
    assert.equal(fake.activities()[0].details, 'x');
  } finally {
    d.stop();
    await fake.close();
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('without an application ID nothing ever happens', async () => {
  const d = new discord.Discord({ appId: '', enabled: true, env: {} });
  assert.equal(d.configured(), false);
  d.setVisible(true);
  d.setPresence({ details: 'x' });
  await tick();
  assert.equal(d.conn, null);
  d.stop();
});
