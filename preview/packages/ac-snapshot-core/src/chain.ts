// ============================================================
// chain.ts —— 快照链：链账 + 内容目录 + GFS 分代 + 回滚目标列
//
// 布局（<dataRoot>/snapshots/——物理外置于变更面，D6 原子二）：
//   snapshots/
//     chain.json          链账（全部快照点元数据，additive-only）
//     <snapId>/           内容目录（被拍文件集的完整拷贝）
//       snapshot.json     该快照的文件清单（路径 → sha256）
// 两轴：轴一（本库）保护面 = 目标目录文件集（代码/配置——结构态
// 与数据不在快照面：registry.json/熔断计数归宿主态，sessions 归
// 数据轴备份）；轴二（D6 快照链分轴）数据备份 = ac-backup 时基，
// 两机制分轴不互替。
// ============================================================

import * as fs from 'node:fs';
import * as path from 'node:path';
import { createHash } from 'node:crypto';

/** 单快照元数据（chain.json 内一行） */
export interface SnapshotMeta {
  /** 快照 id（单调：snap-000001 形态——链序即恢复序） */
  id: string;
  /** 拍摄时主体指纹根（R-7 Merkle 根——回滚目标坐标） */
  root: string;
  /** 拍摄时刻（ISO） */
  takenAt: string;
  /** 健康证据（R-8 判定分层词汇：boot-smoke / run-settled / bench-gate） */
  evidence: 'boot-smoke' | 'run-settled' | 'bench-gate';
  /** epoch 标记（非空 = epoch 边界点，永久保留） */
  epoch?: string;
  /** 注释性伴随（git commit 等——缺席不失效） */
  note?: string;
}

/** 链账（chain.json 全量形态） */
export interface SnapshotChain {
  version: 1;
  snapshots: SnapshotMeta[];
}

/** GFS 分代参数（R-8 残余本批钉：K=3 recent；日/周各留最远一代） */
export interface GfsParams {
  /** 最近 K 份保留（高频贬值快） */
  recentKeep: number;
  /** 每日代保留数（当日最远一份） */
  dailyKeep: number;
  /** 每周代保留数（该周最远一份） */
  weeklyKeep: number;
}

export const DEFAULT_GFS: GfsParams = { recentKeep: 3, dailyKeep: 1, weeklyKeep: 1 };

const CHAIN_FILE = 'chain.json';
const SNAPSHOT_MANIFEST = 'snapshot.json';

function snapshotsDir(dataRoot: string): string {
  return path.join(dataRoot, 'snapshots');
}

function sha256File(file: string): string {
  return createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function sha256Content(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex');
}

function readChain(dataRoot: string): SnapshotChain {
  try {
    const parsed = JSON.parse(fs.readFileSync(path.join(snapshotsDir(dataRoot), CHAIN_FILE), 'utf-8')) as Partial<SnapshotChain>;
    if (Array.isArray(parsed.snapshots)) return { version: 1, snapshots: parsed.snapshots as SnapshotMeta[] };
  } catch {
    // 缺席 = 空链
  }
  return { version: 1, snapshots: [] };
}

function writeChainAtomic(dataRoot: string, chain: SnapshotChain): void {
  const dir = snapshotsDir(dataRoot);
  fs.mkdirSync(dir, { recursive: true });
  const file = path.join(dir, CHAIN_FILE);
  const tmp = file + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(chain, null, 2), 'utf-8');
  fs.renameSync(tmp, file);
}

function nextSnapId(chain: SnapshotChain): string {
  const last = chain.snapshots.at(-1);
  const n = last === undefined ? 1 : Number.parseInt(last.id.slice('snap-'.length), 10) + 1;
  return 'snap-' + String(n).padStart(6, '0');
}

/** 拍快照（主体指纹根 + 保护面文件集 → 内容目录 + 链账追加）。返回新快照元数据。
 * 轮转独立调用（rotate）——拍与轮转是两个动作（R-8 事件基触发各自独立）。 */
export function takeSnapshot(
  dataRoot: string,
  input: { root: string; evidence: SnapshotMeta['evidence']; epoch?: string; note?: string; now?: () => Date },
  files: Array<{ path: string; content: string }>,
): SnapshotMeta {
  const chain = readChain(dataRoot);
  const id = nextSnapId(chain);
  const meta: SnapshotMeta = {
    id,
    root: input.root,
    takenAt: (input.now ?? (() => new Date))().toISOString(),
    evidence: input.evidence,
    ...(input.epoch !== undefined ? { epoch: input.epoch } : {}),
    ...(input.note !== undefined ? { note: input.note } : {}),
  };
  // 内容目录拷贝（完整性清单同写）
  const dir = path.join(snapshotsDir(dataRoot), id);
  fs.mkdirSync(dir, { recursive: true });
  const manifest: Record<string, string> = {};
  for (const f of files) {
    const rel = f.path.replaceAll('\\', '/');
    fs.mkdirSync(path.dirname(path.join(dir, rel)), { recursive: true });
    fs.writeFileSync(path.join(dir, rel), f.content, 'utf-8');
    manifest[rel] = sha256Content(f.content);
  }
  fs.writeFileSync(path.join(dir, SNAPSHOT_MANIFEST), JSON.stringify(manifest, null, 2), 'utf-8');
  chain.snapshots.push(meta);
  writeChainAtomic(dataRoot, chain);
  return meta;
}

/**
 * GFS 分代轮转（R-8：非均匀轮转的收敛保证——同向跑偏串不整链同亡）：
   · epoch 点永久保留（跨 epoch 回退桥）
   · 日代 = 同日快照留最新 1；周代 = 同 ISO 周留最新 1
   · recentKeep 内最新 K 份恒留
 保留判定自旧向新算；轮转只删内容目录与链账条目（内容物化纪律：
 删除前内容已在链上别的快照或其来源处——快照互不共享叶，物理独立）。
 */
export function rotate(dataRoot: string, chain: SnapshotChain, gfs: GfsParams): string[] {
  const keep = new Set<string>();
  for (const s of chain.snapshots) {
    if (s.epoch !== undefined) keep.add(s.id);
  }
  const latest = [...chain.snapshots].reverse();
  for (const s of latest.slice(0, gfs.recentKeep)) keep.add(s.id);
  const seenDay = new Set<string>();
  for (const s of latest) {
    const day = s.takenAt.slice(0, 10);
    if (!seenDay.has(day)) { seenDay.add(day); keep.add(s.id); }
  }
  const seenWeek = new Set<string>();
  for (const s of latest) {
    const week = isoWeekOf(s.takenAt);
    if (!seenWeek.has(week)) { seenWeek.add(week); keep.add(s.id); }
  }
  const removed: string[] = [];
  const remaining: SnapshotMeta[] = [];
  for (const s of chain.snapshots) {
    if (keep.has(s.id)) remaining.push(s);
    else {
      removed.push(s.id);
      fs.rmSync(path.join(snapshotsDir(dataRoot), s.id), { recursive: true, force: true });
    }
  }
  if (removed.length > 0) {
    chain.snapshots = remaining;
    writeChainAtomic(dataRoot, chain);
  }
  return removed;
}

/** ISO 周键（周一为首日——分代判定只用） */
function isoWeekOf(iso: string): string {
  const d = new Date(iso);
  const day = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - day + 3);
  const firstThursday = new Date(Date.UTC(d.getUTCFullYear(), 0, 4));
  const fday = (firstThursday.getUTCDay() + 6) % 7;
  firstThursday.setUTCDate(firstThursday.getUTCDate() - fday + 3);
  const week = 1 + Math.round((d.getTime() - firstThursday.getTime()) / (7 * 86_400_000));
  return d.getUTCFullYear() + '-W' + String(week).padStart(2, '0');
}

/**
 * 回滚目标列（R-7 裁决：不裸列根——(根, 快照时间, 健康证据) 三元组；
 * 可回滚指纹 = 快照链上有快照的根）。最新在前。
 */
export interface RollbackTarget {
  root: string;
  snapshotId: string;
  takenAt: string;
  evidence: SnapshotMeta['evidence'];
  epoch?: string;
}

export function rollbackTargets(dataRoot: string): RollbackTarget[] {
  return readChain(dataRoot).snapshots
    .slice().reverse()
    .map((s) => ({
      root: s.root,
      snapshotId: s.id,
      takenAt: s.takenAt,
      evidence: s.evidence,
      ...(s.epoch !== undefined ? { epoch: s.epoch } : {}),
    }));
}

/** 恢复（快照内容 → 目标目录覆盖写）：完整性校验先行，任一 sha256 不符 = fail-loud 拒恢复。 */
export function restoreSnapshot(
  dataRoot: string,
  snapshotId: string,
  targetDir: string,
  opts: { verifyRoot?: string } = {},
): { files: string[]; meta: SnapshotMeta } {
  const chain = readChain(dataRoot);
  const meta = chain.snapshots.find((s) => s.id === snapshotId);
  if (meta === undefined) {
    throw new Error('快照不在链上：' + snapshotId + '——可回滚目标 = 链上有快照的根');
  }
  if (opts.verifyRoot !== undefined && opts.verifyRoot !== meta.root) {
    throw new Error('快照根不匹配：链上 ' + meta.root + ' ≠ 期望 ' + opts.verifyRoot + '——fail-loud');
  }
  const dir = path.join(snapshotsDir(dataRoot), snapshotId);
  const manifest = JSON.parse(fs.readFileSync(path.join(dir, SNAPSHOT_MANIFEST), 'utf-8')) as Record<string, string>;
  for (const [rel, digest] of Object.entries(manifest)) {
    if (sha256File(path.join(dir, rel)) !== digest) {
      throw new Error('快照内容完整性失败：' + snapshotId + '/' + rel + '——拒绝恢复');
    }
  }
  const files: string[] = [];
  for (const rel of Object.keys(manifest)) {
    const dest = path.join(targetDir, rel);
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.copyFileSync(path.join(dir, rel), dest);
    files.push(rel);
  }
  return { files, meta };
}

/** 盘上链账直读（诊断/接线面） */
export function readSnapshotChain(dataRoot: string): SnapshotChain {
  return readChain(dataRoot);
}
