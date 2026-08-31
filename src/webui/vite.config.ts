// ============================================================
// vite.config.ts —— preview WebUI 构建配置（同源迁移，阶段一）
//
//   · dev：vite 3831 + proxy → 3830（HTTP /api、/ui-plugin 与 WS /ws；生产同源）
//   · build：双入口（主应用 + ui-plugin-iframe isolated 档运行时）；
//     dist 由 ac-web-server staticDir 托管 + SPA fallback
//   · @agentchat/protocol → 本地自包含垫片（src UI 零改动；类型 +
//     isBackgroundRunSource 唯一运行时值，见 src/shims/）
// ============================================================
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
      '@agentchat/protocol': fileURLToPath(new URL('./src/shims/@agentchat/protocol.ts', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 3831,
    proxy: {
      '/api': 'http://localhost:3830',
      '/ui-plugin': 'http://localhost:3830',
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
