import { defineConfig } from 'vite'
import { VitePWA } from 'vite-plugin-pwa'
import legacy from '@vitejs/plugin-legacy'

export default defineConfig({
    plugins: [
        legacy({
            targets: ['chrome 56'],
            additionalLegacyPolyfills: ['regenerator-runtime/runtime']
        }),
        VitePWA({
            registerType: 'autoUpdate',
            injectRegister: null, // Disable automatic registration (crashes Chrome 56)
            // Include assets to be copied to dist
            includeAssets: ['pwa-192x192.png', 'pwa-512x512.png', 'video.mp4'],
            manifest: {
                name: 'PWA Motorola Video Loop',
                short_name: 'MotorolaPWA',
                description: 'App para reproducción de video en loop y redirección',
                theme_color: '#000000',
                background_color: '#000000',
                display: 'fullscreen',
                orientation: 'portrait',
                icons: [
                    {
                        src: 'pwa-192x192.png',
                        sizes: '192x192',
                        type: 'image/png'
                    },
                    {
                        src: 'pwa-512x512.png',
                        sizes: '512x512',
                        type: 'image/png'
                    },
                    {
                        src: 'pwa-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'any'
                    },
                    {
                        src: 'pwa-512x512.png',
                        sizes: '512x512',
                        type: 'image/png',
                        purpose: 'maskable'
                    }
                ]
            }
        })
    ]
})
