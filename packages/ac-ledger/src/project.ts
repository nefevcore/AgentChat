// ============================================================
// project.ts —— user 终稿层读时投影（cr-973 / cr-972 第一刀）
//
// viewer 物化账本（cr-698）退役：终稿层不再是落盘派生物，而是 agent
// 域账本的纯读时投影。谓词与派生器时代同源：peer 行 = agent 自著行
//（requestId 幂等 / run 键单行 / 空终稿不投——空终稿 run 由 session
// 读面的 steps 盲区投影渲染）；user 发言行 = agent 域入站行
//（agent_id='user'——与 viewer 时代 writeOwn 同一条消息的落账侧）。
// 排序事实键 = 行时间戳（cr-716 同款；跨域文件序无全序意义）。
// cr-998：viewer 存量直读兼容窗退役（数据根已迁移归零；viewer 树纯投影
// 可整删，读面不再回看）。
// ============================================================
import * as path from 'node:path';
import { conversationDirs } from './manage.ts';
import { readLedger } from './reader.ts';
import type { UserReplayRow } from './user.ts';
import type { LedgerRow } from './records.ts';

/** 终稿行 → replay 行（agent 域形态：run 键住 run 字段、runMs 透传） */
function replayOfAgentRow(r: LedgerRow, domain: string): UserReplayRow {
  return {
    role: 'peer',
    agentId: domain,
    content: r.content,
    ...(typeof r.run === 'string' && r.run !== '' ? { run: r.run } : {}),
    ...(r.runMs !== undefined ? { runMs: r.runMs } : {}),
    ...(r.requestId !== undefined ? { requestId: r.requestId } : {}),
    timestamp: r.timestamp,
    ...(r.seq !== undefined ? { seq: r.seq } : {}),
  };
}

/** 入站 user 行 → replay 行 */
function replayOfUserRow(r: LedgerRow): UserReplayRow {
  return {
    role: 'user',
    agentId: 'user',
    content: r.content,
    ...(r.requestId !== undefined ? { requestId: r.requestId } : {}),
    timestamp: r.timestamp,
    ...(r.seq !== undefined ? { seq: r.seq } : {}),
  };
}

/**
 * user 视角终稿层投影（读时纯函数——cr-973 viewer 停写后的唯一读面）。
 * 输入 = agent 域账本（对桶键 participants 双端并读，行时间戳归并）。
 */
export function projectUserReplay(dataRoot: string, uuid: string): UserReplayRow[] {
  const domainRows: Array<{ domain: string; rows: LedgerRow[] }> = [];
  for (const dir of conversationDirs(dataRoot, uuid, { includeJournalOnly: true })) {
    const domain = path.basename(path.dirname(path.dirname(dir)));
    if (domain === 'viewer') continue;
    domainRows.push({ domain, rows: readLedger(dir).rows });
  }
  const collected: Array<{ row: UserReplayRow; ord: number }> = [];
  let ord = 0;
  const seen = new Set<string>();
  // 行身份键（cr-978）：message_id 缺席/空 = v1 裸行无身份——不参与判重
  //（旧形态 seen.add(undefined) 会把全部无身份行塌缩成一条 = 静默丢消息）。
  const idKeyOf = (r: LedgerRow): string | undefined => {
    const k = r.requestId ?? r.message_id;
    return typeof k === 'string' && k !== '' ? k : undefined;
  };
  // user 发言行：入站行 agent_id='user'。restarted-* 前缀 = cr-946 前机制
  // 通知的存量落形（viewer 时代即不投影——读面按 event 行另投）。
  for (const { rows } of domainRows) {
    for (const r of rows) {
      if (r.role !== 'agent' || r.agent_id !== 'user') continue;
      if (typeof r.requestId === 'string' && r.requestId.startsWith('restarted-')) continue;
      const key = idKeyOf(r);
      if (key !== undefined && seen.has(key)) continue;
      if (r.requestId !== undefined) seen.add(r.requestId);
      if (key !== undefined) seen.add(key);
      collected.push({ row: replayOfUserRow(r), ord: ord++ });
    }
  }
  // peer 终稿/通知行：cr-698 派生谓词原样（幂等 / run 单行 / 空终稿不投 /
  // 物化段行与注入行不投——steps 联查与注入卡归口在读面 view 组装）
  const runsWithFinal = new Set<string>();
  for (const { domain, rows } of domainRows) {
    for (const r of rows) {
      if (r.role !== 'agent' || r.agent_id !== domain) continue;
      if (r.source === 'segment' || r.source === 'inject' || (r.message_id as string | undefined)?.startsWith('seg-') === true) continue;
      if (String(r.content).trim() === '') continue;
      const key = idKeyOf(r);
      if (key !== undefined && seen.has(key)) continue;
      const run = typeof r.run === 'string' && r.run !== '' ? r.run : undefined;
      if (run !== undefined && runsWithFinal.has(run)) continue;
      if (r.requestId !== undefined) seen.add(r.requestId);
      if (key !== undefined) seen.add(key);
      if (run !== undefined) runsWithFinal.add(run);
      collected.push({ row: replayOfAgentRow(r, domain), ord: ord++ });
    }
  }
  // 排序事实键 = 时间戳（稳定：同刻按收集序——user 行先于 peer 行收集）
  return collected
    .sort((a, b) => (a.row.timestamp < b.row.timestamp ? -1 : a.row.timestamp > b.row.timestamp ? 1 : a.ord - b.ord))
    .map((c) => c.row);
}
