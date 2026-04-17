// ─── Forzar tamaño estricto de pantalla para matar el bug de Chrome Android ───
function flushViewport() {
    const vh = window.innerHeight;
    document.documentElement.style.height = `${vh}px`;
    document.body.style.height = `${vh}px`;
    const app = document.getElementById('app');
    if (app) app.style.height = `${vh}px`;
    window.scrollTo(0, 0);
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState === 'visible') {
        setTimeout(flushViewport, 50);
        setTimeout(flushViewport, 300);
    }
});
window.addEventListener('resize', flushViewport);
document.addEventListener('DOMContentLoaded', flushViewport);
