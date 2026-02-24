// BeamIt Transfer module — File reception, chunking, and download

export class FileReceiver {
    constructor(onProgress, onComplete) {
        this.onProgress = onProgress;
        this.onComplete = onComplete;
        this.currentFile = null;
        this.chunks = [];
        this.received = 0;
        this.startTime = 0;
    }

    handleData(peerId, data) {
        // String messages are control messages (JSON)
        if (typeof data === 'string') {
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
            return;
        }

        // Binary data is a file chunk
        if (this.currentFile) {
            this.chunks.push(new Uint8Array(data));
            this.received += data.byteLength;

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
