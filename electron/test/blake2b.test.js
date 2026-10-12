// The BLAKE2b-512 the update check falls back to inside Electron, whose crypto has none of
// its own: checked against RFC 7693 and against Node's (OpenSSL) implementation, and the
// signature check run through it the way the packaged app runs it.

const test = require('node:test');
const assert = require('node:assert/strict');
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { Blake2b512, blake2b512 } = require('../src/blake2b');

const native = (d) => crypto.createHash('blake2b512').update(d).digest();

test('RFC 7693 appendix A: BLAKE2b-512("abc")', () => {
  assert.equal(
    blake2b512(Buffer.from('abc')).toString('hex'),
    'ba80a53f981c4d0d6a2797b69f12f6e94c212f14685ac4b74b12bb6fdbffa2d1' +
      '7d87c5392aab792dc252d5de4533cc9518d38aa8dbf1925ab92386edd4009923',
  );
});

test('matches OpenSSL around every block boundary', () => {
  for (const n of [0, 1, 63, 64, 127, 128, 129, 255, 256, 257, 383, 384, 385, 1000, 65537]) {
    const d = crypto.randomBytes(n);
    assert.ok(blake2b512(d).equals(native(d)), `length ${n}`);
  }
});

test('fed in arbitrary chunks, the digest is the same', () => {
  for (let i = 0; i < 100; i++) {
    const d = crypto.randomBytes(Math.floor(Math.random() * 4000));
    const h = new Blake2b512();
    for (let off = 0; off < d.length; ) {
      const k = Math.floor(Math.random() * 300);
      h.update(d.subarray(off, off + k));
      off += k;
    }
    assert.ok(h.digest().equals(native(d)));
  }
});

test('the signature check works without native BLAKE2b, as in Electron', async () => {
  // Load a fresh copy of the verifier while crypto claims to have no BLAKE2b.
  const getHashes = crypto.getHashes;
  crypto.getHashes = () => getHashes().filter((h) => !/blake2/i.test(h));
  const id = require.resolve('../src/minisign');
  delete require.cache[id];
  let minisign;
  try {
    minisign = require('../src/minisign');
  } finally {
    crypto.getHashes = getHashes;
    delete require.cache[id];
  }
  const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));
  const data = fixture('update.txt');
  const signature = fixture('update.txt.sig').toString('utf8');
  const publicKey = fixture('test-only.key.pub').toString('utf8');
  assert.equal(minisign.verify(data, signature, publicKey), true);

  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'strafe-b2b-'));
  try {
    const file = path.join(dir, 'update.txt');
    fs.writeFileSync(file, data);
    assert.equal(await minisign.verifyFile(file, signature, publicKey), true);
    const tampered = Buffer.from(data);
    tampered[0] ^= 1;
    fs.writeFileSync(file, tampered);
    assert.equal(await minisign.verifyFile(file, signature, publicKey), false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
