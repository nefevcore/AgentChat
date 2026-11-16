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
import { materializeChild, readAgentConfig, readAgentPatchV3At, writeAgentConfig, agentDir } from 'ac-agents-core';
import type { RowsetCatalog } from 'ac-rowset-core';
import { evolveShell, defaultCollectProtectedFiles } from '../evolve.ts';
import { takeSnapshot } from 'ac-snapshot-core';
import { validateReceiptPayload, waitForShellReady, readBootProgress, manageRoundTrip } from 'ac-envelope-core';

const ROOT = path.join('sandbox', 'test-rsi-' + process.pid);
const BOOT = fileURLToPath(new URL('../../shell/boot.ts', import.meta.url));
const CATALOG = fileURLToPath(new URL('../../catalog/row-catalog.json', import.meta.url));
beforeEach(() => {
  fs.mkdirSync(ROOT, { recursive: true });
  // v3 播种与指纹对拍都需数据根内目录（writeAgentConfig 定义拷贝面）
  fs.copyFileSync(CATALOG, path.join(ROOT, 'row-catalog.json'));
});
// 收割兜底（cr-513 纪律）：只按 spawn 句柄精确 pid，禁扫进程表
const spawned: ChildProcess[] = [];
afterEach(() => {
  for (const c of spawned.splice(0)) {
    try { if (c.exitCode === null) c.kill('SIGKILL'); } catch { /* 已退出 */ }
  }
  fs.rmSync(ROOT, { recursive: true, force: true });
});

// 播种 = v3 菜单片段（cr-1022 批3：boot 对 config.json-only 旧形态 fail-loud
// ——「先迁移」；变更标记用 name〔system 已退役，name 随 agent.json 档案
// 进指纹输入〕）
function seedAgent(agentId: string, extra: Record<string, unknown> = {}): void {
  writeAgentConfig(ROOT, { id: agentId, model: 'mock', ...extra } as Parameters<typeof writeAgentConfig>[1]);
}

/** 真壳 adopt：spawn boot.ts → 等三节拍 → 取第四域（指纹根）→ shutdown 面 */
function realShell(dataRoot: string, agentId: string, parentId?: string) {
  return {
    adopt: () => new Promise<{ bootId: string; fingerprintRoot: string; shutdown: () => Promise<void> }>((resolve, reject) => {
      const args = ['--experimental-strip-types', BOOT, '--data-root', path.resolve(dataRoot), '--agent-id', agentId, '--catalog', CATALOG];
      if (parentId !== undefined) args.push('--parent-id', parentId);
      const child = spawn(process.execPath, args, { stdio: ['ignore', 'ignore', 'inherit'] });
      spawned.push(child);
      // 就绪判据 = 锁 + probeIpc 实连；bootId/指纹取自锁与 boot-progress
      //（stdio ignore——stdout 无管道，诊断走 stderr inherit）
      const agentDir = path.join(dataRoot, 'agents', parentId !== undefined ? path.join(parentId, 'children', agentId) : agentId);
      child.on('exit', (code) => { reject(new Error('壳进程早退 code=' + code)); });
      void (async () => {
        const lock = await waitForShellReady(agentDir, 15_000);
        const progress = readBootProgress(agentDir);
        const root = progress !== null && progress.bootId === lock.bootId ? progress.fingerprintRoot : undefined;
        if (root === undefined) throw new Error('boot-progress 缺 fingerprintRoot（终拍未达）');
        resolve({
            bootId: lock.bootId,
            fingerprintRoot: root,
            shutdown: () => new Promise<void>((res) => {
              void manageRoundTrip(lock.transportHint, { ctrl: 'system', op: 'shutdown' }, 5_000).catch(() => { /* kill 兜底 */ });
              child.on('exit', () => res());
            }),
        });
      })();
    }),
  };
}

/** 伴生行包根（boot.ts 指纹面的装配代码真值镜像——ac-shell-rows
 * COMPANION_ROW_ROOTS 冻结副本：host 测试不引 shell 行包依赖） */
const COMPANION_ROW_ROOTS: Record<string, string> = {
  'fs-tools': 'packages/ac-file-snapshots',
};

/** workspace 依赖闭包（boot.ts workspaceClosureRoots 的冻结镜像：包根 +
 * 递归 dependencies 中 workspace:/link: 协议包——运行时足迹） */
function closureRoots(pkgRoot: string): string[] {
  const out: string[] = [];
  const visited = new Set<string>();
  const walk = (dir: string): void => {
    const resolved = path.resolve(dir);
    if (visited.has(resolved)) return;
    visited.add(resolved);
    out.push(resolved);
    let deps: Record<string, string> = {};
    try {
      deps = (JSON.parse(fs.readFileSync(path.join(resolved, 'package.json'), 'utf-8')) as { dependencies?: Record<string, string> }).dependencies ?? {};
    } catch { /* 坏 package.json——包根本身仍在指纹面 */ }
    for (const spec of Object.values(deps)) {
      const m = /^(?:workspace|link):(.+)$/.exec(spec);
      if (m !== null) walk(path.resolve(resolved, '..', m[1]!));
    }
  };
  walk(pkgRoot);
  return out;
}

/** 宿主侧同函数现算根（R-7 对拍半边——与 bootShell 同输入面：config +
 * catalog + 菜单行〔骨架 ∪ v3 定义〕包根 × 依赖闭包，cr-1022 批3 口径） */
function hostSideRoot(dataRoot: string, agentId: string): string {
  const catalog = JSON.parse(fs.readFileSync(CATALOG, 'utf-8')) as RowsetCatalog;
  const v3 = readAgentPatchV3At(agentDir(dataRoot, agentId))!;
  const menuIds = new Set([
    ...catalog.rows.filter((r) => r.tree === 'shell' && r.zone === 'skeleton').map((r) => r.id),
    ...v3.defs.map((d) => d.id),
  ]);
  const rows = catalog.rows
    .filter((r) => r.tree === 'shell' && r.path !== undefined && menuIds.has(r.id))
    .flatMap((r) => {
      const roots = closureRoots(r.path as string);
      const companion = COMPANION_ROW_ROOTS[r.id];
      if (companion !== undefined) roots.push(...closureRoots(companion));
      return roots.map((root, i) => ({ id: i === 0 ? r.id : r.id + '/' + path.basename(root), root: path.resolve(root) }));
    });
  const fp = subjectFingerprint({
    configJson: JSON.stringify(readAgentConfig(dataRoot, agentId)), // cr-918：与 shell boot 同读面（patch 赢）
    catalogJson: fs.readFileSync(CATALOG, 'utf-8'),
    rows,
  });
  return fp.root;
}

describe('M6.6 RSI 影子闭环（级联验收）', () => {
  it('换装成功线：对拍 → 变更 → 真新壳 boot → 快照点 + 成功回执', async () => {
    seedAgent('w', { name: 'v1' });
    const inc = await realShell(ROOT, 'w').adopt();
    expect(inc.fingerprintRoot).toBe(hostSideRoot(ROOT, 'w')); // 两形态同源断言（真进程）
    await inc.shutdown();
    const out = await evolveShell({
      dataRoot: ROOT, agentId: 'w',
      incumbentRoot: inc.fingerprintRoot, expectedRoot: inc.fingerprintRoot,
      mutations: [{ rel: 'agents/w/agent.json', content: JSON.stringify({ model: 'mock', name: 'v2' }) }],
      spawnShell: () => realShell(ROOT, 'w'),
    });
    expect(out.outcome).toBe('upgraded');
    expect(validateReceiptPayload(out.receipt)).toEqual([]);
    expect(out.receipt.rollbackTargets[0].root).toBe(out.root);
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'w', 'agent.json'), 'utf-8')).name).toBe('v2');
  }, 45_000);

  it('换装失败线：验收拒 → restore 回退旧内容 + 旧内容壳续跑 + 失败回执', async () => {
    seedAgent('w', { name: 'v1' });
    const inc = await realShell(ROOT, 'w').adopt();
    await inc.shutdown();
    takeSnapshot(ROOT, { root: inc.fingerprintRoot, evidence: 'boot-smoke' }, defaultCollectProtectedFiles(ROOT, 'w'));
    const out = await evolveShell({
      dataRoot: ROOT, agentId: 'w',
      incumbentRoot: inc.fingerprintRoot, expectedRoot: inc.fingerprintRoot,
      mutations: [{ rel: 'agents/w/agent.json', content: JSON.stringify({ model: 'mock', name: 'BAD' }) }],
      spawnShell: () => realShell(ROOT, 'w'),
      acceptance: { check: async () => ({ ok: false, reason: 'mock run 未收束' }) },
    });
    expect(out.outcome).toBe('rolled-back');
    expect(JSON.parse(fs.readFileSync(path.join(ROOT, 'agents', 'w', 'agent.json'), 'utf-8')).name).toBe('v1');
    expect(validateReceiptPayload(out.receipt)).toEqual([]);
    expect(out.receipt.rolledBackTo!.root).toBe(inc.fingerprintRoot);
    // 旧内容壳续跑（回退后 boot 仍可拉起——rollback 非 retry）
    const again = await realShell(ROOT, 'w').adopt();
    // 跨 boot 的指纹恒等不可达：boot-graph.json 审计快照（at 时间戳）在
    // 指纹求值前落盘并经单元文件读并进 config——每次 boot 的根必含新时戳。
    // 断言换两形态同源面（自报根 == 宿主侧同函数现算根——R-7 不变量本体）
    expect(again.fingerprintRoot).toBe(hostSideRoot(ROOT, 'w'));
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
