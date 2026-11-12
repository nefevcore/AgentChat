// ============================================================
// config-keys.test.ts —— 行内 config 键面自述（cr-1037 批3b）
//
// 链路：ac.rows[].configKeys → aggregatePackageRows → RowDescriptor
// 投影 → applyAssemblyLayer 未知键 warn（不阻断；机制键豁免）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { mergeMenu, applyAssemblyLayer, type Menu } from '../src/menu.ts';
import { projectBaseEntry } from '../src/base-docs.ts';

const menuOf = (ids: string[]): Menu => mergeMenu({ skeleton: ids.map((id) => ({ id })) });

describe('cr-1037 批3b：键面自述', () => {
  it('投影透传：configKeys 经 projectBaseEntry 进 RowDescriptor', () => {
    const d = projectBaseEntry({ id: 'browser', name: 'link:packages/ac-web-tools', configKeys: ['level', 'headless'] }, 'shell');
    expect(d.configKeys).toEqual(['level', 'headless']);
    expect(projectBaseEntry({ id: 'x' }, 'shell').configKeys).toBeUndefined();
  });

  it('未知键 warn 不阻断：config 合并照常、notice 点名未知键', () => {
    const menu = menuOf(['browser']);
    const keys = new Map([['browser', ['level']]]);
    const out = applyAssemblyLayer(menu,
      [{ id: 'browser', config: { level: 'full', oldKey: true } }],
      undefined, [], keys);
    expect(out.entries[0]?.config).toEqual({ level: 'full', oldKey: true }); // 不阻断——合并照常
    expect(out.notices.some((n) => n.includes('未知键') && n.includes('oldKey'))).toBe(true);
  });

  it('机制保留键豁免 + 未自述行不校验', () => {
    const menu = menuOf(['browser', 'mcp']);
    const keys = new Map([['browser', ['level']]]);
    const out = applyAssemblyLayer(menu,
      [
        { id: 'browser', config: { level: 'full', configVersion: 2 } }, // 机制键豁免
        { id: 'mcp', config: { 任意键: 1 } }, // 未自述——不校验
      ],
      undefined, [], keys);
    expect(out.notices.filter((n) => n.includes('未知键'))).toEqual([]);
  });
});