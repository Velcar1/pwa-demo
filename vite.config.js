import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
    plugins: [
        VitePWA({
            registerType: 'autoUpdate',
            includeAssets: ['pwa-192x192.png', 'pwa-512x512.png', 'pwa-icon-192x192.png', 'pwa-icon-512x512.png', 'video.mp4'],
            workbox: {
                globPatterns: ['**/*.{js,css,html,ico,png,svg,webmanifest}'],
                runtimeCaching: [
                    {
                        urlPattern: /^https:\/\/.*\/api\/files\/.*/i,
                        handler: 'CacheFirst',
                        options: {
                            cacheName: 'pwa-media-v1',
                            expiration: {
                                maxEntries: 50,
                                maxAgeSeconds: 30 * 24 * 60 * 60, // 30 days
                            },
                            cacheableResponse: {
                                statuses: [0, 200],
                            },
                        },
                    },
                ],
            },
            manifest: {
                id: 'com.linx.pwa.motorola',
                name: 'PWA Motorola Video Loop',
                short_name: 'MotorolaPWA',
                description: 'App para reproducción de video en loop y redirección',
                start_url: '/',
                theme_color: '#ffffff',
                background_color: '#ffffff',
                display: 'fullscreen',
                display_override: ['fullscreen', 'standalone', 'minimal-ui'],
                orientation: 'portrait',
                categories: ['productivity', 'utilities', 'business'],
                icons: [
                    {
                        src: 'pwa-icon-192x192.png',
                        sizes: '192x192',
                        type: 'image/png',
                        purpose: 'maskable any'
                    },
                    {
                        src: 'pwa-icon-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'maskable any'
                    },
                    {
                        src: 'pwa-192x192.png',
                        sizes: '192x192',
                        type: 'image/png',
                        purpose: 'any'
                    },
                    {
                        src: 'pwa-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'any'
                    }
                ]
            }
        })
    ]
})
