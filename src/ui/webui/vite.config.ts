import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Icons from 'unplugin-icons/vite';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';

const rootDir = fileURLToPath(new URL('.', import.meta.url));

export default defineConfig({
  plugins: [vue(), Icons({ compiler: 'vue3' })],
  resolve: {
    alias: {
      '@': fileURLToPath(new URL('./src', import.meta.url)),
      // src/ui/webui → 仓库根 src/shared
      '@shared': fileURLToPath(new URL('../../shared', import.meta.url)),
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
    rollupOptions: {
      input: {
        main: path.resolve(rootDir, 'index.html'),
        // P5.5 iframe isolated 档运行时（sandbox 插件容器）
        'ui-plugin-iframe': path.resolve(rootDir, 'ui-plugin-iframe.html'),
      },
      output: {
        // 拆分 vendor chunk：框架/渲染/图表/编辑相关独立成块，长缓存 + 并行加载
        manualChunks: {
          vue: ['vue', 'pinia'],
          markdown: ['markdown-it', 'markdown-it-texmath', 'katex', 'highlight.js'],
          chart: ['chart.js', 'd3-chord'],
        },
      },
    },
  },
});
