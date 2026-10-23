// ============================================================
// write.ts + mcp.ts 单测（cr-545）：两层写者面——additive 追加 / 墓碑
// 吊销 / per-agent grants·denials 幂等 / mcp.json 清单 / 原子写往返。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  appendGlobalEntry,
  revokeGlobalEntry,
  addGrant,
  removeGrant,
  addDenial,
  removeDenial,
  readGlobalAuth,
  readAgentAuth,
  authFingerprint,
  addMcpServer,
  removeMcpServer,
  readMcpManifest,
  type GlobalAuthEntry,
} from '../src/index.ts';

const ROOT = path.join('preview', 'sandbox', 'test-auth-write-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const entry = (id: string): GlobalAuthEntry => ({
  id,
  asset: { kind: 'row-load', rowId: 'browser' },
  grantedAt: '2026-10-19T00:00:00Z',
  grantSource: 'user-webui',
});

describe('全局层写者面', () => {
  it('追加 additive + id 撞车 fail-loud', () => {
    appendGlobalEntry(ROOT, entry('g1'));
    appendGlobalEntry(ROOT, { ...entry('g2'), asset: { kind: 'mcp-server', name: 'wiki' } });
    const g = readGlobalAuth(ROOT);
    expect(g.entries.map((e) => e.id)).toEqual(['g1', 'g2']);
    expect(() => appendGlobalEntry(ROOT, entry('g1'))).toThrow();
  });

  it('吊销 = 墓碑（幂等）；未命中 fail-loud', () => {
    appendGlobalEntry(ROOT, entry('g1'));
    revokeGlobalEntry(ROOT, { id: 'g1' }, '2026-10-19T01:00:00Z');
    const g = readGlobalAuth(ROOT);
    expect(g.entries[0].revokedAt).toBe('2026-10-19T01:00:00Z');
    // 幂等——再吊销不变
    revokeGlobalEntry(ROOT, { id: 'g1' }, '2026-10-19T02:00:00Z');
    expect(readGlobalAuth(ROOT).entries[0].revokedAt).toBe('2026-10-19T01:00:00Z');
    expect(() => revokeGlobalEntry(ROOT, { id: 'nope' }, 'x')).toThrow();
  });

  it('按资产键吊销（credential ref 匹配）', () => {
    appendGlobalEntry(ROOT, { ...entry('c1'), asset: { kind: 'credential', ref: 'openai' } });
    revokeGlobalEntry(ROOT, { assetKey: { kind: 'credential', name: 'openai' } }, 't');
    expect(readGlobalAuth(ROOT).entries[0].revokedAt).toBe('t');
  });
});

describe('per-agent 层写者面', () => {
  it('grants 追加幂等（同资产键去重）+ 移除', () => {
    const a1 = addGrant(ROOT, 'alpha', { mcp: 'wiki' });
    expect(a1.changed).toBe(true);
    const a2 = addGrant(ROOT, 'alpha', { mcp: 'wiki' });
    expect(a2.changed).toBe(false);
    expect(readAgentAuth(ROOT, 'alpha')!.grants).toHaveLength(1);
    const r1 = removeGrant(ROOT, 'alpha', { mcp: 'wiki' });
    expect(r1.changed).toBe(true);
    const r2 = removeGrant(ROOT, 'alpha', { mcp: 'wiki' });
    expect(r2.changed).toBe(false);
    expect(readAgentAuth(ROOT, 'alpha')!.grants).toHaveLength(0);
  });

  it('denials 追加/移除（F2 编辑面词汇）', () => {
    addDenial(ROOT, 'alpha', { mcp: 'wiki' });
    expect(readAgentAuth(ROOT, 'alpha')!.denials).toEqual([{ mcp: 'wiki' }]);
    addDenial(ROOT, 'alpha', { mcp: 'wiki' }); // 幂等
    expect(readAgentAuth(ROOT, 'alpha')!.denials).toHaveLength(1);
    removeDenial(ROOT, 'alpha', { mcp: 'wiki' });
    expect(readAgentAuth(ROOT, 'alpha')!.denials).toHaveLength(0);
  });

  it('写者面变更后指纹漂移（B3 对拍依赖）', () => {
    const fp0 = authFingerprint(readGlobalAuth(ROOT), readAgentAuth(ROOT, 'alpha') ?? undefined);
    addGrant(ROOT, 'alpha', { mcp: 'wiki' });
    const fp1 = authFingerprint(readGlobalAuth(ROOT), readAgentAuth(ROOT, 'alpha') ?? undefined);
    expect(fp1).not.toBe(fp0);
  });
});

describe('mcp.json 清单（F1：独立文件）', () => {
  it('追加去重 / 移除 / 缺席 = 空表', () => {
    expect(readMcpManifest(ROOT).servers).toEqual([]);
    addMcpServer(ROOT, { name: 'wiki', url: 'http://x' });
    addMcpServer(ROOT, { name: 'wiki', url: 'http://y' }); // 同名幂等——首写保留
    expect(readMcpManifest(ROOT).servers).toEqual([{ name: 'wiki', url: 'http://x' }]);
    removeMcpServer(ROOT, 'wiki');
    expect(readMcpManifest(ROOT).servers).toEqual([]);
    removeMcpServer(ROOT, 'wiki'); // 缺位幂等
  });
});
