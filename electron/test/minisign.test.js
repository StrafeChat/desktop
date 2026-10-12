// The update signature check, against a real signature made by the Tauri CLI with a
// throwaway key (see fixtures/README.txt - TEST ONLY, never trusted by any build).

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const minisign = require('../src/minisign');

const fixture = (name) => fs.readFileSync(path.join(__dirname, 'fixtures', name));
const text = (name) => fixture(name).toString('utf8');

const data = fixture('update.txt');
const signature = text('update.txt.sig');
const publicKey = text('test-only.key.pub');

test('a file signed with the key verifies', () => {
  assert.equal(minisign.verify(data, signature, publicKey), true);
});

test('the key and signature also work as the raw minisign text, not just base64', () => {
  const rawKey = Buffer.from(publicKey, 'base64').toString('utf8');
  const rawSig = Buffer.from(signature, 'base64').toString('utf8');
  assert.match(rawKey, /^untrusted comment:/);
  assert.equal(minisign.verify(data, rawSig, rawKey), true);
});

test('one changed byte fails', () => {
  const tampered = Buffer.from(data);
  tampered[10] ^= 0x01;
  assert.equal(minisign.verify(tampered, signature, publicKey), false);
});

test('a different key fails', () => {
  assert.equal(minisign.verify(data, signature, text('other-test-only.key.pub')), false);
});

test('a swapped trusted comment fails (the global signature covers it)', () => {
  const lines = Buffer.from(signature, 'base64').toString('utf8').split('\n');
  lines[2] = lines[2].replace('file:update.txt', 'file:something-else.txt');
  assert.equal(minisign.verify(data, lines.join('\n'), publicKey), false);
});

test('a signature for another file fails', () => {
  assert.equal(minisign.verify(fixture('update-versioned.txt'), signature, publicKey), false);
});

test('garbage is refused, not crashed on silently', () => {
  assert.throws(() => minisign.verify(data, 'not a signature', publicKey));
  assert.throws(() => minisign.verify(data, signature, 'not a key'));
});
