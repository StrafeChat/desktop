// scripts/linux-update-feed.mjs: the Linux entries it adds to the release's latest.json.

import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import crypto from 'node:crypto';
import { mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { fileURLToPath } from 'node:url';
import { promisify } from 'node:util';

import { addLinuxEntries, signedFields } from '../../scripts/linux-update-feed.mjs';

const SCRIPT = fileURLToPath(new URL('../../scripts/linux-update-feed.mjs', import.meta.url));
const BASE = 'https://github.com/StrafeChat/desktop/releases/download/v1.4.0';

/** A throwaway minisign key, signing the way `tauri signer sign --app-version` does: the
 * BLAKE2b-prehashed "ED" form, base64 of the whole signature file as the .sig text. */
function makeKey() {
  const { publicKey, privateKey } = crypto.generateKeyPairSync('ed25519');
  const keyId = crypto.randomBytes(8);
  const raw = publicKey.export({ format: 'der', type: 'spki' }).subarray(-32);
  const pub = `untrusted comment: minisign public key\n${Buffer.concat([Buffer.from('Ed'), keyId, raw]).toString('base64')}\n`;
  function sign(data, { file, version, timestamp = 1790000000 }) {
    const trusted = [`timestamp:${timestamp}`, `file:${file}`, version && `version:${version}`].filter(Boolean).join('\t');
    const sig = crypto.sign(null, crypto.createHash('blake2b512').update(data).digest(), privateKey);
    const global = crypto.sign(null, Buffer.concat([sig, Buffer.from(trusted)]), privateKey);
    const text = [
      'untrusted comment: signature from tauri secret key',
      Buffer.concat([Buffer.from('ED'), keyId, sig]).toString('base64'),
      `trusted comment: ${trusted}`,
      global.toString('base64'),
      '',
    ].join('\n');
    return Buffer.from(text).toString('base64');
  }
  return { pub, sign };
}

const NAMES = {
  appimage: 'Strafe_1.4.0_amd64.AppImage',
  deb: 'Strafe_1.4.0_amd64.deb',
  rpm: 'Strafe-1.4.0-1.x86_64.rpm',
};

/** What tauri-action leaves in a draft once Windows and macOS are built. */
function tauriFeed(version = '1.4.0') {
  return {
    version,
    notes: 'Installers for Windows, macOS and Linux are below. Installed copies update themselves.',
    pub_date: '2026-10-20T10:00:00.000Z',
    platforms: {
      'darwin-aarch64': { signature: 'mac-sig', url: `${BASE}/Strafe_aarch64.app.tar.gz` },
      'windows-x86_64': { signature: 'win-sig', url: `${BASE}/Strafe_1.4.0_x64_en-US.msi` },
    },
  };
}

function signedArtifacts(key, names = NAMES, version = '1.4.0') {
  return Object.fromEntries(
    Object.entries(names).map(([kind, name]) => [kind, { name, signature: key.sign(Buffer.from(name), { file: name, version }) }]),
  );
}

describe('addLinuxEntries', () => {
  const key = makeKey();

  it('adds the AppImage, deb and rpm entries and keeps everything else', () => {
    const feed = tauriFeed();
    const before = structuredClone(feed);
    const artifacts = signedArtifacts(key);
    const out = addLinuxEntries(feed, { baseUrl: BASE, artifacts });

    assert.deepEqual(feed, before, 'the input feed is not modified');
    assert.equal(out.version, '1.4.0');
    assert.equal(out.notes, feed.notes);
    assert.equal(out.pub_date, feed.pub_date);
    assert.deepEqual(out.platforms['darwin-aarch64'], feed.platforms['darwin-aarch64']);
    assert.deepEqual(out.platforms['windows-x86_64'], feed.platforms['windows-x86_64']);

    const appimage = { signature: artifacts.appimage.signature, url: `${BASE}/Strafe_1.4.0_amd64.AppImage` };
    assert.deepEqual(out.platforms['linux-x86_64'], appimage);
    assert.deepEqual(out.platforms['linux-x86_64-appimage'], appimage);
    assert.deepEqual(out.platforms['linux-x86_64-deb'], { signature: artifacts.deb.signature, url: `${BASE}/Strafe_1.4.0_amd64.deb` });
    assert.deepEqual(out.platforms['linux-x86_64-rpm'], { signature: artifacts.rpm.signature, url: `${BASE}/Strafe-1.4.0-1.x86_64.rpm` });
  });

  it('replaces Linux entries already in the feed', () => {
    const feed = tauriFeed();
    feed.platforms['linux-x86_64-deb'] = { signature: 'stale', url: `${BASE}/old.deb` };
    const out = addLinuxEntries(feed, { baseUrl: BASE, artifacts: signedArtifacts(key) });
    assert.equal(out.platforms['linux-x86_64-deb'].url, `${BASE}/Strafe_1.4.0_amd64.deb`);
  });

  it('takes the .sig text as is, minus surrounding whitespace, and a base URL with a trailing slash', () => {
    const artifacts = signedArtifacts(key);
    const raw = artifacts.deb.signature;
    artifacts.deb = { ...artifacts.deb, signature: `${raw}\n` };
    const out = addLinuxEntries(tauriFeed(), { baseUrl: `${BASE}/`, artifacts });
    assert.equal(out.platforms['linux-x86_64-deb'].signature, raw);
    assert.equal(out.platforms['linux-x86_64-deb'].url, `${BASE}/Strafe_1.4.0_amd64.deb`);
  });

  it('accepts a feed version with a leading v', () => {
    const out = addLinuxEntries(tauriFeed('v1.4.0'), { baseUrl: BASE, artifacts: signedArtifacts(key) });
    assert.equal(out.version, 'v1.4.0');
    assert.ok(out.platforms['linux-x86_64-rpm']);
  });

  it('refuses artifacts of another version than the feed', () => {
    const names = { appimage: 'Strafe_1.3.9_amd64.AppImage', deb: 'Strafe_1.3.9_amd64.deb', rpm: 'Strafe-1.3.9-1.x86_64.rpm' };
    assert.throws(
      () => addLinuxEntries(tauriFeed(), { baseUrl: BASE, artifacts: signedArtifacts(key, names, '1.3.9') }),
      /Strafe_1\.3\.9_amd64\.AppImage is version 1\.3\.9, but the feed is for 1\.4\.0/,
    );
  });

  it('refuses one artifact out of step with the others', () => {
    const artifacts = signedArtifacts(key);
    artifacts.rpm = { name: 'Strafe-1.3.9-1.x86_64.rpm', signature: key.sign(Buffer.from('x'), { file: 'Strafe-1.3.9-1.x86_64.rpm', version: '1.3.9' }) };
    assert.throws(() => addLinuxEntries(tauriFeed(), { baseUrl: BASE, artifacts }), /rpm is version 1\.3\.9/);
  });

  it('refuses names the bundles do not have', () => {
    const artifacts = signedArtifacts(key);
    artifacts.rpm = { ...artifacts.rpm, name: 'Strafe-1.4.0.x86_64.rpm' };
    assert.throws(() => addLinuxEntries(tauriFeed(), { baseUrl: BASE, artifacts }), /not a rpm name, expected Strafe-<version>-1\.x86_64\.rpm/);
  });

  it('refuses a missing artifact or an empty signature', () => {
    const noDeb = signedArtifacts(key);
    delete noDeb.deb;
    assert.throws(() => addLinuxEntries(tauriFeed(), { baseUrl: BASE, artifacts: noDeb }), /no deb given/);
    const artifacts = signedArtifacts(key);
    artifacts.appimage = { ...artifacts.appimage, signature: '  \n' };
    assert.throws(() => addLinuxEntries(tauriFeed(), { baseUrl: BASE, artifacts }), /AppImage: no signature/);
  });

  it('refuses a signature made for another file', () => {
    const artifacts = signedArtifacts(key);
    artifacts.appimage = { ...artifacts.appimage, signature: artifacts.deb.signature };
    assert.throws(() => addLinuxEntries(tauriFeed(), { baseUrl: BASE, artifacts }), /the signature is for Strafe_1\.4\.0_amd64\.deb/);
  });

  it('refuses a signature for another version, or for none', () => {
    const artifacts = signedArtifacts(key);
    artifacts.deb = { ...artifacts.deb, signature: key.sign(Buffer.from('x'), { file: NAMES.deb, version: '1.3.2' }) };
    assert.throws(() => addLinuxEntries(tauriFeed(), { baseUrl: BASE, artifacts }), /signature is for version 1\.3\.2/);
    artifacts.deb = { ...artifacts.deb, signature: key.sign(Buffer.from('x'), { file: NAMES.deb }) };
    assert.throws(() => addLinuxEntries(tauriFeed(), { baseUrl: BASE, artifacts }), /names no version - sign with `tauri signer sign --app-version 1\.4\.0`/);
  });

  it('refuses something that is not a signature, a feed, or an https base URL', () => {
    const artifacts = signedArtifacts(key);
    assert.throws(() => addLinuxEntries({ platforms: {} }, { baseUrl: BASE, artifacts }), /not an update feed/);
    assert.throws(() => addLinuxEntries(tauriFeed(), { baseUrl: 'http://example.com/x', artifacts }), /must be https/);
    artifacts.deb = { ...artifacts.deb, signature: Buffer.from('hello').toString('base64') };
    assert.throws(() => addLinuxEntries(tauriFeed(), { baseUrl: BASE, artifacts }), /deb: unreadable signature/);
  });

  it('reads the signatures tauri-action published for v1.3.2', () => {
    // The real .sig texts of the v1.3.2 Linux bundles (latest.json, byte for byte), so the
    // format this expects is the one the release tooling actually produces.
    const real = {
      appimage: {
        name: 'Strafe_1.3.2_amd64.AppImage',
        signature:
          'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUaGU5UHR1c294UHRpNjNNYVlWZG5MSmFvdUt6Q0dzLzVoYTNNZTNyOE5pS2dza2w5aVlrQThJb0c2Y1p3M21JZk5aajFJZG1MY2VaZ05tYkRRUlVNTmlWVkJtVE9xUlFrPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxNjg3Nzc0CWZpbGU6U3RyYWZlXzEuMy4yX2FtZDY0LkFwcEltYWdlCXZlcnNpb246MS4zLjIKQTc3NTEva0R1V09rMEw5UDJNbGUxT2RsNm1YQlluSjMxcEZtcGF2QXU3QWZSbFBqbVZCK3J4c2szVU5ZQXRPT3U4Tnh2VDF3b3FDaTBzK0hkV1d4Q3c9PQo=',
      },
      deb: {
        name: 'Strafe_1.3.2_amd64.deb',
        signature:
          'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUaGU5UHR1c294UHNwaGxpbWJuOE1iTDJjWm0zT2VBL0JwMlJjY3ZVVnhHbTZKMGIzUVloZWtwT1A2N2tFaEpSSmN6SEhSRTdMU0ZNVWw3V1p2R0QySm5Kb1R2QmpnVVFnPQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxNjg3Nzc0CWZpbGU6U3RyYWZlXzEuMy4yX2FtZDY0LmRlYgl2ZXJzaW9uOjEuMy4yCnEvV3VzeGhaRW9Cak9PdEIrYVdYM3JQOGdCSit0NnM4azdmYVhNR1lRUDZOYUsxbTNJWTNuamJVSk1HSUZONUdtaE40SXpGMEoxeHkrYXhtbWhQVEF3PT0K',
      },
      rpm: {
        name: 'Strafe-1.3.2-1.x86_64.rpm',
        signature:
          'dW50cnVzdGVkIGNvbW1lbnQ6IHNpZ25hdHVyZSBmcm9tIHRhdXJpIHNlY3JldCBrZXkKUlVUaGU5UHR1c294UHRtbnFsUmlXL2s3QzdqSzVQYmN2MGoyQXZoa011VFNxZ0xPODdsaEJjc3FpVndrMnhVV0dLQnlidlZwdmMza3RDOWxzUG44ZlhTam5aTE1yb3RpMWc4PQp0cnVzdGVkIGNvbW1lbnQ6IHRpbWVzdGFtcDoxNzkxNjg3Nzc0CWZpbGU6U3RyYWZlLTEuMy4yLTEueDg2XzY0LnJwbQl2ZXJzaW9uOjEuMy4yCmlxYWZjWVd6eUlKQW5qblJ3WnR0aEdOaVplK2RWdkFrRFNHNnludFloSldCK0FEZFpZR1V1TGNNU1FoYUpCMTh6WmdqVVV3Y2NnQzczdnFRTlJZYkR3PT0K',
      },
    };
    assert.deepEqual(signedFields(real.appimage.signature), { timestamp: '1791687774', file: 'Strafe_1.3.2_amd64.AppImage', version: '1.3.2' });
    const base = 'https://github.com/StrafeChat/desktop/releases/download/v1.3.2';
    const out = addLinuxEntries(tauriFeed('1.3.2'), { baseUrl: base, artifacts: real });
    // What tauri-action itself wrote for these files.
    assert.deepEqual(out.platforms['linux-x86_64-appimage'], { signature: real.appimage.signature, url: `${base}/Strafe_1.3.2_amd64.AppImage` });
    assert.deepEqual(out.platforms['linux-x86_64-rpm'], { signature: real.rpm.signature, url: `${base}/Strafe-1.3.2-1.x86_64.rpm` });
  });
});

describe('linux-update-feed command line', () => {
  const run = promisify(execFile);
  const dirs = [];
  after(() => Promise.all(dirs.map((d) => rm(d, { recursive: true, force: true }))));

  /** A scratch release: three "bundles", their .sig files, the key's public half and a feed. */
  async function release() {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'strafe-feed-'));
    dirs.push(dir);
    const key = makeKey();
    const files = {};
    for (const [kind, name] of Object.entries(NAMES)) {
      const data = crypto.randomBytes(4096);
      files[kind] = path.join(dir, name);
      await writeFile(files[kind], data);
      await writeFile(`${files[kind]}.sig`, key.sign(data, { file: name, version: '1.4.0' }));
    }
    await writeFile(path.join(dir, 'key.pub'), key.pub);
    await writeFile(path.join(dir, 'latest.json'), JSON.stringify(tauriFeed(), null, 2));
    const args = ['--feed', path.join(dir, 'latest.json'), '--base-url', BASE, '--pubkey', path.join(dir, 'key.pub')];
    for (const [kind, file] of Object.entries(files)) args.push(`--${kind}`, file);
    return { dir, files, args };
  }

  it('writes the feed with the Linux entries, signatures as in the .sig files', async () => {
    const { dir, files, args } = await release();
    const out = path.join(dir, 'out.json');
    await run(process.execPath, [SCRIPT, ...args, '--out', out]);
    const feed = JSON.parse(await readFile(out, 'utf8'));
    assert.equal(feed.platforms['linux-x86_64-deb'].signature, await readFile(`${files.deb}.sig`, 'utf8'));
    assert.equal(feed.platforms['linux-x86_64'].url, `${BASE}/${NAMES.appimage}`);
    assert.equal(feed.platforms['windows-x86_64'].signature, 'win-sig');
  });

  it('rewrites --feed in place when there is no --out', async () => {
    const { dir, args } = await release();
    await run(process.execPath, [SCRIPT, ...args]);
    const feed = JSON.parse(await readFile(path.join(dir, 'latest.json'), 'utf8'));
    assert.ok(feed.platforms['linux-x86_64-rpm']);
  });

  it('refuses, writing nothing, when a .sig is missing', async () => {
    const { dir, files, args } = await release();
    await rm(`${files.rpm}.sig`);
    const out = path.join(dir, 'out.json');
    await assert.rejects(run(process.execPath, [SCRIPT, ...args, '--out', out]), (err) => {
      assert.match(err.stderr, /Strafe-1\.4\.0-1\.x86_64\.rpm\.sig is missing/);
      return true;
    });
    await assert.rejects(stat(out), { code: 'ENOENT' });
  });

  it('refuses a bundle that does not match its signature', async () => {
    const { files, args } = await release();
    await writeFile(files.appimage, 'tampered');
    await assert.rejects(run(process.execPath, [SCRIPT, ...args]), (err) => {
      assert.match(err.stderr, /AppImage\.sig does not verify against the updater's public key/);
      return true;
    });
  });

  it('refuses signatures by another key', async () => {
    const { dir, args } = await release();
    await writeFile(path.join(dir, 'key.pub'), makeKey().pub);
    await assert.rejects(run(process.execPath, [SCRIPT, ...args]), /does not verify/);
  });

  it('says what is missing from the command line', async () => {
    await assert.rejects(run(process.execPath, [SCRIPT, '--feed', 'latest.json']), (err) => {
      assert.match(err.stderr, /missing --base-url, --appimage, --deb, --rpm/);
      return true;
    });
  });
});
