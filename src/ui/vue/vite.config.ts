import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      '@shared': fileURLToPath(new URL('../../../shared', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 3831,
    proxy: {
      '/api': 'http://localhost:3830',
      '/ws': {
        target: 'ws://localhost:3830',
        ws: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    emptyOutDir: true,
  },
});
