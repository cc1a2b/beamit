// BeamIt Transfer module — receives files, decrypts, verifies integrity, and writes them out.
//
// Design goals for v1.1.0:
//   • Per-peer receive sessions — receiving from several peers at once no longer clobbers state.
//   • No memory ceiling — large transfers stream straight to disk via the File System Access API
//     (Chromium, secure context). Small transfers keep the frictionless auto-download path.
//   • End-to-end integrity — a streaming SHA-256 is compared against the sender's digest so a
//     silently corrupted or truncated transfer is caught, even over the WebSocket relay.

import { decryptPacked } from './crypto.js';
import { TAG_CONTROL, TAG_CHUNK, unframe, decodeControl, toBytes } from './wire.js';
import { Sha256 } from './sha256.js';

// Above this total size, prefer streaming to disk (if supported) instead of buffering in RAM.
const STREAM_TO_DISK_THRESHOLD = 1024 * 1024 * 1024; // 1 GiB

const fsAccessSupported = typeof window !== 'undefined'
    && typeof window.showSaveFilePicker === 'function'
    && typeof window.showDirectoryPicker === 'function'
    && (window.isSecureContext !== false);

function forceMemoryMode() {
    try {
        return localStorage.getItem('beamit_force_memory') === '1';
    } catch {
        return false;
    }
}

function sanitizeFilename(name) {
    const clean = String(name || 'file').replace(/[\\/:*?"<>|\x00-\x1f]/g, '_').replace(/^\.+/, '_').trim();
    return clean || 'file';
}

export class FileReceiver {
    constructor(onProgress, onComplete) {
        this.onProgress = onProgress;
        this.onComplete = onComplete;
        this.sessions = new Map(); // peerId -> session
        this.keys = new Map();     // peerId -> CryptoKey
    }

    /** Register the per-peer shared encryption key (from ECDH key exchange). */
    setPeerKey(peerId, key) {
        if (key) this.keys.set(peerId, key);
    }

    /**
     * Prepare a receive target for an accepted transfer. MUST be called from the accept
     * user-gesture so the save/directory picker can open. Chooses disk streaming for large
     * transfers when supported, otherwise the in-memory auto-download path.
     * Never throws — a cancelled picker gracefully falls back to memory mode.
     */
    async prepare(peerId, files) {
        const list = Array.isArray(files) ? files : [];
        const totalSize = list.reduce((sum, f) => sum + (Number(f.size) || 0), 0);
        const session = this._newSession(peerId);
        session.plan = list;

        const wantDisk = fsAccessSupported && !forceMemoryMode() && totalSize > STREAM_TO_DISK_THRESHOLD;
        if (!wantDisk) {
            session.mode = 'memory';
            return session.mode;
        }

        try {
            if (list.length === 1) {
                session.fileHandle = await window.showSaveFilePicker({
                    suggestedName: sanitizeFilename(list[0].name),
                });
                session.mode = 'disk-file';
            } else {
                session.dirHandle = await window.showDirectoryPicker({ mode: 'readwrite' });
                session.mode = 'disk-dir';
            }
        } catch (err) {
            // User cancelled or picker unavailable — fall back to in-memory download.
            console.warn('Save location not chosen, using in-memory download:', err?.name || err);
            session.mode = 'memory';
            session.fileHandle = null;
            session.dirHandle = null;
        }
        return session.mode;
    }

    /** Feed an incoming frame (ArrayBuffer / Uint8Array / string) for a peer. Ordering preserved. */
    handleData(peerId, data) {
        const session = this.sessions.get(peerId) || this._newSession(peerId);
        // Serialize per-peer so async decrypt + disk writes apply strictly in arrival order.
        session.queue = session.queue
            .then(() => this._handleFrame(session, peerId, data))
            .catch((err) => console.error('receive error:', err));
        return session.queue;
    }

    /** Tear down a peer's session, aborting any open file handle. */
    async cleanup(peerId) {
        const session = this.sessions.get(peerId);
        this.keys.delete(peerId);
        if (!session) return;
        this.sessions.delete(peerId);
        if (session.writable) {
            try { await session.writable.abort(); } catch { /* ignore */ }
        }
    }

    // ── internals ────────────────────────────────────────

    _newSession(peerId) {
        const session = {
            peerId,
            mode: 'memory',
            plan: [],
            planIndex: 0,
            fileHandle: null,
            dirHandle: null,
            writable: null,
            current: null,   // { name, size, mime, expectedHash }
            chunks: [],
            received: 0,
            startTime: 0,
            hasher: null,
            queue: Promise.resolve(),
        };
        this.sessions.set(peerId, session);
        return session;
    }

    async _handleFrame(session, peerId, data) {
        let bytes = toBytes(data);

        // Decrypt if we hold this peer's key; fall back to treating bytes as an unencrypted frame.
        const key = this.keys.get(peerId);
        if (key) {
            try {
                bytes = await decryptPacked(key, bytes);
            } catch {
                // Not encrypted (pre-key-exchange or plaintext transfer) — use as-is.
            }
        }

        const { tag, payload } = unframe(bytes);
        if (tag === TAG_CONTROL) {
            const msg = decodeControl(payload);
            if (!msg) return;
            if (msg.type === 'file_meta') await this._startFile(session, peerId, msg);
            else if (msg.type === 'file_end') await this._endFile(session, peerId, msg);
            else if (msg.type === 'transfer_cancel') await this._abortCurrent(session, peerId);
        } else if (tag === TAG_CHUNK) {
            await this._writeChunk(session, payload);
        }
    }

    async _abortCurrent(session, peerId) {
        const file = session.current;
        session.current = null;
        session.hasher = null;
        session.chunks = [];
        if (session.writable) {
            try { await session.writable.abort(); } catch { /* ignore */ }
            session.writable = null;
        }
        if (file) {
            this.onProgress?.({
                id: `recv-${session.peerId}-${file.name}`,
                name: file.name,
                sent: session.received,
                total: file.size || 0,
                progress: 0,
                speed: 0,
                direction: 'receive',
                cancelled: true,
            });
            this.onComplete?.(file.name, session.received, { cancelled: true });
        }
    }

    async _startFile(session, peerId, meta) {
        // Finalize any file left open (defensive against a missing file_end).
        if (session.current) await this._endFile(session, peerId, {});

        session.current = {
            name: meta.name || 'file',
            size: Number(meta.size) || 0,
            mime: meta.mime || 'application/octet-stream',
            expectedHash: null,
        };
        session.received = 0;
        session.startTime = Date.now();
        session.hasher = new Sha256();
        session.chunks = [];
        session.writable = null;

        if (session.mode === 'disk-file' && session.fileHandle) {
            session.writable = await session.fileHandle.createWritable();
        } else if (session.mode === 'disk-dir' && session.dirHandle) {
            const fh = await session.dirHandle.getFileHandle(sanitizeFilename(session.current.name), { create: true });
            session.writable = await fh.createWritable();
        }
        session.planIndex++;
        console.log(`Receiving ${session.current.name} (${session.current.size} bytes) [${session.mode}]`);
    }

    async _writeChunk(session, payload) {
        if (!session.current) return;
        const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);

        session.hasher?.update(bytes);
        session.received += bytes.length;

        if (session.writable) {
            // Copy: the underlying frame buffer may be reused before the async write completes.
            await session.writable.write(bytes.slice());
        } else {
            session.chunks.push(bytes.slice());
        }
        this._reportProgress(session);
    }

    async _endFile(session, peerId, msg) {
        const file = session.current;
        if (!file) return;
        session.current = null;

        const actualHash = session.hasher ? session.hasher.hexDigest() : null;
        session.hasher = null;
        const expectedHash = msg && msg.hash ? String(msg.hash).toLowerCase() : null;
        let verified = null; // null = not provided, true/false = checked
        if (expectedHash && actualHash) verified = expectedHash === actualHash;

        if (session.writable) {
            try {
                await session.writable.close();
            } catch (err) {
                console.error('failed to finalize file on disk:', err);
            }
            session.writable = null;
        } else {
            const blob = new Blob(session.chunks, { type: file.mime });
            session.chunks = [];
            this._downloadBlob(blob, sanitizeFilename(file.name));
        }

        this.onProgress?.({
            id: `recv-${session.peerId}-${file.name}`,
            name: file.name,
            sent: file.size || session.received,
            total: file.size || session.received,
            progress: 1,
            speed: 0,
            direction: 'receive',
            verified,
        });

        this.onComplete?.(file.name, file.size || session.received, { verified, mode: session.mode });
    }

    _reportProgress(session) {
        const file = session.current;
        if (!file) return;
        const elapsed = (Date.now() - session.startTime) / 1000;
        const speed = elapsed > 0 ? session.received / elapsed : 0;
        const total = file.size || 0;
        const progress = total > 0 ? Math.min(session.received / total, 1) : 0;
        this.onProgress?.({
            id: `recv-${session.peerId}-${file.name}`,
            name: file.name,
            sent: session.received,
            total,
            progress,
            speed,
            eta: speed > 0 && total > 0 ? Math.max((total - session.received) / speed, 0) : 0,
            direction: 'receive',
        });
    }

    _downloadBlob(blob, filename) {
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = filename;
        a.style.display = 'none';
        document.body.appendChild(a);
        a.click();
        setTimeout(() => {
            URL.revokeObjectURL(url);
            a.remove();
        }, 1000);
    }
}
