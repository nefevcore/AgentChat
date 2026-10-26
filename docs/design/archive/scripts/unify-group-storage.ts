// ============================================================
// src/scripts/unify-group-storage.ts —— D11 存储统一一次性整备
//
// 用法：npx tsx src/scripts/unify-group-storage.ts [数据根=../workspace/preview]
// （相对 src/；或绝对路径）
//
// 对存量数据执行（配合 M21/D11 运行时改造）：
//   1. 群本体迁入 sessions 树：合并三源 → sessions/groups/<gid>/
//      （经 SessionService compact/setShelf owning 写口；中性行 + 头行
//      + 单调 seq）：
//        a. groups/<gid>/messages.jsonl（旧本体，GroupMessageRecord）
//        b. sessions/<gid>/messages.jsonl（迁移/运行时桶，SessionRecord）
//        c. sessions/<gid>~<member>/（src 时代视角桶——含 <msg> 包装
//           hint 行，跳过包装行取漏网回复）
//      去重按 message_id（优先级 a > b > c）；按时间排序重排 seq。
//   2. 退役 groups/<gid>/messages.jsonl（删除；成员表 group.json 保留）。
//   3. 删除视角桶 sessions/<gid>~<member>/（内容已并入——per-Agent 视角
//      文件不采纳，S1/S3）。
//   4. singles 上架归位：sessions/<sid>/ → sessions/singles/<ws|ungrouped>/
//      （setShelf；与 ac-singles 运行时 syncShelves 同款）。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Context } from '@agentchat/cordis';
import { SessionService, type SessionRecord } from 'ac-session';

const SCRIPTS_DIR = fileURLToPath(new URL('.', import.meta.url));
const TRACK_DIR = path.resolve(SCRIPTS_DIR, '..');
const ROOT = path.resolve(TRACK_DIR, process.argv[2] ?? '../workspace/preview');

if (!fs.existsSync(path.join(ROOT, 'groups'))) {
  console.error(`[unify] 数据根无 groups/（${ROOT}）——无需整备`);
  process.exit(1);
}

// ---- SessionService（owning 写口：compact/setShelf）----
const ctx = new Context();
const fiber = ctx.plugin(SessionService, { root: ROOT });
for (let i = 0; i < 500; i++) {
  if ((ctx as unknown as { session?: unknown }).session) break;
  await new Promise((r) => setTimeout(r, 2));
}
const session = ctx.session;

/** 中性行载荷（合并中间形态） */
interface Row {
  message_id: string;
  agent_id: string;
  content: string;
  timestampMs: number;
  timestamp: string;
  reasoning?: string;
  steps?: SessionRecord['steps'];
}

function toRow(r: { message_id?: string; agent_id?: string; content?: string; timestamp?: string; reasoning_content?: string; steps?: SessionRecord['steps'] }): Row | null {
  if (typeof r.message_id !== 'string' || !r.message_id) return null;
  if (typeof r.content !== 'string') return null;
  const ts = typeof r.timestamp === 'string' ? r.timestamp : '';
  return {
    message_id: r.message_id,
    agent_id: r.agent_id ?? 'user',
    content: r.content,
    timestampMs: Date.parse(ts) || 0,
    timestamp: ts,
    ...(r.reasoning_content ? { reasoning: r.reasoning_content } : {}),
    ...(r.steps ? { steps: r.steps } : {}),
  };
}

/** 旧本体行（GroupMessageRecord）→ 中性行 */
function bodyRow(raw: { id?: string; from?: string; content?: string; at?: number }): Row | null {
  if (typeof raw.id !== 'string' || !raw.id) return null;
  if (typeof raw.content !== 'string') return null;
  const at = typeof raw.at === 'number' ? raw.at : 0;
  return {
    message_id: raw.id,
    agent_id: raw.from ?? 'user',
    content: raw.content,
    timestampMs: at,
    timestamp: new Date(at).toISOString(),
  };
}

/** 读 jsonl 行（宽容：损坏行跳过；头行跳过） */
function readJsonl(file: string): Array<Record<string, unknown>> {
  if (!fs.existsSync(file)) return [];
  const out: Array<Record<string, unknown>> = [];
  for (const line of fs.readFileSync(file, 'utf-8').split('\n')) {
    const t = line.trim();
    if (!t || t.startsWith('{"type":"session-header"')) continue;
    try {
      out.push(JSON.parse(t) as Record<string, unknown>);
    } catch {
      /* 损坏行跳过 */
    }
  }
  return out;
}

const gids = fs
  .readdirSync(path.join(ROOT, 'groups'), { withFileTypes: true })
  .filter((d) => d.isDirectory())
  .map((d) => d.name);

let totalMerged = 0;
let memberBucketsRemoved = 0;

for (const gid of gids) {
  // ── 三源收集（优先级：本体 > 桶 > 视角桶；<msg> 包装 hint 行跳过）──
  const byId = new Map<string, Row>();
  const ingest = (rows: Array<Row | null>, allowWrapped: boolean) => {
    for (const r of rows) {
      if (!r) continue;
      if (!allowWrapped && r.content.startsWith('<msg ')) continue; // hint 包装 = 本体发言的重复投递形态
      if (!byId.has(r.message_id)) byId.set(r.message_id, r);
    }
  };
  // a. 旧本体（GroupMessageRecord；无包装）
  ingest(
    readJsonl(path.join(ROOT, 'groups', gid, 'messages.jsonl')).map((raw) =>
      bodyRow(raw as { id?: string; from?: string; content?: string; at?: number }),
    ),
    true,
  );
  const hadBody = byId.size > 0;
  // b. 会话桶（SessionRecord；无本体时连包装行也保留——宁可重复不可丢失）
  ingest(
    readJsonl(path.join(ROOT, 'sessions', gid, 'messages.jsonl')).map((raw) =>
      toRow(raw as Parameters<typeof toRow>[0]),
    ),
    hadBody,
  );
  // c. 视角桶（src 时代成员视图；包装行跳过）
  const memberDirs = fs
    .readdirSync(path.join(ROOT, 'sessions'), { withFileTypes: true })
    .filter((d) => d.isDirectory() && d.name.startsWith(`${gid}~`))
    .map((d) => d.name);
  for (const member of memberDirs) {
    ingest(
      readJsonl(path.join(ROOT, 'sessions', member, 'messages.jsonl')).map((raw) =>
        toRow(raw as Parameters<typeof toRow>[0]),
      ),
      hadBody,
    );
  }

  // ── 排序 + seq + 写桶（compact 保头行）→ shelf 归位 ──
  const merged = [...byId.values()].sort((a, b) => a.timestampMs - b.timestampMs || (a.message_id < b.message_id ? -1 : 1));
  const records: SessionRecord[] = merged.map((r, i) => ({
    role: 'agent',
    content: r.content,
    agent_id: r.agent_id,
    message_id: r.message_id,
    timestamp: r.timestamp,
    seq: i + 1,
    ...(r.reasoning ? { reasoning_content: r.reasoning } : {}),
    ...(r.steps ? { steps: r.steps } : {}),
  }));
  await session.compact(gid, { keep: records });
  session.setShelf(gid, 'groups');

  // ── 清理：旧本体 + 视角桶 ──
  const bodyFile = path.join(ROOT, 'groups', gid, 'messages.jsonl');
  if (fs.existsSync(bodyFile)) fs.rmSync(bodyFile);
  for (const member of memberDirs) {
    fs.rmSync(path.join(ROOT, 'sessions', member), { recursive: true, force: true });
    memberBucketsRemoved++;
  }
  totalMerged += records.length;
  console.log(
    `[unify] 群 ${gid}：合并 ${records.length} 行 → sessions/groups/${gid}/（视角桶清理 ${memberDirs.length} 个）`,
  );
}

// ── singles 上架归位 ──
let shelved = 0;
const singlesDir = path.join(ROOT, 'singles');
if (fs.existsSync(singlesDir)) {
  for (const d of fs.readdirSync(singlesDir, { withFileTypes: true })) {
    if (!d.isDirectory()) continue;
    const sid = d.name;
    let ws: string | undefined;
    try {
      const meta = JSON.parse(fs.readFileSync(path.join(singlesDir, sid, 'session.json'), 'utf-8')) as { workspaceId?: unknown };
      if (typeof meta.workspaceId === 'string' && meta.workspaceId) ws = meta.workspaceId;
    } catch {
      /* 元数据缺失 → ungrouped */
    }
    session.setShelf(sid, `singles/${ws ?? 'ungrouped'}`);
    shelved++;
  }
}
console.log(`[unify] singles 上架：${shelved} 个 → sessions/singles/<ws|ungrouped>/`);
console.log(`[unify] 完成：${gids.length} 群 / ${totalMerged} 行合并；视角桶清理 ${memberBucketsRemoved} 个`);
await fiber.dispose();
