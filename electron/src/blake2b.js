// BLAKE2b-512 (RFC 7693), unkeyed.
//
// Minisign's default signatures ("ED", what `tauri signer` writes) sign the BLAKE2b-512 of
// the file, and Electron's crypto is BoringSSL, which has no BLAKE2b: createHash('blake2b512')
// throws there although it works under plain Node. So the update check carries its own.
// 64-bit words are kept as pairs of 32-bit halves (low, high) in Uint32Arrays, which V8 runs
// fast enough to hash a 150 MB AppImage in a few seconds; the tests compare it with Node's
// own implementation.

const IV = new Uint32Array([
  0xf3bcc908, 0x6a09e667, 0x84caa73b, 0xbb67ae85, 0xfe94f82b, 0x3c6ef372, 0x5f1d36f1, 0xa54ff53a,
  0xade682d1, 0x510e527f, 0x2b3e6c1f, 0x9b05688c, 0xfb41bd6b, 0x1f83d9ab, 0x137e2179, 0x5be0cd19,
]);

// The message schedule; rounds 10 and 11 repeat 0 and 1. Doubled, to index the 32-bit halves.
const SIGMA = [
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
  11, 8, 12, 0, 5, 2, 15, 13, 10, 14, 3, 6, 7, 1, 9, 4,
  7, 9, 3, 1, 13, 12, 11, 14, 2, 6, 5, 10, 4, 0, 15, 8,
  9, 0, 5, 7, 2, 4, 10, 15, 14, 1, 11, 12, 6, 8, 3, 13,
  2, 12, 6, 10, 0, 11, 8, 3, 4, 13, 7, 5, 15, 14, 1, 9,
  12, 5, 1, 15, 14, 13, 4, 10, 0, 7, 6, 3, 9, 2, 8, 11,
  13, 11, 7, 14, 12, 1, 3, 9, 5, 0, 15, 4, 8, 6, 2, 10,
  6, 15, 14, 9, 11, 3, 0, 8, 12, 2, 13, 7, 1, 4, 10, 5,
  10, 2, 8, 4, 7, 6, 1, 5, 15, 11, 9, 14, 3, 12, 13, 0,
  0, 1, 2, 3, 4, 5, 6, 7, 8, 9, 10, 11, 12, 13, 14, 15,
  14, 10, 4, 8, 9, 15, 13, 6, 1, 12, 0, 2, 11, 7, 5, 3,
].map((x) => x * 2);

const v = new Uint32Array(32);
const m = new Uint32Array(32);

/** v[a] += v[b], 64-bit. */
function add64(a, b) {
  const lo = v[a] + v[b];
  v[a + 1] = v[a + 1] + v[b + 1] + (lo >= 0x100000000 ? 1 : 0);
  v[a] = lo;
}

/** v[a] += (lo, hi), 64-bit. */
function add64c(a, lo, hi) {
  const l = v[a] + lo;
  v[a + 1] = v[a + 1] + hi + (l >= 0x100000000 ? 1 : 0);
  v[a] = l;
}

/** The mixing function G, on the 64-bit words at a, b, c, d with message words x, y. */
function mix(a, b, c, d, x, y) {
  add64(a, b);
  add64c(a, m[x], m[x + 1]);
  let lo = v[d] ^ v[a];
  let hi = v[d + 1] ^ v[a + 1];
  v[d] = hi; // rotate right 32
  v[d + 1] = lo;
  add64(c, d);
  lo = v[b] ^ v[c];
  hi = v[b + 1] ^ v[c + 1];
  v[b] = (lo >>> 24) ^ (hi << 8); // rotate right 24
  v[b + 1] = (hi >>> 24) ^ (lo << 8);
  add64(a, b);
  add64c(a, m[y], m[y + 1]);
  lo = v[d] ^ v[a];
  hi = v[d + 1] ^ v[a + 1];
  v[d] = (lo >>> 16) ^ (hi << 16); // rotate right 16
  v[d + 1] = (hi >>> 16) ^ (lo << 16);
  add64(c, d);
  lo = v[b] ^ v[c];
  hi = v[b + 1] ^ v[c + 1];
  v[b] = (hi >>> 31) ^ (lo << 1); // rotate right 63
  v[b + 1] = (lo >>> 31) ^ (hi << 1);
}

/** Compress the 128-byte block at `block[off..]` into `h`; `t` counts bytes so far. */
function compress(h, block, off, t, last) {
  for (let i = 0; i < 16; i++) {
    v[i] = h[i];
    v[i + 16] = IV[i];
  }
  v[24] ^= t % 0x100000000;
  v[25] ^= Math.floor(t / 0x100000000);
  if (last) {
    v[28] = ~v[28];
    v[29] = ~v[29];
  }
  for (let i = 0; i < 32; i++) {
    const p = off + 4 * i;
    m[i] = block[p] | (block[p + 1] << 8) | (block[p + 2] << 16) | (block[p + 3] << 24);
  }
  for (let r = 0; r < 12; r++) {
    const s = r * 16;
    mix(0, 8, 16, 24, SIGMA[s], SIGMA[s + 1]);
    mix(2, 10, 18, 26, SIGMA[s + 2], SIGMA[s + 3]);
    mix(4, 12, 20, 28, SIGMA[s + 4], SIGMA[s + 5]);
    mix(6, 14, 22, 30, SIGMA[s + 6], SIGMA[s + 7]);
    mix(0, 10, 20, 30, SIGMA[s + 8], SIGMA[s + 9]);
    mix(2, 12, 22, 24, SIGMA[s + 10], SIGMA[s + 11]);
    mix(4, 14, 16, 26, SIGMA[s + 12], SIGMA[s + 13]);
    mix(6, 8, 18, 28, SIGMA[s + 14], SIGMA[s + 15]);
  }
  for (let i = 0; i < 16; i++) h[i] = h[i] ^ v[i] ^ v[i + 16];
}

/** An incremental BLAKE2b-512: update() with chunks as they come, then digest() once. */
class Blake2b512 {
  constructor() {
    this.h = new Uint32Array(IV);
    this.h[0] ^= 0x01010040; // parameter block: digest length 64, no key, fanout 1, depth 1
    this.buf = new Uint8Array(128);
    this.fill = 0;
    this.t = 0;
  }

  update(chunk) {
    const data = chunk instanceof Uint8Array ? chunk : Buffer.from(chunk);
    let off = 0;
    while (off < data.length) {
      // A full buffer is compressed only once more input arrives: the last block of the
      // message must be compressed as the final one, in digest().
      if (this.fill === 128) {
        this.t += 128;
        compress(this.h, this.buf, 0, this.t, false);
        this.fill = 0;
      }
      // Whole blocks straight from the input, keeping at least one byte back for the above.
      if (this.fill === 0) {
        while (data.length - off > 128) {
          this.t += 128;
          compress(this.h, data, off, this.t, false);
          off += 128;
        }
      }
      const take = Math.min(128 - this.fill, data.length - off);
      this.buf.set(data.subarray(off, off + take), this.fill);
      this.fill += take;
      off += take;
    }
    return this;
  }

  digest() {
    this.t += this.fill;
    this.buf.fill(0, this.fill);
    compress(this.h, this.buf, 0, this.t, true);
    const out = Buffer.alloc(64);
    for (let i = 0; i < 64; i++) out[i] = this.h[i >> 2] >>> (8 * (i & 3));
    return out;
  }
}

/** BLAKE2b-512 of `data` (a Buffer or Uint8Array), as a 64-byte Buffer. */
function blake2b512(data) {
  return new Blake2b512().update(data).digest();
}

module.exports = { Blake2b512, blake2b512 };
