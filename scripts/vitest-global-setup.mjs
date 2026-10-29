// ============================================================
// scripts/vitest-global-setup.mjs —— 全量测试前置
// 1) 清空并重建测试数据根 <repo>/workspace/test；
// 2) 预置标准三连接 fixture（openai/deepseek/glm——经 config 而非种子，
//    种子机制已移除：连接池 = 唯一事实源；默认根启动的全树测试
//    [tree/config-boot/chat/aggregate-boot/patch-layer] 与冒烟共享同款）。
// 安全护栏：只操作精确解析为 <repo>/workspace/test 的路径。
// 清理带 EPERM/EBUSY 有界重试（cr-705）：detached 壳或防病毒扫描瞬时
// 占用句柄时给出占用者诊断而非裸 EPERM 悬案；重试耗尽仍失败才抛。
// ============================================================
import { rmSync, mkdirSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO_ROOT = fileURLToPath(new URL('../', import.meta.url));
const TEST_ROOT = resolve(join(REPO_ROOT, 'workspace', 'test'));

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

if (TEST_ROOT.endsWith(join('workspace', 'test'))) {
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

/** 递归删除（Windows 瞬时占用有界重试 + 诊断——cr-705）。
 * 占用者多为上一轮 detached 测试壳（apps/shell/boot.ts）或防病毒扫描；
 * 诊断列 workspace/test 下仍锁着的文件路径，便于定位是哪个测试的残留。 */
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
  console.error('[vitest-global-setup] 用 Get-CimInstance Win32_Process 过滤 node.exe 的 CommandLine 含 shell/boot 或 workspace/test 的残留进程后终止；数据根现场保留待查。');
}

export default function setup() {
  // 清理已在模块加载时完成（globalSetup 只需空实现）
}