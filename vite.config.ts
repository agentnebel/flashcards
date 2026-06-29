import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

// Single-Worker + Static-Assets Deployment (wie dailydose):
// Vite baut nach ./dist, der Worker serviert dist als ASSETS und /api/* selbst.
export default defineConfig({
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['icon.svg', 'icon-maskable.svg'],
      workbox: {
        // SPA-Deeplinks offline auf index.html zurückfallen lassen …
        navigateFallback: '/index.html',
        // … aber /api/* niemals cachen — geht immer ans Netzwerk (Sync/Auth/Media)
        navigateFallbackDenylist: [/^\/api\//],
        globPatterns: ['**/*.{js,css,html,svg,woff2}'],
      },
      manifest: {
        name: 'Flashcards',
        short_name: 'Flashcards',
        description: 'Spaced-Repetition-Lernkarten mit FSRS',
        theme_color: '#ffffff',
        background_color: '#ffffff',
        display: 'standalone',
        display_override: ['standalone', 'minimal-ui'],
        categories: ['education', 'productivity'],
        start_url: '/',
        icons: [
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
          { src: '/icon-maskable.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'maskable' },
        ],
      },
    }),
  ],
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
  server: {
    proxy: {
      // Lokale Frontend-Dev gegen `wrangler dev` (Port 8787)
      '/api': 'http://localhost:8787',
    },
  },
});
