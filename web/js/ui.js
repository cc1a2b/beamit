// BeamIt UI module — DOM manipulation, theming, toasts

const $ = (sel) => document.querySelector(sel);
const $$ = (sel) => document.querySelectorAll(sel);

// Device type detection
function detectDeviceType() {
    const ua = navigator.userAgent;
    if (/iPad|Android(?!.*Mobile)/i.test(ua)) return 'tablet';
    if (/Mobile|iPhone|iPod|Android/i.test(ua)) return 'phone';
    if (/Macintosh|Mac OS/i.test(ua) && navigator.maxTouchPoints > 1) return 'tablet';
    return 'desktop';
}

// Device type to emoji
function deviceEmoji(type) {
    const map = { phone: '\u{1F4F1}', tablet: '\u{1F4F1}', laptop: '\u{1F4BB}', desktop: '\u{1F5A5}\uFE0F' };
    return map[type] || '\u{1F4BB}';
}

// Get device name
function getDeviceName() {
    const stored = localStorage.getItem('beamit_name');
    if (stored) return stored;

    const platform = navigator.platform || '';
    if (/iPhone/.test(platform)) return 'iPhone';
    if (/iPad/.test(platform)) return 'iPad';
    if (/Android/.test(navigator.userAgent)) return 'Android';
    if (/Mac/.test(platform)) return 'Mac';
    if (/Win/.test(platform)) return 'Windows PC';
    if (/Linux/.test(platform)) return 'Linux PC';
    return 'Device';
}

// Format file size
function formatSize(bytes) {
    if (bytes === 0) return '0 B';
    const k = 1024;
    const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
    const i = Math.floor(Math.log(bytes) / Math.log(k));
    return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

// Format speed
function formatSpeed(bytesPerSec) {
    return formatSize(bytesPerSec) + '/s';
}

// File type to icon
function fileIcon(name) {
    const ext = name.split('.').pop().toLowerCase();
    const map = {
        jpg: '\u{1F5BC}\uFE0F', jpeg: '\u{1F5BC}\uFE0F', png: '\u{1F5BC}\uFE0F', gif: '\u{1F5BC}\uFE0F',
        webp: '\u{1F5BC}\uFE0F', svg: '\u{1F5BC}\uFE0F', bmp: '\u{1F5BC}\uFE0F',
        mp4: '\u{1F3AC}', mkv: '\u{1F3AC}', avi: '\u{1F3AC}', mov: '\u{1F3AC}', webm: '\u{1F3AC}',
        mp3: '\u{1F3B5}', wav: '\u{1F3B5}', flac: '\u{1F3B5}', ogg: '\u{1F3B5}', aac: '\u{1F3B5}',
        pdf: '\u{1F4C4}', doc: '\u{1F4C4}', docx: '\u{1F4C4}', txt: '\u{1F4C4}', rtf: '\u{1F4C4}',
        zip: '\u{1F4E6}', rar: '\u{1F4E6}', '7z': '\u{1F4E6}', tar: '\u{1F4E6}', gz: '\u{1F4E6}',
        js: '\u{1F4BB}', py: '\u{1F4BB}', go: '\u{1F4BB}', rs: '\u{1F4BB}', ts: '\u{1F4BB}',
        html: '\u{1F310}', css: '\u{1F310}', json: '\u{1F4CB}', xml: '\u{1F4CB}',
    };
    return map[ext] || '\u{1F4CE}';
}

// Theme management
function initTheme() {
    const saved = localStorage.getItem('beamit_theme');
    if (saved) {
        document.documentElement.setAttribute('data-theme', saved);
    }
}

function toggleTheme() {
    const current = document.documentElement.getAttribute('data-theme');
    const prefersDark = window.matchMedia('(prefers-color-scheme: dark)').matches;
    let next;

    if (!current) {
        next = prefersDark ? 'light' : 'dark';
    } else {
        next = current === 'dark' ? 'light' : 'dark';
    }

    document.documentElement.setAttribute('data-theme', next);
    localStorage.setItem('beamit_theme', next);
}

// Toast notifications
function showToast(message, type = 'info', duration = 3000) {
    const container = $('#toast-container');
    const toast = document.createElement('div');
    toast.className = `toast ${type}`;
    toast.textContent = message;
    container.appendChild(toast);

    setTimeout(() => {
        toast.style.opacity = '0';
        toast.style.transform = 'translateY(10px)';
        toast.style.transition = 'all 0.3s ease';
        setTimeout(() => toast.remove(), 300);
    }, duration);
}

// Connection status
function setConnectionStatus(status, text) {
    const el = $('#connection-status');
    el.className = 'connection-status ' + status;
    el.querySelector('.status-text').textContent = text;
}

// Create peer card element
function createPeerCard(peer) {
    const card = document.createElement('div');
    card.className = 'peer-card new';
    card.dataset.peerId = peer.id;
    card.tabIndex = 0;
    card.setAttribute('role', 'button');
    card.setAttribute('aria-label', `Send files to ${peer.name}`);

    card.innerHTML = `
        <div class="peer-avatar">${deviceEmoji(peer.device_type)}</div>
        <div class="peer-name" title="${escapeHtml(peer.name)}">${escapeHtml(peer.name)}</div>
    `;

    // Remove "new" animation after it plays
    setTimeout(() => card.classList.remove('new'), 6000);

    return card;
}

// Update peer card for transfer progress
function updatePeerProgress(peerId, progress) {
    const card = $(`.peer-card[data-peer-id="${peerId}"]`);
    if (!card) return;

    if (progress >= 1) {
        card.classList.remove('transferring');
        const ring = card.querySelector('.peer-progress');
        if (ring) ring.remove();
        return;
    }

    card.classList.add('transferring');
    let svg = card.querySelector('.peer-progress');
    if (!svg) {
        svg = document.createElementNS('http://www.w3.org/2000/svg', 'svg');
        svg.setAttribute('class', 'peer-progress');
        svg.setAttribute('viewBox', '0 0 44 44');
        const circle = document.createElementNS('http://www.w3.org/2000/svg', 'circle');
        circle.setAttribute('cx', '22');
        circle.setAttribute('cy', '22');
        circle.setAttribute('r', '20');
        const circumference = 2 * Math.PI * 20;
        circle.setAttribute('stroke-dasharray', String(circumference));
        circle.setAttribute('stroke-dashoffset', String(circumference));
        svg.appendChild(circle);
        card.querySelector('.peer-avatar').appendChild(svg);
    }

    const circle = svg.querySelector('circle');
    const circumference = 2 * Math.PI * 20;
    circle.setAttribute('stroke-dashoffset', String(circumference * (1 - progress)));
}

// Render files list
function renderFiles(files, onRemove) {
    const section = $('#files-section');
    const list = $('#files-list');
    list.innerHTML = '';

    if (files.length === 0) {
        section.hidden = true;
        return;
    }

    section.hidden = false;

    files.forEach((file, i) => {
        const item = document.createElement('div');
        item.className = 'file-item';
        item.innerHTML = `
            <span class="file-icon">${fileIcon(file.name)}</span>
            <div class="file-info">
                <div class="file-name" title="${escapeHtml(file.name)}">${escapeHtml(file.name)}</div>
                <div class="file-size">${formatSize(file.size)}</div>
            </div>
            <button class="file-remove btn-icon" aria-label="Remove ${escapeHtml(file.name)}" data-index="${i}">
                <svg class="icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        `;
        item.querySelector('.file-remove').addEventListener('click', () => onRemove(i));
        list.appendChild(item);
    });
}

// Render transfer progress
function renderTransfer(transfer) {
    const section = $('#transfer-section');
    section.hidden = false;
    const list = $('#transfer-list');

    let item = list.querySelector(`[data-transfer-id="${transfer.id}"]`);
    if (!item) {
        item = document.createElement('div');
        item.className = 'transfer-item';
        item.dataset.transferId = transfer.id;
        list.appendChild(item);
    }

    const pct = Math.round(transfer.progress * 100);
    const barClass = pct >= 100 ? 'transfer-bar-fill complete' : 'transfer-bar-fill';
    const statusText = pct >= 100 ? 'Complete' : `${formatSize(transfer.sent)} / ${formatSize(transfer.total)}`;

    item.innerHTML = `
        <div class="transfer-header">
            <span class="transfer-name">${escapeHtml(transfer.name)}</span>
            <span class="transfer-speed">${transfer.speed > 0 ? formatSpeed(transfer.speed) : ''}</span>
        </div>
        <div class="transfer-bar"><div class="${barClass}" style="width:${pct}%"></div></div>
        <div class="transfer-status">
            <span>${statusText}</span>
            <span>${pct}%</span>
        </div>
    `;
}

// Show transfer request modal
function showTransferModal(files, onAccept, onReject) {
    const modal = $('#transfer-modal');
    const filesList = $('#transfer-modal-files');

    filesList.innerHTML = files.map(f =>
        `<div class="file-item">
            <span class="file-icon">${fileIcon(f.name)}</span>
            <div class="file-info">
                <div class="file-name">${escapeHtml(f.name)}</div>
                <div class="file-size">${formatSize(f.size)}</div>
            </div>
        </div>`
    ).join('');

    modal.hidden = false;

    const acceptBtn = $('#accept-transfer-btn');
    const rejectBtn = $('#reject-transfer-btn');

    const cleanup = () => {
        modal.hidden = true;
        acceptBtn.replaceWith(acceptBtn.cloneNode(true));
        rejectBtn.replaceWith(rejectBtn.cloneNode(true));
    };

    $('#accept-transfer-btn').addEventListener('click', () => { cleanup(); onAccept(); }, { once: true });
    $('#reject-transfer-btn').addEventListener('click', () => { cleanup(); onReject(); }, { once: true });
    modal.querySelector('.modal-backdrop').addEventListener('click', () => { cleanup(); onReject(); }, { once: true });
}

// Escape HTML
function escapeHtml(str) {
    const div = document.createElement('div');
    div.textContent = str;
    return div.innerHTML;
}

// Update the connection mode badge on a peer card
function updatePeerConnectionMode(peerId, mode) {
    const card = $(`.peer-card[data-peer-id="${peerId}"]`);
    if (!card) return;

    // Remove existing badge
    const existing = card.querySelector('.connection-badge');
    if (existing) existing.remove();

    const labels = { p2p: 'P2P', turn: 'TURN', relay: 'Relay' };
    const label = labels[mode];
    if (!label) return;

    const badge = document.createElement('span');
    badge.className = `connection-badge connection-badge--${mode}`;
    badge.textContent = label;
    card.appendChild(badge);
}

export {
    $, $$,
    detectDeviceType, deviceEmoji, getDeviceName,
    formatSize, formatSpeed, fileIcon,
    initTheme, toggleTheme,
    showToast, setConnectionStatus,
    createPeerCard, updatePeerProgress, updatePeerConnectionMode,
    renderFiles, renderTransfer, showTransferModal,
    escapeHtml,
};
