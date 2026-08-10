// BeamIt Service Worker — offline app shell + installable PWA.
//
// Strategy:
//   • Precache the static app shell on install so BeamIt opens instantly and works offline.
//   • Navigation requests: network-first (fresh HTML when online), fall back to cached shell.
//   • Same-origin static assets (JS/CSS/manifest): cache-first, refreshed in the background.
//   • Never touch signaling/transfer traffic (/ws, /api/*, /health) — those must hit the network.

const CACHE = 'beamit-v1.1.0';

const APP_SHELL = [
    '/',
    '/index.html',
    '/manifest.json',
    '/css/style.css',
    '/js/app.js',
    '/js/rtc.js',
    '/js/transfer.js',
    '/js/crypto.js',
    '/js/discovery.js',
    '/js/ui.js',
    '/js/wire.js',
    '/js/sha256.js',
    '/js/qrcode.js',
];

self.addEventListener('install', (event) => {
    event.waitUntil(
        caches.open(CACHE)
            .then((cache) => cache.addAll(APP_SHELL))
            .then(() => self.skipWaiting())
            .catch((err) => console.warn('SW precache failed:', err)),
    );
});

self.addEventListener('activate', (event) => {
    event.waitUntil(
        caches.keys()
            .then((keys) => Promise.all(keys.filter((k) => k !== CACHE).map((k) => caches.delete(k))))
            .then(() => self.clients.claim()),
    );
});

function isBypassed(url) {
    return url.pathname === '/ws'
        || url.pathname === '/health'
        || url.pathname.startsWith('/api/');
}

self.addEventListener('fetch', (event) => {
    const req = event.request;
    if (req.method !== 'GET') return;

    const url = new URL(req.url);
    if (url.origin !== self.location.origin || isBypassed(url)) return;

    if (req.mode === 'navigate') {
        event.respondWith(
            fetch(req)
                .then((resp) => {
                    const copy = resp.clone();
                    caches.open(CACHE).then((cache) => cache.put('/', copy));
                    return resp;
                })
                .catch(() => caches.match('/').then((r) => r || caches.match('/index.html'))),
        );
        return;
    }

    event.respondWith(
        caches.match(req).then((cached) => {
            const network = fetch(req)
                .then((resp) => {
                    if (resp && resp.status === 200 && resp.type === 'basic') {
                        const copy = resp.clone();
                        caches.open(CACHE).then((cache) => cache.put(req, copy));
                    }
                    return resp;
                })
                .catch(() => cached);
            return cached || network;
        }),
    );
});
