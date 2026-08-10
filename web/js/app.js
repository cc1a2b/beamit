// BeamIt — Main Application
// Ties together: signaling, WebRTC, file transfer, encryption, QR/deep-link, PWA, UI.

import { SignalingClient } from './discovery.js';
import { RTCPeer, fetchTURNCredentials, _base64ToArray } from './rtc.js';
import { FileReceiver } from './transfer.js';
import {
    $, detectDeviceType, getDeviceName,
    initTheme, toggleTheme,
    showToast, setConnectionStatus,
    createPeerCard, updatePeerProgress, updatePeerConnectionMode,
    renderFiles, renderTransfer, showTransferModal,
    renderQR, setTransferCancelHandler, clearFinishedTransfers,
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
    pendingJoinCode: null,   // room code from a share link, joined once connected
    pendingAction: null,     // e.g. 'create-room' from a PWA shortcut
    installPrompt: null,     // stashed beforeinstallprompt event
    wakeLock: null,          // Screen Wake Lock sentinel
    wakeRefs: 0,             // active transfers keeping the screen awake
};

// ── Signaling Client ───────────────────────────────────
const signaling = new SignalingClient({
    onOpen() {
        setConnectionStatus('connected', 'Connected');

        signaling.send('join', {
            name: state.deviceName,
            device_type: state.deviceType,
        });

        // Act on any pending deep-link intent now that we are connected.
        if (state.pendingJoinCode) {
            signaling.send('join_room', { code: state.pendingJoinCode });
            showToast(`Joining ${state.pendingJoinCode}…`, 'info');
            state.pendingJoinCode = null;
        }
        if (state.pendingAction === 'create-room') {
            signaling.send('create_room', {});
            state.pendingAction = null;
        }
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
        if (data.peers) {
            for (const peer of data.peers) state.peers.set(peer.id, peer);
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
        state.peers.set(data.peer.id, data.peer);
        renderPeers();
        showToast(`${data.peer.name} connected via code`, 'success');
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
        if (rtcPeer) rtcPeer.handleAnswer(data.sdp);
    },

    on_ice(data) {
        const rtcPeer = state.rtcPeers.get(data.target);
        if (rtcPeer) rtcPeer.handleICECandidate(data.candidate);
    },

    // ── E2E Key Exchange ───────────────────────────────
    on_key_exchange(data) {
        const rtcPeer = getOrCreateRTCPeer(data.target);
        rtcPeer.handleKeyExchange(data.public_key);
    },

    // ── WebSocket Relay Chunks ─────────────────────────
    on_relay_chunk(data) {
        const raw = _base64ToArray(data.data);
        fileReceiver.handleData(data.target, raw);
    },

    // ── Transfer ───────────────────────────────────────
    on_transfer_request(data) {
        showTransferModal(
            data.files,
            async () => {
                // Prepare the receive target (may open a save/directory picker) BEFORE
                // accepting, so the sender only starts once we're ready to write.
                wakeAcquire();
                try {
                    await fileReceiver.prepare(data.target, data.files);
                } catch (err) {
                    console.warn('prepare failed:', err);
                }
                signaling.send('transfer_accept', { target: data.target });
                showToast('Transfer accepted', 'success');
            },
            () => {
                signaling.send('transfer_reject', { target: data.target });
            },
        );
    },

    on_transfer_accept(data) {
        initiateTransfer(data.target);
    },

    on_transfer_reject() {
        showToast('Transfer declined', 'info');
    },

    // ── Text ───────────────────────────────────────────
    on_text(data) {
        const peer = state.peers.get(data.target);
        showReceivedText(data.text, peer?.name || 'Unknown');
    },

    // ── Error ──────────────────────────────────────────
    on_error(data) {
        console.error('Server error:', data.code, data.message);
        showToast(data.message, 'error');
    },

    on_pong() { /* keep-alive */ },
});

// ── File Receiver ──────────────────────────────────────
const fileReceiver = new FileReceiver(
    (transfer) => renderTransfer(transfer),
    (name, size, info = {}) => {
        wakeRelease();
        if (info.cancelled) {
            showToast(`Transfer of ${name} cancelled`, 'info');
        } else if (info.verified === false) {
            showToast(`Integrity check FAILED for ${name}`, 'error', 6000);
        } else if (info.verified === true) {
            showToast(`Received & verified: ${name}`, 'success');
        } else {
            showToast(`Received: ${name}`, 'success');
        }
    },
);

// ── RTC Peer Management ────────────────────────────────
function getOrCreateRTCPeer(peerId) {
    let rtcPeer = state.rtcPeers.get(peerId);
    if (rtcPeer) return rtcPeer;

    rtcPeer = new RTCPeer(peerId, signaling, {
        onConnectionStateChange(id, connState) {
            if (connState === 'connected') showToast('P2P connected', 'success');
        },
        onDataChannelOpen() {
            updateTextSection();
        },
        onDataChannelClose() { /* no-op */ },
        onData(id, data) {
            fileReceiver.handleData(id, data);
        },
        onEncryptionReady(id, key) {
            // Register the derived key so THIS side can decrypt what the peer sends.
            fileReceiver.setPeerKey(id, key);
        },
        onDisconnected(id) {
            fileReceiver.cleanup(id);
            cleanupRTCPeer(id);
        },
        onWebRTCFailed(id) {
            console.warn(`WebRTC connection failed [${id}]`);
        },
        onConnectionModeDetected(id, mode) {
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
    fileReceiver.cleanup(peerId);
}

// ── Transfer Logic ─────────────────────────────────────
const WEBRTC_CONNECT_TIMEOUT = 15000; // 15s before falling back to relay

async function initiateTransfer(peerId) {
    if (state.selectedFiles.length === 0) return;

    const rtcPeer = getOrCreateRTCPeer(peerId);
    let useRelay = false;

    if (!rtcPeer.dc || rtcPeer.dc.readyState !== 'open') {
        try {
            await rtcPeer.createOffer();
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
            console.warn('WebRTC failed, falling back to relay:', err.message);
            showToast('WebRTC failed, using relay…', 'info');
            useRelay = true;
        }
    }

    // Perform E2E key exchange before transfer.
    try {
        if (!rtcPeer.encryptionReady) await rtcPeer.initiateKeyExchange();
        fileReceiver.setPeerKey(peerId, rtcPeer.sharedKey);
    } catch (err) {
        console.warn('Key exchange failed, transferring without encryption:', err.message);
    }

    wakeAcquire();
    try {
        for (const file of state.selectedFiles) {
            const transferId = `send-${file.name}`;
            try {
                const progressCb = (progress) => {
                    renderTransfer({ id: transferId, peerId, ...progress });
                    updatePeerProgress(peerId, progress.progress);
                };
                if (useRelay) await rtcPeer.sendFileViaRelay(file, progressCb);
                else await rtcPeer.sendFile(file, progressCb);
                showToast(`Sent: ${file.name}`, 'success');
            } catch (err) {
                if (err.message === 'cancelled') {
                    renderTransfer({ id: transferId, peerId, name: file.name, progress: 0, sent: 0, total: file.size, speed: 0, direction: 'send', cancelled: true });
                    showToast(`Cancelled: ${file.name}`, 'info');
                } else {
                    console.error('Transfer failed:', err);
                    showToast(`Failed to send ${file.name}`, 'error');
                }
            }
        }
    } finally {
        wakeRelease();
    }

    state.selectedFiles = [];
    renderFiles([], removeFile);
    updatePeerProgress(peerId, 1);
}

function cancelTransfer(peerId) {
    const rtcPeer = state.rtcPeers.get(peerId);
    if (rtcPeer) rtcPeer.cancelSend();
}

function sendTransferRequest(peerId) {
    if (state.selectedFiles.length === 0) {
        showToast('Select files first', 'info');
        return;
    }

    const files = state.selectedFiles.map(f => ({ name: f.name, size: f.size, type: f.type }));
    signaling.send('transfer_request', { target: peerId, files });
    state.selectedPeerId = peerId;
    showToast('Transfer request sent…', 'info');
}

// ── Screen Wake Lock ───────────────────────────────────
async function wakeAcquire() {
    state.wakeRefs++;
    if (state.wakeLock || !('wakeLock' in navigator)) return;
    try {
        state.wakeLock = await navigator.wakeLock.request('screen');
        state.wakeLock.addEventListener('release', () => { state.wakeLock = null; });
    } catch { /* not permitted / unsupported — non-fatal */ }
}

function wakeRelease() {
    state.wakeRefs = Math.max(0, state.wakeRefs - 1);
    if (state.wakeRefs === 0 && state.wakeLock) {
        state.wakeLock.release().catch(() => {});
        state.wakeLock = null;
    }
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible' && state.wakeRefs > 0 && !state.wakeLock) {
        wakeAcquire();
        state.wakeRefs--; // wakeAcquire incremented; keep the count balanced
    }
});

// ── UI Rendering ───────────────────────────────────────
function renderPeers() {
    const grid = $('#peers-grid');
    const noPeers = $('#no-peers');

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

    const empty = grid.querySelector('.empty-state');
    if (empty) empty.remove();

    for (const [id, peer] of state.peers) {
        const card = createPeerCard(peer);
        card.addEventListener('click', () => selectPeer(id));
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
    state.selectedPeerId = state.selectedPeerId === peerId ? null : peerId;

    document.querySelectorAll('.peer-card').forEach(card => {
        card.classList.toggle('selected', card.dataset.peerId === state.selectedPeerId);
    });

    if (state.selectedPeerId && state.selectedFiles.length > 0) {
        sendTransferRequest(state.selectedPeerId);
    }

    updateTextSection();
}

function updateTextSection() {
    const hasTarget = state.selectedPeerId || state.peers.size > 0;
    const textSection = $('#text-section');
    textSection.hidden = !hasTarget;
    $('#send-text-btn').disabled = !state.selectedPeerId;
}

// ── Room codes, QR & share links ───────────────────────
function buildShareUrl(code) {
    return `${location.origin}${location.pathname}#${code}`;
}

function showRoomCode(code, expiresIn) {
    const createDiv = $('#room-create');
    const codeDiv = $('#room-code-display');
    const codeEl = $('#room-code');
    const timerEl = $('#room-timer');

    createDiv.hidden = true;
    codeDiv.hidden = false;
    codeEl.textContent = code;

    // Render the scannable share link as a QR code.
    const shareUrl = buildShareUrl(code);
    const linkEl = $('#share-link');
    if (linkEl) {
        linkEl.textContent = shareUrl;
        linkEl.dataset.url = shareUrl;
    }
    const canvas = $('#room-qr');
    if (canvas) {
        try {
            renderQR(canvas, shareUrl);
            canvas.hidden = false;
        } catch (err) {
            console.warn('QR render failed:', err);
            canvas.hidden = true;
        }
    }

    let remaining = expiresIn;
    const tick = () => {
        if (remaining <= 0) {
            clearInterval(state.roomTimer);
            timerEl.textContent = 'Code expired';
            resetRoomUI();
            return;
        }
        const min = Math.floor(remaining / 60);
        const sec = remaining % 60;
        timerEl.textContent = `Expires in ${min}:${sec.toString().padStart(2, '0')}`;
    };
    clearInterval(state.roomTimer);
    tick();
    state.roomTimer = setInterval(() => { remaining--; tick(); }, 1000);
}

function resetRoomUI() {
    $('#room-create').hidden = false;
    $('#room-code-display').hidden = true;
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

// ── Deep links ─────────────────────────────────────────
const CODE_RE = /^(BEAM-)?[0-9A-Z]{4,8}$/i;

function parseDeepLink() {
    const hash = decodeURIComponent(location.hash.replace(/^#/, '')).trim();
    if (hash && CODE_RE.test(hash)) {
        state.pendingJoinCode = hash.toUpperCase().startsWith('BEAM-') ? hash.toUpperCase() : `BEAM-${hash.toUpperCase()}`;
        history.replaceState(null, '', location.pathname + location.search);
        return;
    }
    const params = new URLSearchParams(location.search);
    const code = params.get('code');
    if (code && CODE_RE.test(code.trim())) {
        const c = code.trim().toUpperCase();
        state.pendingJoinCode = c.startsWith('BEAM-') ? c : `BEAM-${c}`;
    }
    if (params.get('action') === 'create-room') state.pendingAction = 'create-room';
}

// ── PWA ────────────────────────────────────────────────
function registerServiceWorker() {
    if (!('serviceWorker' in navigator)) return;
    window.addEventListener('load', () => {
        navigator.serviceWorker.register('/sw.js', { scope: '/' })
            .catch((err) => console.warn('SW registration failed:', err));
    });
}

function initInstallPrompt() {
    const btn = $('#install-btn');
    if (!btn) return;
    window.addEventListener('beforeinstallprompt', (e) => {
        e.preventDefault();
        state.installPrompt = e;
        btn.hidden = false;
    });
    btn.addEventListener('click', async () => {
        if (!state.installPrompt) return;
        state.installPrompt.prompt();
        await state.installPrompt.userChoice;
        state.installPrompt = null;
        btn.hidden = true;
    });
    window.addEventListener('appinstalled', () => {
        btn.hidden = true;
        showToast('BeamIt installed', 'success');
    });
}

// ── Event Bindings ─────────────────────────────────────
function initEvents() {
    $('#theme-toggle').addEventListener('click', toggleTheme);

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
            fileInput.value = '';
        }
    });

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
        if (e.dataTransfer.files.length > 0) addFiles(e.dataTransfer.files);
    });

    document.body.addEventListener('dragover', (e) => e.preventDefault());
    document.body.addEventListener('drop', (e) => e.preventDefault());

    $('#create-room-btn').addEventListener('click', () => signaling.send('create_room', {}));

    const joinInput = $('#join-code-input');
    const joinBtn = $('#join-room-btn');

    joinBtn.addEventListener('click', () => {
        const code = joinInput.value.trim();
        if (code) {
            signaling.send('join_room', { code });
            joinInput.value = '';
        }
    });
    joinInput.addEventListener('keydown', (e) => { if (e.key === 'Enter') joinBtn.click(); });
    joinInput.addEventListener('input', (e) => {
        e.target.value = e.target.value.toUpperCase().replace(/[^A-Z0-9\-]/g, '');
    });

    $('#copy-code-btn').addEventListener('click', () => copyText($('#room-code').textContent, 'Code copied!'));

    const copyLinkBtn = $('#copy-link-btn');
    if (copyLinkBtn) {
        copyLinkBtn.addEventListener('click', () => {
            const url = $('#share-link')?.dataset.url || buildShareUrl(state.roomCode || '');
            copyText(url, 'Link copied!');
        });
    }

    const clearBtn = $('#clear-transfers-btn');
    if (clearBtn) clearBtn.addEventListener('click', clearFinishedTransfers);

    const textInput = $('#text-input');
    const sendTextBtn = $('#send-text-btn');

    textInput.addEventListener('input', () => {
        sendTextBtn.disabled = !textInput.value.trim() || !state.selectedPeerId;
    });
    sendTextBtn.addEventListener('click', () => {
        if (!state.selectedPeerId || !textInput.value.trim()) return;
        signaling.send('text', { target: state.selectedPeerId, text: textInput.value.trim() });
        showToast('Text sent', 'success');
        textInput.value = '';
        sendTextBtn.disabled = true;
    });

    setTransferCancelHandler(cancelTransfer);
}

async function copyText(text, okMsg) {
    try {
        await navigator.clipboard.writeText(text);
        showToast(okMsg, 'success');
    } catch {
        const input = document.createElement('input');
        input.value = text;
        document.body.appendChild(input);
        input.select();
        document.execCommand('copy');
        input.remove();
        showToast(okMsg, 'success');
    }
}

// ── Initialization ─────────────────────────────────────
async function init() {
    initTheme();
    initEvents();
    parseDeepLink();
    registerServiceWorker();
    initInstallPrompt();
    setConnectionStatus('', 'Connecting...');

    await fetchTURNCredentials();
    signaling.connect();

    setInterval(() => {
        if (signaling.connected) signaling.send('ping', {});
    }, 30000);
}

if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
} else {
    init();
}
