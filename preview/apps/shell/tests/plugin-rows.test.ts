// ============================================================
// 壳侧插件行集测试（cr-543）：安装 = 授权动作 → 壳行集条目
// （<dataRoot>/plugin-rows.json 合并进目录）+ 插件行动态装载。
// 数据根恒 preview/sandbox（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, FiberStates } from '@agentchat/cordis';
import { writePluginRows, pluginRowsOf, type RowDescriptor } from 'ac-rowset-core';
import { assemblePluginRow, deriveAndAssertRowset } from '../boot.ts';

const ROOT = path.join('preview', 'sandbox', 'test-shell-plugin-rows-' + process.pid);
const CATALOG = path.join('preview', 'sandbox', 'test-shell-plugin-catalog-' + process.pid + '.json');

/** 出厂目录（只含一行壳行——插件行由 plugin-rows.json 注入） */
function writeCatalog(): void {
  fs.writeFileSync(CATALOG, JSON.stringify({
    version: 1,
    rows: [{ id: 'ledger', tree: 'shell', role: '账本' }],
  }, null, 2) + '\n', 'utf-8');
}

/** 安装目录（manifest.rows 声明 + 可装载入口） */
function makeInstallDir(): string {
  const dir = path.join(ROOT, 'plugins', 'demo');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify({
    name: 'demo',
    version: '1.0.0',
    entry: 'index.ts',
    rows: [{ id: 'demo-tools', tools: ['demo_hello'] }],
  }, null, 2) + '\n', 'utf-8');
  fs.writeFileSync(path.join(dir, 'index.ts'), [
    'export const name = "demo-plugin-row";',
    'export function apply(): void {',
    '  (globalThis as Record<string, unknown>).__demoPluginApplied = true;',
    '}',
    '',
  ].join('\n'), 'utf-8');
  return dir;
}

function writeAgent(tools: string[]): void {
  const dir = path.join(ROOT, 'agents', 'demo-agent');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({
    id: 'demo-agent', model: 'mock', tools,
  }, null, 2) + '\n', 'utf-8');
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  (globalThis as Record<string, unknown>).__demoPluginApplied = false;
  writeCatalog();
  writeAgent(['ledger', 'demo-tools']);
});
afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(CATALOG, { force: true });
});

describe('壳行集 × 插件行（install = 授权动作）', () => {
  it('未安装时点名插件行 = 行集静态断言 fail-loud（目录不可见即不可点名）', () => {
    expect(() => deriveAndAssertRowset(ROOT, 'demo-agent', CATALOG)).toThrow(/tools 条目未命中目录：demo-tools/);
  });

  it('插件行集合并后点名命中：行集含插件行 + 树归属 shell', () => {
    const installDir = makeInstallDir();
    const parsed = pluginRowsOf('demo', installDir, JSON.parse(fs.readFileSync(path.join(installDir, 'manifest.json'), 'utf-8')));
    writePluginRows(ROOT, parsed.rows);
    const rowset = deriveAndAssertRowset(ROOT, 'demo-agent', CATALOG);
    expect(rowset.rowIds).toEqual(['demo-tools', 'ledger']);
    expect(rowset.toolNames).toEqual(['demo_hello']);
    // 合并后的目录里，插件行保持 shell 归属（宿主装配面不出现第三方行）
    expect(rowset.catalogRows.find((row) => row.id === 'demo-tools')).toEqual({
      id: 'demo-tools', tree: 'shell', tools: ['demo_hello'], path: installDir,
    } as RowDescriptor);
  });

  it('插件行动态装载：安装目录 manifest.entry → 动态 import → 行 fiber ACTIVE', async () => {
    const installDir = makeInstallDir();
    const row: RowDescriptor = { id: 'demo-tools', tree: 'shell', tools: ['demo_hello'], path: installDir };
    const ctx = new Context();
    const fiber = await assemblePluginRow(row, ctx);
    await fiber;
    try {
      expect(fiber.state).toBe(FiberStates.ACTIVE);
      expect((globalThis as Record<string, unknown>).__demoPluginApplied).toBe(true);
    } finally {
      await fiber.dispose();
    }
    // path 数组形（出厂行多包指代）不适用于插件行 = fail-loud
    await expect(assemblePluginRow({ id: 'x', tree: 'shell', path: [installDir] }, ctx)).rejects.toThrow(/path 非法/);
  });
});
