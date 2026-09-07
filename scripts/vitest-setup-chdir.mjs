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
import { existsSync, mkdirSync } from 'node:fs';
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

mkdirSync(TEST_ROOT, { recursive: true });
process.chdir(TEST_ROOT);

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
