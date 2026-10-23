// ============================================================
// M6.5 影子派生授权单测：deriveChildAuth ⊆ 父投影（row 转词汇 /
// inline 快照 / denials 叠加收紧）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { deriveChildAuth, projectEffective, type GlobalAuth, type AgentAuth } from '../src/auth.ts';

const globalAuth: GlobalAuth = {
  version: 1,
  entries: [
    { id: 'g1', asset: { kind: 'row-load', rowId: 'fs-tools' }, grantedAt: 't', grantSource: 'user-webui' },
    { id: 'g2', asset: { kind: 'credential', ref: 'openai-key' }, grantedAt: 't', grantSource: 'user-webui' },
    { id: 'g3', asset: { kind: 'mcp-server', name: 'weather' }, grantedAt: 't', grantSource: 'install' },
  ],
};
const parentAuth: AgentAuth = {
  version: 1, agentId: 'w', grants: [], denials: [],
};
const rowset = new Set(['fs-tools']);

describe('M6.5 影子派生授权', () => {
  it('父投影快照为子内联 grants（row/credential/mcp 三词汇全覆盖）', () => {
    const child = deriveChildAuth({
      childId: 'shadow', parentId: 'w',
      parentEnv: { global: globalAuth, agent: parentAuth, rowset },
      materializedAt: '2026-10-18T08:00:00Z',
    });
    expect(child.agentId).toBe('shadow');
    expect(child.parentId).toBe('w');
    expect(child.grants).toEqual([
      { row: 'fs-tools' },
      { inline: { kind: 'inline', spec: { credentialRef: 'openai-key' }, note: 'derived from g2' } },
      { mcp: 'weather' },
    ]);
    expect(child.denials).toEqual([]);
  });

  it('子投影 ⊆ 父投影：projectEffective(child 层) 不越父面', () => {
    const child = deriveChildAuth({
      childId: 'shadow', parentId: 'w',
      parentEnv: { global: globalAuth, agent: parentAuth, rowset },
      materializedAt: 't',
    });
    // 子按自身 auth 层 + 空全局重算（物化后独立）
    const childProjection = projectEffective({
      global: { version: 1, entries: [] },
      agent: child,
      rowset,
    });
    const parentProjection = projectEffective({ global: globalAuth, agent: parentAuth, rowset });
    // row 资产键对齐比较
    const keys = (arr: ReturnType<typeof projectEffective>) => arr.map((a) => {
      if (a.via === 'global') {
        const asset = a.entry.asset;
        if (asset.kind === 'row-load') return 'row:' + asset.rowId;
        if (asset.kind === 'credential') return 'cred:' + asset.ref;
        return 'mcp:' + asset.name;
      }
      // 子面 credential 以 inline spec 快照形态存在（物化独立语义）——按 spec 归一
      const spec = a.asset.spec as Record<string, unknown>;
      if (typeof spec.credentialRef === 'string') return 'cred:' + spec.credentialRef;
      return 'inline:' + JSON.stringify(spec);
    });
    expect(keys(childProjection).sort()).toEqual(keys(parentProjection).sort());
  });

  it('denials 叠加收紧（extraDenials 生效）', () => {
    const child = deriveChildAuth({
      childId: 'shadow', parentId: 'w',
      parentEnv: { global: globalAuth, agent: parentAuth, rowset },
      extraDenials: [{ row: 'fs-tools' }],
      materializedAt: 't',
    });
    const childProjection = projectEffective({ global: { version: 1, entries: [] }, agent: child, rowset });
    expect(childProjection.filter((a) => a.via === 'global' && a.entry.asset.kind === 'row-load')).toEqual([]);
  });
});
