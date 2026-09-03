// ============================================================
// scripts/vitest-global-setup.mjs —— 全量测试前置
// 1) 清空并重建测试数据根 <repo>/workspace/test；
// 2) 预置标准三连接 fixture（openai/deepseek/glm——经 config 而非种子，
//    种子机制已移除：连接池 = 唯一事实源；默认根启动的全树测试
//    [tree/config-boot/chat/aggregate-boot/patch-layer] 与冒烟共享同款）。
// 安全护栏：只操作精确解析为 <repo>/workspace/test 的路径。
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
  rmSync(TEST_ROOT, { recursive: true, force: true });
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

export default function setup() {
  // 清理已在模块加载时完成（globalSetup 只需空实现）
}
