// Configuration
const REDIRECT_URL = 'https://d107qu3rkmrqtq.cloudfront.net/?device=taipei_row&sku=default&carrier=default&json=device.json';

const app = document.getElementById('app');
const video = document.getElementById('idleVideo');
const iframe = document.getElementById('contentFrame');
const overlay = document.getElementById('interactionOverlay');

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

// Ensure video plays (some browsers require interaction, but muted should work)
document.addEventListener('DOMContentLoaded', () => {
    video.play().catch(error => {
        console.warn('Auto-play was prevented. Waiting for first interaction to play if needed.', error);
    });
});
