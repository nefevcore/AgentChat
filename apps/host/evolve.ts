// ============================================================
// evolve.ts —— 换装编排（M6.4；五步闭环步 2+3 + 4 + 5 的宿主侧线）
//
// 流程（R-7/R-8/D5）：
//   ① 指纹对拍：现任壳自报根 vs 宿主侧同函数现算根（漂移 = fail-loud 前置）
//   ② 现任收束：优雅 shutdown（放锁——迁移语义）
//   ③ 变更：apply(input.mutations)（文件级变更集）
//   ④ 新壳拉起 + 验收门：boot 三节拍（boot-smoke）+ 可选 run 收束判定（注入）
//   ⑤ 通过 → takeSnapshot（新 last known good）+ 成功回执；失败 → restore 回退
//      + 旧壳重拉 + 失败回执（回退到快照链上最近 good 点，不 retry 新版本）
// 进程 IO（spawn/shutdown）与变更应用、验收判定全部注入——编排纯域可测。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { takeSnapshot, restoreSnapshot, rollbackTargets, readSnapshotChain } from 'ac-snapshot-core';
import type { ReceiptPayload, RollbackTargetRef } from 'ac-envelope-core';

/** 文件变更集（步 ③ 输入） */
export interface FileMutation {
  /** 相对数据根路径（ posix） */
  rel: string;
  content: string | null; // null = 删除
}

/** 壳进程操作面（注入——真 spawn / 测试替身同构） */
export interface ShellHandle {
  /** 拉起壳直到 boot.ready（adopt 形态），返回自报主体根。失败抛错。 */
  adopt(): Promise<{ bootId: string; fingerprintRoot: string; shutdown(): Promise<void> }>;
}

/** 验收判定（步 ⑤ 门——run 收束判定注入；缺省只看 boot-smoke） */
export interface AcceptanceGateResult { ok: boolean; reason?: string }
export interface AcceptanceGate {
  check(shell: { fingerprintRoot: string }): Promise<AcceptanceGateResult>;
}

export interface EvolveInput {
  dataRoot: string;
  agentId: string;
  /** 现任自报根（对拍用） */
  incumbentRoot: string;
  /** 宿主侧同函数现算根（R-7 两侧同算法） */
  expectedRoot: string;
  mutations: FileMutation[];
  /** 拉壳面（现任重拉与新壳拉起共用——闭包捕获当前盘态） */
  spawnShell: () => ShellHandle;
  /** 快照保护面文件集读取器（默认 = 数据根内 agent 域文件全集） */
  collectProtectedFiles?: (dataRoot: string, agentId: string) => Array<{ path: string; content: string }>;
  acceptance?: AcceptanceGate;
  evidence?: 'boot-smoke' | 'run-settled' | 'bench-gate';
  note?: string;
  now?: () => Date;
}

export interface EvolveOutcome {
  outcome: 'upgraded' | 'rolled-back';
  /** 升级生效根（upgraded）/ 回退至根（rolled-back） */
  root: string;
  snapshotId: string;
  receipt: ReceiptPayload;
  /** 回退时被撤销的变更集（诊断面） */
  reason?: string;
}

/** 默认保护面：agents/<id>/ 域内全部普通文件（相对数据根） */
export function defaultCollectProtectedFiles(dataRoot: string, agentId: string): Array<{ path: string; content: string }> {
  const dir = path.join(dataRoot, 'agents', agentId);
  const out: Array<{ path: string; content: string }> = [];
  const walk = (d: string, rel: string) => {
    let entries: fs.Dirent[];
    try {
      entries = fs.readdirSync(d, { withFileTypes: true });
    } catch {
      return;
    }
    for (const ent of entries) {
      if (ent.name === 'activation.lock' || ent.name.startsWith('activation.lock.')) continue;
      if (ent.name === 'received.jsonl') continue; // 会话运行期产物——数据轴非结构轴
      if (ent.name === 'sessions') continue; // 账本 = 数据（D4），不进结构快照
      const r = rel === '' ? ent.name : rel + '/' + ent.name;
      if (ent.isDirectory()) walk(path.join(d, ent.name), r);
      else if (ent.isFile()) out.push({ path: r, content: fs.readFileSync(path.join(d, ent.name), 'utf-8') });
    }
  };
  walk(dir, '');
  return out;
}

/** 回执的三元组列（链上现况——最新在前） */
function targetsOf(dataRoot: string): RollbackTargetRef[] {
  return rollbackTargets(dataRoot).map((t) => ({
    root: t.root,
    snapshotId: t.snapshotId,
    takenAt: t.takenAt,
    evidence: t.evidence,
    ...(t.epoch !== undefined ? { epoch: t.epoch } : {}),
  }));
}

/**
 * 换装主流程。前置失败（指纹对拍不过）直接抛错——不动盘面。
 */
export async function evolveShell(input: EvolveInput): Promise<EvolveOutcome> {
  // ① 指纹对拍（两形态同源断言——漂移即停，不进换装）
  if (input.incumbentRoot !== input.expectedRoot) {
    throw new Error('指纹对拍失败：现任自报 ' + input.incumbentRoot + ' ≠ 宿主现算 ' + input.expectedRoot + '——fail-loud（两形态同源漂移）');
  }
  const collect = input.collectProtectedFiles ?? defaultCollectProtectedFiles;
  // ② 现任收束（放锁）
  // （现任 shutdown 由调用方在 spawnShell 切换前完成——本函数不持有现任句柄，
  //  收束与放锁语义归属编排调用面；evolve 只要求 adopt() 可用）
  // ③ 变更
  for (const m of input.mutations) {
    const dest = path.join(input.dataRoot, m.rel.replaceAll('\\', '/'));
    if (m.content === null) {
      fs.rmSync(dest, { force: true });
      continue;
    }
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.writeFileSync(dest, m.content, 'utf-8');
  }
  // ④ 新壳拉起 + 验收门
  const gate = input.acceptance ?? { check: () => Promise.resolve({ ok: true }) };
  let verdict: { ok: boolean; reason?: string };
  let shellRoot: string;
  try {
    const shell = input.spawnShell();
    const adopted = await shell.adopt();
    shellRoot = adopted.fingerprintRoot;
    verdict = await gate.check({ fingerprintRoot: shellRoot });
    if (!verdict.ok) await adopted.shutdown().catch(() => {});
    else await adopted.shutdown().catch(() => {});
  } catch (err) {
    verdict = { ok: false, reason: String(err) };
    shellRoot = input.incumbentRoot;
  }
  // ⑤ 判定分流
  if (verdict.ok) {
    const meta = takeSnapshot(input.dataRoot, {
      root: shellRoot,
      evidence: input.evidence ?? 'boot-smoke',
      ...(input.note !== undefined ? { note: input.note } : {}),
      ...(input.now !== undefined ? { now: input.now } : {}),
    }, collect(input.dataRoot, input.agentId));
    return {
      outcome: 'upgraded',
      root: shellRoot,
      snapshotId: meta.id,
      receipt: {
        subject: 'upgrade-success', root: shellRoot, agent: input.agentId, ok: true,
        snapshotId: meta.id,
        rollbackTargets: targetsOf(input.dataRoot),
      },
    };
  }
  // 失败线：回退最近快照（链空 = 报错——无 good 点可退，人unsupervised 保底）
  const chain = readSnapshotChain(input.dataRoot);
  const last = chain.snapshots.at(-1);
  if (last === undefined) {
    throw new Error('换装失败且快照链空——无 last known good 可回退（保底：人工介入）。原因：' + (verdict.reason ?? ''));
  }
  restoreSnapshot(input.dataRoot, last.id, path.join(input.dataRoot, 'agents', input.agentId), { verifyRoot: last.root });
  // 旧壳（旧内容）重拉自证
  const backShell = input.spawnShell();
  const backAdopted = await backShell.adopt();
  await backAdopted.shutdown().catch(() => {});
  return {
    outcome: 'rolled-back',
    root: last.root,
    snapshotId: last.id,
    reason: verdict.reason,
    receipt: {
      subject: 'upgrade-failed', root: input.incumbentRoot, agent: input.agentId, ok: false,
      rolledBackTo: { snapshotId: last.id, root: last.root },
      rollbackTargets: targetsOf(input.dataRoot),
      ...(verdict.reason !== undefined ? { reason: verdict.reason } : {}),
    },
  };
}
