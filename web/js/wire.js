// BeamIt wire protocol — framing shared by sender (rtc.js) and receiver (transfer.js).
//
// Every payload sent over a data channel or the WebSocket relay is a binary frame:
//   plaintext frame  = [tag(1) | payload...]
//   encrypted frame  = AES-256-GCM( [tag(1) | payload...] )  ->  [iv(12) | ciphertext]
//
// The 1-byte tag disambiguates control messages from raw file bytes without heuristics,
// so a file whose bytes happen to look like JSON can never be mistaken for a control frame.

export const TAG_CONTROL = 0x00; // payload is UTF-8 JSON (file_meta / file_end)
export const TAG_CHUNK = 0x01;   // payload is raw file bytes

const encoder = new TextEncoder();
const decoder = new TextDecoder();

/** Build a framed byte array [tag | payload]. `payload` is a Uint8Array. */
export function frame(tag, payload) {
    const out = new Uint8Array(1 + payload.length);
    out[0] = tag;
    out.set(payload, 1);
    return out;
}

/** Frame a control object as [TAG_CONTROL | utf8(json)]. */
export function frameControl(obj) {
    return frame(TAG_CONTROL, encoder.encode(JSON.stringify(obj)));
}

/** Frame raw file bytes as [TAG_CHUNK | bytes]. */
export function frameChunk(bytes) {
    return frame(TAG_CHUNK, bytes);
}

/** Parse a framed byte array into { tag, payload }. */
export function unframe(bytes) {
    return { tag: bytes[0], payload: bytes.subarray(1) };
}

/** Decode a control payload (Uint8Array) into an object, or null if malformed. */
export function decodeControl(payload) {
    try {
        return JSON.parse(decoder.decode(payload));
    } catch {
        return null;
    }
}

/** Normalize DataChannel / relay input (ArrayBuffer, TypedArray, or string) to Uint8Array. */
export function toBytes(data) {
    if (data instanceof Uint8Array) return data;
    if (data instanceof ArrayBuffer) return new Uint8Array(data);
    if (ArrayBuffer.isView(data)) return new Uint8Array(data.buffer, data.byteOffset, data.byteLength);
    if (typeof data === 'string') return encoder.encode(data);
    return new Uint8Array(data);
}
