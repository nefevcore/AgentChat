// ============================================================
// 行集目录对账单测（M3.1 验收 / cr-1022 批3 收口）：两树行数恒等式 +
// 命名域唯一 + 目录可派生（骨架面 mergeMenu——存量差量换算面已迁
// migrate 脚本，见 ac-agents-core/tests/migrate-agent-patch.test）。
// 行数史：62 = 23+39（cr-881）；cr-973：session-index 宿主新增（65 = 25+40）；cr-1066：permission-gate 骨架新增（66 = 25+41）；cr-1121：host-face 贡献行 timer-face/profile-face（68 = 27+41）；cr-1158：net-monitor 壳骨架新增（69 = 27+42）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deriveHostRowset, type RowsetCatalog, type RowDescriptor } from '../src/rowset.ts';
import { mergeMenu, type MenuEntry } from '../src/menu.ts';

const catalog = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../apps/catalog/row-catalog.json', import.meta.url)), 'utf-8'),
) as RowsetCatalog;

const shellRows = catalog.rows.filter((r) => r.tree === 'shell');
const skeletonRows = shellRows.filter((r) => r.zone === 'skeleton');
const capabilityRows = shellRows.filter((r) => r.zone !== 'skeleton');
const toDef = (r: RowDescriptor): MenuEntry => ({
  id: r.id,
  ...(r.path !== undefined ? { name: 'link:' + r.path } : {}),
  ...(r.requires !== undefined ? { requires: r.requires } : {}),
});
const skeletonDefs = skeletonRows.map(toDef);
const capabilityDefs = capabilityRows.map(toDef);

describe('行集目录对账（manifest R8 恒等式）', () => {
  it('总行数 70 = 宿主 28 + 壳 42（cr-1121：host-face 贡献行 +2；cr-1165：fs-source 采集行；cr-1066：permission-gate 骨架新增；cr-1158 net-monitor）', () => {
    expect(catalog.rows).toHaveLength(70);
    expect(catalog.rows.filter((r) => r.tree === 'host')).toHaveLength(28);
    expect(catalog.rows.filter((r) => r.tree === 'shell')).toHaveLength(42);
  });

  it('每树内 id 唯一（跨树同名 = 基座双计，合法）', () => {
    for (const tree of ['host', 'shell'] as const) {
      const ids = catalog.rows.filter((r) => r.tree === tree).map((r) => r.id);
      expect(new Set(ids).size, tree + ' 内 id 重复').toBe(ids.length);
    }
  });

  it('基座双计恰两行：logger-console / config 跨树同名', () => {
    const both = catalog.rows.filter((r) => r.id === 'logger-console' || r.id === 'config');
    expect(both).toHaveLength(4); // 各树各一
  });

  it('双区完备：壳行恰分骨架/能力两区（menu-assembly §2.1 分层立法）', () => {
    expect(skeletonRows.length).toBeGreaterThan(0);
    expect(capabilityRows.length).toBeGreaterThan(0);
    // 骨架区无 zone 残缺（双区化后壳行必带 zone——host 行单区无标记合法）
    expect(shellRows.length).toBe(skeletonRows.length + capabilityRows.length);
  });

  it('目录可派生：骨架面 mergeMenu + 宿主全集；能力行不进即不装', () => {
    const menu = () => mergeMenu({ skeleton: skeletonDefs });
    expect(menu().entries.length).toBeGreaterThan(0);
    expect(menu().entries.map((e) => e.id)).not.toContain('dev-tools'); // 勘误剔除行不在目录
    expect(deriveHostRowset([], catalog).rowIds).toHaveLength(28); // cr-1121：timer-face/profile-face 贡献行；cr-1165：fs-source 采集行
    // cr-1022 批2：骨架 = 恒装面——能力目录行不进骨架菜单（成组选择由
    // patch/模板物化承担，取代 cr-1007 bundle 摘出语义）
    expect(menu().entries.map((e) => e.id)).not.toContain('plugin-dev');
    expect(menu().entries.map((e) => e.id)).not.toContain('sap-adt');
    expect(menu().entries.map((e) => e.id)).not.toContain('harness-tools');
    expect(menu().entries.map((e) => e.id)).not.toContain('bench');
    expect(menu().entries.map((e) => e.id)).not.toContain('restart');
    expect(menu().errors).toEqual([]);
  });

  it('点名引入（mergeMenu patch——行 id 单一词形）：能力行显式点名', () => {
    // 能力行行 id 直取（工具名/捆绑词词形退役——fs/creator/abap 随 tools
    // 声明消亡；成组选择由模板物化承担）
    const byId = new Map(capabilityDefs.map((d) => [d.id, d] as const));
    const picked = mergeMenu({
      skeleton: skeletonDefs,
      patch: ['restart', 'plugin-dev', 'sap-adt'].map((id) => byId.get(id)!),
    });
    expect(picked.errors).toEqual([]);
    expect(picked.entries.map((e) => e.id)).toEqual(expect.arrayContaining(['restart', 'plugin-dev', 'sap-adt']));
    // 不进即不装：未点名能力行不在菜单
    expect(picked.entries.map((e) => e.id)).not.toContain('math');
  });

  it('requires 词表自洽（cr-521；cr-551 宿主行首用）：引用 id 均为同树内行（垫片服务不标注）', () => {
    const idsByTree = new Map<string, Set<string>>();
    for (const r of catalog.rows) {
      if (!idsByTree.has(r.tree)) idsByTree.set(r.tree, new Set());
      idsByTree.get(r.tree)!.add(r.id);
    }
    let checked = 0;
    for (const r of catalog.rows) {
      for (const req of r.requires ?? []) {
        expect(idsByTree.get(r.tree)!.has(req), r.id + ' requires ' + req + ' 不在 ' + r.tree + ' 树').toBe(true);
        checked++;
      }
    }
    expect(checked).toBeGreaterThan(0);
  });
});
