import PocketBase from 'pocketbase';

// Configuration & Fallbacks
const PB_URL = 'https://pretty-provider-inline-lesson.trycloudflare.com/';
let REDIRECT_URL = 'https://d107qu3rkmrqtq.cloudfront.net/?device=taipei_row&sku=default&carrier=default&json=device.json';
let VIDEO_URL = '/video.mp4';

const pb = new PocketBase(PB_URL);

const app = document.getElementById('app');
const video = document.getElementById('idleVideo');
const iframe = document.getElementById('contentFrame');
const overlay = document.getElementById('interactionOverlay');
const loadingOverlay = document.getElementById('loadingOverlay');

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

            // If video_url is a file field in PB, we need to get the file URL
            // If it's a plain text URL, we use it directly.
            // Following assumes it might be a file or a URL string.
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

// Initialize
document.addEventListener('DOMContentLoaded', async () => {
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
});
