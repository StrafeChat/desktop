// Minisign signature verification, for updates.
//
// Releases are signed with the key from `tauri signer generate` (minisign format) and the
// installed app only accepts files that verify against the public key it was built with -
// the same guarantee the Tauri updater gives on Windows and macOS. Whoever can upload to the
// release page still cannot ship an update without the private key.

const crypto = require('node:crypto');
const fs = require('node:fs');
const { Blake2b512 } = require('./blake2b');

// Electron's crypto (BoringSSL) has no BLAKE2b; plain Node's (OpenSSL) does. Same digest.
const NATIVE_BLAKE2B = crypto.getHashes().includes('blake2b512');
const newBlake2b = () => (NATIVE_BLAKE2B ? crypto.createHash('blake2b512') : new Blake2b512());
/** Chunks small enough that hashing one never holds the main process up noticeably. */
const READ_CHUNK = 256 * 1024;

/** DER prefix of an Ed25519 SubjectPublicKeyInfo; the raw 32-byte key follows it. */
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

function decodeLines(text) {
  return String(text)
    .split(/\r?\n/)
    .map((l) => l.trim())
    .filter((l) => l.length > 0);
}

/**
 * Parse a minisign public key. Accepts the key file's text, or that text base64-encoded as
 * Tauri stores it (`plugins.updater.pubkey` in tauri.conf.json).
 */
function parsePublicKey(input) {
  let text = String(input).trim();
  if (!text.startsWith('untrusted comment:')) text = Buffer.from(text, 'base64').toString('utf8');
  const lines = decodeLines(text);
  const blob = Buffer.from(lines[lines.length - 1], 'base64');
  if (blob.length !== 42 || blob.subarray(0, 2).toString('latin1') !== 'Ed') {
    throw new Error('not a minisign Ed25519 public key');
  }
  return {
    keyId: blob.subarray(2, 10),
    key: crypto.createPublicKey({ key: Buffer.concat([ED25519_SPKI_PREFIX, blob.subarray(10)]), format: 'der', type: 'spki' }),
  };
}

/** Parse a signature file's text (or base64 of it, as latest.json carries it). */
function parseSignature(input) {
  let text = String(input).trim();
  if (!text.startsWith('untrusted comment:')) text = Buffer.from(text, 'base64').toString('utf8');
  const lines = decodeLines(text);
  if (lines.length < 4 || !lines[2].startsWith('trusted comment: ')) throw new Error('malformed minisign signature');
  const blob = Buffer.from(lines[1], 'base64');
  if (blob.length !== 74) throw new Error('malformed minisign signature');
  const algorithm = blob.subarray(0, 2).toString('latin1');
  if (algorithm !== 'ED' && algorithm !== 'Ed') throw new Error(`unsupported signature algorithm ${algorithm}`);
  return {
    algorithm,
    keyId: blob.subarray(2, 10),
    signature: blob.subarray(10),
    trustedComment: lines[2].slice('trusted comment: '.length),
    globalSignature: Buffer.from(lines[3], 'base64'),
  };
}

/** Both minisign checks on a parsed signature, given the signed message (the file, or for
 * "ED" its BLAKE2b-512): the file signature, and the global one over the trusted comment,
 * which names the file and version and so must not be swappable. */
function check(message, pub, sig) {
  if (!pub.keyId.equals(sig.keyId)) return false;
  if (!crypto.verify(null, message, pub.key, sig.signature)) return false;
  const global = Buffer.concat([sig.signature, Buffer.from(sig.trustedComment, 'utf8')]);
  return crypto.verify(null, global, pub.key, sig.globalSignature);
}

/** True when `data` (a Buffer) carries a valid signature by `publicKey`. */
function verify(data, signatureText, publicKeyText) {
  const pub = parsePublicKey(publicKeyText);
  const sig = parseSignature(signatureText);
  // "ED" (minisign's default since 0.10, what Tauri writes) signs the BLAKE2b-512 of the file.
  const message = sig.algorithm === 'ED' ? newBlake2b().update(data).digest() : data;
  return check(message, pub, sig);
}

/**
 * verify() for a file on disk, read and hashed in small chunks so that checking a 150 MB
 * AppImage never freezes the app (hashing is a few seconds of work without native BLAKE2b).
 */
async function verifyFile(file, signatureText, publicKeyText) {
  const pub = parsePublicKey(publicKeyText);
  const sig = parseSignature(signatureText);
  if (sig.algorithm !== 'ED') return check(await fs.promises.readFile(file), pub, sig);
  const hash = newBlake2b();
  for await (const chunk of fs.createReadStream(file, { highWaterMark: READ_CHUNK })) {
    hash.update(chunk);
  }
  return check(hash.digest(), pub, sig);
}

module.exports = { verify, verifyFile, parsePublicKey, parseSignature };
