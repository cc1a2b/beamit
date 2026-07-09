// BeamIt Transfer module — File reception, chunking, decryption, and download

import { decryptPacked } from './crypto.js';

export class FileReceiver {
    constructor(onProgress, onComplete) {
        this.onProgress = onProgress;
        this.onComplete = onComplete;
        this.currentFile = null;
        this.chunks = [];
        this.received = 0;
        this.startTime = 0;
        this.sharedKey = null; // Set by app.js when key exchange completes
    }

    /**
     * Set the shared encryption key for decrypting incoming data.
     */
    setSharedKey(key) {
        this.sharedKey = key;
    }

    async handleData(peerId, data) {
        // String messages are plaintext control messages (backward compat)
        if (typeof data === 'string') {
            this._handlePlainData(peerId, data);
            return;
        }

        // Binary data — try decryption first if we have a key
        if (data instanceof ArrayBuffer || data instanceof Uint8Array) {
            const raw = data instanceof Uint8Array ? data : new Uint8Array(data);

            if (this.sharedKey) {
                try {
                    const decrypted = await decryptPacked(this.sharedKey, raw);
                    await this._processDecryptedData(peerId, decrypted);
                    return;
                } catch {
                    // Decryption failed — fall through to plain handling
                }
            }

            // No encryption key or decryption failed — handle as plain binary
            this._handlePlainBinary(peerId, raw);
        }
    }

    async _processDecryptedData(peerId, decrypted) {
        // Try to parse as JSON control message
        try {
            const text = new TextDecoder().decode(decrypted);
            const msg = JSON.parse(text);
            if (msg.type === 'file_meta') {
                this._startFile(peerId, msg);
                return;
            }
            if (msg.type === 'file_end') {
                this._endFile(peerId);
                return;
            }
        } catch {
            // Not JSON — it's a binary file chunk
        }

        // Binary file chunk
        if (this.currentFile) {
            this.chunks.push(new Uint8Array(decrypted));
            this.received += decrypted.byteLength;
            this._reportProgress();
        }
    }

    _handlePlainData(peerId, data) {
        try {
            const msg = JSON.parse(data);
            if (msg.type === 'file_meta') {
                this._startFile(peerId, msg);
            } else if (msg.type === 'file_end') {
                this._endFile(peerId);
            }
        } catch (err) {
            console.error('Failed to parse control message:', err);
        }
    }

    _handlePlainBinary(peerId, data) {
        if (this.currentFile) {
            this.chunks.push(new Uint8Array(data));
            this.received += data.byteLength;
            this._reportProgress();
        }
    }

    _startFile(peerId, meta) {
        this.currentFile = {
            name: meta.name,
            size: meta.size,
            mime: meta.mime || 'application/octet-stream',
        };
        this.chunks = [];
        this.received = 0;
        this.startTime = Date.now();
        console.log(`Receiving file: ${meta.name} (${meta.size} bytes)`);
    }

    _endFile(peerId) {
        if (!this.currentFile) return;

        // Assemble chunks into a Blob and trigger download
        const blob = new Blob(this.chunks, { type: this.currentFile.mime });
        this._downloadBlob(blob, this.currentFile.name);

        this.onProgress?.({
            id: `recv-${this.currentFile.name}`,
            name: this.currentFile.name,
            sent: this.currentFile.size,
            total: this.currentFile.size,
            progress: 1,
            speed: 0,
        });

        this.onComplete?.(this.currentFile.name, this.currentFile.size);

        this.currentFile = null;
        this.chunks = [];
        this.received = 0;
    }

    _reportProgress() {
        if (!this.currentFile) return;
        const elapsed = (Date.now() - this.startTime) / 1000;
        const speed = elapsed > 0 ? this.received / elapsed : 0;

        this.onProgress?.({
            id: `recv-${this.currentFile.name}`,
            name: this.currentFile.name,
            sent: this.received,
            total: this.currentFile.size,
            progress: this.currentFile.size > 0 ? this.received / this.currentFile.size : 0,
            speed,
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

        // Cleanup after a delay
        setTimeout(() => {
            URL.revokeObjectURL(url);
            a.remove();
        }, 1000);
    }
}
