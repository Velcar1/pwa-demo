import PocketBase from 'pocketbase';

// --- Configuration ---
const PB_URL = import.meta.env.VITE_PB_URL || 'https://firm-ordinary-metres-complex.trycloudflare.com/';

const pb = new PocketBase(PB_URL);
pb.autoCancellation(false);

// --- Register custom media Service Worker ---
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw-media.js').then((reg) => {
        console.log('[SW] Media service worker registered:', reg.scope);
    }).catch((err) => {
        console.warn('[SW] Service worker registration failed:', err);
    });
}

// --- DOM Elements ---
const app = document.getElementById('app');
const video = document.getElementById('idleVideo');
const image = document.getElementById('displayImage');
const iframe = document.getElementById('contentFrame');
const overlay = document.getElementById('interactionOverlay');
const loadingOverlay = document.getElementById('loadingOverlay');
const pairingOverlay = document.getElementById('pairingOverlay');
const pairingCodeDisplay = document.getElementById('pairingCodeDisplay');

// --- App State ---
let currentConfig = null;
let playlistItems = [];
let currentPlaylistItemIndex = 0;
let playlistTimeout = null;

// --- Sync Indicator ---
function showSync(message) {
    const el = document.getElementById('syncStatus');
    if (!el) return;
    el.textContent = message || '⬇ Sincronizando...';
    el.classList.remove('hidden');
    el.style.opacity = '1';
}
function hideSync() {
    const el = document.getElementById('syncStatus');
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(() => el.classList.add('hidden'), 600);
}

// --- Persistence Helpers ---
function saveConfig(config) {
    try { localStorage.setItem('pwa_last_config', JSON.stringify(config)); } catch (e) {}
}
function getSavedConfig() {
    try { return JSON.parse(localStorage.getItem('pwa_last_config')); } catch (e) { return null; }
}
function savePlaylist(items) {
    try { localStorage.setItem('pwa_last_playlist', JSON.stringify(items)); } catch (e) {}
}
function getSavedPlaylist() {
    try { return JSON.parse(localStorage.getItem('pwa_last_playlist')); } catch (e) { return null; }
}

// --- Pairing Code Generator ---
function generatePairingCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 6; i++) result += chars[Math.floor(Math.random() * chars.length)];
    return result;
}

// --- Fetch Config from PocketBase ---
async function fetchConfig(groupId) {
    if (!groupId) return null;

    const records = await pb.collection('pwa_config').getFullList({
        filter: `group = "${groupId}"`,
        sort: '-created',
        expand: 'media,playlist'
    });

    if (records.length === 0) return null;

    const now = new Date();
    let activeRecord = null;
    let baseRecord = null;

    for (const record of records) {
        if (record.is_schedule && record.schedule_start && record.schedule_end) {
            const start = new Date(record.schedule_start);
            const end = new Date(record.schedule_end);
            if (now >= start && now <= end) { activeRecord = record; break; }
        } else if (!record.is_schedule && !baseRecord) {
            baseRecord = record;
        }
    }

    const recordToUse = activeRecord || baseRecord;
    if (!recordToUse) return null;

    // Compute media URL
    if (recordToUse.content_type !== 'playlist' && recordToUse.expand?.media) {
        const mediaRecord = recordToUse.expand.media;
        const fileUrl = pb.files.getURL(mediaRecord, mediaRecord.file);
        if (recordToUse.content_type === 'video_interactive' || recordToUse.content_type === 'video_only') {
            recordToUse.video_full_url = fileUrl;
        } else if (recordToUse.content_type === 'image_only') {
            recordToUse.image_full_url = fileUrl;
        }
    }

    // Fetch playlist items if needed
    if (recordToUse.content_type === 'playlist' && recordToUse.playlist) {
        const items = await pb.collection('playlist_items').getFullList({
            filter: `playlist = "${recordToUse.playlist}"`,
            sort: 'sort_order',
            expand: 'media'
        });
        const mapped = items.map(item => ({
            ...item,
            full_url: pb.files.getURL(item.expand.media, item.expand.media.file)
        }));
        savePlaylist(mapped);
        playlistItems = mapped;
        
        // Pre-warm cache in background (service worker will cache automatically on normal fetch)
        preWarmCache(mapped.map(i => i.full_url));
    } else {
        playlistItems = [];
        // Pre-warm single media
        const urls = [recordToUse.video_full_url, recordToUse.image_full_url].filter(Boolean);
        preWarmCache(urls);
    }

    saveConfig(recordToUse);
    return recordToUse;
}

// Pre-warm cache by fetching URLs silently in the background
// The service worker will intercept these fetches and cache them automatically
function preWarmCache(urls) {
    if (!urls || urls.length === 0) return;
    showSync('⬇ Sincronizando...');
    let pending = urls.length;
    urls.forEach(url => {
        fetch(url, { mode: 'no-cors' }).catch(() => {}).finally(() => {
            pending--;
            if (pending <= 0) hideSync();
        });
    });
}

// --- Load Config: Try network first, fall back to localStorage ---
async function loadConfig(groupId) {
    if (!groupId) {
        console.warn('[PWA] No groupId provided.');
        return getSavedConfig();
    }

    try {
        const config = await fetchConfig(groupId);
        if (config) {
            console.log('[PWA] Config loaded from network.');
            return config;
        }
    } catch (err) {
        console.warn('[PWA] Network fetch failed, loading from local storage:', err.message);
    }

    // Offline fallback
    const saved = getSavedConfig();
    if (saved) {
        console.log('[PWA] Loaded config from localStorage.');
        const savedPl = getSavedPlaylist();
        if (savedPl) playlistItems = savedPl;
        return saved;
    }

    return null;
}

// --- Rendering ---
async function renderContent(config) {
    if (!config) return;

    const type = config.content_type || 'video_interactive';
    console.log('[PWA] Rendering:', type);

    // Reset all
    video.classList.add('hidden');
    image.classList.add('hidden');
    iframe.classList.remove('visible');
    overlay.classList.add('hidden');
    video.pause();

    if (playlistTimeout) { clearTimeout(playlistTimeout); playlistTimeout = null; }

    if (type === 'playlist') {
        currentPlaylistItemIndex = 0;
        renderPlaylistItem();
    } else if (type === 'video_interactive' || type === 'video_only') {
        if (config.video_full_url) {
            const source = video.querySelector('source') || video;
            source.src = config.video_full_url;
            video.load();
            video.loop = true;
            video.onended = null;
            video.classList.remove('hidden');
            if (type === 'video_interactive') overlay.classList.remove('hidden');
            video.play().catch(e => console.warn('[PWA] Autoplay blocked:', e.message));
        } else {
            console.warn('[PWA] No video URL in config.');
        }
    } else if (type === 'image_only') {
        if (config.image_full_url) {
            image.src = config.image_full_url;
            image.classList.remove('hidden');
        }
    } else if (type === 'web_only') {
        if (config.redirect_url) {
            if (iframe.src !== config.redirect_url) iframe.src = config.redirect_url;
            iframe.classList.add('visible');
        }
    }
}

function renderPlaylistItem() {
    if (playlistItems.length === 0) { console.warn('Playlist is empty.'); return; }

    const item = playlistItems[currentPlaylistItemIndex];
    const isVideo = item.full_url.toLowerCase().match(/\.(mp4|webm|ogg)(\?|$)/i);

    video.classList.add('hidden');
    image.classList.add('hidden');
    video.pause();

    if (isVideo) {
        const source = video.querySelector('source') || video;
        source.src = item.full_url;
        video.load();
        video.loop = false;
        video.onended = nextPlaylistItem;
        video.play().then(() => {
            video.classList.remove('hidden');
        }).catch(e => {
            console.error('[PWA] Playlist video error:', e.message);
            nextPlaylistItem();
        });
    } else {
        image.src = item.full_url;
        image.classList.remove('hidden');
        const duration = (item.duration || 5) * 1000;
        playlistTimeout = setTimeout(nextPlaylistItem, duration);
    }
}

function nextPlaylistItem() {
    currentPlaylistItemIndex = (currentPlaylistItemIndex + 1) % playlistItems.length;
    renderPlaylistItem();
}

// --- Main content loader ---
async function updateContentFromConfig(groupId) {
    console.log('[PWA] Loading config for group:', groupId);
    try {
        const config = await loadConfig(groupId);
        currentConfig = config;

        // Hide loading overlay
        loadingOverlay.style.opacity = '0';
        setTimeout(() => loadingOverlay.classList.add('hidden'), 400);

        if (!config) {
            console.warn('[PWA] No config available (online or offline).');
            video.classList.add('hidden');
            image.classList.add('hidden');
            iframe.classList.remove('visible');
            return;
        }

        renderContent(config);
    } catch (err) {
        console.error('[PWA] Fatal error loading config:', err);
        loadingOverlay.style.opacity = '0';
        setTimeout(() => loadingOverlay.classList.add('hidden'), 400);
    }
}

// --- Real-time subscription ---
function subscribeToConfigChanges(groupId) {
    pb.collection('pwa_config').subscribe('*', (e) => {
        if ((e.action === 'update' || e.action === 'create') && e.record.group === groupId) {
            console.log('[PWA] Real-time config update received.');
            updateContentFromConfig(groupId);
        }
    }).catch(err => {
        if (!err.isAbort) console.info('[PWA] Realtime unavailable, polling active.');
    });
}

// --- Start content display ---
async function startContent(device) {
    if (!device) return;
    console.log('[PWA] Starting content for device:', device.id);

    pairingOverlay.classList.add('hidden');
    loadingOverlay.classList.remove('hidden');
    loadingOverlay.style.opacity = '1';

    const deviceId = device.id;
    let groupId = device.group || localStorage.getItem('pwa_group_id');
    if (!groupId) {
        console.warn('[PWA] No groupId found. Cannot load content.');
        loadingOverlay.style.opacity = '0';
        setTimeout(() => loadingOverlay.classList.add('hidden'), 400);
        return;
    }

    await updateContentFromConfig(groupId);

    // Realtime subscriptions (best-effort, may not work over Cloudflare tunnels)
    if (navigator.onLine) {
        subscribeToConfigChanges(groupId);
        subscribeToDeviceChanges(deviceId);
    }

    // --- POLLING FALLBACK: Check for device status + group changes every 15s ---
    // This is the primary detection mechanism when realtime is unavailable.
    setInterval(async () => {
        if (!navigator.onLine || !deviceId) return;
        try {
            const latestDevice = await pb.collection('devices').getOne(deviceId);

            // --- Detect group change ---
            const currentGroupId = localStorage.getItem('pwa_group_id');
            if (latestDevice.group && latestDevice.group !== currentGroupId) {
                console.log(`[PWA] Polling detected group change: ${currentGroupId} → ${latestDevice.group}`);
                groupId = latestDevice.group;
                localStorage.setItem('pwa_group_id', groupId);
                localStorage.removeItem('pwa_last_config');
                localStorage.removeItem('pwa_last_playlist');
                video.pause();
                if (playlistTimeout) { clearTimeout(playlistTimeout); playlistTimeout = null; }
                try { pb.collection('pwa_config').unsubscribe(); } catch (ex) {}
                loadingOverlay.classList.remove('hidden');
                loadingOverlay.style.opacity = '1';
                await updateContentFromConfig(groupId);
                subscribeToConfigChanges(groupId);
                return;
            }

            // --- Detect unpairing ---
            if (!latestDevice.is_registered) {
                console.log('[PWA] Polling detected device unregistered. Re-pairing...');
                localStorage.removeItem('pwa_device_id');
                localStorage.removeItem('pwa_group_id');
                localStorage.removeItem('pwa_last_config');
                localStorage.removeItem('pwa_last_playlist');
                video.pause();
                video.classList.add('hidden');
                image.classList.add('hidden');
                iframe.src = 'about:blank';
                iframe.classList.remove('visible');
                checkDevicePairing();
            }

        } catch (err) {
            if (err.status === 404) {
                console.warn('[PWA] Polling: device deleted from server. Re-pairing...');
                localStorage.removeItem('pwa_device_id');
                localStorage.removeItem('pwa_group_id');
                localStorage.removeItem('pwa_last_config');
                localStorage.removeItem('pwa_last_playlist');
                checkDevicePairing();
            }
            // Other errors (offline etc.) are silently ignored until next poll
        }
    }, 15000); // Poll every 15 seconds

    // Also poll config changes every 60s as a fallback
    setInterval(() => {
        if (navigator.onLine) {
            const gId = localStorage.getItem('pwa_group_id');
            if (gId) updateContentFromConfig(gId);
        }
    }, 60000);

    // Restore sync when internet comes back (only register once)
    if (!window._onlineListenerAdded) {
        window._onlineListenerAdded = true;
        window.addEventListener('online', () => {
            console.log('[PWA] Internet restored, syncing...');
            const gId = localStorage.getItem('pwa_group_id');
            if (gId) {
                updateContentFromConfig(gId);
                subscribeToConfigChanges(gId);
            }
        });
    }
}

// --- Pairing Screen ---
function showPairingScreen(code) {
    pairingCodeDisplay.textContent = code;
    pairingOverlay.classList.remove('hidden');
    loadingOverlay.classList.add('hidden');
    video.classList.add('hidden');
    image.classList.add('hidden');
    iframe.classList.remove('visible');
    if (playlistTimeout) { clearTimeout(playlistTimeout); playlistTimeout = null; }
}

// --- Finalize Pairing ---
function finalizePairing(deviceId, record) {
    if (localStorage.getItem('pwa_device_id')) return; // Already done
    console.log('[PWA] Pairing confirmed!');
    localStorage.setItem('pwa_device_id', deviceId);
    if (record.group) localStorage.setItem('pwa_group_id', record.group);
    try { pb.collection('devices').unsubscribe(deviceId); } catch (e) {}
    startContent(record);
    subscribeToDeviceChanges(deviceId);
}

// --- Watch for remote unpairing or group changes ---
function subscribeToDeviceChanges(deviceId) {
    pb.collection('devices').subscribe(deviceId, (e) => {
        if (e.action === 'delete' || (e.action === 'update' && !e.record.is_registered)) {
            console.log('[PWA] Device remotely unpaired.');
            localStorage.removeItem('pwa_device_id');
            localStorage.removeItem('pwa_group_id');
            localStorage.removeItem('pwa_last_config');
            localStorage.removeItem('pwa_last_playlist');
            video.pause();
            video.classList.add('hidden');
            image.classList.add('hidden');
            iframe.src = 'about:blank';
            iframe.classList.remove('visible');
            overlay.classList.remove('hidden');
            try { pb.collection('devices').unsubscribe(deviceId); } catch (ex) {}
            checkDevicePairing();
        } else if (e.action === 'update' && e.record.is_registered) {
            const currentGroupId = localStorage.getItem('pwa_group_id');
            const newGroupId = e.record.group;

            if (newGroupId && newGroupId !== currentGroupId) {
                console.log(`[PWA] Group changed from ${currentGroupId} to ${newGroupId}. Reloading content...`);

                // Clear stale cached config so we don't show old content
                localStorage.setItem('pwa_group_id', newGroupId);
                localStorage.removeItem('pwa_last_config');
                localStorage.removeItem('pwa_last_playlist');

                // Stop current playback
                video.pause();
                if (playlistTimeout) { clearTimeout(playlistTimeout); playlistTimeout = null; }
                
                // Unsubscribe old config subscription and resubscribe for new group
                try { pb.collection('pwa_config').unsubscribe(); } catch (ex) {}

                // Show loading while we fetch new group's content
                loadingOverlay.classList.remove('hidden');
                loadingOverlay.style.opacity = '1';
                
                updateContentFromConfig(newGroupId).then(() => {
                    subscribeToConfigChanges(newGroupId);
                });
            }
        }
    }).catch(err => {
        if (!err.isAbort) console.info('[PWA] Realtime device tracking unavailable.');
    });
}

// --- Interaction handler (for video_interactive) ---
const handleInteraction = () => {
    if (!currentConfig || !pairingOverlay.classList.contains('hidden')) return;
    if (currentConfig.content_type !== 'video_interactive') return;

    console.log('[PWA] Interaction detected.');
    iframe.src = currentConfig.redirect_url;
    iframe.classList.add('visible');
    video.classList.add('hidden');
    overlay.classList.add('hidden');
    if (playlistTimeout) { clearTimeout(playlistTimeout); playlistTimeout = null; }
};
app.addEventListener('click', handleInteraction);
app.addEventListener('touchstart', handleInteraction, { passive: true });

// --- Main Entry Point ---
async function checkDevicePairing() {
    let deviceId = localStorage.getItem('pwa_device_id');
    let groupId = localStorage.getItem('pwa_group_id');

    // No device ID → start pairing flow
    if (!deviceId) {
        // But first, check if we can reach the server
        if (!navigator.onLine) {
            // Offline and no device ID → nothing we can do
            loadingOverlay.classList.add('hidden');
            pairingOverlay.classList.remove('hidden');
            pairingCodeDisplay.textContent = 'Sin conexión';
            return;
        }

        const code = generatePairingCode();
        console.log('[PWA] Starting pairing. Code:', code);

        try {
            const record = await pb.collection('devices').create({ pairing_code: code, is_registered: false });
            deviceId = record.id;
            showPairingScreen(code);

            // Real-time pairing listener
            pb.collection('devices').subscribe(deviceId, (e) => {
                if (e.record.is_registered) finalizePairing(deviceId, e.record);
            });

            // Polling fallback
            const poll = setInterval(async () => {
                try {
                    const r = await pb.collection('devices').getOne(deviceId);
                    if (r.is_registered) { clearInterval(poll); finalizePairing(deviceId, r); }
                } catch (err) {
                    if (err.status === 404) clearInterval(poll);
                }
            }, 5000);
        } catch (err) {
            console.error('[PWA] Failed to create device:', err);
            pairingCodeDisplay.textContent = 'ERROR';
            pairingCodeDisplay.style.color = 'red';
        }
        return;
    }

    // Device ID exists → verify with server
    try {
        const device = await pb.collection('devices').getOne(deviceId);
        if (device.is_registered) {
            startContent(device);
            subscribeToDeviceChanges(deviceId);
        } else {
            // Server says not registered → force re-pair
            console.warn('[PWA] Device is_registered=false, re-pairing.');
            localStorage.removeItem('pwa_device_id');
            checkDevicePairing();
        }
    } catch (err) {
        if (err.status === 404) {
            // Device deleted from backend → need new pairing
            console.warn('[PWA] Device not found (404), clearing and re-pairing.');
            localStorage.removeItem('pwa_device_id');
            localStorage.removeItem('pwa_group_id');
            localStorage.removeItem('pwa_last_config');
            localStorage.removeItem('pwa_last_playlist');
            checkDevicePairing();
        } else {
            // Network error (offline) → load from local storage
            console.warn('[PWA] Offline. Loading from cache. Error:', err.message || err);
            startContent({ id: deviceId, group: groupId });
        }
    }
}

// --- Initialize ---
document.addEventListener('DOMContentLoaded', () => {
    checkDevicePairing();
});
