// ============================================================
// write.ts 装配补丁单测（cr-552）：tools 意图 + settings per-name
// 合并语义 + 变更键报告（并集比较——键删除也报）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { applyAssemblyPatch, type AgentConfig } from '../src/index.ts';

const base: AgentConfig = { id: 'a', model: 'm', rows: { include: ['t1', 't2'] }, settings: { persona: { enabled: true, maxTokens: 100 } } };

describe('applyAssemblyPatch（装配写口纯函数）', () => {
  it('rows include 覆盖 + 变更键报告', () => {
    const { config, changed } = applyAssemblyPatch(base, { rows: { include: ['t1'] } });
    expect(config.rows).toEqual({ include: ['t1'] });
    expect(changed).toEqual(['rows']);
  });

  it('rows 全空意图 = 删键恢复缺省', () => {
    const { config, changed } = applyAssemblyPatch(base, { rows: {} });
    expect(config.rows).toBeUndefined();
    expect(changed).toEqual(['rows']);
  });

  it('tools exclude 空数组 = 同删键（无 include 无 exclude）', () => {
    const { config } = applyAssemblyPatch(base, { rows: { exclude: [] } });
    expect(config.rows).toBeUndefined();
  });

  it('settings 浅合并：只动 enabled，maxTokens 不动', () => {
    const { config, changed } = applyAssemblyPatch(base, { settings: { persona: { enabled: false } } });
    expect(config.settings).toEqual({ persona: { enabled: false, maxTokens: 100 } });
    expect(changed).toEqual(['settings']);
  });

  it('settings 字段级 null = 删单字段；清空 = 删 name', () => {
    const r1 = applyAssemblyPatch(base, { settings: { persona: { maxTokens: null } } });
    expect(r1.config.settings).toEqual({ persona: { enabled: true } });
    expect(r1.changed).toEqual(['settings']);
    const r2 = applyAssemblyPatch(base, { settings: { persona: { enabled: null, maxTokens: null } } });
    expect(r2.config.settings).toBeUndefined(); // 清空到无字段 = 删段
    expect(r2.changed).toEqual(['settings']);
  });

  it('settings name 级 null = 删整段（键删除也报变更）', () => {
    const { config, changed } = applyAssemblyPatch(base, { settings: { persona: null } });
    expect(config.settings).toBeUndefined();
    expect(changed).toEqual(['settings']);
  });

  it('settings 旧非对象形状（string）= 整体替换', () => {
    const cur: AgentConfig = { id: 'a', settings: { persona: '旧字符串' } as unknown as AgentConfig['settings'] };
    const { config } = applyAssemblyPatch(cur, { settings: { persona: { enabled: true } } });
    expect(config.settings).toEqual({ persona: { enabled: true } });
  });

  it('零变更：changed 空 + config 恒等', () => {
    const { config, changed } = applyAssemblyPatch(base, { settings: { persona: { enabled: true } } });
    expect(changed).toEqual([]);
    expect(JSON.stringify(config)).toBe(JSON.stringify(base));
  });

  it('未知顶层键 fail-closed', () => {
    expect(() => applyAssemblyPatch(base, { presets: ['x'] })).toThrow(/白名单/);
    expect(() => applyAssemblyPatch(base, { rows: { include: [1] } })).toThrow(/字符串数组/);
    expect(() => applyAssemblyPatch(base, { rows: 'x' })).toThrow(/须为对象/);
  });
});