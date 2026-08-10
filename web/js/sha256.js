// BeamIt SHA-256 module — pure-JS incremental SHA-256.
//
// The Web Crypto digest API (crypto.subtle.digest) is one-shot: it needs the entire
// buffer at once, which defeats streaming large files. This implements the FIPS 180-4
// SHA-256 with an update()/digest() interface so a multi-gigabyte transfer can be hashed
// chunk-by-chunk on both ends without ever holding the whole file in memory.

const K = new Uint32Array([
    0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
    0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
    0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
    0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
    0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
    0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
    0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
    0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

export class Sha256 {
    constructor() {
        this.h = new Uint32Array([
            0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a,
            0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
        ]);
        this.block = new Uint8Array(64);
        this.blockLen = 0;
        this.bytesHi = 0; // high 32 bits of total byte count
        this.bytesLo = 0; // low 32 bits of total byte count
        this.w = new Uint32Array(64);
        this.finished = false;
    }

    update(data) {
        if (this.finished) throw new Error('Sha256: update after digest');
        const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);

        // Track total length in bytes (64-bit via two 32-bit halves).
        this.bytesLo += bytes.length;
        if (this.bytesLo >= 0x100000000) {
            this.bytesHi += Math.floor(this.bytesLo / 0x100000000);
            this.bytesLo = this.bytesLo >>> 0;
        }

        let offset = 0;
        // Fill an existing partial block first.
        if (this.blockLen > 0) {
            const need = 64 - this.blockLen;
            const take = Math.min(need, bytes.length);
            this.block.set(bytes.subarray(0, take), this.blockLen);
            this.blockLen += take;
            offset = take;
            if (this.blockLen === 64) {
                this._compress(this.block, 0);
                this.blockLen = 0;
            }
        }
        // Process full 64-byte blocks directly from the input.
        while (offset + 64 <= bytes.length) {
            this._compress(bytes, offset);
            offset += 64;
        }
        // Buffer any remainder.
        if (offset < bytes.length) {
            this.block.set(bytes.subarray(offset), 0);
            this.blockLen = bytes.length - offset;
        }
        return this;
    }

    digest() {
        if (this.finished) return this._out.slice();

        // Total message length in bits (64-bit).
        const bitsHi = ((this.bytesHi << 3) | (this.bytesLo >>> 29)) >>> 0;
        const bitsLo = (this.bytesLo << 3) >>> 0;

        // Pad: append 0x80, then zeros, then 8-byte big-endian bit length.
        const padLen = this.blockLen < 56 ? 64 - this.blockLen : 128 - this.blockLen;
        const pad = new Uint8Array(padLen);
        pad[0] = 0x80;
        pad[padLen - 8] = (bitsHi >>> 24) & 0xff;
        pad[padLen - 7] = (bitsHi >>> 16) & 0xff;
        pad[padLen - 6] = (bitsHi >>> 8) & 0xff;
        pad[padLen - 5] = bitsHi & 0xff;
        pad[padLen - 4] = (bitsLo >>> 24) & 0xff;
        pad[padLen - 3] = (bitsLo >>> 16) & 0xff;
        pad[padLen - 2] = (bitsLo >>> 8) & 0xff;
        pad[padLen - 1] = bitsLo & 0xff;
        this.update(pad);

        const out = new Uint8Array(32);
        for (let i = 0; i < 8; i++) {
            out[i * 4] = (this.h[i] >>> 24) & 0xff;
            out[i * 4 + 1] = (this.h[i] >>> 16) & 0xff;
            out[i * 4 + 2] = (this.h[i] >>> 8) & 0xff;
            out[i * 4 + 3] = this.h[i] & 0xff;
        }
        this.finished = true;
        this._out = out;
        return out.slice();
    }

    hexDigest() {
        const out = this.digest();
        let hex = '';
        for (let i = 0; i < out.length; i++) hex += out[i].toString(16).padStart(2, '0');
        return hex;
    }

    _compress(p, pos) {
        const w = this.w;
        for (let i = 0; i < 16; i++) {
            w[i] = (p[pos + i * 4] << 24) | (p[pos + i * 4 + 1] << 16) | (p[pos + i * 4 + 2] << 8) | p[pos + i * 4 + 3];
        }
        for (let i = 16; i < 64; i++) {
            const a = w[i - 15];
            const b = w[i - 2];
            const s0 = ((a >>> 7) | (a << 25)) ^ ((a >>> 18) | (a << 14)) ^ (a >>> 3);
            const s1 = ((b >>> 17) | (b << 15)) ^ ((b >>> 19) | (b << 13)) ^ (b >>> 10);
            w[i] = (w[i - 16] + s0 + w[i - 7] + s1) >>> 0;
        }

        let a = this.h[0], b = this.h[1], c = this.h[2], d = this.h[3];
        let e = this.h[4], f = this.h[5], g = this.h[6], h = this.h[7];

        for (let i = 0; i < 64; i++) {
            const S1 = ((e >>> 6) | (e << 26)) ^ ((e >>> 11) | (e << 21)) ^ ((e >>> 25) | (e << 7));
            const ch = (e & f) ^ (~e & g);
            const t1 = (h + S1 + ch + K[i] + w[i]) >>> 0;
            const S0 = ((a >>> 2) | (a << 30)) ^ ((a >>> 13) | (a << 19)) ^ ((a >>> 22) | (a << 10));
            const maj = (a & b) ^ (a & c) ^ (b & c);
            const t2 = (S0 + maj) >>> 0;
            h = g; g = f; f = e;
            e = (d + t1) >>> 0;
            d = c; c = b; b = a;
            a = (t1 + t2) >>> 0;
        }

        this.h[0] = (this.h[0] + a) >>> 0;
        this.h[1] = (this.h[1] + b) >>> 0;
        this.h[2] = (this.h[2] + c) >>> 0;
        this.h[3] = (this.h[3] + d) >>> 0;
        this.h[4] = (this.h[4] + e) >>> 0;
        this.h[5] = (this.h[5] + f) >>> 0;
        this.h[6] = (this.h[6] + g) >>> 0;
        this.h[7] = (this.h[7] + h) >>> 0;
    }
}

/** One-shot convenience: hex SHA-256 of a byte array. */
export function sha256Hex(bytes) {
    return new Sha256().update(bytes).hexDigest();
}
