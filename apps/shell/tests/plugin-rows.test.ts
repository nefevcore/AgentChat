// ============================================================
// 壳侧插件行集测试（cr-543；cr-1001 镜像退役后装载输入 =
// profile/installed.yml〔cr-1004 改名〕）：安装 = 授权动作 →
// 壳行集条目（fit 反向适配并入存在合成）+ 插件行动态装载。
// 数据根恒 sandbox（红线）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { Context, FiberStates } from '@agentchat/cordis';
import type { RowDescriptor } from 'ac-rowset-core';
import { readCatalog } from 'ac-rowset-core';
import { writeAgentConfig, writeAgentProfileAt, writeAgentPatchV3At, readAgentPatchV3At } from 'ac-agents-core';
import { assemblePluginRow, deriveAndAssertRowset } from '../boot.ts';

const ROOT = path.join('sandbox', 'test-shell-plugin-rows-' + process.pid);
const CATALOG = path.join('sandbox', 'test-shell-plugin-catalog-' + process.pid + '.json');

/** 出厂目录（只含一行壳行——插件行由 installed 菜单注入） */
function writeCatalog(): void {
  fs.writeFileSync(CATALOG, JSON.stringify({
    version: 1,
    rows: [{ id: 'ledger', tree: 'shell', description: '账本' }],
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

// v3 播种（cr-1022 批3）：正清单定义拷贝需 shell 能力目录——本文件用
// fixture 目录（数据根无 row-catalog.json），经 opts.shellRows 显式注入
function writeAgent(rows: string[]): void {
  const shellRows = readCatalog(CATALOG).rows.filter((r) => r.tree === 'shell');
  writeAgentConfig(ROOT, { id: 'demo-agent', model: 'mock', rows }, { shellRows });
}

beforeEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.mkdirSync(ROOT, { recursive: true });
  (globalThis as Record<string, unknown>).__demoPluginApplied = false;
  writeCatalog();
});
afterEach(() => {
  fs.rmSync(ROOT, { recursive: true, force: true });
  fs.rmSync(CATALOG, { force: true });
});

describe('壳行集 × 插件行（install = 授权动作）', () => {
  it('坏引用两副面孔：未安装插件行点名 = 写侧静默丢；菜单 requires 缺失 = fail-loud', () => {
    // ① 写侧正清单：demo-tools 不在能力目录（未安装 = 目录不可见即不可
    // 点名）→ rowsToMenuDefs 静默丢，v3 菜单片段只余 ledger
    writeAgent(['ledger', 'demo-tools']);
    const dir = path.join(ROOT, 'agents', 'demo-agent');
    expect(readAgentPatchV3At(dir)!.defs.map((d) => d.id)).toEqual(['ledger']);
    // ② boot 侧 fail-loud 面 = 菜单 requires 完备性校验：手写 v3 菜单片段
    // 点名插件行 + requires 引用 ghost 行 → mergeMenu 报「requires 缺失」
    writeAgentProfileAt(dir, { model: 'mock' });
    writeAgentPatchV3At(dir, [{ id: 'demo-tools', requires: ['ghost-row'] }], {});
    expect(() => deriveAndAssertRowset(ROOT, 'demo-agent', CATALOG)).toThrow(/requires 缺失/);
  });

  it('插件行集合并后点名命中：行集含插件行 + 树归属 shell', () => {
    const installDir = makeInstallDir().replace(/\\/g, '/');
    // installed.yml 登记（link: 目录词形——安装器代写面的同款投影；
    // cr-1004：无 scope 字段，face 反向适配在求值器；
    // JSON 流映射 = js-yaml 合法子集）
    fs.mkdirSync(path.join(ROOT, 'profile'), { recursive: true });
    const entry = { id: 'demo', name: 'link:' + installDir };
    fs.writeFileSync(path.join(ROOT, 'profile', 'installed.yml'),
      '- ' + JSON.stringify(entry) + '\n', 'utf-8');
    // v3 播种在 installed.yml 之后（基线戳盖 profile/installed.yml——播种
    // 早于登记则 boot 侧现算戳漂移 fail-loud）；demo-tools 点名在写侧静默
    // 丢（正清单），插件行经 installed 菜单注入进集
    writeAgent(['ledger', 'demo-tools']);
    const rowset = deriveAndAssertRowset(ROOT, 'demo-agent', CATALOG);
    expect(rowset.rowIds).toEqual(['demo-tools', 'ledger']);
    // 合并后的菜单里，插件行保持 shell 归属（宿主装配面不出现第三方行；
    // tools 声明词汇退役——工具面经注册面 dump 观测，见下一用例）
    expect(rowset.rows.find((row) => row.id === 'demo-tools')).toEqual({
      id: 'demo-tools', tree: 'shell', path: installDir,
    } as RowDescriptor);
  });

  it('插件行动态装载：安装目录 manifest.entry → 动态 import → 行 fiber ACTIVE', async () => {
    const installDir = makeInstallDir();
    const row: RowDescriptor = { id: 'demo-tools', tree: 'shell', path: installDir };
    const ctx = new Context();
    const fiber = await assemblePluginRow(row, ctx);
    await fiber;
    try {
      expect(fiber.state).toBe(FiberStates.ACTIVE);
      expect((globalThis as Record<string, unknown>).__demoPluginApplied).toBe(true);
    } finally {
      await fiber.dispose();
    }
    // path 缺席（数组形随 packs 词汇退役不可表达）= fail-loud——插件行须指单安装目录
    await expect(assemblePluginRow({ id: 'x', tree: 'shell' }, ctx)).rejects.toThrow(/path 非法/);
  });
});
