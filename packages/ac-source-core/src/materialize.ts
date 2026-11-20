// ============================================================
// materialize.ts —— source 物化纯函数（cr-1165 timer-v3 §五采集层）
//
// 物化形态（宿主属主目录——不放 agents/<id>/files/ 下，那是 Agent
// write 可写域，会被用来向另一 Agent 语境投喂伪造数据）：
//   <dataRoot>/exports/<source>/<view>/rows.jsonl  # 追加式，行内单调 seq
//   <dataRoot>/exports/<source>/<view>/meta.json   # 快照 + 健康契约
//
// 快照 diff 物化：上次快照（meta.seen）与当前快照比对——新增/变更的
// 键各追加一行（seq 单调推进），删除不记（v1 边界——fs 万能适配器的
// 语义是「目录里出现了什么」，不是「目录里少了什么」）。零变化也刷新
// generatedAt（源活性心跳——stale 判定靠它）。
//
// 采集与探测正交（timer-v3 §五）：本模块不知道 timer 的存在；消费方
// （timers 行）经 readMeta / readRowsSince 读物化面。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';

/** fs 快照行输入（相对 root 的稳定路径 + 量测） */
export interface FsSnapshotInput {
  path: string;
  mtime: number;
  size: number;
}

/** meta.json 形态（健康契约：stale 判定 = generatedAt 超 staleAfterMs） */
export interface SourceMeta {
  generatedAt: string;
  /** 已物化最大行 seq（单调） */
  seq: number;
  /** 行 schema 版本（只增不改字段） */
  schema: string;
  staleAfterMs: number;
  /** 上次快照全量键集（diff 基准；fs-source = path → 量测） */
  seen?: Record<string, { mtime: number; size: number }>;
}

/** rows.jsonl 滚动阈值（单文件最大行数 → .old 覆盖保留一代） */
export const MAX_SOURCE_ROWS = 10_000;

/** 读 meta（缺席/损坏 = null——消费方按源不可用处理） */
export function readMeta(dir: string): SourceMeta | null {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(dir, 'meta.json'), 'utf-8')) as SourceMeta;
    if (typeof raw.seq !== 'number') return null;
    return raw;
  } catch {
    return null;
  }
}

/**
 * 读 seq 大于 sinceSeq 的物化行（先 .old 后当前——滚动保留一代，
 * seq 跨文件单调）。损坏行跳过（追加式日志的读侧容错）。
 */
export function readRowsSince(dir: string, sinceSeq: number): Array<Record<string, unknown>> {
  const out: Array<Record<string, unknown>> = [];
  for (const file of ['rows.jsonl.old', 'rows.jsonl']) {
    let text: string;
    try { text = fs.readFileSync(path.join(dir, file), 'utf-8'); } catch { continue; }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      try {
        const row = JSON.parse(line) as Record<string, unknown>;
        if (typeof row.seq === 'number' && row.seq > sinceSeq) out.push(row);
      } catch { /* 损坏行跳过 */ }
    }
  }
  out.sort((a, b) => (a.seq as number) - (b.seq as number));
  return out;
}

function writeAtomic(file: string, text: string): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = file + '.' + process.pid + '.tmp';
  fs.writeFileSync(tmp, text, 'utf-8');
  fs.renameSync(tmp, file);
}

/**
 * 快照物化（追加变化行 + 刷新 meta）。返回追加行数与终态 seq。
 * staleAfterMs 由源按自身 cadence 的 2 倍声明（timer-v3 §五）。
 */
export function materializeSnapshot(
  dir: string,
  current: FsSnapshotInput[],
  staleAfterMs: number,
  schema = 'fs-file-snapshot-v1',
): { appended: number; seq: number } {
  const prev = readMeta(dir);
  const meta: SourceMeta = {
    generatedAt: new Date().toISOString(),
    seq: prev?.seq ?? 0,
    schema,
    staleAfterMs,
    seen: {},
  };
  const fresh: string[] = [];
  const seen: Record<string, { mtime: number; size: number }> = {};
  for (const row of current) {
    seen[row.path] = { mtime: row.mtime, size: row.size };
    const was = prev?.seen?.[row.path];
    if (was !== undefined && was.mtime === row.mtime && was.size === row.size) continue;
    meta.seq += 1;
    fresh.push(JSON.stringify({ seq: meta.seq, path: row.path, mtime: row.mtime, size: row.size }));
  }
  meta.seen = seen;
  if (fresh.length > 0) {
    // 滚动：超行数阈值 → 当前转 .old 覆盖（保留一代）
    let existing = 0;
    try {
      existing = fs.readFileSync(path.join(dir, 'rows.jsonl'), 'utf-8').split('\n').filter((l) => l.trim() !== '').length;
    } catch { /* 首件 */ }
    if (existing + fresh.length > MAX_SOURCE_ROWS) {
      try { fs.renameSync(path.join(dir, 'rows.jsonl'), path.join(dir, 'rows.jsonl.old')); } catch { /* 无当前件 */ }
    }
    fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(path.join(dir, 'rows.jsonl'), fresh.join('\n') + '\n', 'utf-8');
  }
  writeAtomic(path.join(dir, 'meta.json'), JSON.stringify(meta, null, 2));
  return { appended: fresh.length, seq: meta.seq };
}
