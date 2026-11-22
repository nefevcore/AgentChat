// ============================================================
// scripts/vitest-global-setup.mjs —— 全量测试前置
// 1) 清空并重建本轮测试数据根（cr-1211 起为 workspace/test-run-<pid>，由
//    vitest.config.ts 求值期注入 AGENTCHAT_TEST_ROOT；回落 workspace/test
//    兼容不经根配置直跑的形态）；
// 2) 预置标准三连接 fixture（openai/deepseek/glm——经 config 而非种子，
//    种子机制已移除：连接池 = 唯一事实源；默认根启动的全树测试
//    [tree/config-boot/chat/aggregate-boot/patch-layer] 与冒烟共享同款）。
// 3) GC：清扫 workspace/test-run-* 中 pid 已死的残根（cr-1211——测试结束
//    不做 teardown 清理：detached 壳/防病毒残留句柄会让已全绿的轮次在收尾
//    阶段挂掉；死根由下一轮开工时回收，磁盘占用封顶于活轮数）。
// 安全护栏：只操作精确解析为 <repo>/workspace 下 test 或 test-run-<pid> 的路径。
// 清理带 EPERM/EBUSY 有界重试（cr-705）：瞬时占用句柄时给出占用者诊断而非
// 裸 EPERM 悬案；重试耗尽仍失败才抛（本轮根 fail-loud 保现场，GC 根跳过）。
// ============================================================
import { rmSync, mkdirSync, writeFileSync, readdirSync } from 'node:fs';
import { join, resolve, dirname, basename } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const WORKSPACE_DIR = join(REPO_ROOT, 'workspace');
const TEST_ROOT = resolve(process.env.AGENTCHAT_TEST_ROOT ?? join(WORKSPACE_DIR, 'test'));

/** 标准三连接 fixture（与 smoke.ts 同款——配置驱动注册的测试基准面） */
export const FIXTURE_POOL = {
  openai: {
    base_url: 'https://api.openai.com/v1',
    defaultModel: 'gpt-4o-mini',
    models: ['gpt-4o-mini', 'gpt-4o', 'gpt-4.1', 'gpt-5', 'o3'],
  },
  deepseek: {
    base_url: 'https://api.deepseek.com/',
    defaultModel: 'deepseek-v4-flash',
    models: ['deepseek-v4-flash', 'deepseek-v4-pro', 'deepseek-v4-flash-vision-exp'],
  },
  glm: {
    base_url: 'https://open.bigmodel.cn/api/paas/v4',
    defaultModel: 'glm-5.3',
    models: ['glm-5.3'],
  },
};

// 护栏（cr-1211 泛化）：仅放行 <repo>/workspace/test（回落兼容）与
// <repo>/workspace/test-run-<pid>（每轮专属根）。env 被污染指向任意路径时拒绝。
const isLegacyRoot = TEST_ROOT === join(WORKSPACE_DIR, 'test');
const isRunRoot = dirname(TEST_ROOT) === WORKSPACE_DIR && /^test-run-\d+$/.test(basename(TEST_ROOT));
if (isLegacyRoot || isRunRoot) {
  sweepDeadRunRoots();
  rmWithRetry(TEST_ROOT);
  mkdirSync(join(TEST_ROOT, 'data'), { recursive: true });
  writeFileSync(
    join(TEST_ROOT, 'data', 'config.json'),
    `${JSON.stringify({ llmProviders: FIXTURE_POOL }, null, 2)}\n`,
    'utf8',
  );
  console.log(`[vitest-global-setup] 测试数据根已重置（含三连接 fixture）: ${TEST_ROOT}`);
} else {
  throw new Error(`测试数据根路径异常，拒绝清理: ${TEST_ROOT}`);
}

/** 回收死轮残根（cr-1211）：test-run-<pid> 中宿主进程已死者。探活用
 * process.kill(pid, 0)：成功或 EPERM = 进程在场（跳过）；ESRCH = 已死
 * （回收）。pid 复用只会导致漏清（保守跳过），无跨根误删路径。best-effort：
 * 单根清理失败仅 warn 不阻塞本轮——残根留给下一轮。 */
function sweepDeadRunRoots() {
  let entries;
  try {
    entries = readdirSync(WORKSPACE_DIR, { withFileTypes: true });
  } catch {
    return; // workspace 目录不存在 = 无残根可清
  }
  for (const entry of entries) {
    const m = /^test-run-(\d+)$/.exec(entry.name);
    if (!m || !entry.isDirectory()) continue;
    const root = join(WORKSPACE_DIR, entry.name);
    if (root === TEST_ROOT) continue; // 本轮根稍后由主流程重置
    let alive;
    try {
      process.kill(Number(m[1]), 0);
      alive = true;
    } catch (err) {
      alive = err?.code !== 'ESRCH'; // EPERM = 在场但无权限
    }
    if (alive) continue;
    try {
      rmWithRetry(root, 3);
      console.log(`[vitest-global-setup] GC 已回收死轮残根: ${root}`);
    } catch (err) {
      console.warn(`[vitest-global-setup] GC 跳过残根（${err?.code}，留待下轮）: ${root}`);
    }
  }
}

/** 递归删除（Windows 瞬时占用有界重试 + 诊断——cr-705）。
 * 占用者多为 detached 测试壳（apps/shell/boot.ts）或防病毒扫描；
 * 诊断列测试根下仍锁着的文件路径，便于定位是哪个测试的残留。 */
function rmWithRetry(dir, attempts = 5) {
  for (let i = 0; ; i++) {
    try {
      rmSync(dir, { recursive: true, force: true });
      return;
    } catch (err) {
      if (!['EPERM', 'EBUSY', 'EACCES'].includes(err?.code) || i >= attempts) {
        diagnoseLocked(dir, err);
        throw err;
      }
      const delay = 200 * (i + 1);
      console.warn(`[vitest-global-setup] 清理 ${dir} 撞 ${err.code}（第 ${i + 1}/${attempts} 次重试，${delay}ms 后再试）`);
      Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, delay);
    }
  }
}

/** 重试耗尽的现场诊断：列 dir 下已消失失败的子路径 + 全局壳进程提示 */
function diagnoseLocked(dir, err) {
  console.error(`[vitest-global-setup] 清理失败（${err?.code}）：${dir}`);
  console.error('[vitest-global-setup] 常见占用者：上一轮 detached 测试壳（apps/shell/boot.ts）或防病毒扫描——检查残留进程：');
  console.error('[vitest-global-setup] 用 Get-CimInstance Win32_Process 过滤 node.exe 的 CommandLine 含 shell/boot 或 test-run 的残留进程后终止；数据根现场保留待查。');
}

export default function setup() {
  // 清理已在模块加载时完成（globalSetup 只需空实现）
}
