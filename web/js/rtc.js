// BeamIt RTC module — WebRTC connection management

const RTC_CONFIG = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
    ]
};

const CHUNK_SIZE = 64 * 1024; // 64KB chunks
const DATA_CHANNEL_OPTIONS = {
    ordered: true,
    maxRetransmits: 10,
};

export class RTCPeer {
    constructor(peerId, signaling, handlers) {
        this.peerId = peerId;
        this.signaling = signaling;
        this.handlers = handlers;
        this.pc = null;
        this.dc = null; // data channel
        this.isInitiator = false;
        this.connectionState = 'new';
        this.pendingCandidates = [];
    }

    async createOffer() {
        this.isInitiator = true;
        this._createPeerConnection();
        this._createDataChannel();

        const offer = await this.pc.createOffer();
        await this.pc.setLocalDescription(offer);

        this.signaling.send('offer', {
            target: this.peerId,
            sdp: this.pc.localDescription.sdp,
        });
    }

    async handleOffer(sdp) {
        this.isInitiator = false;
        this._createPeerConnection();

        await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'offer', sdp }));

        // Apply any pending ICE candidates
        for (const candidate of this.pendingCandidates) {
            await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
        this.pendingCandidates = [];

        const answer = await this.pc.createAnswer();
        await this.pc.setLocalDescription(answer);

        this.signaling.send('answer', {
            target: this.peerId,
            sdp: this.pc.localDescription.sdp,
        });
    }

    async handleAnswer(sdp) {
        if (!this.pc) return;
        await this.pc.setRemoteDescription(new RTCSessionDescription({ type: 'answer', sdp }));

        // Apply any pending ICE candidates
        for (const candidate of this.pendingCandidates) {
            await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
        }
        this.pendingCandidates = [];
    }

    async handleICECandidate(candidate) {
        if (!this.pc || !this.pc.remoteDescription) {
            this.pendingCandidates.push(candidate);
            return;
        }
        await this.pc.addIceCandidate(new RTCIceCandidate(candidate));
    }

    async sendFile(file, onProgress) {
        if (!this.dc || this.dc.readyState !== 'open') {
            throw new Error('Data channel not open');
        }

        // Send file metadata first
        const meta = JSON.stringify({
            type: 'file_meta',
            name: file.name,
            size: file.size,
            mime: file.type,
        });
        this.dc.send(meta);

        // Read and send file in chunks
        const reader = file.stream().getReader();
        let sent = 0;
        const startTime = Date.now();

        const sendNextChunks = async () => {
            while (true) {
                // Back-pressure: wait if buffer is getting full
                if (this.dc.bufferedAmount > CHUNK_SIZE * 16) {
                    await new Promise(resolve => {
                        this.dc.onbufferedamountlow = resolve;
                        this.dc.bufferedAmountLowThreshold = CHUNK_SIZE * 4;
                    });
                }

                const { done, value } = await reader.read();
                if (done) break;

                // Send chunk — may need to split if larger than CHUNK_SIZE
                let offset = 0;
                while (offset < value.length) {
                    const end = Math.min(offset + CHUNK_SIZE, value.length);
                    const chunk = value.slice(offset, end);
                    this.dc.send(chunk);
                    sent += chunk.length;
                    offset = end;

                    const elapsed = (Date.now() - startTime) / 1000;
                    const speed = elapsed > 0 ? sent / elapsed : 0;
                    onProgress?.({
                        sent,
                        total: file.size,
                        progress: sent / file.size,
                        speed,
                        name: file.name,
                    });
                }
            }

            // Send end marker
            this.dc.send(JSON.stringify({ type: 'file_end' }));
            onProgress?.({
                sent: file.size,
                total: file.size,
                progress: 1,
                speed: 0,
                name: file.name,
            });
        };

        await sendNextChunks();
    }

    close() {
        if (this.dc) {
            this.dc.close();
            this.dc = null;
        }
        if (this.pc) {
            this.pc.close();
            this.pc = null;
        }
        this.connectionState = 'closed';
    }

    _createPeerConnection() {
        this.pc = new RTCPeerConnection(RTC_CONFIG);

        this.pc.onicecandidate = (event) => {
            if (event.candidate) {
                this.signaling.send('ice', {
                    target: this.peerId,
                    candidate: event.candidate.toJSON(),
                });
            }
        };

        this.pc.onconnectionstatechange = () => {
            this.connectionState = this.pc.connectionState;
            this.handlers.onConnectionStateChange?.(this.peerId, this.connectionState);

            if (this.connectionState === 'failed' || this.connectionState === 'disconnected') {
                this.handlers.onDisconnected?.(this.peerId);
            }
        };

        this.pc.oniceconnectionstatechange = () => {
            console.debug(`ICE state [${this.peerId}]:`, this.pc.iceConnectionState);
        };

        // Handle incoming data channel (when we're the answerer)
        this.pc.ondatachannel = (event) => {
            this.dc = event.channel;
            this._setupDataChannel();
        };
    }

    _createDataChannel() {
        this.dc = this.pc.createDataChannel('beamit', DATA_CHANNEL_OPTIONS);
        this.dc.binaryType = 'arraybuffer';
        this._setupDataChannel();
    }

    _setupDataChannel() {
        this.dc.binaryType = 'arraybuffer';
        this.dc.bufferedAmountLowThreshold = CHUNK_SIZE * 4;

        this.dc.onopen = () => {
            console.log(`Data channel open [${this.peerId}]`);
            this.handlers.onDataChannelOpen?.(this.peerId);
        };

        this.dc.onclose = () => {
            console.log(`Data channel closed [${this.peerId}]`);
            this.handlers.onDataChannelClose?.(this.peerId);
        };

        this.dc.onmessage = (event) => {
            this.handlers.onData?.(this.peerId, event.data);
        };

        this.dc.onerror = (event) => {
            console.error(`Data channel error [${this.peerId}]:`, event);
        };
    }
}

export { CHUNK_SIZE };
