// ============================================================
// plugin-rows 纯库单测（cr-543；cr-1001 文件域退役后仅 manifest 投影 +
// 目录合并）：插件行集条目 schema + 三条判据（树归属恒 shell / 路径恒
// 安装目录 / 撞名出厂行丢弃）。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  mergeRowsetCatalog,
  pluginRowsOf,
  readPluginRowDeclarations,
  type RowsetCatalog,
} from '../src/index.ts';

const INSTALL_DIR = '/data/plugins/demo';

describe('插件行集条目 schema', () => {
  it('合法声明归一：树归属恒 shell（manifest 自述忽略）+ 路径恒安装目录', () => {
    const { rows, warnings } = pluginRowsOf('demo', INSTALL_DIR, {
      name: 'demo',
      rows: [
        // 插件不得自述 tree / path（判据 1、2）——一律被覆盖
        { id: 'demo-tools', tools: ['demo_hello'], tree: 'host', path: '/etc' },
        { id: 'demo-extra', bundle: 'demo', requires: ['demo-tools'], description: '演示' },
      ],
    });
    expect(warnings).toEqual([]); // tools/bundle 派生词退役——登记在场容忍忽略，不告警
    expect(rows).toEqual([
      { id: 'demo-tools', tree: 'shell', path: INSTALL_DIR },
      { id: 'demo-extra', tree: 'shell', requires: ['demo-tools'], description: '演示', path: INSTALL_DIR },
    ]);
  });

  it('非法条目 fail-soft：id 词法 / requires 形态 / 非对象条目各自告警跳过', () => {
    expect(readPluginRowDeclarations({ rows: 'nope' }).warnings).toEqual(['manifest.rows 必须是数组——已忽略']);
    const read = readPluginRowDeclarations({
      rows: [
        { id: 'Bad Id' },
        { id: 'ok-row', requires: 'nope' },
        { id: 'ok-row-2', tools: ['x', 1] },
        'not-an-object',
      ],
    });
    expect(read.decls).toEqual([{ id: 'ok-row' }, { id: 'ok-row-2' }]); // tools 不再是合法词汇——静默忽略
    expect(read.warnings.length).toBe(3);
    // 未声明 rows = 无行集条目（插件只提供工具时不必声明）
    expect(readPluginRowDeclarations({ name: 'x' }).decls).toEqual([]);
  });
});

describe('目录合并（保留字护栏）', () => {
  const base: RowsetCatalog = { rows: [{ id: 'backup', tree: 'host' }, { id: 'ledger', tree: 'shell' }] };

  it('撞名出厂行丢弃插件行 + 插件行内部重复 id 后到丢弃', () => {
    const merged = mergeRowsetCatalog(base, [
      { id: 'backup', tree: 'shell', path: '/p/a' },
      { id: 'demo-tools', tree: 'shell', path: '/p/a' },
      { id: 'demo-tools', tree: 'shell', path: '/p/b' },
    ]);
    expect(merged.catalog.rows.map((r) => r.id)).toEqual(['backup', 'ledger', 'demo-tools']);
    expect(merged.catalog.rows[2]?.path).toBe('/p/a');
    expect(merged.warnings).toEqual(['插件行与既有行撞名，已丢弃：backup', '插件行与既有行撞名，已丢弃：demo-tools']);
    // 不可变：基础目录不被就地改写
    expect(base.rows.length).toBe(2);
  });
});
