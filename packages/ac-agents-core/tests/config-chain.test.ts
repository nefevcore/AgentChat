// ============================================================
// config-chain.test.ts —— 行内 config 迁移链测试（cr-1037 批1/批2）
// ============================================================
import { describe, it, expect } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { validateChain } from 'ac-migration-core';
import {
  parseConfigMigrationsDecl, assertMigrationModulePath, importConfigMigrations,
  runConfigMigration, needsConfigMigration, readConfigVersion, stripVersion,
  aggregateConfigChains,
  CONFIG_VERSION_KEY, LEGACY_KEY,
} from '../src/config-chain.ts';

const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

const edge = (from: number, map: (c: Record<string, unknown>) => Record<string, unknown>) =>
  ({ from, to: from + 1, migrate: map });

describe('cr-1037 声明面', () => {
  it('decl 解析：正常/缺席/白名单外字段 fail-loud', () => {
    expect(parseConfigMigrationsDecl(undefined, 'p.json')).toBeNull();
    expect(parseConfigMigrationsDecl({ module: './src/config-migrations.ts' }, 'p.json'))
      .toEqual({ module: './src/config-migrations.ts' });
    expect(() => parseConfigMigrationsDecl({ module: './src/x.ts', extra: 1 }, 'p.json')).toThrow('白名单外字段');
    expect(() => parseConfigMigrationsDecl({ module: 42 }, 'p.json')).toThrow('非空字符串');
  });

  it('模块路径白名单：包内 src/ 单文件 .ts；逃逸拒绝', () => {
    assertMigrationModulePath('./src/config-migrations.ts', 'p.json'); // 不炸即过
    expect(() => assertMigrationModulePath('../evil.ts', 'p.json')).toThrow('路径非法');
    expect(() => assertMigrationModulePath('./src/a/b.ts', 'p.json')).toThrow('路径非法');
    expect(() => assertMigrationModulePath('./dist/x.js', 'p.json')).toThrow('路径非法');
  });

  it('importConfigMigrations：真模块 import + 坏导出 fail-loud', async () => {
    const ROOT = path.join('sandbox', 'test-config-chain-' + process.pid);
    try {
      fs.mkdirSync(path.join(ROOT, 'pkg-ok', 'src'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'pkg-ok', 'src', 'config-migrations.ts'),
        'export const configMigrations = { foo: [{ from: 0, to: 1, migrate: (c) => c }] };');
      const rows = await importConfigMigrations(
        path.join(ROOT, 'pkg-ok'), { module: './src/config-migrations.ts' });
      expect(Object.keys(rows ?? {})).toEqual(['foo']);
      fs.mkdirSync(path.join(ROOT, 'pkg-bad', 'src'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'pkg-bad', 'src', 'config-migrations.ts'),
        'export const other = 1;');
      await expect(importConfigMigrations(
        path.join(ROOT, 'pkg-bad'), { module: './src/config-migrations.ts' }))
        .rejects.toThrow('须导出 configMigrations');
    } finally {
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  });
});

describe('cr-1037 执行语义', () => {
  it('configVersion 读写：缺席/非整数 = v0；stripVersion 剥机制键', () => {
    expect(readConfigVersion(undefined)).toBe(0);
    expect(readConfigVersion({ [CONFIG_VERSION_KEY]: 2 })).toBe(2);
    expect(readConfigVersion({ [CONFIG_VERSION_KEY]: 'x' })).toBe(0);
    expect(stripVersion({ a: 1, [CONFIG_VERSION_KEY]: 3 })).toEqual({ a: 1 });
  });

  it('无损路径：逐边接力 + configVersion 戳 current', () => {
    // 键名换轨边的责任 = 完整换算（删旧写新）——map 显式重构键面
    const chain = [
      edge(0, (c) => ({ enabledNew: c.oldFlag, levelOld: c.levelOld })),
      edge(1, (c) => { const { levelOld, ...rest } = c; return { ...rest, levelNew: levelOld }; }),
    ];
    expect(validateChain(chain)).toEqual([]); // 链完备
    expect(needsConfigMigration(chain, { oldFlag: true })).toBe(true);
    // 边 0 完整换算 oldFlag→enabledNew；边 1 换 levelOld→levelNew（透传其余键）
    const out = runConfigMigration(chain, { oldFlag: true, levelOld: 2 }, 'browser');
    expect(out.notices).toEqual([]);
    expect(out.reports.map((r) => [r.from, r.to])).toEqual([[0, 1], [1, 2]]);
    expect(out.config).toEqual({ enabledNew: true, levelNew: 2, [CONFIG_VERSION_KEY]: 2 });
    // 已最新 → 不迁
    expect(needsConfigMigration(chain, out.config)).toBe(false);
    expect(runConfigMigration(chain, out.config, 'browser').reports).toEqual([]);
  });

  it('缺边 → legacy 路径：旧值整体移入 config.legacy + notice', () => {
    const chain = [edge(1, (c) => c)]; // 缺 v0→v1
    expect(validateChain(chain).length).toBeGreaterThan(0); // 链不完备
    const out = runConfigMigration(chain, { oldFlag: true }, 'browser');
    expect(out.reports).toEqual([]);
    expect(out.config).toEqual({ [LEGACY_KEY]: { oldFlag: true }, [CONFIG_VERSION_KEY]: 2 });
    expect(out.notices[0]).toContain('config.legacy');
    expect(out.notices[0]).toContain('browser');
  });

  it('map 抛错 → 同 legacy 路径（不可迁显式报告）', () => {
    const chain = [edge(0, () => { throw new Error('值域不兼容'); })];
    const out = runConfigMigration(chain, { a: 1 }, 'browser');
    expect(out.config).toEqual({ [LEGACY_KEY]: { a: 1 }, [CONFIG_VERSION_KEY]: 1 });
    expect(out.notices[0]).toContain('值域不兼容');
  });

  it('未来版本拒绝降级读 → legacy 路径（新数据旧代码）', () => {
    const chain = [edge(0, (c) => c)];
    const out = runConfigMigration(chain, { a: 1, [CONFIG_VERSION_KEY]: 5 }, 'browser');
    expect(out.config[LEGACY_KEY]).toEqual({ a: 1 });
    expect(out.notices[0]).toContain('未来版本');
  });

  it('空链 = 不迁（configVersion 不污染无链行）', () => {
    expect(needsConfigMigration([], { a: 1 })).toBe(false);
    const out = runConfigMigration([], { a: 1 }, 'browser');
    expect(out.reports).toEqual([]);
    expect(out.config).toEqual({ a: 1, [CONFIG_VERSION_KEY]: 0 }); // chainCurrent(空)=0，幂等
  });
});

describe('cr-1037 聚合面', () => {
  it('真实仓库聚合合法（批1 落地零声明——首例 CR 注册边后此处仍须过）', async () => {
    const agg = await aggregateConfigChains(REPO_ROOT);
    // 零声明 = 合法零态（链完备性由 gen 链构建期把门——有声明即红于缺环）
    for (const [rowId, chain] of Object.entries(agg.chains)) {
      expect(validateChain(chain), '行 ' + rowId + ' 链须完备').toEqual([]);
    }
  });

  it('沙箱聚合：缺环链 fail-loud / 撞名 fail-loud / 完备链通过', async () => {
    const ROOT = path.join('sandbox', 'test-config-agg-' + process.pid);
    const writePkg = (dir: string, rows: string) => {
      fs.mkdirSync(path.join(ROOT, 'packages', dir, 'src'), { recursive: true });
      fs.writeFileSync(path.join(ROOT, 'packages', dir, 'package.json'), JSON.stringify({
        name: dir,
        ac: { configMigrations: { module: './src/config-migrations.ts' } },
      }));
      fs.writeFileSync(path.join(ROOT, 'packages', dir, 'src', 'config-migrations.ts'),
        'export const configMigrations = ' + rows + ';');
    };
    try {
      // 缺环：从 v1 起（缺 v0→v1）——聚合不校验（校验在 gen 链/消费面），此处验证导入通道
      writePkg('pkg-a', '{ broken: [{ from: 1, to: 2, migrate: (c) => c }] }');
      const agg = await aggregateConfigChains(ROOT);
      expect(agg.chains.broken).toHaveLength(1);
      expect(agg.owners.broken).toBe('pkg-a');
      expect(validateChain(agg.chains.broken).length).toBeGreaterThan(0);
      // 撞名：两包同声明行 id
      writePkg('pkg-b', '{ broken: [{ from: 0, to: 1, migrate: (c) => c }] }');
      await expect(aggregateConfigChains(ROOT)).rejects.toThrow('撞行 id');
    } finally {
      fs.rmSync(ROOT, { recursive: true, force: true });
    }
  });
});