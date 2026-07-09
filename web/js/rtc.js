// BeamIt RTC module — WebRTC connection management, encryption, relay fallback

import {
    generateECDHKeyPair, exportPublicKey, importPublicKey,
    deriveSharedKey, encryptPacked, decryptPacked,
} from './crypto.js';

let rtcConfig = {
    iceServers: [
        { urls: 'stun:stun.l.google.com:19302' },
        { urls: 'stun:stun1.l.google.com:19302' },
        { urls: 'stun:stun2.l.google.com:19302' },
        { urls: 'stun:stun3.l.google.com:19302' },
        { urls: 'stun:stun4.l.google.com:19302' },
        { urls: 'stun:stun.cloudflare.com:3478' },
    ]
};

const CHUNK_SIZE = 64 * 1024; // 64KB chunks
const RELAY_CHUNK_SIZE = 48 * 1024; // Smaller for base64 overhead over WebSocket
const DATA_CHANNEL_OPTIONS = {
    ordered: true,
    maxRetransmits: 10,
};

/**
 * Fetch TURN credentials from the server and merge into rtcConfig.
 */
export async function fetchTURNCredentials() {
    try {
        const resp = await fetch('/api/turn');
        if (!resp.ok) return;
        const data = await resp.json();
        if (data.ice_servers && data.ice_servers.length > 0) {
            for (const server of data.ice_servers) {
                rtcConfig.iceServers.push(server);
            }
            console.log('TURN credentials loaded:', data.ice_servers.length, 'server(s)');
        }
    } catch (err) {
        console.warn('Failed to fetch TURN credentials:', err);
    }
}

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

        // E2E encryption state
        this.ecdhKeyPair = null;
        this.sharedKey = null;
        this.encryptionReady = false;

        // Connection mode tracking
        this.connectionMode = 'connecting'; // 'connecting' | 'p2p' | 'turn' | 'relay'
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

        await this.pc.setRemoteDescription({ type: 'offer', sdp });

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
        await this.pc.setRemoteDescription({ type: 'answer', sdp });

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

    // ── E2E Encryption Key Exchange ──────────────────────

    /**
     * Initiate ECDH key exchange — generate keypair, send public key via signaling.
     * Returns a promise that resolves when the shared key is derived.
     */
    async initiateKeyExchange() {
        this.ecdhKeyPair = await generateECDHKeyPair();
        const pubKeyRaw = await exportPublicKey(this.ecdhKeyPair);
        const pubKeyB64 = _arrayToBase64(pubKeyRaw);

        this.signaling.send('key_exchange', {
            target: this.peerId,
            public_key: pubKeyB64,
        });

        // If we already have the peer's key (they sent first), derive now.
        if (this._pendingPeerKey) {
            await this._deriveSharedKey(this._pendingPeerKey);
            this._pendingPeerKey = null;
        }

        // Wait for encryption to be ready (peer key may arrive later).
        await this._waitForEncryption(10000);
    }

    /**
     * Handle incoming key_exchange message from peer.
     */
    async handleKeyExchange(pubKeyB64) {
        const peerPubKeyRaw = _base64ToArray(pubKeyB64);

        if (!this.ecdhKeyPair) {
            // Peer initiated first — store their key and generate our own.
            this._pendingPeerKey = peerPubKeyRaw;
            this.ecdhKeyPair = await generateECDHKeyPair();
            const ourPubRaw = await exportPublicKey(this.ecdhKeyPair);
            this.signaling.send('key_exchange', {
                target: this.peerId,
                public_key: _arrayToBase64(ourPubRaw),
            });
            await this._deriveSharedKey(peerPubKeyRaw);
        } else {
            // We already sent our key — just derive the shared secret.
            await this._deriveSharedKey(peerPubKeyRaw);
        }
    }

    async _deriveSharedKey(peerPubKeyRaw) {
        const peerPubKey = await importPublicKey(peerPubKeyRaw);
        this.sharedKey = await deriveSharedKey(this.ecdhKeyPair.privateKey, peerPubKey);
        this.encryptionReady = true;
        console.log(`E2E encryption established [${this.peerId}]`);
    }

    _waitForEncryption(timeoutMs) {
        if (this.encryptionReady) return Promise.resolve();
        return new Promise((resolve, reject) => {
            const start = Date.now();
            const check = () => {
                if (this.encryptionReady) return resolve();
                if (Date.now() - start > timeoutMs) return reject(new Error('Key exchange timeout'));
                setTimeout(check, 50);
            };
            check();
        });
    }

    // ── Encrypted File Transfer ──────────────────────────

    async sendFile(file, onProgress) {
        if (!this.dc || this.dc.readyState !== 'open') {
            throw new Error('Data channel not open');
        }

        // Send file metadata first (encrypted if key available)
        const meta = JSON.stringify({
            type: 'file_meta',
            name: file.name,
            size: file.size,
            mime: file.type,
        });

        if (this.encryptionReady) {
            const encMeta = await encryptPacked(this.sharedKey, new TextEncoder().encode(meta));
            this.dc.send(encMeta);
        } else {
            this.dc.send(meta);
        }

        // Read and send file in chunks
        const reader = file.stream().getReader();
        let sent = 0;
        const startTime = Date.now();

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

                if (this.encryptionReady) {
                    const encChunk = await encryptPacked(this.sharedKey, chunk);
                    this.dc.send(encChunk);
                } else {
                    this.dc.send(chunk);
                }

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
        const endMarker = JSON.stringify({ type: 'file_end' });
        if (this.encryptionReady) {
            const encEnd = await encryptPacked(this.sharedKey, new TextEncoder().encode(endMarker));
            this.dc.send(encEnd);
        } else {
            this.dc.send(endMarker);
        }

        onProgress?.({
            sent: file.size,
            total: file.size,
            progress: 1,
            speed: 0,
            name: file.name,
        });
    }

    // ── WebSocket Relay Fallback ─────────────────────────

    async sendFileViaRelay(file, onProgress) {
        this.connectionMode = 'relay';
        this.handlers.onConnectionModeDetected?.(this.peerId, 'relay');

        const reader = file.stream().getReader();
        let sent = 0;
        let seq = 0;
        const startTime = Date.now();

        // Send metadata
        const meta = JSON.stringify({
            type: 'file_meta',
            name: file.name,
            size: file.size,
            mime: file.type,
        });

        let metaData;
        if (this.encryptionReady) {
            const encMeta = await encryptPacked(this.sharedKey, new TextEncoder().encode(meta));
            metaData = _arrayToBase64(encMeta);
        } else {
            metaData = _arrayToBase64(new TextEncoder().encode(meta));
        }

        this.signaling.send('relay_chunk', {
            target: this.peerId,
            data: metaData,
            seq: seq++,
        });

        // Send file chunks via relay with throttling
        while (true) {
            const { done, value } = await reader.read();
            if (done) break;

            let offset = 0;
            while (offset < value.length) {
                const end = Math.min(offset + RELAY_CHUNK_SIZE, value.length);
                const chunk = value.slice(offset, end);

                let chunkData;
                if (this.encryptionReady) {
                    const encChunk = await encryptPacked(this.sharedKey, chunk);
                    chunkData = _arrayToBase64(encChunk);
                } else {
                    chunkData = _arrayToBase64(chunk);
                }

                this.signaling.send('relay_chunk', {
                    target: this.peerId,
                    data: chunkData,
                    seq: seq++,
                });

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

                // Throttle: ~10ms delay between chunks to avoid flooding WebSocket
                await new Promise(r => setTimeout(r, 10));
            }
        }

        // Send end marker
        const endMarker = JSON.stringify({ type: 'file_end' });
        let endData;
        if (this.encryptionReady) {
            const encEnd = await encryptPacked(this.sharedKey, new TextEncoder().encode(endMarker));
            endData = _arrayToBase64(encEnd);
        } else {
            endData = _arrayToBase64(new TextEncoder().encode(endMarker));
        }

        this.signaling.send('relay_chunk', {
            target: this.peerId,
            data: endData,
            seq: seq++,
            final: true,
        });

        onProgress?.({
            sent: file.size,
            total: file.size,
            progress: 1,
            speed: 0,
            name: file.name,
        });
    }

    // ── Connection Mode Detection ────────────────────────

    async detectConnectionMode() {
        if (!this.pc) return;
        try {
            const stats = await this.pc.getStats();
            let candidateType = null;
            for (const [, report] of stats) {
                if (report.type === 'candidate-pair' && report.state === 'succeeded') {
                    const localId = report.localCandidateId;
                    const localCandidate = stats.get(localId);
                    if (localCandidate) {
                        candidateType = localCandidate.candidateType;
                    }
                    break;
                }
            }

            if (candidateType === 'relay') {
                this.connectionMode = 'turn';
            } else if (candidateType === 'host' || candidateType === 'srflx' || candidateType === 'prflx') {
                this.connectionMode = 'p2p';
            }

            this.handlers.onConnectionModeDetected?.(this.peerId, this.connectionMode);
        } catch (err) {
            console.warn('Failed to detect connection mode:', err);
        }
    }

    // ── Lifecycle ────────────────────────────────────────

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
        this.encryptionReady = false;
        this.sharedKey = null;
        this.ecdhKeyPair = null;
    }

    _createPeerConnection() {
        this.pc = new RTCPeerConnection(rtcConfig);

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

            if (this.connectionState === 'connected') {
                // Detect connection mode after connection establishes.
                setTimeout(() => this.detectConnectionMode(), 500);
            }

            if (this.connectionState === 'failed') {
                this.handlers.onWebRTCFailed?.(this.peerId);
            }
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

// ── Base64 Helpers ───────────────────────────────────────

function _arrayToBase64(arr) {
    const bytes = arr instanceof Uint8Array ? arr : new Uint8Array(arr);
    let binary = '';
    for (let i = 0; i < bytes.length; i++) {
        binary += String.fromCharCode(bytes[i]);
    }
    return btoa(binary);
}

function _base64ToArray(b64) {
    const binary = atob(b64);
    const bytes = new Uint8Array(binary.length);
    for (let i = 0; i < binary.length; i++) {
        bytes[i] = binary.charCodeAt(i);
    }
    return bytes;
}

export { CHUNK_SIZE, _base64ToArray };
