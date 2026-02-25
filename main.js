import PocketBase from 'pocketbase';

// Configuration & Fallbacks
const PB_URL = 'https://pretty-provider-inline-lesson.trycloudflare.com/';
let REDIRECT_URL = 'https://d107qu3rkmrqtq.cloudfront.net/?device=taipei_row&sku=default&carrier=default&json=device.json';
let VIDEO_URL = '/video.mp4';

const pb = new PocketBase(PB_URL);
pb.autoCancellation(false);

// DOM Elements
const app = document.getElementById('app');
const video = document.getElementById('idleVideo');
const iframe = document.getElementById('contentFrame');
const overlay = document.getElementById('interactionOverlay');
const loadingOverlay = document.getElementById('loadingOverlay');
const pairingOverlay = document.getElementById('pairingOverlay');
const pairingCodeDisplay = document.getElementById('pairingCodeDisplay');

// 1. Generar un código aleatorio de 6 caracteres
function generatePairingCode() {
    const chars = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789'; // Evitamos O, 0, I, 1 por confusión
    let result = '';
    for (let i = 0; i < 6; i++) {
        result += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return result;
}

async function fetchConfig(groupId) {
    if (!groupId) {
        console.warn('No group ID provided for fetchConfig');
        return;
    }

    try {
        // Fetch the latest config from PocketBase for the specific group
        const record = await pb.collection('pwa_config').getFirstListItem(`group = "${groupId}"`, {
            sort: '-created',
        });

        if (record) {
            console.log('Config fetched from PocketBase:', record);

            // Update URLs from PocketBase
            if (record.redirect_url) REDIRECT_URL = record.redirect_url;

            if (record.video_url) {
                if (record.video_url.startsWith('http')) {
                    VIDEO_URL = record.video_url;
                } else {
                    VIDEO_URL = pb.files.getURL(record, record.video_url);
                }

                // Update video source
                const source = video.querySelector('source');
                if (source) {
                    source.src = VIDEO_URL;
                    video.load(); // Reload video with new source
                }
            }
        }
    } catch (error) {
        console.warn('Failed to fetch from PocketBase, using fallbacks:', error);
    }
}

const handleInteraction = () => {
    // Only handle interaction if we are not in the pairing screen
    if (!pairingOverlay.classList.contains('hidden')) return;

    console.log('Interaction detected, loading frame...');

    // Set source and show iframe
    iframe.src = REDIRECT_URL;
    iframe.classList.add('visible');

    // Hide video and overlay
    video.classList.add('hidden');
    overlay.classList.add('hidden');
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
    iframe.classList.remove('visible');
}

async function startContent(device) {
    console.log("¡Dispositivo vinculado!", device ? device.name : "Local");

    // Ocultar pantalla de vinculación
    pairingOverlay.classList.add('hidden');

    // Mostrar loading
    loadingOverlay.classList.remove('hidden');
    loadingOverlay.style.opacity = '1';

    // 1. Fetch dynamic config using the device's group ID
    const groupId = device.group || localStorage.getItem('pwa_group_id');
    await fetchConfig(groupId);

    // 2. Play video
    try {
        await video.play();
        // 3. Hide loading only after video playback starts successfully
        video.classList.remove('hidden');
        loadingOverlay.style.opacity = '0';
        setTimeout(() => {
            loadingOverlay.classList.add('hidden');
        }, 500);
    } catch (error) {
        console.warn('Auto-play was prevented or failed. Waiting for first interaction to play if needed.', error);
        // Still hide loading so user can interact to play
        video.classList.remove('hidden');
        loadingOverlay.classList.add('hidden');
    }
}

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
    // Escuchar cambios para saber si nos desvinculan (is_registered pasa a false o se borra el registro)
    pb.collection('devices').subscribe(deviceId, (e) => {
        if (e.action === 'delete' || (e.action === 'update' && !e.record.is_registered)) {
            console.log("El dispositivo ha sido desvinculado remotamente.");
            localStorage.removeItem('pwa_device_id');
            localStorage.removeItem('pwa_group_id');

            // Limpiar todo y volver a pantalla de vinculación
            video.pause();
            video.classList.add('hidden');
            iframe.src = 'about:blank';
            iframe.classList.remove('visible');
            overlay.classList.remove('hidden'); // Restaurar para el proximo inicio

            // Evitar duplicar suscripciones
            pb.collection('devices').unsubscribe(deviceId);

            checkDevicePairing();
        }
    }).catch(err => {
        console.warn("No se pudo suscribir a cambios del dispositivo", err);
    });
}

// Initialize
document.addEventListener('DOMContentLoaded', () => {
    checkDevicePairing();
});
