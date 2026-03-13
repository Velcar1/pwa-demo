import PocketBase from 'pocketbase';

// Configuration & Fallbacks
const PB_URL = import.meta.env.VITE_PB_URL || 'https://slots-institution-compact-gamma.trycloudflare.com/';
let REDIRECT_URL = 'https://d107qu3rkmrqtq.cloudfront.net/?device=taipei_row&sku=default&carrier=default&json=device.json';
let VIDEO_URL = '/video.mp4';

const pb = new PocketBase(PB_URL);
pb.autoCancellation(false);

// DOM Elements
const app = document.getElementById('app');
const video = document.getElementById('idleVideo');
const image = document.getElementById('displayImage');
const iframe = document.getElementById('contentFrame');
const overlay = document.getElementById('interactionOverlay');
const loadingOverlay = document.getElementById('loadingOverlay');
const pairingOverlay = document.getElementById('pairingOverlay');
const pairingCodeDisplay = document.getElementById('pairingCodeDisplay');

let currentConfig = null;

// 1. Generar un código aleatorio de 6 caracteres
function generatePairingCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Evitamos O, 0, I, 1 por confusión
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

let playlistItems = [];
let currentPlaylistItemIndex = 0;
let playlistTimeout = null;

async function fetchConfig(groupId) {
    if (!groupId) {
        console.warn('No group ID provided for fetchConfig');
        return null;
    }

    try {
        const records = await pb.collection('pwa_config').getFullList({
            filter: `group = "${groupId}"`,
            sort: '-created',
            expand: 'media,playlist'
        });

        if (records.length > 0) {
            // Evaluamos la configuración activa
            const now = new Date();
            let activeRecord = null;
            let baseRecord = null;

            for (const record of records) {
                if (record.is_schedule && record.schedule_start && record.schedule_end) {
                    const start = new Date(record.schedule_start);
                    const end = new Date(record.schedule_end);
                    if (now >= start && now <= end) {
                        activeRecord = record; // Encontramos un horario activo
                        break;
                    }
                } else if (!record.is_schedule) {
                    if (!baseRecord) baseRecord = record; // Guardamos la conf base
                }
            }

            const recordToUse = activeRecord || baseRecord;

            if (recordToUse) {
                console.log('Active Config determined:', recordToUse);
                currentConfig = recordToUse;

                // Pre-calculate URLs if not a playlist
                if (recordToUse.content_type !== 'playlist' && recordToUse.expand && recordToUse.expand.media) {
                    const mediaRecord = recordToUse.expand.media;
                    const fileUrl = pb.files.getURL(mediaRecord, mediaRecord.file);

                    if (recordToUse.content_type === 'video_interactive' || recordToUse.content_type === 'video_only') {
                        recordToUse.video_full_url = fileUrl;
                    } else if (recordToUse.content_type === 'image_only') {
                        recordToUse.image_full_url = fileUrl;
                    }
                }

                // If it's a playlist, fetch items
                if (recordToUse.content_type === 'playlist' && recordToUse.playlist) {
                    const items = await pb.collection('playlist_items').getFullList({
                        filter: `playlist = "${recordToUse.playlist}"`,
                        sort: 'sort_order',
                        expand: 'media'
                    });
                    playlistItems = items.map(item => ({
                        ...item,
                        full_url: pb.files.getURL(item.expand.media, item.expand.media.file)
                    }));
                    console.log('Playlist items fetched:', playlistItems);
                } else {
                    playlistItems = [];
                }

                return recordToUse;
            }
        }
    } catch (error) {
        console.warn('Failed to fetch from PocketBase, using fallbacks:', error);
    }
    return null;
}

const handleInteraction = () => {
    if (!currentConfig || !pairingOverlay.classList.contains('hidden')) return;

    // Only video_interactive reacts to touch/click by showing the iframe
    if (currentConfig.content_type === 'video_interactive') {
        console.log('Interaction detected, loading frame...');
        iframe.src = currentConfig.redirect_url;
        iframe.classList.add('visible');
        video.classList.add('hidden');
        overlay.classList.add('hidden');

        // If we were in a playlist, stop the timer
        if (playlistTimeout) {
            clearTimeout(playlistTimeout);
            playlistTimeout = null;
        }
    }
};

// Add listeners for touch and click
app.addEventListener('click', handleInteraction);
app.addEventListener('touchstart', handleInteraction, { passive: true });

function showPairingScreen(code) {
    pairingCodeDisplay.textContent = code;
    pairingOverlay.classList.remove('hidden');

    // Ocultar los otros elementos
    loadingOverlay.classList.add('hidden');
    video.classList.add('hidden');
    image.classList.add('hidden');
    iframe.classList.remove('visible');

    if (playlistTimeout) {
        clearTimeout(playlistTimeout);
        playlistTimeout = null;
    }
}

async function startContent(device) {
    console.log("¡Dispositivo vinculado!", device ? device.name : "Local");

    pairingOverlay.classList.add('hidden');
    loadingOverlay.classList.remove('hidden');
    loadingOverlay.style.opacity = '1';

    const groupId = device.group || localStorage.getItem('pwa_group_id');

    // Initial fetch
    await updateContentFromConfig(groupId);

    // Subscribe to future changes in pwa_config for this group
    subscribeToConfigChanges(groupId);

    // Polling fallback for config updates
    // If Realtime is unstable, this ensures content still updates
    setInterval(() => {
        console.log("Checking for content updates (scheduled check)...");
        updateContentFromConfig(groupId);
    }, 45000); // Check every 45s as safety net
}

async function updateContentFromConfig(groupId) {
    const config = await fetchConfig(groupId);
    if (!config) return;

    currentPlaylistItemIndex = 0; // Reset index on config change
    renderContent(config);

    // Hide loading if it was visible
    loadingOverlay.style.opacity = '0';
    setTimeout(() => {
        loadingOverlay.classList.add('hidden');
    }, 500);
}

function renderContent(config) {
    const type = config.content_type || 'video_interactive';

    // Reset visibility and timers
    video.classList.add('hidden');
    image.classList.add('hidden');
    iframe.classList.remove('visible');
    overlay.classList.add('hidden');
    video.pause();
    if (playlistTimeout) {
        clearTimeout(playlistTimeout);
        playlistTimeout = null;
    }

    if (type === 'playlist') {
        renderPlaylistItem();
    } else if (type === 'video_interactive' || type === 'video_only') {
        const source = video.querySelector('source');
        if (source && config.video_full_url) {
            if (source.src !== config.video_full_url) {
                source.src = config.video_full_url;
                video.load();
            }
            video.loop = true; // Loop for single video mode
            video.onended = null;
            video.play().then(() => {
                video.classList.remove('hidden');
                if (type === 'video_interactive') overlay.classList.remove('hidden');
            }).catch(e => {
                console.warn("Video play failed:", e);
                video.classList.remove('hidden');
            });
        }
    } else if (type === 'image_only') {
        if (config.image_full_url) {
            image.src = config.image_full_url;
            image.classList.remove('hidden');
        }
    } else if (type === 'web_only') {
        if (config.redirect_url) {
            if (iframe.src !== config.redirect_url) {
                iframe.src = config.redirect_url;
            }
            iframe.classList.add('visible');
        }
    }
}

function renderPlaylistItem() {
    if (playlistItems.length === 0) {
        console.warn('Playlist is empty');
        return;
    }

    const item = playlistItems[currentPlaylistItemIndex];
    const isVideo = item.full_url.toLowerCase().endsWith('.mp4');

    // Hide previous
    video.classList.add('hidden');
    image.classList.add('hidden');
    video.pause();

    if (isVideo) {
        const source = video.querySelector('source');
        if (source && source.src !== item.full_url) {
            source.src = item.full_url;
            video.load();
        }
        video.loop = false; // Don't loop in playlist mode
        video.onended = nextPlaylistItem;
        video.play().then(() => {
            video.classList.remove('hidden');
        }).catch(e => {
            console.error('Video play error in playlist:', e);
            nextPlaylistItem(); // Skip on error
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

function subscribeToConfigChanges(groupId) {
    // Attempt to subscribe. We catch errors silently to avoid console noise
    // since the polling fallback is already active.
    pb.collection('pwa_config').subscribe('*', (e) => {
        if ((e.action === 'update' || e.action === 'create') && e.record.group === groupId) {
            console.log("Content update detected via Realtime!");
            updateContentFromConfig(groupId);
        }
    }).catch(err => {
        // Silencing non-critical errors typical of Cloudflare Tunnels/timeouts
        if (err.isAbort) return; 
        console.info("Realtime config sync unavailable. Polling fallback is active.");
    });
}

async function checkDevicePairing() {
    // Revisar si ya estamos registrados localmente
    let deviceId = localStorage.getItem('pwa_device_id');
    let groupId = localStorage.getItem('pwa_group_id');

    if (!deviceId) {
        // --- PROCESO DE VINCULACIÓN NUEVA ---
        const code = generatePairingCode();
        console.log("Generando nuevo código de vinculación:", code);

        try {
            // Crear el registro en PocketBase
            const record = await pb.collection('devices').create({
                pairing_code: code,
                is_registered: false
            });

            deviceId = record.id;
            console.log("Registro creado en PocketBase con ID:", deviceId);

            // Mostrar el código en pantalla al usuario
            showPairingScreen(code);

            // 1. Suscribirse en tiempo real (SSE)
            pb.collection('devices').subscribe(deviceId, (e) => {
                console.log("Evento recibido vía Realtime:", e.action);
                if (e.record.is_registered) {
                    finalizePairing(deviceId, e.record);
                }
            });

            // 2. FALLBACK: Polling (Consultar cada 5 segundos por si falla Realtime)
            const pollingInterval = setInterval(async () => {
                try {
                    console.log("Verificando estado vía Polling...");
                    const checkRecord = await pb.collection('devices').getOne(deviceId);
                    if (checkRecord.is_registered) {
                        clearInterval(pollingInterval);
                        finalizePairing(deviceId, checkRecord);
                    }
                } catch (err) {
                    // Si el registro ya fue borrado o hay error, paramos polling
                    if (err.status === 404) clearInterval(pollingInterval);
                    console.warn("Error en polling:", err);
                }
            }, 5000);

        } catch (err) {
            console.error("Error al crear registro de dispositivo:", err);
            // Mostrar mensaje de error en la UI de ser posible
            pairingCodeDisplay.textContent = "ERROR";
            pairingCodeDisplay.style.color = "red";
        }

        return;
    }

    // --- DISPOSITIVO YA REGISTRADO ---
    try {
        const device = await pb.collection('devices').getOne(deviceId);
        if (device.is_registered) {
            startContent(device);
            subscribeToDeviceChanges(deviceId);
        } else {
            // Si por alguna razón fue desvinculado desde el dashboard (is_registered = false)
            localStorage.removeItem('pwa_device_id');
            checkDevicePairing();
        }
    } catch (err) {
        // Manejar error (ej: si el registro fue borrado en PocketBase)
        console.warn("Dispositivo no encontrado o error de conexión, solicitando nueva vinculación.", err);
        localStorage.removeItem('pwa_device_id');
        checkDevicePairing();
    }
}

function finalizePairing(deviceId, record) {
    if (localStorage.getItem('pwa_device_id')) return; // Ya finalizado

    console.log("¡Vinculación confirmada!");
    localStorage.setItem('pwa_device_id', deviceId);
    if (record.group) {
        localStorage.setItem('pwa_group_id', record.group);
    }

    try {
        pb.collection('devices').unsubscribe(deviceId);
    } catch (e) { }

    startContent(record);
    subscribeToDeviceChanges(deviceId);
}

function subscribeToDeviceChanges(deviceId) {
    // Escuchar cambios para saber si nos desvinculan
    pb.collection('devices').subscribe(deviceId, (e) => {
        if (e.action === 'delete' || (e.action === 'update' && !e.record.is_registered)) {
            console.log("El dispositivo ha sido desvinculado remotamente.");
            localStorage.removeItem('pwa_device_id');
            localStorage.removeItem('pwa_group_id');

            // Limpiar todo y volver a pantalla de vinculación
            video.pause();
            video.classList.add('hidden');
            image.classList.add('hidden');
            iframe.src = 'about:blank';
            iframe.classList.remove('visible');
            overlay.classList.remove('hidden'); 

            // Evitar duplicar suscripciones
            try { pb.collection('devices').unsubscribe(deviceId); } catch(ex) {}

            checkDevicePairing();
        }
    }).catch(err => {
        if (err.isAbort) return;
        console.info("Realtime device tracking unavailable. Status will be checked on reload.");
    });
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    checkDevicePairing();
});
