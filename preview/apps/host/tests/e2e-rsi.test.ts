// ============================================================
// M6.6 级联验收：RSI 影子闭环（真子进程壳）。
//   换装线：指纹对拍 → 变更 → 新壳 boot（真进程三节拍）→ 快照点 +
//           成功回执；失败线 → restore 回退 + 旧内容壳续跑 + 失败回执。
//   影子线：materializeChild → 影子壳（--parent-id 真进程）与父壳
//           并存各自锁 → mock run 收束判定 → delete 收割，父无扰动。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { subjectFingerprint } from 'ac-fingerprint-core';
import { materializeChild, readAgentConfig } from 'ac-agents-core';
import { deriveShellRowset, type RowsetCatalog } from 'ac-rowset-core';
import { evolveShell, defaultCollectProtectedFiles } from '../evolve.ts';
import { takeSnapshot } from 'ac-snapshot-core';
import { validateReceiptPayload } from 'ac-envelope-core';

const ROOT = path.join('preview', 'sandbox', 'test-rsi-' + process.pid);
const BOOT = fileURLToPath(new URL('../../shell/boot.ts', import.meta.url));
const CATALOG = fileURLToPath(new URL('../../catalog/row-catalog.json', import.meta.url));
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
// 收割兜底（cr-513 纪律）：只按 spawn 句柄精确 pid，禁扫进程表
const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const c of spawned.splice(0)) {
    try { if (c.exitCode === null) c.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

function seedAgent(agentId: string, extra: Record<string, unknown> = {}): void {
  const dir = path.join(ROOT, 'agents', agentId);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'config.json'), JSON.stringify({ id: agentId, model: 'mock', ...extra }), 'utf-8');
}

/** 真壳 adopt：spawn boot.ts → 等三节拍 → 取第四域（指纹根）→ shutdown 面 */
function realShell(dataRoot: string, agentId: string, parentId?: string) {
  return {
    adopt: () => new Promise<{ bootId: string; fingerprintRoot: string; shutdown: () => Promise<void> }>((resolve, reject) => {
      const args = ['--experimental-strip-types', BOOT, '--data-root', path.resolve(dataRoot), '--agent-id', agentId, '--catalog', CATALOG];
      if (parentId !== undefined) args.push('--parent-id', parentId);
      const child = spawn(process.execPath, args, { stdio: ['pipe', 'pipe', 'inherit'] });
      spawned.push(child);
      const lines: string[] = [];
      child.stdout.on('data', (c: Buffer) => { for (const l of c.toString().split('\n')) if (l.trim() !== '') lines.push(l); });
      const timer = setTimeout(() => reject(new Error('boot.ready 超时：' + lines.join(' | '))), 15_000);
      child.on('exit', (code) => { clearTimeout(timer); reject(new Error('壳进程早退 code=' + code)); });
      const iv = setInterval(() => {
        const ready = lines.find((l) => l.startsWith('boot.ready'));
        if (ready !== undefined) {
          clearTimeout(timer); clearInterval(iv);
          const [, , , root] = ready.split('\t');
          resolve({
            bootId: lines.find((l) => l.startsWith('boot.lock.acquired'))!.split('\t')[1],
            fingerprintRoot: root,
            shutdown: () => new Promise<void>((res) => {
              child.stdin.write('shutdown\n');
              child.on('exit', () => res());
            }),
          });
        }
      }, 50);
    }),
  };
}

/** 宿主侧同函数现算根（R-7 对拍半边——与 bootShell 同输入面：config + catalog + 行集派生内 path 行） */
function hostSideRoot(dataRoot: string, agentId: string): string {
  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf-8')) as RowsetCatalog;
  const config = JSON.parse(fs.readFileSync(path.join(dataRoot, 'agents', agentId, 'config.json'), 'utf-8')) as { tools?: unknown };
  // 行集派生走真函数（缺省 = 基础壳行集 = 非 bundle 行）——与 boot.ts 同口径，
  // 不再用「全部有 path 行」极简面（M8.1 第二批起 bundle 行也有 path，口径必须含 rowIds 过滤）
  const derived = deriveShellRowset({ rows: config.tools as string[] | undefined }, catalog);
  const rows = catalog.rows
    .filter((r) => r.tree === 'shell' && derived.rowIds.includes(r.id) && r.path !== undefined);
  const fp = subjectFingerprint({
    configJson: fs.readFileSync(path.join(dataRoot, 'agents', agentId, 'config.json'), 'utf-8'),
    catalogJson: fs.readFileSync(CATALOG, 'utf-8'),
    // path 数组适配与 boot.ts 同口径（一行跨多包 = 多指纹项）
    rows: rows.flatMap((r) => (Array.isArray(r.path) ? r.path : [r.path!])
      .map((p, i) => ({ id: Array.isArray(r.path) ? r.id + '/' + i : r.id, root: path.resolve(p) }))),
  });
  return fp.root;
}

describe('M6.6 RSI 影子闭环（级联验收）', () => {
  it('换装成功线：对拍 → 变更 → 真新壳 boot → 快照点 + 成功回执', async () => {
    seedAgent('w', { system: 'v1' });
    const inc = await realShell(ROOT, 'w').adopt();
    expect(inc.fingerprintRoot).toBe(hostSideRoot(ROOT, 'w')); // 两形态同源断言（真进程）
    await inc.shutdown();
    const out = await evolveShell({
      dataRoot: ROOT, agentId: 'w',
      incumbentRoot: inc.fingerprintRoot, expectedRoot: inc.fingerprintRoot,
      mutations: [{ rel: 'agents/w/config.json', content: JSON.stringify({ id: 'w', model: 'mock', system: 'v2' }) }],
      spawnShell: () => realShell(ROOT, 'w'),
    });
    expect(out.outcome).toBe('upgraded');
    expect(validateReceiptPayload(out.receipt)).toEqual([]);
    expect(out.receipt.rollbackTargets[0].root).toBe(out.root);
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'w', 'config.json'), 'utf-8')).system).toBe('v2');
  }, 45_000);

  it('换装失败线：验收拒 → restore 回退旧内容 + 旧内容壳续跑 + 失败回执', async () => {
    seedAgent('w', { system: 'v1' });
    const inc = await realShell(ROOT, 'w').adopt();
    await inc.shutdown();
    takeSnapshot(ROOT, { root: inc.fingerprintRoot, evidence: 'boot-smoke' }, defaultCollectProtectedFiles(ROOT, 'w'));
    const out = await evolveShell({
      dataRoot: ROOT, agentId: 'w',
      incumbentRoot: inc.fingerprintRoot, expectedRoot: inc.fingerprintRoot,
      mutations: [{ rel: 'agents/w/config.json', content: JSON.stringify({ id: 'w', model: 'mock', system: 'BAD' }) }],
      spawnShell: () => realShell(ROOT, 'w'),
      acceptance: { check: async () => ({ ok: false, reason: 'mock run 未收束' }) },
    });
    expect(out.outcome).toBe('rolled-back');
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'w', 'config.json'), 'utf-8')).system).toBe('v1');
    expect(validateReceiptPayload(out.receipt)).toEqual([]);
    expect(out.receipt.rolledBackTo!.root).toBe(inc.fingerprintRoot);
    // 旧内容壳续跑（回退后 boot 仍可拉起——rollback 非 retry）
    const again = await realShell(ROOT, 'w').adopt();
    expect(again.fingerprintRoot).toBe(inc.fingerprintRoot);
    await again.shutdown();
  }, 45_000);

  it('影子线：materializeChild → 影子壳与父并存（各自锁）→ 收割 delete，父无扰动', async () => {
    seedAgent('w', { model: 'mock' });
    const parent = await realShell(ROOT, 'w').adopt();
    // 影子物化（R-5：父身份剥减快照）
    const parentConfig = readAgentConfig(ROOT, 'w')!;
    materializeChild(ROOT, 'w', 'w-shadow', parentConfig);
    // 影子壳真进程（children 域锁——不撞父锁）
    const shadow = await realShell(ROOT, 'w-shadow', 'w').adopt();
    expect(fs.existsSync(path.join(ROOT, 'agents', 'w', 'activation.lock'))).toBe(true);
    expect(fs.existsSync(path.join(ROOT, 'agents', 'w', 'children', 'w-shadow', 'activation.lock'))).toBe(true);
    expect(shadow.fingerprintRoot).not.toBe(parent.fingerprintRoot); // 派生身份 = 不同主体
    // mock run 收束判定（架构轴替身——bench 门归 cutover）
    const verdict = { ok: shadow.fingerprintRoot.length === 64 };
    expect(verdict.ok).toBe(true);
    // 收割：影子 shutdown + 目录 delete（探查残留消化——R-5 代价诚实清单）
    await shadow.shutdown();
    fs.rmSync(path.join(ROOT, 'agents', 'w', 'children', 'w-shadow'), { recursive: true, force: true });
    // 父壳全程无扰动（仍持有锁与原根）
    expect(fs.existsSync(path.join(ROOT, 'agents', 'w', 'activation.lock'))).toBe(true);
    await parent.shutdown();
  }, 45_000);
});
