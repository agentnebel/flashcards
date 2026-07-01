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
      includeAssets: ['icon.svg', 'icon-maskable.svg', 'apple-touch-icon.png', 'icon-192.png', 'icon-512.png', 'icon-maskable-512.png'],
      workbox: {
        // SPA-Deeplinks offline auf index.html zurückfallen lassen …
        navigateFallback: '/index.html',
        // … aber /api/* niemals cachen — geht immer ans Netzwerk (Sync/Auth/Media)
        navigateFallbackDenylist: [/^\/api\//],
        // .wasm einschließen: sql.js (~660 KB) wird für den .apkg-Import gebraucht und muss
        // offline verfügbar sein. Ohne dieses Muster bricht der Import ohne Netz ab.
        globPatterns: ['**/*.{js,css,html,svg,wasm,woff2,png,ico,json,webmanifest}'],
        // Standardgrenze (2 MiB) anheben, damit die WASM-Datei sicher mit-precacht wird.
        maximumFileSizeToCacheInBytes: 4 * 1024 * 1024,
        // Alte Workbox-Caches früherer Versionen beim Aktivieren des neuen SW entfernen.
        cleanupOutdatedCaches: true,
        clientsClaim: true,
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
        // "/" ist seit der Marketing-Landingpage nur noch der öffentliche Auftritt; die
        // installierte PWA soll direkt in die App (Deckliste) starten, nicht dort.
        start_url: '/app',
        scope: '/app',
        icons: [
          // PNG-Icons in festen Größen: von allen Plattformen (Android/Chrome/Desktop)
          // zuverlässig für die Installation akzeptiert.
          { src: '/icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any' },
          { src: '/icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any' },
          { src: '/icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
          // Skalierbares SVG zusätzlich für gestochen scharfe Darstellung.
          { src: '/icon.svg', sizes: 'any', type: 'image/svg+xml', purpose: 'any' },
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
