// ============================================================
// fixture-pool.ts —— tree/chat 测试的标准三连接 fixture（自给自足）
//
// 背景：这两组测试断言 boot 后 llm 注册面 = openai/deepseek/glm 三连接。
// 此前依赖 vitest globalSetup 预置的共享 workspace/test/data/config.json
// （cwd 缺省链）——但共享根可被并行 fork 里的其他 config 写入者整覆写，
// 2 核 CI（时序不同）确定性踩空。改为每个测试文件 beforeAll 自建
// fixture 根、boot 时显式传 config.root —— 与环境零耦合。
// 形状与 scripts/vitest-global-setup.mjs 的 FIXTURE_POOL 同款
// （smoke.ts 同源）。
// ============================================================
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

/** 标准三连接 fixture（openai/deepseek/glm——配置驱动注册的测试基准面） */
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

/** 建独立 fixture 根（<dir>/config.json = 三连接）；返回目录路径 */
export function makePoolFixtureDir(prefix: string): string {
  const dir = mkdtempSync(join(tmpdir(), prefix));
  writeFileSync(
    join(dir, 'config.json'),
    `${JSON.stringify({ llmProviders: FIXTURE_POOL }, null, 2)}\n`,
    'utf8',
  );
  return dir;
}

/** 清理 fixture 根 */
export function removePoolFixtureDir(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}
