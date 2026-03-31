/**
 * ShelfTag — Service Worker
 * =====================
 * Handles offline caching so the app works without network connectivity.
 * 
 * How it works:
 * 1. On install: caches all app files (HTML, CSS, JS) so the app loads offline
 * 2. On fetch: serves from cache first, falls back to network
 * 3. On activate: cleans up old cache versions when the app is updated
 * 
 * NOTE ON BACKGROUND UPLOADS:
 * Safari does NOT support the Background Sync API (SyncManager).
 * Background uploads are handled by the main thread via visibilitychange
 * events (see sync.js). The service worker's role is purely offline caching.
 * 
 * When the app code is updated on the server:
 * - The browser detects the service worker file has changed
 * - It downloads the new SW and triggers the install event
 * - New cache version is created with updated files
 * - On next page load, the new SW activates and old cache is deleted
 */

// Bump this on every frontend deploy.
// IMPORTANT FOR FUTURE LLMs/ENGINEERS:
// - Keep APP_VERSION in /frontend/js/app.js in sync with this cache bump.
// - Increment app version by 0.01 each deploy (v01.00 -> v01.01 -> v01.02 ...).
const CACHE_VERSION = 'shelftag-v18';

// Files to cache for offline use
const CACHE_FILES = [
    '/',
    '/css/styles.css',
    '/js/app.js',
    '/js/camera.js',
    '/js/storage.js',
    '/js/sync.js',
    '/js/geo.js',
    '/manifest.json',
];


// ---- INSTALL ----
self.addEventListener('install', (event) => {
    console.log('[SW] Installing service worker...');
    event.waitUntil(
        caches.open(CACHE_VERSION)
            .then((cache) => {
                console.log('[SW] Caching app files...');
                return cache.addAll(CACHE_FILES);
            })
            .then(() => self.skipWaiting())
    );
});


// ---- ACTIVATE ----
self.addEventListener('activate', (event) => {
    console.log('[SW] Activating service worker...');
    event.waitUntil(
        caches.keys().then((cacheNames) => {
            return Promise.all(
                cacheNames
                    .filter((name) => name !== CACHE_VERSION)
                    .map((name) => {
                        console.log(`[SW] Deleting old cache: ${name}`);
                        return caches.delete(name);
                    })
            );
        }).then(() => self.clients.claim())
    );
});

// Allow the page to force activation of a newly installed worker immediately.
self.addEventListener('message', (event) => {
    if (event.data?.type === 'SKIP_WAITING') {
        self.skipWaiting();
    }
});


// ---- FETCH ----
// Cache-first for app files, pass-through for API calls
self.addEventListener('fetch', (event) => {
    const url = new URL(event.request.url);

    // API calls always go to network — never cache
    if (url.pathname.startsWith('/api/')) {
        return;
    }

    event.respondWith(
        caches.match(event.request)
            .then((cachedResponse) => {
                if (cachedResponse) {
                    return cachedResponse;
                }
                return fetch(event.request).then((networkResponse) => {
                    return caches.open(CACHE_VERSION).then((cache) => {
                        cache.put(event.request, networkResponse.clone());
                        return networkResponse;
                    });
                });
            })
            .catch(() => {
                console.warn('[SW] Cache and network both failed for:', event.request.url);
            })
    );
});
