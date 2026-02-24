// BeamIt Crypto module — AES-256-GCM encryption using Web Crypto API

const ALGORITHM = 'AES-GCM';
const KEY_LENGTH = 256;
const IV_LENGTH = 12; // 96 bits for GCM

/**
 * Generate an AES-256-GCM key pair for the session.
 * Returns a CryptoKey that can be exported/imported.
 */
async function generateKey() {
    return await crypto.subtle.generateKey(
        { name: ALGORITHM, length: KEY_LENGTH },
        true, // extractable — needed for key exchange
        ['encrypt', 'decrypt']
    );
}

/**
 * Export a CryptoKey to raw bytes (for sending to peer).
 */
async function exportKey(key) {
    const raw = await crypto.subtle.exportKey('raw', key);
    return new Uint8Array(raw);
}

/**
 * Import raw bytes as an AES-256-GCM CryptoKey.
 */
async function importKey(raw) {
    return await crypto.subtle.importKey(
        'raw',
        raw,
        { name: ALGORITHM, length: KEY_LENGTH },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Generate an ECDH key pair for key exchange.
 */
async function generateECDHKeyPair() {
    return await crypto.subtle.generateKey(
        { name: 'ECDH', namedCurve: 'P-256' },
        true,
        ['deriveKey']
    );
}

/**
 * Export an ECDH public key to raw bytes.
 */
async function exportPublicKey(keyPair) {
    const raw = await crypto.subtle.exportKey('raw', keyPair.publicKey);
    return new Uint8Array(raw);
}

/**
 * Import a peer's ECDH public key from raw bytes.
 */
async function importPublicKey(raw) {
    return await crypto.subtle.importKey(
        'raw',
        raw,
        { name: 'ECDH', namedCurve: 'P-256' },
        false,
        []
    );
}

/**
 * Derive a shared AES-256-GCM key from our private key and the peer's public key.
 */
async function deriveSharedKey(privateKey, peerPublicKey) {
    return await crypto.subtle.deriveKey(
        { name: 'ECDH', public: peerPublicKey },
        privateKey,
        { name: ALGORITHM, length: KEY_LENGTH },
        false,
        ['encrypt', 'decrypt']
    );
}

/**
 * Encrypt a chunk of data with AES-256-GCM.
 * Returns: { iv: Uint8Array(12), ciphertext: Uint8Array }
 */
async function encrypt(key, data) {
    const iv = crypto.getRandomValues(new Uint8Array(IV_LENGTH));
    const ciphertext = await crypto.subtle.encrypt(
        { name: ALGORITHM, iv },
        key,
        data
    );
    return { iv, ciphertext: new Uint8Array(ciphertext) };
}

/**
 * Decrypt a chunk of data with AES-256-GCM.
 */
async function decrypt(key, iv, ciphertext) {
    const plaintext = await crypto.subtle.decrypt(
        { name: ALGORITHM, iv },
        key,
        ciphertext
    );
    return new Uint8Array(plaintext);
}

/**
 * Encrypt and pack into a single buffer: [iv(12) | ciphertext]
 */
async function encryptPacked(key, data) {
    const { iv, ciphertext } = await encrypt(key, data);
    const packed = new Uint8Array(iv.length + ciphertext.length);
    packed.set(iv, 0);
    packed.set(ciphertext, iv.length);
    return packed;
}

/**
 * Unpack and decrypt: [iv(12) | ciphertext]
 */
async function decryptPacked(key, packed) {
    const iv = packed.slice(0, IV_LENGTH);
    const ciphertext = packed.slice(IV_LENGTH);
    return await decrypt(key, iv, ciphertext);
}

export {
    generateKey, exportKey, importKey,
    generateECDHKeyPair, exportPublicKey, importPublicKey,
    deriveSharedKey,
    encrypt, decrypt,
    encryptPacked, decryptPacked,
};
