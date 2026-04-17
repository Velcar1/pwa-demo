import PocketBase from 'pocketbase';

// ─── Configuration ────────────────────────────────────────────────────────────
const PB_URL = import.meta.env.VITE_PB_URL || 'https://firm-ordinary-metres-complex.trycloudflare.com/';
const MEDIA_CACHE_NAME = 'pwa-media-v1';

const pb = new PocketBase(PB_URL);
pb.autoCancellation(false);

// ─── Register Service Worker ──────────────────────────────────────────────────
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('/sw-media.js')
        .then(reg => console.log('[SW] Registered:', reg.scope))
        .catch(err => console.warn('[SW] Registration failed:', err));
}

// ─── Fix: White strip on Android Chrome when restoring from background ────────
// When a PWA is minimized and restored, Android Chrome briefly changes the
// viewport dimensions while toggling its system UI, leaving a gap at the top.
// We force a GPU repaint cycle on visibilitychange to flush that stale layout.
document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        // Trigger a GPU layer repaint by toggling a transform on the root element.
        // This is instant (no flash) but forces the browser to re-evaluate layout.
        document.documentElement.style.transform = 'translateZ(0)';
        requestAnimationFrame(() => {
            document.documentElement.style.transform = '';
            window.scrollTo(0, 0);
        });
    }
});

// ─── DOM Elements ─────────────────────────────────────────────────────────────
const app                = document.getElementById('app');
const video              = document.getElementById('idleVideo');
const image              = document.getElementById('displayImage');
let iframe             = document.getElementById('contentFrame');
const overlay            = document.getElementById('interactionOverlay');
const loadingOverlay     = document.getElementById('loadingOverlay');
const pairingOverlay     = document.getElementById('pairingOverlay');
const pairingCodeDisplay = document.getElementById('pairingCodeDisplay');
const interactiveImage   = document.getElementById('interactiveImage');

// ─── App State ────────────────────────────────────────────────────────────────
let currentConfig           = null;
let playlistItems           = [];
let currentPlaylistItemIndex = 0;
let playlistTimeout         = null;
let isLoadingContent        = false; // prevents concurrent content loads

// ─── DOM Helpers ──────────────────────────────────────────────────────────────
// Always recreate the iframe instead of changing .src to avoid polluting window.history
function setIframeContent(url, htmlContent = null) {
    const newIframe = document.createElement('iframe');
    newIframe.id = 'contentFrame';
    newIframe.allow = "autoplay; fullscreen";
    newIframe.frameBorder = "0";
    if (htmlContent !== null) {
        newIframe.srcdoc = htmlContent;
    } else {
        newIframe.src = url || 'about:blank';
    }
    iframe.parentNode.replaceChild(newIframe, iframe);
    iframe = newIframe;
}

// ─── Sync Indicator ───────────────────────────────────────────────────────────
function showSync(msg = '⬇ Descargando...') {
    const el = document.getElementById('syncStatus');
    if (!el) return;
    el.textContent = msg;
    el.classList.remove('hidden');
    el.style.opacity = '1';
}
function hideSync() {
    const el = document.getElementById('syncStatus');
    if (!el) return;
    el.style.opacity = '0';
    setTimeout(() => el.classList.add('hidden'), 600);
}

// ─── localStorage Helpers ─────────────────────────────────────────────────────
function saveConfig(config) {
    // Never persist runtime-only fields (_playlistItems) to localStorage
    try {
        const { _playlistItems, ...rest } = config;
        localStorage.setItem('pwa_last_config', JSON.stringify(rest));
    } catch (e) {}
}
function getSavedConfig() {
    try { return JSON.parse(localStorage.getItem('pwa_last_config')); } catch { return null; }
}
function savePlaylist(items) {
    try { localStorage.setItem('pwa_last_playlist', JSON.stringify(items)); } catch (e) {}
}
function getSavedPlaylist() {
    try { return JSON.parse(localStorage.getItem('pwa_last_playlist')); } catch { return null; }
}

// ─── Media Cache ──────────────────────────────────────────────────────────────
/**
 * Pre-downloads all URLs fully into the Cache API.
 * Uses 'no-cors' so it works even with CORS-restricted origins (e.g. Cloudflare tunnels).
 * The service worker (sw-media.js) will serve them transparently when offline.
 */
async function preCacheMedia(urls) {
    if (!urls || urls.length === 0) return;
    showSync('⬇ Descargando contenido...');
    try {
        const cache = await caches.open(MEDIA_CACHE_NAME);
        await Promise.all(urls.map(async (url) => {
            // Check if already cached
            const existing = await cache.match(url);
            if (existing) return; // Already in cache, skip download
            try {
                // Use cache.add which handles opaque (no-cors) responses correctly
                await cache.add(new Request(url, { mode: 'no-cors' }));
                console.log('[Cache] Stored:', url.split('/').pop());
            } catch (e) {
                // If cache.add fails, try a regular fetch as fallback
                try {
                    const res = await fetch(url);
                    if (res.ok) await cache.put(url, res);
                } catch { /* ignore - will retry next time */ }
            }
        }));
    } finally {
        hideSync();
    }
}

/**
 * Resolves a URL usable for the <video>/<img> element.
 * Tries to serve from cache first for offline support.
 */
async function resolveMediaUrl(url) {
    if (!url) return url;
    try {
        const cache = await caches.open(MEDIA_CACHE_NAME);
        const cached = await cache.match(url);
        if (cached) return url; // Service worker will intercept and serve from cache
    } catch {}
    return url;
}

// ─── Pairing Code Generator ───────────────────────────────────────────────────
function generatePairingCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
    let result = '';
    for (let i = 0; i < 6; i++) result += chars[Math.floor(Math.random() * chars.length)];
    return result;
}

// ─── Fetch Config from PocketBase ─────────────────────────────────────────────
async function fetchConfig(groupId) {
    if (!groupId) return null;

    const records = await pb.collection('pwa_config').getFullList({
        filter: `group = "${groupId}"`,
        sort: '-created',
        expand: 'media,playlist,interactive_image'
    });

    if (records.length === 0) return null;

    // Determine active record (scheduled or base)
    const now = new Date();
    let activeRecord = null;
    let baseRecord   = null;

    for (const record of records) {
        if (record.is_schedule && record.schedule_start && record.schedule_end) {
            const start = new Date(record.schedule_start);
            const end   = new Date(record.schedule_end);
            if (now >= start && now <= end) { activeRecord = record; break; }
        } else if (!record.is_schedule && !baseRecord) {
            baseRecord = record;
        }
    }

    const rec = activeRecord || baseRecord;
    if (!rec) return null;

    // Build media URL
    if (rec.content_type !== 'playlist' && rec.expand?.media) {
        const m = rec.expand.media;
        const url = pb.files.getURL(m, m.file);
        if (rec.content_type === 'video_interactive' || rec.content_type === 'video_only') {
            rec.video_full_url = url;
        } else if (rec.content_type === 'image_only' || rec.content_type === 'html_only') {
            rec.image_full_url = url;
        }
    }

    // Build interactive image URL if available
    if (rec.content_type === 'video_interactive' && rec.expand?.interactive_image) {
        const im = rec.expand.interactive_image;
        rec.interactive_image_url = pb.files.getURL(im, im.file);
    }

    // Fetch playlist items
    if (rec.content_type === 'playlist' && rec.playlist) {
        const items = await pb.collection('playlist_items').getFullList({
            filter: `playlist = "${rec.playlist}"`,
            sort: 'sort_order',
            expand: 'media'
        });
        rec._playlistItems = items.map(item => ({
            ...item,
            full_url: pb.files.getURL(item.expand.media, item.expand.media.file)
        }));
    } else {
        rec._playlistItems = [];
    }

    return rec;
}

// ─── Load Config (network → localStorage fallback) ────────────────────────────
async function loadConfig(groupId) {
    if (!groupId) return getSavedConfig();

    try {
        const config = await fetchConfig(groupId);
        if (config) {
            // Persist metadata (without _playlistItems)
            saveConfig(config);
            if (config._playlistItems?.length > 0) savePlaylist(config._playlistItems);
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
        saved._playlistItems = savedPl || [];
        if (savedPl) playlistItems = savedPl;
        return saved;
    }

    return null;
}

// ─── Rendering ────────────────────────────────────────────────────────────────
function stopCurrentContent() {
    video.classList.add('hidden');
    image.classList.add('hidden');
    interactiveImage.classList.add('hidden');
    setIframeContent('about:blank');
    iframe.classList.remove('visible');
    overlay.classList.add('hidden');
    video.pause();
    video.src = '';
    if (playlistTimeout) { clearTimeout(playlistTimeout); playlistTimeout = null; }
}

function renderContent(config) {
    if (!config) return;
    const type = config.content_type || 'video_interactive';
    console.log('[PWA] Rendering:', type);

    stopCurrentContent();

    if (type === 'playlist') {
        currentPlaylistItemIndex = 0;
        renderPlaylistItem();

    } else if (type === 'video_interactive' || type === 'video_only') {
        if (!config.video_full_url) { console.warn('[PWA] No video URL.'); return; }
        video.src = config.video_full_url;
        video.loop = true;
        video.classList.remove('hidden');
        if (type === 'video_interactive') overlay.classList.remove('hidden');
        video.play().catch(e => console.warn('[PWA] Autoplay blocked:', e.message));

    } else if (type === 'image_only') {
        if (!config.image_full_url) return;
        image.src = config.image_full_url;
        image.classList.remove('hidden');

    } else if (type === 'web_only' || type === 'url_only') {
        if (!config.redirect_url) return;
        
        if (type === 'url_only') {
            const url = config.redirect_url.toLowerCase();
            const isVid = /\.(mp4|webm|ogg|mov)(\?|$)/i.test(url);
            const isImg = /\.(jpg|jpeg|png|gif|webp|bmp|svg)(\?|$)/i.test(url);
            
            if (isVid) {
                video.src = config.redirect_url;
                video.loop = true;
                video.classList.remove('hidden');
                video.play().catch(e => console.warn('[PWA] URL Video Autoplay blocked:', e.message));
                return;
            } else if (isImg) {
                image.src = config.redirect_url;
                image.classList.remove('hidden');
                return;
            }
        }
        
        // Fallback for web_only or generic URL
        setIframeContent(config.redirect_url);
        iframe.classList.add('visible');
    } else if (type === 'html_only') {
        if (!config.image_full_url) return; // Note: image_full_url is used for media file URL
        
        // Fetch HTML content to avoid "Content-Disposition: attachment" download
        fetch(config.image_full_url)
            .then(res => res.text())
            .then(html => {
                setIframeContent(null, html);
                iframe.classList.add('visible');
            })
            .catch(err => console.error('[PWA] Failed to load HTML:', err));
    }
}

function renderPlaylistItem() {
    if (playlistItems.length === 0) { console.warn('[PWA] Playlist is empty.'); return; }

    const item    = playlistItems[currentPlaylistItemIndex];
    const isVideo = /\.(mp4|webm|ogg)(\?|$)/i.test(item.full_url);

    video.classList.add('hidden');
    image.classList.add('hidden');
    setIframeContent('about:blank');
    iframe.classList.remove('visible');
    video.pause();

    if (isVideo) {
        video.src = item.full_url;
        video.loop = false;
        video.onended = nextPlaylistItem;
        video.classList.remove('hidden');
        video.play().catch(e => {
            console.error('[PWA] Playlist video error:', e.message);
            setTimeout(nextPlaylistItem, 1000);
        });
    } else if (item.full_url.toLowerCase().endsWith('.html')) {
        fetch(item.full_url)
            .then(res => res.text())
            .then(html => {
                setIframeContent(null, html);
                iframe.classList.add('visible');
                playlistTimeout = setTimeout(nextPlaylistItem, (item.duration || 5) * 1000);
            })
            .catch(err => {
                console.error('[PWA] Playlist HTML load error:', err);
                setTimeout(nextPlaylistItem, 1000);
            });
    } else {
        image.src = item.full_url;
        image.classList.remove('hidden');
        playlistTimeout = setTimeout(nextPlaylistItem, (item.duration || 5) * 1000);
    }
}

function nextPlaylistItem() {
    currentPlaylistItemIndex = (currentPlaylistItemIndex + 1) % playlistItems.length;
    renderPlaylistItem();
}

// ─── Main Content Loader ───────────────────────────────────────────────────────
async function updateContentFromConfig(groupId) {
    if (isLoadingContent) {
        console.log('[PWA] Content load already in progress, skipping.');
        return;
    }
    isLoadingContent = true;
    console.log('[PWA] Loading config for group:', groupId);

    const hadContent = !!currentConfig; // Is something already playing?

    try {
        const config = await loadConfig(groupId);

        if (!config) {
            console.warn('[PWA] No config available.');
            if (!hadContent) {
                loadingOverlay.style.opacity = '0';
                setTimeout(() => loadingOverlay.classList.add('hidden'), 400);
            }
            return;
        }

        // Collect all media URLs to pre-cache
        const urlsToCache = [];
        if (config._playlistItems?.length > 0) {
            config._playlistItems.forEach(i => urlsToCache.push(i.full_url));
        } else {
            if (config.video_full_url) urlsToCache.push(config.video_full_url);
            if (config.image_full_url) urlsToCache.push(config.image_full_url);
            if (config.interactive_image_url) urlsToCache.push(config.interactive_image_url);
        }

        // Download media BEFORE swapping content:
        // - First load: spinner is visible, download in foreground
        // - Subsequent loads: old content keeps playing, download silently in background
        if (urlsToCache.length > 0) {
            console.log('[PWA] Pre-caching', urlsToCache.length, 'file(s)...');
            await preCacheMedia(urlsToCache);
            console.log('[PWA] Cache complete. Swapping content.');
        }

        // Check for changes before rendering
        const isSameConfig = currentConfig && currentConfig.id === config.id;
        const isUserInteracting = iframe.classList.contains('visible');

        // If it's the same config, only re-render if:
        // 1. The config was actually updated (new timestamp) AND the user is NOT interacting.
        // 2. Or if the config is different.
        // We NEVER want to auto-refresh and kill an active interactive session if the ID is the same.
        if (isSameConfig) {
            const updatedChanged = currentConfig.updated !== config.updated;
            
            if (!updatedChanged || isUserInteracting) {
                console.log('[PWA] Same config (or user interacting). Skipping render to preserve state.');
                loadingOverlay.style.opacity = '0';
                setTimeout(() => loadingOverlay.classList.add('hidden'), 400);
                // Still update the global currentConfig to keep the latest 'updated' timestamp
                currentConfig = config; 
                return;
            }
        }

        // Update global state
        if (config._playlistItems) {
            playlistItems = config._playlistItems;
        }
        currentConfig = config;

        // Hide spinner and render
        loadingOverlay.style.opacity = '0';
        setTimeout(() => loadingOverlay.classList.add('hidden'), 400);
        renderContent(config);

    } catch (err) {
        console.error('[PWA] Fatal error loading config:', err);
        if (!hadContent) {
            loadingOverlay.style.opacity = '0';
            setTimeout(() => loadingOverlay.classList.add('hidden'), 400);
        }
    } finally {
        isLoadingContent = false;
    }
}

// ─── Real-time Config Subscription ────────────────────────────────────────────
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

// ─── Real-time Device Subscription ────────────────────────────────────────────
function subscribeToDeviceChanges(deviceId) {
    pb.collection('devices').subscribe(deviceId, (e) => {
        if (e.action === 'delete' || (e.action === 'update' && !e.record.is_registered)) {
            handleUnpair();
        } else if (e.action === 'update' && e.record.is_registered) {
            const currentGroupId = localStorage.getItem('pwa_group_id');
            const newGroupId     = e.record.group;
            if (newGroupId && newGroupId !== currentGroupId) {
                handleGroupChange(newGroupId);
            }
        }
    }).catch(err => {
        if (!err.isAbort) console.info('[PWA] Realtime device tracking unavailable.');
    });
}

// ─── Group Change Handler ──────────────────────────────────────────────────────
function handleGroupChange(newGroupId) {
    console.log(`[PWA] Group changed → ${newGroupId}`);
    localStorage.setItem('pwa_group_id', newGroupId);
    localStorage.removeItem('pwa_last_config');
    localStorage.removeItem('pwa_last_playlist');
    try { pb.collection('pwa_config').unsubscribe(); } catch {}
    updateContentFromConfig(newGroupId).then(() => subscribeToConfigChanges(newGroupId));
}

// ─── Unpair Handler ───────────────────────────────────────────────────────────
function handleUnpair() {
    console.log('[PWA] Device unpaired.');
    localStorage.removeItem('pwa_device_id');
    localStorage.removeItem('pwa_group_id');
    localStorage.removeItem('pwa_last_config');
    localStorage.removeItem('pwa_last_playlist');
    stopCurrentContent();
    currentConfig = null;
    checkDevicePairing();
}

// ─── Start Content Display ────────────────────────────────────────────────────
async function startContent(device) {
    if (!device) return;
    console.log('[PWA] Starting content for device:', device.id);

    pairingOverlay.classList.add('hidden');
    // Show loading only if there's nothing cached yet
    if (!currentConfig) {
        loadingOverlay.classList.remove('hidden');
        loadingOverlay.style.opacity = '1';
    }

    const deviceId = device.id;
    let groupId    = device.group || localStorage.getItem('pwa_group_id');

    if (!groupId) {
        console.warn('[PWA] No groupId found.');
        loadingOverlay.style.opacity = '0';
        setTimeout(() => loadingOverlay.classList.add('hidden'), 400);
        return;
    }

    await updateContentFromConfig(groupId);

    // Best-effort realtime (may not work over Cloudflare tunnels)
    if (navigator.onLine) {
        subscribeToConfigChanges(groupId);
        subscribeToDeviceChanges(deviceId);
    }

    // ── Device polling (primary mechanism for group/unregister detection) ──
    setInterval(async () => {
        if (!navigator.onLine) return;
        try {
            const latest = await pb.collection('devices').getOne(deviceId);
            const currentGroupId = localStorage.getItem('pwa_group_id');

            if (!latest.is_registered) {
                handleUnpair();
                return;
            }
            if (latest.group && latest.group !== currentGroupId) {
                handleGroupChange(latest.group);
                groupId = latest.group;
            }
        } catch (err) {
            // Only unpair on explicit 404 from server
            if (err.status === 404) handleUnpair();
            // All other errors (network timeouts, etc.) → keep playing current content
        }
    }, 15000);

    // ── Config polling fallback ──
    setInterval(() => {
        if (!navigator.onLine) return;
        const gId = localStorage.getItem('pwa_group_id');
        if (gId) updateContentFromConfig(gId);
    }, 60000);

    // ── Heartbeat: report online status every 10 minutes ──
    const sendHeartbeat = async () => {
        if (!navigator.onLine) return;
        const gId = localStorage.getItem('pwa_group_id');
        if (!deviceId || !gId) return;
        try {
            // Fetch the device to get the organization id
            const dev = await pb.collection('devices').getOne(deviceId);
            await pb.collection('device_heartbeats').create({
                device: deviceId,
                group: gId,
                organization: dev.organization || null,
                status: 'online',
            });
            console.log('[PWA] Heartbeat sent.');
        } catch (err) {
            console.warn('[PWA] Heartbeat failed:', err?.message);
        }
    };

    // Send immediately on start, then every 10 minutes
    sendHeartbeat();
    setInterval(sendHeartbeat, 10 * 60 * 1000);

    // ── Restore on reconnect ──
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

// ─── Pairing Screen ───────────────────────────────────────────────────────────
function showPairingScreen(code) {
    pairingCodeDisplay.textContent = code;
    pairingOverlay.classList.remove('hidden');
    loadingOverlay.classList.add('hidden');
    video.classList.add('hidden');
    image.classList.add('hidden');
    setIframeContent('about:blank');
    iframe.classList.remove('visible');
    if (playlistTimeout) { clearTimeout(playlistTimeout); playlistTimeout = null; }
}

// ─── Finalize Pairing ─────────────────────────────────────────────────────────
function finalizePairing(deviceId, record) {
    if (localStorage.getItem('pwa_device_id')) return; // Already done
    console.log('[PWA] Pairing confirmed!');
    localStorage.setItem('pwa_device_id', deviceId);
    if (record.group) localStorage.setItem('pwa_group_id', record.group);
    try { pb.collection('devices').unsubscribe(deviceId); } catch {}
    startContent(record);
}

// ─── Interaction Handler & Inactivity Timer ──────────────────────────────────────────────
// ─── Interaction Handler & Inactivity Timer ──────────────────────────────────────────────
let interactionTimestamp = 0;
let inactivityPoller = null;
let iframeFocusPoller = null; // New poller for detecting iframe clicks
const INACTIVITY_LIMIT_MS = 60000; // 60 seconds

// Create a focus sink to pull focus back from iframe
const focusSink = document.createElement('button');
focusSink.id = 'focusSink';
focusSink.style.cssText = 'position:absolute; top:-1000px; left:-1000px; opacity:0; pointer-events:none;';
document.body.appendChild(focusSink);

function markInteraction(event) {
    const now = Date.now();
    const eventType = event ? (event.type || 'unknown') : 'manual';
    console.log(`[PWA-Timer] Interaction detected (${eventType}). Timestamp reset.`);
    interactionTimestamp = now;
}

function stopInactivityPoller() {
    if (inactivityPoller) {
        clearInterval(inactivityPoller);
        inactivityPoller = null;
    }
    if (iframeFocusPoller) {
        clearInterval(iframeFocusPoller);
        iframeFocusPoller = null;
    }
}

function startInactivityPoller() {
    stopInactivityPoller();
    interactionTimestamp = Date.now();
    console.log(`[PWA-Timer] ACTIVATING ${INACTIVITY_LIMIT_MS/1000}s poller.`);
    
    inactivityPoller = setInterval(() => {
        // Stop checking if we are no longer in an interactive state (iframe OR intermediate image)
        const isInteractive = currentConfig && currentConfig.content_type === 'video_interactive' && overlay.classList.contains('hidden');
        
        if (!isInteractive) {
            console.log('[PWA-Timer] Stopping poller: No longer in interactive state.');
            stopInactivityPoller();
            return;
        }

        const elapsedMs = Date.now() - interactionTimestamp;
        const remainingS = Math.max(0, Math.ceil((INACTIVITY_LIMIT_MS - elapsedMs) / 1000));
        
        // Log every 10 seconds or when below 10 seconds
        if (remainingS % 10 === 0 || remainingS <= 10) {
            console.log(`[PWA-Timer] Inactivity check: ${remainingS}s remaining.`);
        }
        
        if (elapsedMs >= INACTIVITY_LIMIT_MS) {
            console.log('[PWA-Timer] !!! LIMIT EXCEEDED !!! Returning to video.');
            stopInactivityPoller();
            
            // Cleanly simulate pressing "Back" to pop the history state and restore video
            history.back();
            
            // Failsafe direct render just in case history is broken
            setTimeout(() => {
                if (overlay.classList.contains('hidden')) {
                    console.log('[PWA-Timer] Failsafe: history.back() might have failed, forcing renderContent.');
                    renderContent(currentConfig);
                }
            }, 500); 
        }
    }, 1000);

    // High frequency poller specifically for detecting when focus enters the iframe
    iframeFocusPoller = setInterval(() => {
        if (document.activeElement === iframe) {
            console.log('[PWA-Timer] Iframe focus detected via poller. Resetting timer & pulling focus back.');
            markInteraction({ type: 'iframe_poller' });
            
            // Steal focus back to our invisible sink so that the next click can be detected again
            focusSink.focus();
        }
    }, 250);
}

// Hook main window events to reset the timestamp
['touchstart', 'click'].forEach(evt => {
    window.addEventListener(evt, markInteraction, { passive: true, capture: true });
});

const handleInteraction = () => {
    if (!currentConfig || !pairingOverlay.classList.contains('hidden')) return;
    if (currentConfig.content_type !== 'video_interactive') return;
    
    // If iframe is already open, just mark interaction
    if (iframe.classList.contains('visible')) {
        markInteraction({ type: 'handleInteraction_call' });
        return;
    }

    // STATE 1: CLICK ON VIDEO -> SHOW INTERACTIVE IMAGE (if exists)
    if (!video.classList.contains('hidden')) {
        console.log('[PWA] Transition: Video -> Image');

        if (currentConfig.interactive_image_url) {
            history.pushState({ stage: 'image' }, '');
            interactiveImage.src = currentConfig.interactive_image_url;
            interactiveImage.classList.remove('hidden');
            video.classList.add('hidden');
            overlay.classList.add('hidden');
            video.pause();
            
            // Start the poller now as we are in interactive mode (intermediate image)
            startInactivityPoller();
            return;
        } 
        // If no image, fallthrough to Step 2 (open iframe directly)
    }

    // STATE 2: CLICK ON IMAGE (OR VIDEO IF NO IMAGE) -> OPEN IFRAME
    console.log('[PWA] Transition: Open Iframe');
    history.pushState({ stage: 'iframe' }, '');

    setIframeContent(currentConfig.redirect_url);
    iframe.classList.add('visible');
    
    // Hide everything else
    video.classList.add('hidden');
    interactiveImage.classList.add('hidden');
    overlay.classList.add('hidden');
    video.pause();
    if (playlistTimeout) { clearTimeout(playlistTimeout); playlistTimeout = null; }
    
    startInactivityPoller();
};

// Handle back button navigation
window.addEventListener('popstate', (event) => {
    console.log('[PWA] Back navigation detected.');
    stopInactivityPoller();
    
    // Simple logic: if anyone pressed back, we check what needs to be shown based on state
    // But since we use simple rendering, we just call renderContent which resets everything to idle
    // unless the state tells us otherwise.
    
    const state = event.state || {};
    
    if (state.stage === 'image') {
        // Return to the image state
        stopCurrentContent();
        interactiveImage.src = currentConfig.interactive_image_url;
        interactiveImage.classList.remove('hidden');
        startInactivityPoller();
    } else {
        // Return to the idle video state
        renderContent(currentConfig);
    }
});

app.addEventListener('click', handleInteraction);
// The 'touchstart' listener was causing double-firing (touchstart then click),
// making it skip the image state instantly when the user released their finger.
// Relying only on 'click' works for both mouse and touch without duplication.

// ─── Main Entry Point ─────────────────────────────────────────────────────────
async function checkDevicePairing() {
    const deviceId = localStorage.getItem('pwa_device_id');
    const groupId  = localStorage.getItem('pwa_group_id');

    // No device ID → start pairing flow
    if (!deviceId) {
        if (!navigator.onLine) {
            loadingOverlay.classList.add('hidden');
            pairingOverlay.classList.remove('hidden');
            pairingCodeDisplay.textContent = 'Sin conexión';
            return;
        }

        const code = generatePairingCode();
        console.log('[PWA] Starting pairing. Code:', code);

        try {
            const record = await pb.collection('devices').create({ pairing_code: code, is_registered: false });
            const newDeviceId = record.id;
            showPairingScreen(code);

            // Realtime listener for pairing
            pb.collection('devices').subscribe(newDeviceId, (e) => {
                if (e.record.is_registered) finalizePairing(newDeviceId, e.record);
            });

            // Polling fallback for pairing
            const poll = setInterval(async () => {
                try {
                    const r = await pb.collection('devices').getOne(newDeviceId);
                    if (r.is_registered) { clearInterval(poll); finalizePairing(newDeviceId, r); }
                } catch (err) {
                    if (err.status === 404) clearInterval(poll);
                }
            }, 5000);
        } catch (err) {
            console.error('[PWA] Failed to create device:', err);
            pairingCodeDisplay.textContent = 'ERROR';
        }
        return;
    }

    // Device ID exists → verify with server (persistent pairing)
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
            // Only clear pairing on explicit 404 (device deleted from backend)
            console.warn('[PWA] Device not found (404). Clearing and re-pairing.');
            localStorage.removeItem('pwa_device_id');
            localStorage.removeItem('pwa_group_id');
            localStorage.removeItem('pwa_last_config');
            localStorage.removeItem('pwa_last_playlist');
            checkDevicePairing();
        } else {
            // Network/timeout error → load from local storage, keep pairing
            console.warn('[PWA] Offline. Loading from cache. Error:', err.message || err);
            startContent({ id: deviceId, group: groupId });
        }
    }
}

// ─── Initialize ───────────────────────────────────────────────────────────────
document.addEventListener('DOMContentLoaded', () => {
    checkDevicePairing();
});
