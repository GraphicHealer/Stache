import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg'],
      manifest: {
        name: 'Stash',
        short_name: 'Stash',
        description: 'Where is my stuff?',
        theme_color: '#111318',
        background_color: '#111318',
        display: 'standalone',
        start_url: '/',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png,ico,woff2}'],
        navigateFallback: '/index.html',
        navigateFallbackDenylist: [/^\/api/, /^\/photos/],
        runtimeCaching: [
          {
            urlPattern: /\/photos\/.*/,
            handler: 'CacheFirst',
            options: {
              cacheName: 'stash-photos',
              expiration: { maxEntries: 2000, maxAgeSeconds: 60 * 60 * 24 * 90 },
            },
          },
          {
            // Auth must never be cached — a stale session check would lie.
            urlPattern: /\/api\/(auth|me|setup|users)\b.*/,
            handler: 'NetworkOnly',
          },
          {
            urlPattern: /\/api\/.*/,
            handler: 'NetworkFirst',
            options: {
              cacheName: 'stash-api',
              networkTimeoutSeconds: 4,
              expiration: { maxEntries: 500, maxAgeSeconds: 60 * 60 * 24 * 30 },
            },
          },
        ],
      },
    }),
  ],
  server: {
    proxy: {
      '/api': 'http://localhost:8080',
      '/photos': 'http://localhost:8080',
    },
  },
});
