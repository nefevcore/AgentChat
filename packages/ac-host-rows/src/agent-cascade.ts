// ============================================================
// agent-cascade.ts —— agent 删除的会话面级联（cr-1209，D1 裁决：硬删全部）
//
// agents/delete 删树只覆盖 agents/<id>/ 本体——meta/sessions 元数据、
// 对端 agent 域的会话副本、群名册与成员流、会话快照都在树外，删树不触及
// （孤儿全靠人工算法追的根源）。本库把「删 agent = 删其全部会话面」收口
// 为两段：
//   collectAgentTraces（删树前读）→ 会话键集合 + 名册含该 agent 的群
//   cleanupAgentTraces（删树后清）→ 对端副本 / meta / 群名册移出与成员流 /
//                                 快照 / 未读计数
// 两段分离是语义要求：会话键住在将被删除的树里，树删后无法再枚举。
//
// 群面只清被删者自己的成员流（gid~<id>）与其他成员域内的同键副本——
// 其他成员的私有流 gid~<m> 保留（群还在，历史不动）；群解散才全清（group/delete）。
//
// 纯库纪律（ac-backup-core / SnapshotStore 同款）：零 cordis 依赖，可独立单测。
// ============================================================
import * as fs from 'node:fs';
import * as path from 'node:path';
import { conversationDirs, metaSessionsDir, userMetaFile } from 'ac-ledger';
import { clearUnread, listGroupConfigs, memberStreamKey, writeGroupConfig, type GroupConfig } from 'ac-core-utils';
import { SnapshotStore } from 'ac-file-snapshots/src/store.ts';

/** 删树前收集到的会话面轨迹 */
export interface AgentTraces {
  /** 该 agent 参与的全部会话键（uuid 形独立会话 / 对桶 a~b / 群成员流 gid~m / 子 Agent sub_*） */
  conversations: string[];
  /** 名册含该 agent 的群 id（cleanup 时重读盘按现名册写回） */
  groupIds: string[];
}

export interface AgentCascadeStats {
  /** 处理的会话键数 */
  conversations: number;
  /** 清理的账本目录数（对端 agent 域副本；本 agent 树已由删树覆盖） */
  peerDirs: number;
  /** 清理的 meta/sessions 元数据文件数 */
  metaFiles: number;
  /** 名册移出该 agent 的群数 */
  groups: number;
  /** 清理的快照目录数 */
  snapshots: number;
}

/** cleanup 结果：统计 + 名册已移出该 agent 的群（写回后的现名册——调用方广播刷新用） */
export interface AgentCascadeResult {
  stats: AgentCascadeStats;
  groups: GroupConfig[];
}

/**
 * 删树前收集（会话键住在将被删除的树里——顺序不可换）：
 *   ① agents/<id>/sessions/ 目录名（唯一完整枚举面）；
 *   ② meta/sessions 中 agentId 归属本 agent 的独立会话（消息未落域但元数据已写的兜底）；
 *   ③ listGroupConfigs 名册含本 agent 的群。
 */
export function collectAgentTraces(dataRoot: string, agentId: string): AgentTraces {
  const conversations = new Set<string>();
  try {
    for (const e of fs.readdirSync(path.join(dataRoot, 'agents', agentId, 'sessions'), { withFileTypes: true })) {
      if (e.isDirectory()) conversations.add(e.name);
    }
  } catch { /* 该 agent 无 sessions 域 */ }
  const metaDir = metaSessionsDir(dataRoot);
  let metas: fs.Dirent[] = [];
  try { metas = fs.readdirSync(metaDir, { withFileTypes: true }); } catch { /* 无元数据域 */ }
  for (const e of metas) {
    if (!e.isFile() || !e.name.endsWith('.json') || e.name.startsWith('.')) continue;
    const id = e.name.slice(0, -5);
    if (id.includes('.')) continue; // 词汇锁（cr-1100）：meta/sessions 只收裸 <sid>.json
    try {
      const raw: unknown = JSON.parse(fs.readFileSync(path.join(metaDir, e.name), 'utf-8'));
      if (raw !== null && typeof raw === 'object' && !Array.isArray(raw) && (raw as Record<string, unknown>).agentId === agentId) {
        conversations.add(id);
      }
    } catch { /* 损坏元数据：不认领 */ }
  }
  const groupIds = listGroupConfigs(dataRoot).filter((g) => g.members.includes(agentId)).map((g) => g.id);
  return { conversations: [...conversations], groupIds };
}

/**
 * 删树后清理（幂等：目录/文件缺席即跳过；返回清理统计供日志与回执）。
 * 群名册按 cleanup 时刻的盘面重读——collect 与 cleanup 之间名册可能已变。
 */
export function cleanupAgentTraces(dataRoot: string, agentId: string, traces: AgentTraces): AgentCascadeResult {
  const store = new SnapshotStore({ root: path.join(dataRoot, 'file-snapshots') });
  const stats: AgentCascadeStats = { conversations: 0, peerDirs: 0, metaFiles: 0, groups: 0, snapshots: 0 };
  const touched: GroupConfig[] = [];
  // ① 会话面：各 agent 域残留目录（含 journal-only）+ 元数据 + 快照 + 未读计数
  for (const cid of traces.conversations) {
    stats.conversations += 1;
    for (const dir of conversationDirs(dataRoot, cid, { includeJournalOnly: true })) {
      fs.rmSync(dir, { recursive: true, force: true });
      stats.peerDirs += 1;
    }
    const metaFile = userMetaFile(dataRoot, cid);
    if (fs.existsSync(metaFile)) {
      fs.rmSync(metaFile, { force: true });
      stats.metaFiles += 1;
    }
    stats.snapshots += store.dropConversation(cid);
    clearUnread(dataRoot, cid);
  }
  // ② 群面：名册移出 + 被删者成员流快照（成员流目录 gid~<id> 只住本 agent 域，
  //    随删树已清；快照在 file-snapshots 全局目录，须显式清）
  for (const gid of traces.groupIds) {
    const group = listGroupConfigs(dataRoot).find((g) => g.id === gid);
    if (group === undefined || !group.members.includes(agentId)) continue;
    group.members = group.members.filter((m) => m !== agentId);
    writeGroupConfig(dataRoot, group);
    stats.groups += 1;
    touched.push(group);
    stats.snapshots += store.dropConversation(memberStreamKey(gid, agentId));
  }
  return { stats, groups: touched };
}