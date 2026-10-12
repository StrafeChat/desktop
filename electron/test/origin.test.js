const test = require('node:test');
const assert = require('node:assert/strict');
const { ORIGIN, isAppUrl, isExternalUrl } = require('../src/origin');

test('the app is tauri://localhost and nothing else', () => {
  assert.equal(ORIGIN, 'tauri://localhost');
  assert.equal(isAppUrl('tauri://localhost/'), true);
  assert.equal(isAppUrl('tauri://localhost/spaces/1?x=1#y'), true);
  assert.equal(isAppUrl('tauri://localhost'), true);
  for (const url of [
    'tauri://localhost:8080/',
    'tauri://localhost.evil.example/',
    'tauri://evil/',
    'https://localhost/',
    'http://tauri.localhost/',
    'file:///etc/passwd',
    'null',
    '',
    undefined,
  ]) {
    assert.equal(isAppUrl(url), false, String(url));
  }
});

test('in development, the dev server origin instead', () => {
  const dev = 'http://localhost:3000';
  assert.equal(isAppUrl('http://localhost:3000/login', dev), true);
  assert.equal(isAppUrl('http://localhost:3001/', dev), false);
  assert.equal(isAppUrl('tauri://localhost/', dev), false);
});

test('links out: web and mail only', () => {
  assert.equal(isExternalUrl('https://strafe.chat/download'), true);
  assert.equal(isExternalUrl('http://example.com'), true);
  assert.equal(isExternalUrl('mailto:someone@example.com'), true);
  for (const url of ['file:///etc/passwd', 'javascript:alert(1)', 'tauri://localhost/', 'steam://run/1', 'smb://host/share', 'not a url']) {
    assert.equal(isExternalUrl(url), false, url);
  }
});
