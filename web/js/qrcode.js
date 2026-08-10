// BeamIt QR module — dependency-free QR Code generator (byte mode, versions 1-40).
//
// Implements the QR Code Model 2 spec (ISO/IEC 18004): data encoding, Reed-Solomon
// error correction over GF(256), function-pattern placement, data masking with penalty
// scoring, and BCH format/version information. Byte-mode only, which is all BeamIt needs
// (it encodes short share URLs). Algorithm follows the public-domain reference approach
// of Project Nayuki's QR Code generator, reimplemented here as a self-contained module.

const Ecc = {
    LOW:      { ordinal: 0, formatBits: 1 },
    MEDIUM:   { ordinal: 1, formatBits: 0 },
    QUARTILE: { ordinal: 2, formatBits: 3 },
    HIGH:     { ordinal: 3, formatBits: 2 },
};

const MIN_VERSION = 1;
const MAX_VERSION = 40;

// ECC codewords per block, indexed [ecl.ordinal][version]. Index 0 is padding.
const ECC_CODEWORDS_PER_BLOCK = [
    [-1, 7, 10, 15, 20, 26, 18, 20, 24, 30, 18, 20, 24, 26, 30, 22, 24, 28, 30, 28, 28, 28, 28, 30, 30, 26, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 10, 16, 26, 18, 24, 16, 18, 22, 22, 26, 30, 22, 22, 24, 24, 28, 28, 26, 26, 26, 26, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28, 28],
    [-1, 13, 22, 18, 26, 18, 24, 18, 22, 20, 24, 28, 26, 24, 20, 30, 24, 28, 28, 26, 30, 28, 30, 30, 30, 30, 28, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
    [-1, 17, 28, 22, 16, 22, 28, 26, 26, 24, 28, 24, 28, 22, 24, 24, 30, 28, 28, 26, 28, 30, 24, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30, 30],
];

// Number of ECC blocks, indexed [ecl.ordinal][version]. Index 0 is padding.
const NUM_ERROR_CORRECTION_BLOCKS = [
    [-1, 1, 1, 1, 1, 1, 2, 2, 2, 2, 4, 4, 4, 4, 4, 6, 6, 6, 6, 7, 8, 8, 9, 9, 10, 12, 12, 12, 13, 14, 15, 16, 17, 18, 19, 19, 20, 21, 22, 24, 25],
    [-1, 1, 1, 1, 2, 2, 4, 4, 4, 5, 5, 5, 8, 9, 9, 10, 10, 11, 13, 14, 16, 17, 17, 18, 20, 21, 23, 25, 26, 28, 29, 31, 33, 35, 37, 38, 40, 43, 45, 47, 49],
    [-1, 1, 1, 2, 2, 4, 4, 6, 6, 8, 8, 8, 10, 12, 16, 12, 17, 16, 18, 21, 20, 23, 23, 25, 27, 29, 34, 34, 35, 38, 40, 43, 45, 48, 51, 53, 56, 59, 62, 65, 68],
    [-1, 1, 1, 2, 4, 4, 4, 5, 6, 8, 8, 11, 11, 16, 16, 18, 16, 19, 21, 25, 25, 25, 34, 30, 32, 35, 37, 40, 42, 45, 48, 51, 54, 57, 60, 63, 66, 70, 74, 77, 81],
];

function assert(cond) {
    if (!cond) throw new Error('QR assertion failed');
}

function getBit(x, i) {
    return ((x >>> i) & 1) !== 0;
}

// ── Reed-Solomon over GF(256) ────────────────────────────

function reedSolomonMultiply(x, y) {
    let z = 0;
    for (let i = 7; i >= 0; i--) {
        z = (z << 1) ^ ((z >>> 7) * 0x11D);
        z ^= ((y >>> i) & 1) * x;
    }
    return z & 0xFF;
}

function reedSolomonComputeDivisor(degree) {
    if (degree < 1 || degree > 255) throw new RangeError('degree out of range');
    const result = [];
    for (let i = 0; i < degree - 1; i++) result.push(0);
    result.push(1);
    let root = 1;
    for (let i = 0; i < degree; i++) {
        for (let j = 0; j < result.length; j++) {
            result[j] = reedSolomonMultiply(result[j], root);
            if (j + 1 < result.length) result[j] ^= result[j + 1];
        }
        root = reedSolomonMultiply(root, 0x02);
    }
    return result;
}

function reedSolomonComputeRemainder(data, divisor) {
    const result = divisor.map(() => 0);
    for (const b of data) {
        const factor = b ^ result.shift();
        result.push(0);
        divisor.forEach((coef, i) => result[i] ^= reedSolomonMultiply(coef, factor));
    }
    return result;
}

// ── Bit buffer helpers ───────────────────────────────────

function appendBits(val, len, bb) {
    if (len < 0 || len > 31 || val >>> len !== 0) throw new RangeError('value out of range');
    for (let i = len - 1; i >= 0; i--) bb.push((val >>> i) & 1);
}

// ── Segment (byte mode only) ─────────────────────────────

function utf8ToBytes(str) {
    return Array.from(new TextEncoder().encode(str));
}

function makeBytesSegment(data) {
    const bb = [];
    for (const b of data) appendBits(b, 8, bb);
    return { modeBits: 0x4, numChars: data.length, bitData: bb };
}

function numCharCountBits(version) {
    // Byte mode: 8 bits for v1-9, else 16 bits.
    return version <= 9 ? 8 : 16;
}

function segmentTotalBits(seg, version) {
    const ccbits = numCharCountBits(version);
    if (seg.numChars >= (1 << ccbits)) return Infinity;
    return 4 + ccbits + seg.bitData.length;
}

// ── QrCode ───────────────────────────────────────────────

export class QrCode {
    constructor(version, ecl, dataCodewords, mask) {
        if (version < MIN_VERSION || version > MAX_VERSION) throw new RangeError('version out of range');
        if (mask < -1 || mask > 7) throw new RangeError('mask out of range');
        this.version = version;
        this.ecl = ecl;
        this.size = version * 4 + 17;

        const row = new Array(this.size).fill(false);
        this.modules = [];
        this.isFunction = [];
        for (let i = 0; i < this.size; i++) {
            this.modules.push(row.slice());
            this.isFunction.push(row.slice());
        }

        this._drawFunctionPatterns();
        const allCodewords = this._addEccAndInterleave(dataCodewords);
        this._drawCodewords(allCodewords);

        if (mask === -1) {
            let minPenalty = Infinity;
            for (let i = 0; i < 8; i++) {
                this._applyMask(i);
                this._drawFormatBits(i);
                const penalty = this._getPenaltyScore();
                if (penalty < minPenalty) {
                    mask = i;
                    minPenalty = penalty;
                }
                this._applyMask(i); // undo
            }
        }
        assert(mask >= 0 && mask <= 7);
        this.mask = mask;
        this._applyMask(mask);
        this._drawFormatBits(mask);
        this.isFunction = [];
    }

    getModule(x, y) {
        return x >= 0 && x < this.size && y >= 0 && y < this.size && this.modules[y][x];
    }

    static encodeText(text, ecl) {
        return QrCode.encodeBinary(utf8ToBytes(text), ecl);
    }

    static encodeBinary(data, ecl) {
        const seg = makeBytesSegment(data);
        return QrCode._encodeSegment(seg, ecl);
    }

    static _encodeSegment(seg, ecl, boostEcl = true) {
        let version = MIN_VERSION;
        let dataUsedBits;
        for (;; version++) {
            const capacityBits = QrCode._getNumDataCodewords(version, ecl) * 8;
            const usedBits = segmentTotalBits(seg, version);
            if (usedBits <= capacityBits) {
                dataUsedBits = usedBits;
                break;
            }
            if (version >= MAX_VERSION) throw new RangeError('Data too long for a QR code');
        }

        for (const newEcl of [Ecc.MEDIUM, Ecc.QUARTILE, Ecc.HIGH]) {
            if (boostEcl && dataUsedBits <= QrCode._getNumDataCodewords(version, newEcl) * 8) ecl = newEcl;
        }

        const bb = [];
        appendBits(seg.modeBits, 4, bb);
        appendBits(seg.numChars, numCharCountBits(version), bb);
        for (const bit of seg.bitData) bb.push(bit);

        const dataCapacityBits = QrCode._getNumDataCodewords(version, ecl) * 8;
        appendBits(0, Math.min(4, dataCapacityBits - bb.length), bb);
        appendBits(0, (8 - (bb.length % 8)) % 8, bb);
        for (let padByte = 0xEC; bb.length < dataCapacityBits; padByte ^= 0xEC ^ 0x11) {
            appendBits(padByte, 8, bb);
        }

        const dataCodewords = new Array(bb.length >>> 3).fill(0);
        bb.forEach((bit, i) => {
            dataCodewords[i >>> 3] |= bit << (7 - (i & 7));
        });

        return new QrCode(version, ecl, dataCodewords, -1);
    }

    // ── Function patterns ────────────────────────────────

    _drawFunctionPatterns() {
        for (let i = 0; i < this.size; i++) {
            this._setFunctionModule(6, i, i % 2 === 0);
            this._setFunctionModule(i, 6, i % 2 === 0);
        }

        this._drawFinderPattern(3, 3);
        this._drawFinderPattern(this.size - 4, 3);
        this._drawFinderPattern(3, this.size - 4);

        const alignPatPos = this._getAlignmentPatternPositions();
        const numAlign = alignPatPos.length;
        for (let i = 0; i < numAlign; i++) {
            for (let j = 0; j < numAlign; j++) {
                if (!((i === 0 && j === 0) || (i === 0 && j === numAlign - 1) || (i === numAlign - 1 && j === 0))) {
                    this._drawAlignmentPattern(alignPatPos[i], alignPatPos[j]);
                }
            }
        }

        this._drawFormatBits(0);
        this._drawVersion();
    }

    _drawFormatBits(mask) {
        const data = (this.ecl.formatBits << 3) | mask;
        let rem = data;
        for (let i = 0; i < 10; i++) rem = (rem << 1) ^ ((rem >>> 9) * 0x537);
        const bits = ((data << 10) | rem) ^ 0x5412;
        assert(bits >>> 15 === 0);

        for (let i = 0; i <= 5; i++) this._setFunctionModule(8, i, getBit(bits, i));
        this._setFunctionModule(8, 7, getBit(bits, 6));
        this._setFunctionModule(8, 8, getBit(bits, 7));
        this._setFunctionModule(7, 8, getBit(bits, 8));
        for (let i = 9; i < 15; i++) this._setFunctionModule(14 - i, 8, getBit(bits, i));

        for (let i = 0; i < 8; i++) this._setFunctionModule(this.size - 1 - i, 8, getBit(bits, i));
        for (let i = 8; i < 15; i++) this._setFunctionModule(8, this.size - 15 + i, getBit(bits, i));
        this._setFunctionModule(8, this.size - 8, true);
    }

    _drawVersion() {
        if (this.version < 7) return;
        let rem = this.version;
        for (let i = 0; i < 12; i++) rem = (rem << 1) ^ ((rem >>> 11) * 0x1F25);
        const bits = (this.version << 12) | rem;
        assert(bits >>> 18 === 0);

        for (let i = 0; i < 18; i++) {
            const bit = getBit(bits, i);
            const a = this.size - 11 + (i % 3);
            const b = Math.floor(i / 3);
            this._setFunctionModule(a, b, bit);
            this._setFunctionModule(b, a, bit);
        }
    }

    _drawFinderPattern(x, y) {
        for (let dy = -4; dy <= 4; dy++) {
            for (let dx = -4; dx <= 4; dx++) {
                const dist = Math.max(Math.abs(dx), Math.abs(dy));
                const xx = x + dx;
                const yy = y + dy;
                if (xx >= 0 && xx < this.size && yy >= 0 && yy < this.size) {
                    this._setFunctionModule(xx, yy, dist !== 2 && dist !== 4);
                }
            }
        }
    }

    _drawAlignmentPattern(x, y) {
        for (let dy = -2; dy <= 2; dy++) {
            for (let dx = -2; dx <= 2; dx++) {
                this._setFunctionModule(x + dx, y + dy, Math.max(Math.abs(dx), Math.abs(dy)) !== 1);
            }
        }
    }

    _setFunctionModule(x, y, isDark) {
        this.modules[y][x] = isDark;
        this.isFunction[y][x] = true;
    }

    // ── Codewords ────────────────────────────────────────

    _addEccAndInterleave(data) {
        const ver = this.version;
        const ecl = this.ecl;
        if (data.length !== QrCode._getNumDataCodewords(ver, ecl)) throw new RangeError('invalid data length');

        const numBlocks = NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
        const blockEccLen = ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver];
        const rawCodewords = Math.floor(QrCode._getNumRawDataModules(ver) / 8);
        const numShortBlocks = numBlocks - (rawCodewords % numBlocks);
        const shortBlockLen = Math.floor(rawCodewords / numBlocks);

        const blocks = [];
        const rsDiv = reedSolomonComputeDivisor(blockEccLen);
        for (let i = 0, k = 0; i < numBlocks; i++) {
            const datLen = shortBlockLen - blockEccLen + (i < numShortBlocks ? 0 : 1);
            const dat = data.slice(k, k + datLen);
            k += datLen;
            const ecc = reedSolomonComputeRemainder(dat, rsDiv);
            if (i < numShortBlocks) dat.push(0);
            blocks.push(dat.concat(ecc));
        }

        const result = [];
        for (let i = 0; i < blocks[0].length; i++) {
            blocks.forEach((block, j) => {
                if (i !== shortBlockLen - blockEccLen || j >= numShortBlocks) result.push(block[i]);
            });
        }
        assert(result.length === rawCodewords);
        return result;
    }

    _drawCodewords(data) {
        if (data.length !== Math.floor(QrCode._getNumRawDataModules(this.version) / 8)) {
            throw new RangeError('invalid codeword length');
        }
        let i = 0;
        for (let right = this.size - 1; right >= 1; right -= 2) {
            if (right === 6) right = 5;
            for (let vert = 0; vert < this.size; vert++) {
                for (let j = 0; j < 2; j++) {
                    const x = right - j;
                    const upward = ((right + 1) & 2) === 0;
                    const y = upward ? this.size - 1 - vert : vert;
                    if (!this.isFunction[y][x] && i < data.length * 8) {
                        this.modules[y][x] = getBit(data[i >>> 3], 7 - (i & 7));
                        i++;
                    }
                }
            }
        }
        assert(i === data.length * 8);
    }

    _applyMask(mask) {
        for (let y = 0; y < this.size; y++) {
            for (let x = 0; x < this.size; x++) {
                let invert;
                switch (mask) {
                    case 0: invert = (x + y) % 2 === 0; break;
                    case 1: invert = y % 2 === 0; break;
                    case 2: invert = x % 3 === 0; break;
                    case 3: invert = (x + y) % 3 === 0; break;
                    case 4: invert = (Math.floor(x / 3) + Math.floor(y / 2)) % 2 === 0; break;
                    case 5: invert = ((x * y) % 2) + ((x * y) % 3) === 0; break;
                    case 6: invert = (((x * y) % 2) + ((x * y) % 3)) % 2 === 0; break;
                    case 7: invert = (((x + y) % 2) + ((x * y) % 3)) % 2 === 0; break;
                    default: throw new Error('unreachable');
                }
                if (!this.isFunction[y][x] && invert) this.modules[y][x] = !this.modules[y][x];
            }
        }
    }

    _getPenaltyScore() {
        let result = 0;
        const size = this.size;
        const mod = this.modules;

        // Adjacent modules in rows.
        for (let y = 0; y < size; y++) {
            let runColor = false, runX = 0;
            const runHistory = [0, 0, 0, 0, 0, 0, 0];
            for (let x = 0; x < size; x++) {
                if (mod[y][x] === runColor) {
                    runX++;
                    if (runX === 5) result += 3;
                    else if (runX > 5) result++;
                } else {
                    this._finderPenaltyAddHistory(runX, runHistory);
                    if (!runColor) result += this._finderPenaltyCountPatterns(runHistory) * 40;
                    runColor = mod[y][x];
                    runX = 1;
                }
            }
            result += this._finderPenaltyTerminateAndCount(runColor, runX, runHistory) * 40;
        }
        // Adjacent modules in columns.
        for (let x = 0; x < size; x++) {
            let runColor = false, runY = 0;
            const runHistory = [0, 0, 0, 0, 0, 0, 0];
            for (let y = 0; y < size; y++) {
                if (mod[y][x] === runColor) {
                    runY++;
                    if (runY === 5) result += 3;
                    else if (runY > 5) result++;
                } else {
                    this._finderPenaltyAddHistory(runY, runHistory);
                    if (!runColor) result += this._finderPenaltyCountPatterns(runHistory) * 40;
                    runColor = mod[y][x];
                    runY = 1;
                }
            }
            result += this._finderPenaltyTerminateAndCount(runColor, runY, runHistory) * 40;
        }

        // 2x2 blocks of same color.
        for (let y = 0; y < size - 1; y++) {
            for (let x = 0; x < size - 1; x++) {
                const c = mod[y][x];
                if (c === mod[y][x + 1] && c === mod[y + 1][x] && c === mod[y + 1][x + 1]) result += 3;
            }
        }

        // Balance of dark/light.
        let dark = 0;
        for (const rowArr of mod) dark += rowArr.reduce((s, c) => s + (c ? 1 : 0), 0);
        const total = size * size;
        const k = Math.ceil(Math.abs(dark * 20 - total * 10) / total) - 1;
        result += k * 10;
        return result;
    }

    _finderPenaltyCountPatterns(runHistory) {
        const n = runHistory[1];
        const core = n > 0 && runHistory[2] === n && runHistory[3] === n * 3 && runHistory[4] === n && runHistory[5] === n;
        return (core && runHistory[0] >= n * 4 && runHistory[6] >= n ? 1 : 0)
             + (core && runHistory[6] >= n * 4 && runHistory[0] >= n ? 1 : 0);
    }

    _finderPenaltyTerminateAndCount(currentRunColor, currentRunLength, runHistory) {
        if (currentRunColor) {
            this._finderPenaltyAddHistory(currentRunLength, runHistory);
            currentRunLength = 0;
        }
        currentRunLength += this.size;
        this._finderPenaltyAddHistory(currentRunLength, runHistory);
        return this._finderPenaltyCountPatterns(runHistory);
    }

    _finderPenaltyAddHistory(currentRunLength, runHistory) {
        if (runHistory[0] === 0) currentRunLength += this.size;
        runHistory.pop();
        runHistory.unshift(currentRunLength);
    }

    _getAlignmentPatternPositions() {
        if (this.version === 1) return [];
        const numAlign = Math.floor(this.version / 7) + 2;
        const step = this.version === 32 ? 26 : Math.ceil((this.version * 4 + 4) / (numAlign * 2 - 2)) * 2;
        const result = [6];
        for (let pos = this.size - 7; result.length < numAlign; pos -= step) result.splice(1, 0, pos);
        return result;
    }

    static _getNumRawDataModules(ver) {
        if (ver < MIN_VERSION || ver > MAX_VERSION) throw new RangeError('version out of range');
        let result = (16 * ver + 128) * ver + 64;
        if (ver >= 2) {
            const numAlign = Math.floor(ver / 7) + 2;
            result -= (25 * numAlign - 10) * numAlign - 55;
            if (ver >= 7) result -= 36;
        }
        return result;
    }

    static _getNumDataCodewords(ver, ecl) {
        return Math.floor(QrCode._getNumRawDataModules(ver) / 8)
             - ECC_CODEWORDS_PER_BLOCK[ecl.ordinal][ver] * NUM_ERROR_CORRECTION_BLOCKS[ecl.ordinal][ver];
    }
}

export { Ecc };

// ── Rendering helpers ────────────────────────────────────

/**
 * Render a QrCode onto a canvas element. Scales to fit `sizePx` (device pixels).
 */
export function renderToCanvas(qr, canvas, sizePx, border = 4, dark = '#000000', light = '#ffffff') {
    const dim = qr.size + border * 2;
    const scale = Math.max(1, Math.floor(sizePx / dim));
    canvas.width = dim * scale;
    canvas.height = dim * scale;
    const ctx = canvas.getContext('2d');
    ctx.fillStyle = light;
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = dark;
    for (let y = 0; y < qr.size; y++) {
        for (let x = 0; x < qr.size; x++) {
            if (qr.getModule(x, y)) {
                ctx.fillRect((x + border) * scale, (y + border) * scale, scale, scale);
            }
        }
    }
    return canvas;
}

/**
 * Produce a standalone SVG string for a QrCode.
 */
export function toSvgString(qr, border = 4, dark = '#000000', light = '#ffffff') {
    const dim = qr.size + border * 2;
    const parts = [];
    for (let y = 0; y < qr.size; y++) {
        for (let x = 0; x < qr.size; x++) {
            if (qr.getModule(x, y)) parts.push(`M${x + border},${y + border}h1v1h-1z`);
        }
    }
    return `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 ${dim} ${dim}" stroke="none">` +
        `<rect width="100%" height="100%" fill="${light}"/>` +
        `<path d="${parts.join(' ')}" fill="${dark}"/></svg>`;
}
