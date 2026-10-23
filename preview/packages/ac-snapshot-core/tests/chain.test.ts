// ============================================================
// 6.1 快照链单测：链账单调 + GFS 分代轮转 + epoch 永久 +
// 回滚目标三元组 + 恢复完整性校验（fail-loud 面）。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import {
  takeSnapshot, rotate, rollbackTargets, restoreSnapshot, readSnapshotChain,
  DEFAULT_GFS, type SnapshotChain,
} from '../src/index.ts';

const ROOT = path.join('preview', 'sandbox', 'test-snap-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

const files = (n: number) => [{ path: 'pkg/a.ts', content: 'A' + n }, { path: 'pkg/sub/b.json', content: '{"n":' + n + '}' }];

// 指定时刻拍快照（takenAt 可控——分代判定需要）
function takeAt(root: string, n: number, takenAt: string, extra: { epoch?: string; evidence?: 'boot-smoke' | 'run-settled' | 'bench-gate' } = {}) {
  return takeSnapshot(ROOT, {
    root,
    evidence: extra.evidence ?? 'boot-smoke',
    now: () => new Date(takenAt),
    ...(extra.epoch !== undefined ? { epoch: extra.epoch } : {}),
  }, files(n));
}

describe('M6.1 ac-snapshot-core 快照链', () => {
  it('拍快照：链账追加 + id 单调 + 内容清单完整', () => {
    const s1 = takeSnapshot(ROOT, { root: 'r1', evidence: 'boot-smoke' }, files(1));
    const s2 = takeSnapshot(ROOT, { root: 'r2', evidence: 'run-settled' }, files(2));
    expect(s1.id).toBe('snap-000001');
    expect(s2.id).toBe('snap-000002');
    const chain = readSnapshotChain(ROOT);
    expect(chain.snapshots.map((s) => s.root)).toEqual(['r1', 'r2']);
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'snapshots', s2.id, 'snapshot.json'), 'utf-8'));
    expect(Object.keys(manifest).sort()).toEqual(['pkg/a.ts', 'pkg/sub/b.json']);
  });

  it('恢复：内容覆盖写 + 完整性校验 + 根不匹配 fail-loud', () => {
    const s = takeSnapshot(ROOT, { root: 'r1', evidence: 'boot-smoke' }, files(1));
    const target = path.join(ROOT, 'restore-target');
    const { files: restored, meta } = restoreSnapshot(ROOT, s.id, target);
    expect(restored.sort()).toEqual(['pkg/a.ts', 'pkg/sub/b.json']);
    expect(fs.readFileSync(path.join(target, 'pkg/a.ts'), 'utf-8')).toBe('A1');
    expect(meta.id).toBe(s.id);
    // 覆盖写（第二次恢复旧快照覆盖新内容）
    takeSnapshot(ROOT, { root: 'r2', evidence: 'boot-smoke' }, files(9));
    restoreSnapshot(ROOT, s.id, target);
    expect(fs.readFileSync(path.join(target, 'pkg/a.ts'), 'utf-8')).toBe('A1');
    // 篡改快照内容 → 拒恢复
    fs.writeFileSync(path.join(ROOT, 'snapshots', s.id, 'pkg/a.ts'), 'TAMPERED', 'utf-8');
    expect(() => restoreSnapshot(ROOT, s.id, target)).toThrow(/完整性失败/);
    // 根不匹配
    const s2 = readSnapshotChain(ROOT).snapshots[1];
    expect(() => restoreSnapshot(ROOT, s2.id, target, { verifyRoot: 'r1' })).toThrow(/根不匹配/);
    // 不在链上
    expect(() => restoreSnapshot(ROOT, 'snap-999999', target)).toThrow(/不在链上/);
  });

  it('回滚目标列：三元组最新在前 + epoch 字段透传', () => {
    takeAt('r1', 1, '2026-10-18T08:00:00Z');
    takeAt('r2', 2, '2026-10-18T12:00:00Z', { epoch: 'merkle-v2' });
    takeAt('r3', 3, '2026-10-19T09:00:00Z');
    const targets = rollbackTargets(ROOT);
    expect(targets.map((t) => t.root)).toEqual(['r3', 'r2', 'r1']);
    expect(targets[1]).toMatchObject({ root: 'r2', epoch: 'merkle-v2' });
    expect(targets[0].takenAt.slice(0, 19)).toBe('2026-10-19T09:00:00');
    expect(targets.every((t) => 'evidence' in t)).toBe(true);
  });

  it('GFS：同日多份只留最新 + 跨日保留 + epoch 永久', () => {
    takeAt('r1', 1, '2026-10-17T08:00:00Z');
    takeAt('r2', 2, '2026-10-17T10:00:00Z');
    takeAt('r3', 3, '2026-10-17T12:00:00Z'); // 同日第三份（> recentKeep? K=3 恰在界内）
    takeAt('r4', 4, '2026-10-17T14:00:00Z', { epoch: 'e1' }); // epoch 点
    takeAt('r5', 5, '2026-10-18T08:00:00Z');
    takeAt('r6', 6, '2026-10-18T09:00:00Z');
    takeAt('r7', 7, '2026-10-19T08:00:00Z');
    const removed = rotate(ROOT, readSnapshotChain(ROOT), { recentKeep: 2, dailyKeep: 1, weeklyKeep: 1 });
    const kept = readSnapshotChain(ROOT).snapshots.map((s) => s.root);
    // recent 2 = r7 r6；同周代并入 recent；17 日代 = r4（epoch 兼最远）；18 日代 = r6（并入 recent）
    expect(kept).toEqual(['r4', 'r6', 'r7']);
    expect(removed.sort()).toEqual(['snap-000001', 'snap-000002', 'snap-000003', 'snap-000005']);
    // 内容目录已删
    expect(fs.existsSync(path.join(ROOT, 'snapshots', 'snap-000001'))).toBe(false);
  });

  it('GFS 缺省参数：连续同向跑偏不整链同亡（K 份外的旧日代留桥）', () => {
    takeAt('r1', 1, '2026-10-16T08:00:00Z');
    takeAt('r2', 2, '2026-10-17T08:00:00Z');
    takeAt('r3', 3, '2026-10-18T08:00:00Z');
    takeAt('r4', 4, '2026-10-19T08:00:00Z');
    takeAt('r5', 5, '2026-10-19T09:00:00Z');
    const removed = rotate(ROOT, readSnapshotChain(ROOT), DEFAULT_GFS);
    expect(removed).toEqual([]); // recent3 吸收 19 日两份；16/17/18 各留日代——全保
    const kept = readSnapshotChain(ROOT).snapshots.map((s) => s.root);
    expect(kept).toEqual(['r1', 'r2', 'r3', 'r4', 'r5']);
    expect(DEFAULT_GFS.recentKeep).toBe(3);
  });
});
