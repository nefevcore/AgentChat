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

// ac-ask-questions 的 ASK_WAIT_WINDOW_MS 注释）。

// 环境渗漏防线（2026-09-10 事故）：开发 shell 为 `pnpm dev` 导出的
// AGENTCHAT_DATA_ROOT 会渗入测试进程——bootTree 只显式隔离部分持久化行
// （session/group/…），其余行按 `root ?? env ?? './data'` 回落链解析，
// 渗漏 env 使它们直连【真实数据根】。事故形态：pnpm test 的
// singles/create → purgeEmpty() 在真实根上按「空白会话」硬删 8 条真实
// 会话元数据（hasMessages 走的却是临时根 session 服务，恒 false），同时
// 真实根被写入 helper/f2 等测试 Agent 与 g/gg/team 等测试群。本文件的
// 设计前提本就是「env 未设」（ac-group/ac-conversation 纯内存语义）——
// 这里显式摘除渗漏值，使前提对宿主 shell 环境免疫。
if (process.env.AGENTCHAT_DATA_ROOT !== undefined) {
  console.warn(
    `[vitest-setup-chdir] 摘除渗漏的 AGENTCHAT_DATA_ROOT=${process.env.AGENTCHAT_DATA_ROOT}（测试不得触碰真实数据根）`,
  );
  delete process.env.AGENTCHAT_DATA_ROOT;
}

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
