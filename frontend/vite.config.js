import { defineConfig } from 'vite-plus'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import { TanStackRouterVite } from '@tanstack/router-plugin/vite'
import { VitePWA } from 'vite-plugin-pwa'

export default defineConfig({
  build: {
    chunkSizeWarningLimit: 1000,
    sourcemap: true,
  },
  plugins: [
    tailwindcss(),
    TanStackRouterVite({
      autoCodeSplitting: true,
      codeSplittingOptions: {
        defaultBehavior: [['component'], ['errorComponent'], ['notFoundComponent']],
      },
    }),
    react(),
    VitePWA({
      registerType: 'prompt',
      injectRegister: 'script-defer',
      manifest: {
        id: '/',
        scope: '/',
        name: 'RumaQ',
        short_name: 'RumaQ',
        description: 'Household shopping & inventory assistant',
        theme_color: '#f6f7f8',
        background_color: '#f6f7f8',
        display: 'standalone',
        start_url: '/',
        categories: ['shopping', 'productivity', 'utilities'],
        icons: [
          { src: '/icon-192x192.png', sizes: '192x192', type: 'image/png' },
          { src: '/icon-512x512.png', sizes: '512x512', type: 'image/png' },
          {
            src: '/icon-maskable-512x512.png',
            sizes: '512x512',
            type: 'image/png',
            purpose: 'maskable',
          },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,ico,png,svg,woff2}'],
        // Serve the app shell for navigations, online or not: a separate
        // offline fallback here would make EVERY hard navigation (direct URL,
        // refresh) show it once the SW is active. Offline UX is handled
        // in-app by the OfflineBanner.
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api\//],
        runtimeCaching: [
          {
            urlPattern: /^\/api\/(stock|plans|purchases)(\?.*)?$/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'rumaq-api-reads',
              expiration: {
                maxEntries: 50,
                maxAgeSeconds: 300,
              },
              cacheableResponse: {
                statuses: [0, 200],
              },
            },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': {
        target: 'http://localhost:8787',
        changeOrigin: true,
      },
    },
  },
  // No resolve.alias here: `virtual:pwa-register/react` must resolve to the
  // REAL vite-plugin-pwa module in builds so the PwaUpdatePrompt banner sees
  // actual service-worker state (the test-only mock alias lives in the root
  // vite.config.ts vitest project).
})
