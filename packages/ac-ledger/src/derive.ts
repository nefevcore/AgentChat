// ============================================================
// derive.ts —— viewer 账本派生器（cr-698 viewer 派生化）
//
// 裁决：viewer = f(settled 事实) 的物化视图，写面只有宿主派生器一个。
// 终稿信封降级为通知（壳侧 postReply 照发，宿主收到后触发派生而非直接
// 落行）；派生源 = 各 agent 域账本的 agent 自著行（终稿 + 通知），按
// requestId 幂等、按 run 键单行（同 run 已有非空行不再写——锚信双行
// 事故的根因修复）。空终稿 run 不落 viewer 行——「有 steps 无正文」是
// 中断常态，由 session/history 读面的 steps 盲区投影渲染，显示形态归
// 前端。附带存量迁移：同 run 空 content 锚行 + 其后非空同 run 行 →
// 锚行剔除（原子重写）。
//
// 调用面：user 壳收信通知（user-stub receive）+ session/history 读面前
// 触发（宿主单进程串行——读时派生兼做崩溃窗口兜底）。纯库零 cordis。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readLedger } from './reader.ts';
import { sessionDir } from './writer.ts';
import { userSessionDir } from './user.ts';
import type { LedgerRow } from './records.ts';

/** 派生一行 viewer 行的输入形态（agent 域账本行 → viewer 投影行） */
interface DerivedRow {
  agentId: string;
  content: string;
  run?: string;
  /** run 墙钟耗时（毫秒，cr-772——agent 域终稿行 runMs 透传） */
  runMs?: number;
  requestId?: string;
  timestamp: string;
}

/**
 * viewer 账本派生：agent 域自著行（终稿/通知）→ viewer 行。
 * 幂等键 = requestId（缺席回落 message_id）；run 键单行（同 run 已有非空
 * 行的后续行跳过）。返回新派生行数（诊断面——消费方恒忽略亦可）。
 */
export async function deriveViewerLedger(dataRoot: string, uuid: string, agentDomains: string[]): Promise<number> {
  const viewerDir = userSessionDir(dataRoot, uuid);
  repairDuplicateAnchors(viewerDir);
  const viewerRows = readLedger(viewerDir).rows;
  const seen = new Set<string>();
  for (const r of viewerRows) {
    if (r.requestId !== undefined) seen.add(r.requestId);
    seen.add(r.message_id);
  }
  // run 键非空行集合（同 run 已有终稿/通知 → 后续行不派生）
  const runsWithFinal = new Set<string>();
  for (const r of viewerRows) {
    if (typeof r.source === 'string' && r.source.startsWith('run:') && r.content.trim() !== '') {
      runsWithFinal.add(r.source.slice(4));
    }
  }
  const pending: DerivedRow[] = [];
  for (const domain of agentDomains) {
    const rows = readLedger(sessionDir(dataRoot, domain, uuid)).rows;
    for (const r of rows) {
      // agent 自著行：终稿（run 键）+ 通知（无 run 键）；user 域入站行
      //（viewer 已由 writeOwn 落）与物化段行/注入行不派生
      if (r.role !== 'agent' || r.agent_id !== domain) continue;
      if (r.source === 'segment' || r.source === 'inject' || r.message_id.startsWith('seg-')) continue;
      // 空终稿不落 viewer 行（cr-698 裁决——读面 steps 盲区投影渲染）
      if (r.content.trim() === '') continue;
      if (seen.has(r.requestId ?? r.message_id)) continue;
      const run = typeof r.run === 'string' && r.run !== '' ? r.run : undefined;
      if (run !== undefined && runsWithFinal.has(run)) continue;
      pending.push({
        agentId: domain,
        content: r.content,
        ...(run !== undefined ? { run } : {}),
        ...(r.runMs !== undefined ? { runMs: r.runMs } : {}),
        ...(r.requestId !== undefined ? { requestId: r.requestId } : {}),
        timestamp: r.timestamp,
      });
      if (r.requestId !== undefined) seen.add(r.requestId);
      seen.add(r.message_id);
      if (run !== undefined) runsWithFinal.add(run);
    }
  }
  if (pending.length === 0) return 0;
  // 追加面：viewer 目录可能尚无文件（首派生先于任何 user 发言——写穿件
  // ensureHeader 兜头行）；逐行 deliver（requestId 幂等 + 原 ts）
  const { UserLedger } = await import('./user.ts');
  const ledger = new UserLedger(dataRoot, uuid, ['user', ...agentDomains]);
  for (const p of pending) {
    await ledger.writeThrough({ ...p, uuid });
  }
  return pending.length;
}

/**
 * 存量迁移（cr-698）：viewer 账本中同 run 双行——空 content 锚行（cr-631
 * 锚信产物）且同 run 存在非空行 → 锚行剔除。tmp+rename 原子重写，头行
 * 保留。幂等：无不洁行即无操作。
 */
function repairDuplicateAnchors(viewerDir: string): void {
  const { header, rows } = readLedger(viewerDir);
  const runsWithFinal = new Set<string>();
  for (const r of rows) {
    if (typeof r.source === 'string' && r.source.startsWith('run:') && r.content.trim() !== '') {
      runsWithFinal.add(r.source.slice(4));
    }
  }
  const keep = rows.filter((r) => !(typeof r.source === 'string' && r.source.startsWith('run:')
    && r.content.trim() === '' && runsWithFinal.has(r.source.slice(4))));
  if (keep.length === rows.length) return;
  const file = path.join(viewerDir, 'messages.jsonl');
  const tmp = file + '.tmp';
  fs.mkdirSync(viewerDir, { recursive: true });
  const lines: string[] = [];
  if (header !== null) lines.push(JSON.stringify(header));
  for (const r of keep) lines.push(JSON.stringify(r));
  fs.writeFileSync(tmp, lines.join('\n') + '\n', 'utf-8');
  fs.renameSync(tmp, file);
}
