// ============================================================
// vite.config.ts —— preview WebUI 构建配置（同源迁移，阶段一）
//
//   · dev：vite 3831 + proxy → 3830（HTTP /api、/ui-plugin 与 WS /ws；生产同源）
//   · build：双入口（主应用 + ui-plugin-iframe isolated 档运行时）；
//     dist 由 ac-web-server staticDir 托管 + SPA fallback
//   · @agentchat/protocol → 本地自包含垫片（src UI 零改动；类型 +
//     isBackgroundRunSource 唯一运行时值，见 src/shims/）
//   · rowClientsPlugin（M27 S3/D7）：扫 src/ac-*/client/index.ts 行
//     client 半边 → virtual:row-clients 模块（行名 → () => import
//     静态映射——dev 直服源码 / prod 构建为行 client 模块块）
// ============================================================
import { defineConfig, type Plugin } from 'vite';
import vue from '@vitejs/plugin-vue';
import Icons from 'unplugin-icons/vite';
import { existsSync, readdirSync } from 'node:fs';
import { fileURLToPath, URL } from 'node:url';
import path from 'node:path';

const rootDir = fileURLToPath(new URL('.', import.meta.url));
const srcRoot = path.resolve(rootDir, '..');

// 行 client 半边发现：src 下各 ac- 前缀包的 client/index.ts
//（包名 → 稳定行名 = 去 ac- 前缀、去 -client 后缀）
function discoverRowClients(): Array<{ name: string; entry: string }> {
  const out: Array<{ name: string; entry: string }> = [];
  for (const dir of readdirSync(srcRoot, { withFileTypes: true })) {
    if (!dir.isDirectory() || !dir.name.startsWith('ac-')) continue;
    const entry = path.join(srcRoot, dir.name, 'client', 'index.ts');
    if (!existsSync(entry)) continue;
    out.push({ name: dir.name.replace(/^ac-client-/, '').replace(/^ac-/, ''), entry });
  }
  return out.sort((a, b) => a.name.localeCompare(b.name));
}

const VIRTUAL_ID = 'virtual:row-clients';

/** virtual:row-clients 生成（dev 与 build 同一映射——prod 时行模块成为独立 chunk） */
function rowClientsPlugin(): Plugin {
  const rows = discoverRowClients();
  const code = [
    `// 自动生成（vite rowClientsPlugin——M27 S3 boot graph 静态映射）`,
    `export const rowClientLoaders = {`,
    ...rows.map((r) => `  ${JSON.stringify(r.name)}: () => import(${JSON.stringify(r.entry)}),`),
    `};`,
  ].join('\n');
  return {
    name: 'agentchat-row-clients',
    resolveId(id) {
      if (id === VIRTUAL_ID) return '\0' + VIRTUAL_ID;
      return undefined;
    },
    load(id) {
      if (id === '\0' + VIRTUAL_ID) return code;
      return undefined;
    },
  };
}

export default defineConfig({
  plugins: [vue(), Icons({ compiler: 'vue3' }), rowClientsPlugin()],
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
        // 拆分 vendor chunk：框架独立成块（长缓存 + 并行加载）。
        // katex / markdown-it-texmath / 冷门 hljs 语言刻意【不列入】——
        // 它们在源码里走动态 import，rollup 自动拆为独立块；一旦写进本表
        // 就会被强制并入静态块，按需加载随之失效（见 useMarkdown/hljs-languages）。
        manualChunks(id) {
          // @vue-office 三包（OfficeView 动态 import）：命名各自成块——
          // 既保持按需加载（函数式只归并命中模块，不引入静态依赖），
          // 又让构建产物可读（此前 rollup 默认命名为 index-<hash>，
          // 1.6MB 的 xlsx 解析器块无法辨认）。
          const office = id.match(/[\\/]node_modules[\\/]@vue-office[\\/](docx|excel|pptx)[\\/]/);
          if (office) return `office-${office[1]}`;
          if (id.includes('node_modules/vue/') || id.includes('node_modules/pinia/')) return 'vue';
          if (id.includes('node_modules/markdown-it/')) return 'markdown';
          return undefined;
        },
      },
    },
  },
});
