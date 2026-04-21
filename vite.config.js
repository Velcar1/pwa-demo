import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
    plugins: [
        VitePWA({
            registerType: 'autoUpdate',
            includeAssets: ['pwa-192x192.jpg', 'pwa-512x512.jpg', 'video.mp4'],
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
                theme_color: '#000000',
                background_color: '#000000',
                display: 'fullscreen',
                orientation: 'portrait',
                categories: ['productivity', 'utilities', 'business'],
                icons: [
                    {
                        src: 'pwa-192x192.jpg',
                        sizes: '192x192',
                        type: 'image/jpeg'
                    },
                    {
                        src: 'pwa-512x512.jpg',
                        sizes: '512x512',
                        type: 'image/jpeg'
                    },
                    {
                        src: 'pwa-512x512.jpg',
                        sizes: '512x512',
                        type: 'image/jpeg',
                        purpose: 'any'
                    },
                    {
                        src: 'pwa-512x512.jpg',
                        sizes: '512x512',
                        type: 'image/jpeg',
                        purpose: 'maskable'
                    }
                ]
            }
        })
    ]
})
