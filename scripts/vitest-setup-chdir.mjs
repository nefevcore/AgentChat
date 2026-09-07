// ============================================================
// scripts/vitest-setup-chdir.mjs —— vitest setupFiles：测试进程数据根重定位
//
// process.chdir(<repo>/workspace/test)：所有服务的 './data' 缺省链
// （root ?? env ?? './data'，相对 cwd 解析）整体落到集中管理的
// workspace/test/data；**不设 AGENTCHAT_DATA_ROOT**——ac-group/
// ac-conversation 的"env 未设 = 纯内存态"语义是多数单测的隐含前提，
// 全局设 env 会打开持久化造成跨测试踩踏（曾致 9 红）。
// 生产入口（boot.ts/chat.ts）自行锚定 env，不受影响。
// ============================================================
import { copyFileSync, existsSync, mkdirSync } from 'node:fs';
import { dirname, join } from 'node:path';

function resolveRepoRoot() {
  // vitest.config.ts 注入的锚点（node 进程可靠计算；env 序列化进 worker——
  // jsdom 等浏览器环境下 import.meta.url/URL 全局是垫片，不可用）
  if (process.env.AGENTCHAT_REPO_ROOT) return process.env.AGENTCHAT_REPO_ROOT;
  // 兜底：自定义配置直跑时从 cwd 向上找 pnpm-workspace.yaml
  let dir = process.cwd();
  for (;;) {
    if (existsSync(join(dir, 'pnpm-workspace.yaml'))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error('vitest-setup-chdir: 无法定位仓库根（设 AGENTCHAT_REPO_ROOT 或自仓库根运行）');
    dir = parent;
  }
}

const REPO_ROOT = resolveRepoRoot();
const TEST_ROOT = join(REPO_ROOT, 'workspace', 'test');

// 每 worker 独立数据根：并行 worker 同时 boot 服务器（agents 目录 rename /
// config 写入）会在共享根上竞态（EPERM/丢行）——按 pool id 分桶隔离；
// 同 worker 内文件串行复用同桶（跨文件状态共享 = 原共享根语义，不劣化）。
const POOL_ID = process.env.VITEST_POOL_ID ?? process.env.VITEST_WORKER_ID ?? 'main';
const WORKER_ROOT = POOL_ID === 'main' ? TEST_ROOT : join(TEST_ROOT, `w${POOL_ID}`);

mkdirSync(join(WORKER_ROOT, 'data'), { recursive: true });
// 三连接 fixture 复制（默认根启动面：tree/config-boot/chat 等读取
// <data>/config.json——globalSetup 在全局根预置，分桶根照搬）
const fixtureSrc = join(TEST_ROOT, 'data', 'config.json');
const fixtureDst = join(WORKER_ROOT, 'data', 'config.json');
if (WORKER_ROOT !== TEST_ROOT && existsSync(fixtureSrc) && !existsSync(fixtureDst)) {
  try { copyFileSync(fixtureSrc, fixtureDst); } catch { /* 缺 fixture 容忍（非默认根测试不受影响） */ }
}
process.chdir(WORKER_ROOT);

// jsdom 环境最小垫：matchMedia（webui 视图链 useMarkdown/theme 于模块
// 求值期读取；node 环境无 window 不受影响）
if (typeof window !== 'undefined' && typeof window.matchMedia !== 'function') {
  window.matchMedia = (query) => ({
    matches: false,
    media: query,
    onchange: null,
    addListener: () => {},
    removeListener: () => {},
    addEventListener: () => {},
    removeEventListener: () => {},
    dispatchEvent: () => false,
  });
}
