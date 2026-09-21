import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import Icons from 'unplugin-icons/vite';
import { fileURLToPath, URL } from 'node:url';

// ============================================================
// 测试分档（2026-01 梳理）：277 个测试文件里 37 个（79% 的执行时长）是
// 真起进程/服务器/整树 boot 的集成测试——它们与 216 个亚秒级纯逻辑用例
// 混在同一批次里，导致本地每次反馈都要付全量代价。
//   · 约定：慢用例文件名带 .integration.test.ts（与 vitest include 的
//     *.test.ts 天然兼容，无需登记清单，新用例作者自行归类）。
//   · 档位经 VITEST_PROFILE 选择：unit（快循环）/ integration（限流跑）
//     / 未设（全量，等价改造前行为）。由 scripts/run-tests.mjs 编排。
// ============================================================
const PROFILE = process.env.VITEST_PROFILE ?? 'all'; // 'all' = 不加 include/exclude 过滤
const ALL_TESTS = 'src/**/tests/**/*.test.ts';
const INTEGRATION_TESTS = 'src/**/tests/**/*.integration.test.ts';

export default defineConfig({
  plugins: [
    // webui 前端测试可 import .vue 组件与 ~icons/* 虚拟模块（SlotOutlet/
    // AppFrame 等 M27 slot 面；不触及它们的包测试不受影响）
    vue(),
    Icons({ compiler: 'vue3' }),
  ],
  resolve: {
    alias: {
      // webui 前端测试的 @ 别名（与 webui/vite.config.ts 同源映射；
      // 后端包测试不使用 @，无碰撞）
      '@': fileURLToPath(new URL('./src/webui/src', import.meta.url)),
      // 同源迁移：@agentchat/protocol → 自包含垫片（与 webui/vite.config.ts
      // 及 webui/tsconfig.json paths 三处同源映射）
      '@agentchat/protocol': fileURLToPath(new URL('./src/webui/src/shims/@agentchat/protocol.ts', import.meta.url)),
      // virtual:row-clients（boot graph 静态映射——测试用注入口垫片，
      // 生产由 webui vite 插件生成真实映射）
      'virtual:row-clients': fileURLToPath(new URL('./src/webui/src/runtime/virtual-row-clients.ts', import.meta.url)),
      // electron → 桌面壳测试垫片（desktop-bridge.test.ts 驱动 main.mjs 用；
      // 仅测试态生效：生产桌面打包走 electron-builder，不经 vitest resolver）
      electron: fileURLToPath(new URL('./desktop/tests-support/electron-shim.mjs', import.meta.url)),
    },
  },
  test: {
    // unit 档只排集成文件；integration 档只排集成文件；all 档两者皆含
    include: PROFILE === 'integration' ? [INTEGRATION_TESTS] : [ALL_TESTS],
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      ...(PROFILE === 'unit' ? [INTEGRATION_TESTS] : []),
    ],
    environment: 'node',
    // 仓库根锚点（env 序列化进各 worker——jsdom 等浏览器环境下 setup 文件
    // 的 import.meta.url/URL 全局不可靠，见 scripts/vitest-setup-chdir.mjs）
    env: {
      AGENTCHAT_REPO_ROOT: fileURLToPath(new URL('./', import.meta.url)),
    },
    // 测试数据根集中管理：setupFiles 把测试进程 chdir 到 workspace/test——
    // 一切 './data' 缺省解析随之落位（不再写仓库 data/）；globalSetup 每轮
    // 清空。刻意不设 AGENTCHAT_DATA_ROOT：ac-group/ac-conversation 的
    // "env 未设 = 纯内存态"语义是多数单测的隐含前提
    setupFiles: ['./scripts/vitest-setup-chdir.mjs'],
    globalSetup: ['./scripts/vitest-global-setup.mjs'],
    // 凭据加密（PBKDF2 600k 迭代）与磁盘 IO 在全量并行下较慢；冷启动 transform 也耗时
    testTimeout: 15000,
    hookTimeout: 15000,
    // 集成档限流：这些用例真起子进程/HTTP 服务器/整树 boot——并发过高会
    // 互相挤占（观察到的形态：子进程冷启动被拖过就绪窗口 → ECONNREFUSED，
    // 单独跑恒绿）。实测 4 路 36s / 8 路 33s / 12 路 33s：墙钟由最大的
    // 单文件（shell-tools 自身 ~36s）决定，加并行度不再有收益，故取 8 路
    // 作为「够用且留出争用余量」的折中。
    ...(PROFILE === 'integration' ? { maxWorkers: 8 } : {}),
  },
});
