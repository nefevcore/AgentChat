// ============================================================
// vite.config.ts —— apps/ui 树构建面（8.5e）
//
// 与主线 apps/ui/vite.config.ts 的差异（preview 形态定向）：
//   · dev proxy → 宿主缺省 3830（8.9 cutover cr-556——正式端口，dev.ts
//     独立联调面仍 3840，两者经 --port 区分）；
//   · 单入口（preview 无 iframe isolated 档——isolated 接线归后续批）；
//   · 通道条目不在本入口构建图内（channel/ 经 build-channel.mjs 独立
//     构建，产物落 pluginsDir——运行时 boot graph 动态装载）；
//   · chrome92 降级同主线（esbuild supported 声明 + target；Windows
//     esbuild renderChunk 临时文件 Access denied 规避——8.5b 遗留项）。
// ============================================================
import { defineConfig } from 'vite';
import vue from '@vitejs/plugin-vue';
import Icons from 'unplugin-icons/vite';
import { fileURLToPath, URL } from 'node:url';

export default defineConfig({
  plugins: [vue(), Icons({ compiler: 'vue3' })],
  // class static block 显式声明不支持（主线同款——vendor/cordis 静态块在
  // WebView 92 报 SyntaxError 的实测根因）
  esbuild: { supported: { 'class-static-blocks': false } },
  resolve: {
    alias: {
      '@agentchat/protocol': fileURLToPath(new URL('./src/shims/@agentchat/protocol.ts', import.meta.url)),
    },
  },
  server: {
    host: true,
    port: 3841,
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
    target: 'chrome92',
    rollupOptions: {
      input: {
        main: fileURLToPath(new URL('./index.html', import.meta.url)),
        // iframe isolated 档运行时（sandbox 插件容器——8.5 收尾批接线）
        'ui-plugin-iframe': fileURLToPath(new URL('./ui-plugin-iframe.html', import.meta.url)),
      },
      output: {
        manualChunks(id) {
          if (id.includes('node_modules/vue/') || id.includes('node_modules/pinia/')) return 'vue';
          if (id.includes('node_modules/markdown-it/')) return 'markdown';
          return undefined;
        },
      },
    },
  },
});
