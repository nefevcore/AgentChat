import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import Icons from 'unplugin-icons/vite';
import { fileURLToPath, URL } from 'node:url';

// ============================================================
// preview 轨测试配置（cr-491 M0.2）：与根配置解耦——不进根 ALL_TESTS
//（CI pnpm test 面零变化），preview 测试经 preview:* 脚本显式跑。
// setupFiles/globalSetup 不挂根 chdir/global 数据根：preview 单测全为
// 纯库用例，数据根由用例自指 preview/sandbox/（数据根隔离红线）。
// ============================================================
export default defineConfig({
  // 8.5b（cr-530）：ac-ui-app client 面测试 import 主线骨架行包（.vue 组件
  // 与 ~icons/* 虚拟模块）——与根 vitest 同款插件（preview 面独立配置自带）。
  plugins: [
    vue(),
    Icons({ compiler: 'vue3' }),
  ],
  resolve: {
    alias: {
      '@agentchat/protocol': fileURLToPath(new URL('../../src/webui/src/shims/@agentchat/protocol.ts', import.meta.url)),
      // virtual:row-clients（主线 bootGraph.ts 消费——ac-ui-app 不用，但主线
      // 骨架行包若经测试面级联引入则需解析面在）
      'virtual:row-clients': fileURLToPath(new URL('../../src/webui/src/runtime/virtual-row-clients.ts', import.meta.url)),
    },
  },
  test: {
    // jsdom 垫桩（matchMedia）须先于测试文件 import 链——8.5b 第二批起模块资产 re-export 模块级求值会触
    setupFiles: [fileURLToPath(new URL('./tests-setup.ts', import.meta.url))],
    include: [
      'preview/packages/*/tests/**/*.test.ts',
      'preview/apps/*/tests/**/*.test.ts',
    ],
    exclude: ['**/node_modules/**'],
    environment: 'node',
    testTimeout: 15000,
    hookTimeout: 15000,
  },
});
