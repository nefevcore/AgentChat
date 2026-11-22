import { defineConfig } from 'vitest/config';
import vue from '@vitejs/plugin-vue';
import Icons from 'unplugin-icons/vite';
import { fileURLToPath, URL } from 'node:url';
import { join } from 'node:path';

// ============================================================
// 测试分档（2026-01-00 梳理）：277 个测试文件里 37 个（79% 的执行时长）是
// 真起进程/服务器/整树 boot 的集成测试——它们与 216 个亚秒级纯逻辑用例
// 混在同一批次里，导致本地每次反馈都要付全量代价。
//   · 约定：慢用例文件名带 .integration.test.ts（与 vitest include 的
//     *.test.ts 天然兼容，无需登记清单，新用例作者自行归类）。
//   · 档位经 VITEST_PROFILE 选择：unit（快循环）/ integration（限流跑）
//     / 未设（全量，等价改造前行为）。由 scripts/run-tests.mjs 编排。
// cr-703 全仓重组后，packages/ 与 apps/ 同属本配置——不再有 preview 轨
// 独立配置与 preview:* 脚本。
// ============================================================
const PROFILE = process.env.VITEST_PROFILE ?? 'all'; // 'all' = 不加 include/exclude 过滤

// 每轮专属测试根（cr-1211）：workspace/test-run-<pid>。此前所有轮次共享
// workspace/test 且 globalSetup 每轮整树 rmSync——多会话并发测试（或双终端
// 各跑一轮）时一边 worker/子进程 cwd 驻留树内，另一边清树即 EPERM（cr-1181
// 双轮互踩、cr-1197/1199 残留句柄均此形态）。注入点在 config 求值而非
// test.env：test.env 只达 worker，globalSetup 主进程不可见（探针实证）；
// config 求值与 globalSetup 同进程，直写 process.env 两端均可见、worker
// 经继承拿到。watch 同 pid 复用同根；死轮残根由 globalSetup 开工 GC。
const REPO_ROOT = fileURLToPath(new URL('./', import.meta.url));
process.env.AGENTCHAT_TEST_ROOT = join(REPO_ROOT, 'workspace', `test-run-${process.pid}`);
// desktop/tests = 桌面壳域测试（main.mjs 桥/更新/树杀回归，cr-481 自
// ac-client-ui-desktop-storage/tests 归位——被测面在 desktop/，与被测物同住）
const ALL_TESTS = ['packages/**/tests/**/*.test.ts', 'apps/**/tests/**/*.test.ts', 'desktop/tests/**/*.test.ts'];
const INTEGRATION_TESTS = [
  'packages/**/tests/**/*.integration.test.ts',
  'apps/**/tests/**/*.integration.test.ts',
  'desktop/tests/**/*.integration.test.ts',
];

export default defineConfig({
  plugins: [
    // webui 前端测试可 import .vue 组件与 ~icons/* 虚拟模块（SlotOutlet/
    // AppFrame 等 M27 slot 面；不触及它们的包测试不受影响）
    vue(),
    Icons({ compiler: 'vue3' }),
  ],
  resolve: {
    alias: {
      // 前端测试的 @ 别名（与 apps/ui/vite.config.ts 同源映射；
      // 后端包测试不使用 @，无碰撞）
      '@': fileURLToPath(new URL('./apps/ui/src', import.meta.url)),
      // 同源迁移：@agentchat/protocol → 自包含垫片（与 apps/ui/vite.config.ts
      // 及 apps/ui/tsconfig.json paths 三处同源映射）
      '@agentchat/protocol': fileURLToPath(new URL('./apps/ui/src/shims/@agentchat/protocol.ts', import.meta.url)),
      // electron → 桌面壳测试垫片（desktop-bridge.test.ts 驱动 main.mjs 用；
      // 仅测试态生效：生产桌面打包走 electron-builder，不经 vitest resolver）
      electron: fileURLToPath(new URL('./desktop/tests-support/electron-shim.mjs', import.meta.url)),
    },
  },
  test: {
    // unit 档只排集成文件；integration 档只排集成文件；all 档两者皆含
    include: PROFILE === 'integration' ? INTEGRATION_TESTS : ALL_TESTS,
    exclude: [
      '**/node_modules/**',
      '**/.git/**',
      ...(PROFILE === 'unit' ? INTEGRATION_TESTS : []),
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
    // 并发上限 8（20 核机器上缺省会用 19 路）：
    //   · 集成档：真起子进程/HTTP 服务器/整树 boot，并发过高互相挤占（子进程
    //     冷启动被拖过就绪窗口 → ECONNREFUSED，单独跑恒绿）；实测 4/8/12 路
    //     墙钟近似，8 路是够用且留争用余量的折中。
    //   · 全档：Windows 下 19 路并发对测试数据根的原子写（tmp+rename）出现
    //     瞬时 EPERM/EBUSY（cr-703 合并套件后实测 ac-config 与
    //     ac-harness-tools 各中一次，单独跑恒绿）——统一限 8 路。
    maxWorkers: 8,
  },
});
