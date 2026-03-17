// Custom Service Worker for media caching
// This intercepts all requests to PocketBase media files and caches them.
// Strategy: Cache First — serve from cache if available, fetch from network otherwise.

const MEDIA_CACHE_NAME = 'l1nx-media-cache-v2';

// Install and activate immediately
self.addEventListener('install', (event) => {
    console.log('[SW Media] Installing...');
    self.skipWaiting();
});

self.addEventListener('activate', (event) => {
    console.log('[SW Media] Activating...');
    event.waitUntil(
        caches.keys().then((keys) =>
            Promise.all(
                keys
                    .filter((key) => key !== MEDIA_CACHE_NAME && key.startsWith('l1nx-media-cache'))
                    .map((key) => {
                        console.log('[SW Media] Deleting old cache:', key);
                        return caches.delete(key);
                    })
            )
        ).then(() => self.clients.claim())
    );
});

self.addEventListener('fetch', (event) => {
    const url = event.request.url;

    // Only intercept GET requests for media files (images, videos) from PocketBase
    if (event.request.method !== 'GET') return;

    const isMediaFile = /\.(mp4|webm|ogg|jpg|jpeg|png|gif|webp|svg)(\?.*)?$/i.test(url);
    const isPocketBaseFile = url.includes('/api/files/');

    if (!isMediaFile && !isPocketBaseFile) return;

    // Cache-first strategy for media
    event.respondWith(
        caches.open(MEDIA_CACHE_NAME).then(async (cache) => {
            const cached = await cache.match(event.request);
            if (cached) {
                console.log('[SW Media] Cache HIT:', url);
                return cached;
            }

            console.log('[SW Media] Cache MISS, fetching:', url);
            try {
                const networkResponse = await fetch(event.request.clone());
                if (networkResponse.ok) {
                    // Cache a clone so we can also return the response
                    cache.put(event.request, networkResponse.clone());
                    console.log('[SW Media] Cached:', url);
                }
                return networkResponse;
            } catch (err) {
                console.error('[SW Media] Offline and not cached:', url, err);
                // Return empty response with error status so the app can handle it
                return new Response('', { status: 503, statusText: 'Offline - Not Cached' });
            }
        })
    );
});
