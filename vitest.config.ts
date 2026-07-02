import { defineConfig } from 'vitest/config';

// Eigene Vitest-Config (statt vite.config.ts zu erweitern), damit die Tests ohne
// PWA-/React-Plugins laufen. jsdom: DOMPurify (sanitize.ts) braucht ein DOM.
export default defineConfig({
  test: {
    environment: 'jsdom',
    include: ['src/**/*.test.ts'],
  },
});
