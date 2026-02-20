// Configuration
const REDIRECT_URL = 'https://www.google.com'; // Change this to your target URL

const app = document.getElementById('app');
const video = document.getElementById('idleVideo');

const handleInteraction = () => {
    console.log('Interaction detected, redirecting...');
    window.location.href = REDIRECT_URL;
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
