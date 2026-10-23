// ============================================================
// user-projection.ts —— 导入会话的 user 账本投影（cr-547）
//
// 〈webui 读投影〉形态二：user 账本 = webui 唯一数据源（会话列表/回放）。
// singles（kind=user）会话导入后只有 agent 侧账本，webui 读面
//（viewer/sessions/<uuid>/）对历史恒盲——投影补齐：agent 账本行
// → user 终稿层（own/peer 两行面），run 键关联照带（source=run:<id>）。
//
// 投影规则（D4.2 终稿层）：
//   · role=agent 且 agent_id=user → own（user 自己的历史发言）
//   · role=agent 且 agent_id≠user → peer（agent 终稿）；
//   · context 行不入投影——机制行非终稿；
//   · 幂等：requestId 准入（同键重写跳过）——重跑投影不重复。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { readLedger, LedgerWriter } from 'ac-ledger';

export interface UserProjectionStats { sessions: number; rows: number; skipped: number; }

/**
 * 单会话投影：agents/<agentId>/sessions/<uuid>/messages.jsonl →
 * viewer/sessions/<uuid>/messages.jsonl（终稿层 own/peer）。
 * agentId 传路径段形态（盘上目录名——已含 %XX 转义；importSession 的
 * pathSegment(ctx.agentId) 已在导入时完成转义，此处不再转）。
 * 已有 user 账本 = 幂等跳过（既有账本优先——writeOwn 语义账本不重写）。
 */
export async function projectUserLedger(targetRoot: string, agentId: string, uuid: string): Promise<{ rows: number; skipped: boolean }> {
  const agentSessionDir = path.join(targetRoot, 'agents', agentId, 'sessions', uuid);
  const userSessionDir = path.join(targetRoot, 'viewer', 'sessions', uuid);
  if (fs.existsSync(path.join(userSessionDir, 'messages.jsonl'))) {
    return { rows: 0, skipped: true };
  }
  const { rows, header } = readLedger(agentSessionDir);
  const writer = new LedgerWriter(userSessionDir, {
    participants: header?.participants ?? [agentId, 'user'],
    kind: 'user',
  });
  let count = 0;
  for (const row of rows) {
    if (row.role !== 'agent') continue; // 终稿层：机制 context 行不入投影
    // await 串行队列：投影完成契约 = 全部落盘（job 同步 IO，resolve 走
    // microtask——void 丢弃会让同步调用方在落盘前拿到返回值）
    await writer.deliver({
      role: 'agent',
      content: row.content,
      agent_id: row.agent_id,
      uuid,
      ...(row.requestId !== undefined ? { requestId: row.requestId } : {}),
      ...(row.run !== undefined ? { source: 'run:' + row.run } : {}),
      // message_id/timestamp/seq 是 writer 单写者自生成字段（deliver 契约
      // Omit 掉）——user 账本自有序号；原行时刻由 agent 侧账本承载（恒等门域）
    });
    count++;
  }
  return { rows: count, skipped: false };
}

/**
 * 全域投影：扫描 targetRoot/agents/<id>/sessions/<uuid> 逐桶投影。
 * 入投影的会话形态（webui 视角 = user 与 agent 的 1v1）：
 *   · kind=user（singles 导入域）；
 *   · kind=agent-pair 且 participants 含 'user'（主线 M19 直答对桶
 *     pairKey(agent, user)——前端 Agent 1v1 直答视图按对桶键取历史，
 *     缺投影 = 迁移直答会话前端恒空，cr-611）。
 * 其余（agent⇄agent 委托 pair / group / subagent）不入 viewer 投影。
 */
export async function projectUserLedgers(targetRoot: string): Promise<UserProjectionStats> {
  const agentsDir = path.join(targetRoot, 'agents');
  if (!fs.existsSync(agentsDir)) return { sessions: 0, rows: 0, skipped: 0 };
  const stats: UserProjectionStats = { sessions: 0, rows: 0, skipped: 0 };
  for (const agent of fs.readdirSync(agentsDir, { withFileTypes: true })) {
    if (!agent.isDirectory()) continue;
    const sessionsDir = path.join(agentsDir, agent.name, 'sessions');
    if (!fs.existsSync(sessionsDir)) continue;
    for (const session of fs.readdirSync(sessionsDir, { withFileTypes: true })) {
      if (!session.isDirectory()) continue;
      const dir = path.join(sessionsDir, session.name);
      const { header } = readLedger(dir);
      const pairWithUser = header?.kind === 'agent-pair'
        && header.participants.includes('user');
      if (header?.kind !== 'user' && !pairWithUser) continue;
      const r = await projectUserLedger(targetRoot, agent.name, session.name);
      if (r.skipped) { stats.skipped++; continue; }
      stats.sessions++;
      stats.rows += r.rows;
    }
  }
  return stats;
}
