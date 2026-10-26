// ============================================================
// ac-auth-core 单测（M2.2 验收）：投影算法全语义（C 节四要点）+
// 两层直读 + B3 指纹稳定性
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  projectEffective,
  type GlobalAuth, type AgentAuth, type GlobalAuthEntry,
} from '../src/auth.ts';
import {
  readGlobalAuth, readAgentAuth, authFingerprint,
  globalAuthFile, agentAuthFile,
} from '../src/disk.ts';

const entry = (id: string, asset: GlobalAuthEntry['asset'], extra: Partial<GlobalAuthEntry> = {}): GlobalAuthEntry => ({
  id, asset, grantedAt: '2026-10-17T00:00:00Z', grantSource: 'user-webui', ...extra,
});

const g: GlobalAuth = {
  version: 1,
  entries: [
    entry('e1', { kind: 'credential', ref: 'github-token' }),
    entry('e2', { kind: 'row-load', rowId: 'ac-fs-tools' }),
    entry('e3', { kind: 'row-load', rowId: 'ac-web-search' }, { revokedAt: '2026-10-17T01:00:00Z' }),
    entry('e4', { kind: 'mcp-server', name: 'adt' }),
  ],
};

describe('投影算法（C 节）', () => {
  it('全局有效条目全生效（无 per-agent 层）', () => {
    const out = projectEffective({ global: g, agent: undefined, rowset: new Set(['ac-fs-tools']) });
    const ids = out.map((a) => (a.via === 'global' ? a.entry.id : 'inline'));
    expect(ids).toEqual(['e1', 'e2', 'e4']); // e3 墓碑出局
  });

  it('行集双闸：全局 row-load 但行集未装 → 不生效（声明面 ∩ 授权面）', () => {
    const out = projectEffective({ global: g, agent: undefined, rowset: new Set(['ac-other']) });
    const kinds = out.filter((a) => a.via === 'global' && a.entry.asset.kind === 'row-load');
    expect(kinds).toEqual([]);
  });

  it('denials 优先于一切：同类同目标键匹配（含对全局条目的资产键拒绝）', () => {
    const agent: AgentAuth = {
      version: 1, agentId: 'a1',
      grants: [],
      denials: [{ globalId: 'e1' }, { row: 'ac-fs-tools' }],
    };
    const out = projectEffective({ global: g, agent, rowset: new Set(['ac-fs-tools']) });
    const ids = out.map((a) => (a.via === 'global' ? a.entry.id : 'inline'));
    expect(ids).toEqual(['e4']); // e1（globalId 拒）+ e2（资产键拒）出局
  });

  it('内联资产：grants.inline 直享（不受行集闸）；重复 spec 去重', () => {
    const inline = { kind: 'inline' as const, spec: { dir: 'D:/readonly' } };
    const agent: AgentAuth = {
      version: 1, agentId: 'a1',
      grants: [{ inline }, { inline }],
      denials: [],
    };
    const out = projectEffective({ global: { version: 1, entries: [] }, agent, rowset: new Set() });
    expect(out).toEqual([{ via: 'inline', asset: inline }]);
  });

  it('per-agent 行引用（row 词汇）：等效全局 row-load 但只授本 agent，受行集闸', () => {
    const agent: AgentAuth = {
      version: 1, agentId: 'a1',
      grants: [{ row: 'ac-bench' }],
      denials: [],
    };
    const out = projectEffective({ global: { version: 1, entries: [] }, agent, rowset: new Set(['ac-bench']) });
    expect(out).toHaveLength(1);
    expect(out[0]).toMatchObject({ via: 'global', entry: { asset: { kind: 'row-load', rowId: 'ac-bench' } } });
    // 行集未装 → 出局
    const out2 = projectEffective({ global: { version: 1, entries: [] }, agent, rowset: new Set() });
    expect(out2).toEqual([]);
  });

  it('credential 与 mcp-server 不受行集闸（非行装载语义）', () => {
    const out = projectEffective({ global: g, agent: undefined, rowset: new Set() });
    const ids = out.map((a) => (a.via === 'global' ? a.entry.id : 'inline'));
    expect(ids).toEqual(['e1', 'e4']);
  });
});

describe('两层直读 + B3 指纹', () => {
  const ROOT = path.join('sandbox', 'test-auth-' + process.pid);
  beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
  afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

  it('全局层缺席 = 空表；写后直读还原', () => {
    expect(readGlobalAuth(ROOT)).toEqual({ version: 1, entries: [] });
    fs.writeFileSync(globalAuthFile(ROOT), JSON.stringify(g), 'utf-8');
    expect(readGlobalAuth(ROOT)).toEqual(g);
  });

  it('per-agent 层缺席/损坏 = null；写后直读还原', () => {
    expect(readAgentAuth(ROOT, 'a1')).toBeNull();
    fs.mkdirSync(path.join(ROOT, 'agents', 'a1'), { recursive: true });
    fs.writeFileSync(agentAuthFile(ROOT, 'a1'), '{bad', 'utf-8');
    expect(readAgentAuth(ROOT, 'a1')).toBeNull();
    const agent: AgentAuth = { version: 1, agentId: 'a1', grants: [{ globalId: 'e1' }], denials: [] };
    fs.writeFileSync(agentAuthFile(ROOT, 'a1'), JSON.stringify(agent), 'utf-8');
    expect(readAgentAuth(ROOT, 'a1')).toEqual(agent);
  });

  it('指纹稳定性：键序无关（canonical）；吊销变更指纹', () => {
    const agent: AgentAuth = { version: 1, agentId: 'a1', grants: [], denials: [] };
    const fp1 = authFingerprint(g, agent);
    // 条目乱序 + 键乱序的同构输入
    const shuffled: GlobalAuth = { version: 1, entries: [g.entries[2], g.entries[0], g.entries[3], g.entries[1]] };
    const fp2 = authFingerprint(shuffled, agent);
    expect(fp1).toBe(fp2);
    // 吊销变化 → 指纹变（grant 事务对拍依据）
    const revoked: GlobalAuth = { version: 1, entries: [...g.entries, entry('e5', { kind: 'mcp-server', name: 'x' }, { revokedAt: 'T' })] };
    expect(authFingerprint(revoked, agent)).not.toBe(fp1);
  });
});
