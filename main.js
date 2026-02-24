import PocketBase from 'pocketbase';

// Configuration & Fallbacks
const PB_URL = 'https://pretty-provider-inline-lesson.trycloudflare.com/';
let REDIRECT_URL = 'https://d107qu3rkmrqtq.cloudfront.net/?device=taipei_row&sku=default&carrier=default&json=device.json';
let VIDEO_URL = '/video.mp4';

const pb = new PocketBase(PB_URL);

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

async function fetchConfig() {
    try {
        // Fetch the latest config from PocketBase
        const record = await pb.collection('pwa_config').getFirstListItem('', {
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

    // 1. Fetch dynamic config
    await fetchConfig();

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

async function checkDevicePairing() {
    // Revisar si ya estamos registrados localmente
    let deviceId = localStorage.getItem('pwa_device_id');

    if (!deviceId) {
        // --- PROCESO DE VINCULACIÓN NUEVA ---
        const code = generatePairingCode();

        try {
            // Crear el registro en PocketBase
            const record = await pb.collection('devices').create({
                pairing_code: code,
                is_registered: false
                // name is opcional
            });

            // Guardar el ID del registro temporalmente en memoria, 
            // no en localStorage hasta que esté autorizado
            deviceId = record.id;

            // Mostrar el código en pantalla al usuario
            showPairingScreen(code);

            // Suscribirse en tiempo real para saber cuándo nos autorizan en el Dashboard
            pb.collection('devices').subscribe(deviceId, (e) => {
                if (e.record.is_registered) {
                    localStorage.setItem('pwa_device_id', deviceId);
                    pb.collection('devices').unsubscribe(deviceId); // ya no necesitamos escuchar esto especificamente
                    startContent(e.record); // Iniciar la PWA

                    // Suscribirse a los cambios globales del dispositivo para desvincular
                    subscribeToDeviceChanges(deviceId);
                }
            });
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

function subscribeToDeviceChanges(deviceId) {
    // Escuchar cambios para saber si nos desvinculan (is_registered pasa a false o se borra el registro)
    pb.collection('devices').subscribe(deviceId, (e) => {
        if (e.action === 'delete' || (e.action === 'update' && !e.record.is_registered)) {
            console.log("El dispositivo ha sido desvinculado remotamente.");
            localStorage.removeItem('pwa_device_id');

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
