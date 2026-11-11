// ============================================================
// 行集目录对账单测（M3.1 验收）：两树行数恒等式 + 命名域唯一 +
// 目录可派生（shell/host 各自非空）。M8.1 第二批（cr-520）：壳树 35→34
// ——dev-tools 行剔除；cr-566 singles 全新增（83 = 47+36）；
// cr-576 group 全新增（84 = 48+36——宿主群存储行）；cr-629 restart
// 全新增（85 = 48+37——安全重启双件行）；cr-672 auto-title 全新增
// （86 = 48+38——会话命名行）；cr-701 B4 宿主树 ui 组终态清空
// （62 = 23+39——cr-881：system-prompt 行退役、conduct/artifacts 两行新增（净 +1）；
// 此前 61 = 23+38——25 ui 域行撤除：通道包物理迁出后 manifest 声明面
// 随旧装配口径退役，装载面恒在 webui 行 boot graph）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { deriveHostRowset, evaluateAssembly, evaluateLegacyShellRows, SEAT_ROW_IDS, type RowsetCatalog } from '../src/rowset.ts';

const catalog = JSON.parse(
  readFileSync(fileURLToPath(new URL('../../../apps/catalog/row-catalog.json', import.meta.url)), 'utf-8'),
) as RowsetCatalog;

describe('行集目录对账（manifest R8 恒等式）', () => {
  it('总行数 65 = 宿主 25 + 壳 40（cr-973：session-index 宿主新增；cr-886：host-face 双树）', () => {
    expect(catalog.rows).toHaveLength(65);
    expect(catalog.rows.filter((r) => r.tree === 'host')).toHaveLength(25);
    expect(catalog.rows.filter((r) => r.tree === 'shell')).toHaveLength(40);
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

  it('目录可派生：壳基础行集与宿主全集均非空', () => {
    const shellRows = catalog.rows.filter((r) => r.tree === 'shell');
    const base = () => evaluateAssembly({ base: shellRows });
    expect(base().rowIds.length).toBeGreaterThan(0);
    expect(base().rowIds).not.toContain('dev-tools'); // 勘误剔除行不在目录
    expect(deriveHostRowset([], catalog).rowIds).toHaveLength(25); // cr-973：session-index 新增
    // cr-1007 基座去预设并集化：plugin-dev（creator）/sap-adt（abap）/
    // harness-tools·bench（dev）移出基础集——点名可入、空白 Agent 不恒装
    expect(base().rowIds).not.toContain('plugin-dev');
    expect(base().rowIds).not.toContain('sap-adt');
    expect(base().rowIds).not.toContain('harness-tools');
    expect(base().rowIds).not.toContain('bench');
    // cr-672 命名行恒并席位（点名形态也在——legacy 桥 target 恒含席位）
    expect(evaluateLegacyShellRows([], shellRows, [], SEAT_ROW_IDS).rowIds).toContain('auto-title');
    expect(base().rowIds).not.toContain('restart'); // bundle 化离开基础集（cr-635 创造预设专属）
    expect(evaluateLegacyShellRows(['restart'], shellRows, [], SEAT_ROW_IDS).rowIds).toContain('restart'); // 点名引入
    expect(evaluateLegacyShellRows(['creator'], shellRows, [], SEAT_ROW_IDS).rowIds).toContain('restart'); // creator 捆绑词命中
    expect(evaluateLegacyShellRows(['creator'], shellRows, [], SEAT_ROW_IDS).rowIds).toContain('plugin-dev'); // cr-1007：plugin-dev 随 creator 捆绑词
    expect(evaluateLegacyShellRows(['abap'], shellRows, [], SEAT_ROW_IDS).rowIds).toContain('sap-adt'); // cr-1007：sap-adt 随 abap 捆绑词
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
