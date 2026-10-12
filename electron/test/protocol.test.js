const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { resolveRequest, mimeType } = require('../src/protocol');

/** A small web build: index.html, a hashed asset, the docs' own index pages. */
function webBuild(t) {
  const parent = fs.mkdtempSync(path.join(os.tmpdir(), 'strafe-web-'));
  t.after(() => fs.rmSync(parent, { recursive: true, force: true }));
  const root = path.join(parent, 'dist');
  fs.mkdirSync(path.join(root, 'assets'), { recursive: true });
  fs.mkdirSync(path.join(root, 'docs', 'bots'), { recursive: true });
  fs.writeFileSync(path.join(root, 'index.html'), '<!doctype html>');
  fs.writeFileSync(path.join(root, 'assets', 'index-abc123.js'), 'export {}');
  fs.writeFileSync(path.join(root, 'assets', 'with space.css'), 'body{}');
  fs.writeFileSync(path.join(root, 'docs', 'index.html'), 'docs');
  fs.writeFileSync(path.join(root, 'docs', 'bots', 'index.html'), 'bots');
  // Beside the root, where a traversal would land.
  fs.writeFileSync(path.join(parent, 'secret.txt'), 'nope');
  return { root, index: path.join(root, 'index.html') };
}

test('files are served as themselves', (t) => {
  const { root } = webBuild(t);
  assert.deepEqual(resolveRequest(root, '/assets/index-abc123.js'), { file: path.join(root, 'assets', 'index-abc123.js') });
  assert.deepEqual(resolveRequest(root, '/assets/with%20space.css'), { file: path.join(root, 'assets', 'with space.css') });
});

test("the client's routes get index.html", (t) => {
  const { root, index } = webBuild(t);
  for (const route of ['/', '', '/login', '/spaces/123/rooms/456', '/assets', '/invite/abc%40b.local', '/@someone.else']) {
    assert.deepEqual(resolveRequest(root, route), { file: index }, route);
  }
});

test('a directory with its own index.html serves that (the developer docs)', (t) => {
  const { root } = webBuild(t);
  assert.deepEqual(resolveRequest(root, '/docs/'), { file: path.join(root, 'docs', 'index.html') });
  assert.deepEqual(resolveRequest(root, '/docs/bots'), { file: path.join(root, 'docs', 'bots', 'index.html') });
});

test('a missing asset is a 404, not the app', (t) => {
  const { root } = webBuild(t);
  assert.deepEqual(resolveRequest(root, '/assets/index-gone.js'), { status: 404 });
  assert.deepEqual(resolveRequest(root, '/favicon.ico'), { status: 404 });
  assert.deepEqual(resolveRequest(root, '/fonts/x.WOFF2'), { status: 404 });
});

test('nothing outside the root is reachable', (t) => {
  const { root } = webBuild(t);
  for (const p of ['/../secret.txt', '/%2e%2e/secret.txt', '/assets/%2E%2E/%2E%2E/secret.txt', '/..%2fsecret.txt', '/%2e%2e%2f%2e%2e%2fetc%2fpasswd']) {
    assert.deepEqual(resolveRequest(root, p), { status: 404 }, p);
  }
  assert.deepEqual(resolveRequest(root, '/index.html%00.js'), { status: 404 });
  assert.deepEqual(resolveRequest(root, '/%E0%A4%A'), { status: 404 });
});

test('content types', () => {
  assert.equal(mimeType('/a/index.html'), 'text/html; charset=utf-8');
  assert.equal(mimeType('x.js'), 'text/javascript; charset=utf-8');
  assert.equal(mimeType('x.mjs'), 'text/javascript; charset=utf-8');
  assert.equal(mimeType('x.wasm'), 'application/wasm');
  assert.equal(mimeType('manifest.webmanifest'), 'application/manifest+json');
  assert.equal(mimeType('x.WOFF2'), 'font/woff2');
  assert.equal(mimeType('x.JPG'), 'image/jpeg');
  assert.equal(mimeType('x.unknown'), 'application/octet-stream');
});
