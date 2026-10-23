// ============================================================
// M6.4 换装编排单测（替身壳——编排纯域）：成功线（新快照 + 成功回执）/
// 失败线（restore 回退 + 旧内容壳续跑 + 失败回执）/ 对拍前置 fail-loud /
// 链空无退点报错。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';
import { evolveShell, defaultCollectProtectedFiles, type ShellHandle, type FileMutation } from '../evolve.ts';
import { takeSnapshot, readSnapshotChain } from 'ac-snapshot-core';
import { validateReceiptPayload } from 'ac-envelope-core';

const ROOT = path.join('preview', 'sandbox', 'test-evolve-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function seedAgent(agentId: string, files: Record<string, string>): void {
  for (const [rel, content] of Object.entries(files)) {
    const dest = path.join(ROOT, 'agents', agentId, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, content, 'utf-8');
  }
}

// 替身壳：adopt 读盘面现算（config 内容回显——验证 boot 后盘态）；可注入失败
function fakeShell(dataRoot: string, agentId: string, opts: { adoptFails?: boolean } = {}): ShellHandle {
  return {
    adopt: async () => {
      if (opts.adoptFails) throw new Error('替身壳 boot 失败');
      const config = fs.readFileSync(path.join(dataRoot, 'agents', agentId, 'config.json'), 'utf-8');
      const root = 'root-' + createHash('sha256').update(config).digest('hex').slice(0, 16);
      return {
        bootId: 'boot-' + Math.random().toString(36).slice(2, 8),
        fingerprintRoot: root,
        shutdown: async () => {},
      };
    },
  };
}

describe('M6.4 evolveShell 换装编排', () => {
  it('成功线：变更 → 新壳 boot → 快照 + 成功回执（三元组列）', async () => {
    seedAgent('alpha', { 'config.json': JSON.stringify({ id: 'alpha', model: 'm1' }) });
    const inc = fakeShell(ROOT, 'alpha');
    const incumbentRoot = (await inc.adopt()).fingerprintRoot;
    const mutations: FileMutation[] = [
      { rel: 'agents/alpha/config.json', content: JSON.stringify({ id: 'alpha', model: 'm2' }) },
    ];
    const out = await evolveShell({
      dataRoot: ROOT, agentId: 'alpha',
      incumbentRoot, expectedRoot: incumbentRoot,
      mutations,
      spawnShell: () => fakeShell(ROOT, 'alpha'),
    });
    expect(out.outcome).toBe('upgraded');
    expect(out.root).not.toBe(incumbentRoot);
    expect(readSnapshotChain(ROOT).snapshots).toHaveLength(1);
    expect(out.receipt.subject).toBe('upgrade-success');
    expect(out.receipt.snapshotId).toBe('snap-000001');
    expect(validateReceiptPayload(out.receipt)).toEqual([]);
    expect(out.receipt.rollbackTargets[0]).toMatchObject({ snapshotId: 'snap-000001', root: out.root });
    // 盘面已是新内容
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'alpha', 'config.json'), 'utf-8')).model).toBe('m2');
  });

  it('失败线：验收门拒 → restore 回退 + 旧内容壳重拉 + 失败回执（rollback 非 retry）', async () => {
    seedAgent('beta', { 'config.json': JSON.stringify({ id: 'beta', model: 'm1' }) });
    const inc = fakeShell(ROOT, 'beta');
    const incumbentRoot = (await inc.adopt()).fingerprintRoot;
    // 先拍基线快照（回退点）
    takeSnapshot(ROOT, { root: incumbentRoot, evidence: 'boot-smoke' }, defaultCollectProtectedFiles(ROOT, 'beta'));
    const out = await evolveShell({
      dataRoot: ROOT, agentId: 'beta',
      incumbentRoot, expectedRoot: incumbentRoot,
      mutations: [{ rel: 'agents/beta/config.json', content: JSON.stringify({ id: 'beta', model: 'BAD' }) }],
      spawnShell: () => fakeShell(ROOT, 'beta'),
      acceptance: { check: async () => ({ ok: false, reason: 'run 未收束（mock 判定）' }) },
    });
    expect(out.outcome).toBe('rolled-back');
    expect(out.root).toBe(incumbentRoot);
    // 盘面回退旧内容
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'beta', 'config.json'), 'utf-8')).model).toBe('m1');
    // 失败回执
    expect(out.receipt.subject).toBe('upgrade-failed');
    expect(out.receipt.rolledBackTo).toMatchObject({ root: incumbentRoot });
    expect(validateReceiptPayload(out.receipt)).toEqual([]);
    expect(out.reason).toContain('run 未收束');
  });

  it('对拍前置 fail-loud：现任自报 ≠ 宿主现算 → 抛错不动盘面', async () => {
    seedAgent('gamma', { 'config.json': JSON.stringify({ id: 'gamma' }) });
    await expect(evolveShell({
      dataRoot: ROOT, agentId: 'gamma',
      incumbentRoot: 'aaa', expectedRoot: 'bbb',
      mutations: [],
      spawnShell: () => fakeShell(ROOT, 'gamma'),
    })).rejects.toThrow(/指纹对拍失败/);
  });

  it('失败且链空：无 good 点可退 → 报错（保底面）', async () => {
    seedAgent('delta', { 'config.json': JSON.stringify({ id: 'delta' }) });
    const inc = fakeShell(ROOT, 'delta');
    const incumbentRoot = (await inc.adopt()).fingerprintRoot;
    await expect(evolveShell({
      dataRoot: ROOT, agentId: 'delta',
      incumbentRoot, expectedRoot: incumbentRoot,
      mutations: [],
      spawnShell: () => fakeShell(ROOT, 'delta', { adoptFails: true }),
    })).rejects.toThrow(/快照链空/);
  });
});
