import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue2';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
    },
  },
  // mqtt.js тянет несколько node-шных глобалов; в браузере их надо подменить.
  define: {
    global: 'globalThis',
  },
  server: {
    host: true,
    port: 5173,
  },
  build: {
    // Babylon импортируется целиком — так надёжнее, чем собирать список side-effect
    // импортов вручную. Для дев-инструмента размер бандла не критичен.
    chunkSizeWarningLimit: 8000,
  },
});
