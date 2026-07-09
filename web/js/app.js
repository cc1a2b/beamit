// BeamIt — Main Application
// Ties together: signaling, WebRTC, file transfer, encryption, UI

import { SignalingClient } from './discovery.js';
import { RTCPeer, fetchTURNCredentials, _base64ToArray } from './rtc.js';
import { FileReceiver } from './transfer.js';
import {
    $, detectDeviceType, getDeviceName,
    initTheme, toggleTheme,
    showToast, setConnectionStatus,
    createPeerCard, updatePeerProgress, updatePeerConnectionMode,
    renderFiles, renderTransfer, showTransferModal,
} from './ui.js';

// ── State ──────────────────────────────────────────────
const state = {
    peers: new Map(),        // peerId → PeerInfo
    rtcPeers: new Map(),     // peerId → RTCPeer
    selectedFiles: [],       // File[]
    selectedPeerId: null,    // currently selected target peer
    roomCode: null,          // active room code
    roomTimer: null,         // room expiry interval
    deviceName: getDeviceName(),
    deviceType: detectDeviceType(),
};

// ── Signaling Client ───────────────────────────────────
const signaling = new SignalingClient({
    onOpen() {
        setConnectionStatus('connected', 'Connected');

        // Join with device info
        signaling.send('join', {
            name: state.deviceName,
            device_type: state.deviceType,
        });
    },

    onClose() {
        setConnectionStatus('', 'Disconnected');
        state.peers.clear();
        renderPeers();
    },

    onError() {
        setConnectionStatus('error', 'Connection error');
    },

    // ── Peer Discovery ─────────────────────────────────
    on_peers(data) {
        // Initial peer list (LAN peers)
        if (data.peers) {
            for (const peer of data.peers) {
                state.peers.set(peer.id, peer);
            }
            renderPeers();
        }
    },

    on_peer_joined(data) {
        state.peers.set(data.id, data);
        renderPeers();
        showToast(`${data.name} joined`, 'info');
    },

    on_peer_left(data) {
        state.peers.delete(data.peer_id);
        cleanupRTCPeer(data.peer_id);
        renderPeers();
    },

    // ── Room Management ────────────────────────────────
    on_room_created(data) {
        state.roomCode = data.code;
        showRoomCode(data.code, data.expires_in);
    },

    on_room_joined(data) {
        // A peer joined our room (or we joined theirs)
        state.peers.set(data.peer.id, data.peer);
        renderPeers();
        showToast(`${data.peer.name} connected via code`, 'success');

        // Show text sharing section now that we have a peer
        updateTextSection();
    },

    on_room_left(data) {
        state.peers.delete(data.peer_id);
        cleanupRTCPeer(data.peer_id);
        renderPeers();
        updateTextSection();
    },

    // ── WebRTC Signaling ───────────────────────────────
    on_offer(data) {
        const rtcPeer = getOrCreateRTCPeer(data.target);
        rtcPeer.handleOffer(data.sdp);
    },

    on_answer(data) {
        const rtcPeer = state.rtcPeers.get(data.target);
        if (rtcPeer) {
            rtcPeer.handleAnswer(data.sdp);
        }
    },

    on_ice(data) {
        const rtcPeer = state.rtcPeers.get(data.target);
        if (rtcPeer) {
            rtcPeer.handleICECandidate(data.candidate);
        }
    },

    // ── E2E Key Exchange ───────────────────────────────
    on_key_exchange(data) {
        const rtcPeer = getOrCreateRTCPeer(data.target);
        rtcPeer.handleKeyExchange(data.public_key);
    },

    // ── WebSocket Relay Chunks ─────────────────────────
    on_relay_chunk(data) {
        // Decode base64 relay data and feed to file receiver
        const raw = _base64ToArray(data.data);
        fileReceiver.handleData(data.target, raw.buffer);
    },

    // ── Transfer ───────────────────────────────────────
    on_transfer_request(data) {
        const peer = state.peers.get(data.target);
        const peerName = peer?.name || 'Unknown';

        showTransferModal(
            data.files,
            () => {
                // Accept
                signaling.send('transfer_accept', { target: data.target });
                showToast('Transfer accepted', 'success');
            },
            () => {
                // Reject
                signaling.send('transfer_reject', { target: data.target });
            }
        );
    },

    on_transfer_accept(data) {
        // Target accepted — start WebRTC transfer with encryption + fallback
        initiateTransfer(data.target);
    },

    on_transfer_reject(data) {
        showToast('Transfer declined', 'info');
    },

    // ── Text ───────────────────────────────────────────
    on_text(data) {
        const peer = state.peers.get(data.target);
        const peerName = peer?.name || 'Unknown';
        showReceivedText(data.text, peerName);
    },

    // ── Error ──────────────────────────────────────────
    on_error(data) {
        console.error('Server error:', data.code, data.message);
        showToast(data.message, 'error');
    },

    on_pong() {
        // Keep-alive response
    },
});

// ── File Receiver ──────────────────────────────────────
const fileReceiver = new FileReceiver(
    // onProgress
    (transfer) => {
        renderTransfer(transfer);
    },
    // onComplete
    (name, size) => {
        showToast(`Received: ${name}`, 'success');
    }
);

// ── RTC Peer Management ────────────────────────────────
function getOrCreateRTCPeer(peerId) {
    let rtcPeer = state.rtcPeers.get(peerId);
    if (rtcPeer) return rtcPeer;

    rtcPeer = new RTCPeer(peerId, signaling, {
        onConnectionStateChange(id, connState) {
            console.log(`RTC [${id}]: ${connState}`);
            if (connState === 'connected') {
                showToast('P2P connected', 'success');
            }
        },
        onDataChannelOpen(id) {
            console.log(`Data channel ready [${id}]`);
            // Show text section since we have a direct connection
            updateTextSection();
        },
        onDataChannelClose(id) {
            console.log(`Data channel closed [${id}]`);
        },
        onData(id, data) {
            fileReceiver.handleData(id, data);
        },
        onDisconnected(id) {
            showToast('P2P disconnected', 'info');
            cleanupRTCPeer(id);
        },
        onWebRTCFailed(id) {
            console.warn(`WebRTC connection failed [${id}]`);
        },
        onConnectionModeDetected(id, mode) {
            console.log(`Connection mode [${id}]: ${mode}`);
            updatePeerConnectionMode(id, mode);
            const labels = { p2p: 'P2P Direct', turn: 'TURN Relay', relay: 'WebSocket Relay' };
            showToast(`${labels[mode] || mode} connection`, 'info');
        },
    });

    state.rtcPeers.set(peerId, rtcPeer);
    return rtcPeer;
}

function cleanupRTCPeer(peerId) {
    const rtcPeer = state.rtcPeers.get(peerId);
    if (rtcPeer) {
        rtcPeer.close();
        state.rtcPeers.delete(peerId);
    }
}

// ── Transfer Logic ─────────────────────────────────────
const WEBRTC_CONNECT_TIMEOUT = 15000; // 15s before falling back to relay

async function initiateTransfer(peerId) {
    if (state.selectedFiles.length === 0) return;

    let rtcPeer = getOrCreateRTCPeer(peerId);
    let useRelay = false;

    // Try to establish WebRTC connection if not already open
    if (!rtcPeer.dc || rtcPeer.dc.readyState !== 'open') {
        try {
            await rtcPeer.createOffer();

            // Wait for data channel to open with timeout
            await new Promise((resolve, reject) => {
                const timeout = setTimeout(() => reject(new Error('WebRTC timeout')), WEBRTC_CONNECT_TIMEOUT);
                const origOpen = rtcPeer.handlers.onDataChannelOpen;
                rtcPeer.handlers.onDataChannelOpen = (id) => {
                    clearTimeout(timeout);
                    origOpen?.(id);
                    resolve();
                };
                const origFailed = rtcPeer.handlers.onWebRTCFailed;
                rtcPeer.handlers.onWebRTCFailed = (id) => {
                    clearTimeout(timeout);
                    origFailed?.(id);
                    reject(new Error('WebRTC failed'));
                };
            });
        } catch (err) {
            console.warn('WebRTC connection failed, falling back to relay:', err.message);
            showToast('WebRTC failed, using relay...', 'info');
            useRelay = true;
        }
    }

    // Perform E2E key exchange before transfer
    try {
        if (!rtcPeer.encryptionReady) {
            await rtcPeer.initiateKeyExchange();
        }
        // Set shared key on receiver for decryption
        fileReceiver.setSharedKey(rtcPeer.sharedKey);
    } catch (err) {
        console.warn('Key exchange failed, transferring without encryption:', err.message);
    }

    // Send files sequentially
    for (const file of state.selectedFiles) {
        const transferId = `send-${file.name}`;
        try {
            const progressCb = (progress) => {
                renderTransfer({ id: transferId, ...progress });
                updatePeerProgress(peerId, progress.progress);
            };

            if (useRelay) {
                await rtcPeer.sendFileViaRelay(file, progressCb);
            } else {
                await rtcPeer.sendFile(file, progressCb);
            }
            showToast(`Sent: ${file.name}`, 'success');
        } catch (err) {
            console.error('Transfer failed:', err);
            showToast(`Failed to send ${file.name}`, 'error');
        }
    }

    // Clear files after transfer
    state.selectedFiles = [];
    renderFiles([], removeFile);
    updatePeerProgress(peerId, 1);
}

function sendTransferRequest(peerId) {
    if (state.selectedFiles.length === 0) {
        showToast('Select files first', 'info');
        return;
    }

    const files = state.selectedFiles.map(f => ({
        name: f.name,
        size: f.size,
        type: f.type,
    }));

    signaling.send('transfer_request', { target: peerId, files });
    state.selectedPeerId = peerId;
    showToast('Transfer request sent...', 'info');
}

// ── UI Rendering ───────────────────────────────────────
function renderPeers() {
    const grid = $('#peers-grid');
    const noPeers = $('#no-peers');

    // Remove existing peer cards (keep empty state)
    grid.querySelectorAll('.peer-card').forEach(el => el.remove());

    if (state.peers.size === 0) {
        if (!noPeers) {
            grid.innerHTML = `
                <div class="empty-state" id="no-peers">
                    <svg class="empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 12a9 9 0 0 1-9 9m9-9a9 9 0 0 0-9-9m9 9H3m9 9a9 9 0 0 1-9-9m9 9c1.66 0 3-4.03 3-9s-1.34-9-3-9m0 18c-1.66 0-3-4.03-3-9s1.34-9 3-9m-9 9a9 9 0 0 1 9-9"/></svg>
                    <p>Waiting for nearby devices...</p>
                    <p class="hint">Open BeamIt on another device on the same network</p>
                </div>`;
        }
        return;
    }

    // Remove empty state
    const empty = grid.querySelector('.empty-state');
    if (empty) empty.remove();

    for (const [id, peer] of state.peers) {
        const card = createPeerCard(peer);

        card.addEventListener('click', () => {
            selectPeer(id);
        });

        card.addEventListener('keydown', (e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                selectPeer(id);
            }
        });

        grid.appendChild(card);
    }
}

function selectPeer(peerId) {
    // Toggle selection
    if (state.selectedPeerId === peerId) {
        state.selectedPeerId = null;
    } else {
        state.selectedPeerId = peerId;
    }

    // Update UI
    document.querySelectorAll('.peer-card').forEach(card => {
        card.classList.toggle('selected', card.dataset.peerId === state.selectedPeerId);
    });

    // If files are selected and peer is selected, send transfer request
    if (state.selectedPeerId && state.selectedFiles.length > 0) {
        sendTransferRequest(state.selectedPeerId);
    }

    updateTextSection();
}

function updateTextSection() {
    const hasTarget = state.selectedPeerId || state.peers.size > 0;
    const textSection = $('#text-section');
    textSection.hidden = !hasTarget;

    const sendBtn = $('#send-text-btn');
    sendBtn.disabled = !state.selectedPeerId;
}

function showRoomCode(code, expiresIn) {
    const createDiv = $('#room-create');
    const codeDiv = $('#room-code-display');
    const codeEl = $('#room-code');
    const timerEl = $('#room-timer');

    createDiv.hidden = true;
    codeDiv.hidden = false;
    codeEl.textContent = code;

    // Start countdown timer
    let remaining = expiresIn;
    clearInterval(state.roomTimer);
    state.roomTimer = setInterval(() => {
        remaining--;
        if (remaining <= 0) {
            clearInterval(state.roomTimer);
            timerEl.textContent = 'Code expired';
            resetRoomUI();
            return;
        }
        const min = Math.floor(remaining / 60);
        const sec = remaining % 60;
        timerEl.textContent = `Expires in ${min}:${sec.toString().padStart(2, '0')}`;
    }, 1000);

    const min = Math.floor(remaining / 60);
    const sec = remaining % 60;
    timerEl.textContent = `Expires in ${min}:${sec.toString().padStart(2, '0')}`;
}

function resetRoomUI() {
    const createDiv = $('#room-create');
    const codeDiv = $('#room-code-display');
    createDiv.hidden = false;
    codeDiv.hidden = true;
    clearInterval(state.roomTimer);
    state.roomCode = null;
}

function showReceivedText(text, fromName) {
    const section = $('#received-text-section');
    const container = $('#received-text');
    section.hidden = false;

    const entry = document.createElement('div');
    entry.style.marginBottom = '8px';
    entry.innerHTML = `<strong>${escapeHtml(fromName)}:</strong> ${escapeHtml(text)}`;
    container.appendChild(entry);
    container.scrollTop = container.scrollHeight;

    showToast(`Text from ${fromName}`, 'info');
}

function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// ── File Handling ──────────────────────────────────────
function addFiles(fileList) {
    for (const file of fileList) {
        // Prevent duplicates
        if (!state.selectedFiles.some(f => f.name === file.name && f.size === file.size)) {
            state.selectedFiles.push(file);
        }
    }
    renderFiles(state.selectedFiles, removeFile);
}

function removeFile(index) {
    state.selectedFiles.splice(index, 1);
    renderFiles(state.selectedFiles, removeFile);
}

// ── Event Bindings ─────────────────────────────────────
function initEvents() {
    // Theme toggle
    $('#theme-toggle').addEventListener('click', toggleTheme);

    // Drop zone
    const dropZone = $('#drop-zone');
    const fileInput = $('#file-input');

    dropZone.addEventListener('click', () => fileInput.click());
    dropZone.addEventListener('keydown', (e) => {
        if (e.key === 'Enter' || e.key === ' ') {
            e.preventDefault();
            fileInput.click();
        }
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) {
            addFiles(e.target.files);
            fileInput.value = ''; // Reset for re-selection
        }
    });

    // Drag and drop
    dropZone.addEventListener('dragover', (e) => {
        e.preventDefault();
        dropZone.classList.add('dragover');
    });

    dropZone.addEventListener('dragleave', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
    });

    dropZone.addEventListener('drop', (e) => {
        e.preventDefault();
        dropZone.classList.remove('dragover');
        if (e.dataTransfer.files.length > 0) {
            addFiles(e.dataTransfer.files);
        }
    });

    // Prevent default drag behavior on body
    document.body.addEventListener('dragover', (e) => e.preventDefault());
    document.body.addEventListener('drop', (e) => e.preventDefault());

    // Room creation
    $('#create-room-btn').addEventListener('click', () => {
        signaling.send('create_room', {});
    });

    // Room joining
    const joinInput = $('#join-code-input');
    const joinBtn = $('#join-room-btn');

    joinBtn.addEventListener('click', () => {
        const code = joinInput.value.trim();
        if (code) {
            signaling.send('join_room', { code });
            joinInput.value = '';
        }
    });

    joinInput.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') {
            joinBtn.click();
        }
    });

    // Auto-format room code input
    joinInput.addEventListener('input', (e) => {
        let val = e.target.value.toUpperCase().replace(/[^A-Z0-9\-]/g, '');
        e.target.value = val;
    });

    // Copy room code
    $('#copy-code-btn').addEventListener('click', async () => {
        const code = $('#room-code').textContent;
        try {
            await navigator.clipboard.writeText(code);
            showToast('Code copied!', 'success');
        } catch {
            // Fallback for older browsers
            const input = document.createElement('input');
            input.value = code;
            document.body.appendChild(input);
            input.select();
            document.execCommand('copy');
            input.remove();
            showToast('Code copied!', 'success');
        }
    });

    // Text sharing
    const textInput = $('#text-input');
    const sendTextBtn = $('#send-text-btn');

    textInput.addEventListener('input', () => {
        sendTextBtn.disabled = !textInput.value.trim() || !state.selectedPeerId;
    });

    sendTextBtn.addEventListener('click', () => {
        if (!state.selectedPeerId || !textInput.value.trim()) return;

        signaling.send('text', {
            target: state.selectedPeerId,
            text: textInput.value.trim(),
        });

        showToast('Text sent', 'success');
        textInput.value = '';
        sendTextBtn.disabled = true;
    });
}

// ── Initialization ─────────────────────────────────────
async function init() {
    initTheme();
    initEvents();
    setConnectionStatus('', 'Connecting...');

    // Fetch TURN credentials before connecting (non-blocking on failure).
    await fetchTURNCredentials();

    signaling.connect();

    // Periodic ping to keep connection alive
    setInterval(() => {
        if (signaling.connected) {
            signaling.send('ping', {});
        }
    }, 30000);
}

// Start when DOM is ready
if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
