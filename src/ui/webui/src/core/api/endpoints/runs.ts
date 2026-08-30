// ============================================================
// Runs API —— /api/runs（Agent 运行跟踪模块）
// 与后端 src/host/server/src/api/runs.ts DTO 保持一致
// ============================================================

import { request, jsonPost } from '../client';

/** 矩阵轴成员（agent清单 / 群组清单 / system / unknown 残留端点） */
export interface RunsMember {
  id: string;
  name: string;
  kind: 'agent' | 'virtual' | 'preset' | 'group' | 'system' | 'unknown';
  /** 群组成员（kind=group） */
  participants?: string[];
}

/** 时间窗口消息计数（活跃度热力数据源） */
export interface WindowCounts {
  h1: number; d1: number; d3: number; d7: number; d30: number;
}

/** pair 会话（chat~<lo>~<hi>） */
export interface RunsPairSession {
  key: string;
  a: string;
  b: string;
  messageCount: number;
  lastActivity: number;
  bytes: number;
  windows: WindowCounts;
}

/** 群聊本体会话（group~<gid>） */
export interface RunsGroupSession {
  key: string;
  groupId: string;
  messageCount: number;
  lastActivity: number;
  bytes: number;
  windows: WindowCounts;
}

/** 群聊 per-Agent 周归档（agent×group 参与证据） */
export interface RunsGroupArchive {
  groupId: string;
  agentId: string;
  lastActivity: number;
}

/** 独立会话（single~<sid>；两两矩阵之外） */
export interface RunsSingleSession {
  key: string;
  id: string;
  agentId: string;
  title?: string;
  status?: string;
  workspaceId?: string;
  messageCount: number;
  lastActivity: number;
}

/** 运行中 run */
export interface RunsRunningEntry {
  convKey: string;
  kind: 'chat' | 'group' | 'single';
  agentId: string;
  startedAt: number;
  source?: { kind?: string; form?: string; summary?: string };
}

/** 子 Agent 句柄 */
export interface RunsSubagent {
  id: string;
  parentId: string;
  name: string;
  status: 'running' | 'done' | 'error' | 'timeout' | 'killed';
  task: string;
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
}

/** 覆盖面分析（矩阵是否囊括全部会话） */
export interface RunsCoverage {
  matrixSessions: number;
  pairSessions: number;
  groupSessions: number;
  singleSessions: number;
  runningTotal: number;
  runningSingles: number;
  unknownMembers: string[];
}

export interface RunsSnapshot {
  generatedAt: string;
  members: RunsMember[];
  pairs: RunsPairSession[];
  groups: RunsGroupSession[];
  groupArchives: RunsGroupArchive[];
  singles: RunsSingleSession[];
  running: RunsRunningEntry[];
  subagents: { active: RunsSubagent[]; completed: RunsSubagent[] };
  coverage: RunsCoverage;
}

/** 运行跟踪快照（轮询用；后端为纯读操作 + mtime/size 行数缓存） */
export function fetchRuns(): Promise<RunsSnapshot> {
  return request('/api/runs');
}

/** 中断指定会话键的运行中 run（软中断：run 走完 runEnd 落盘后退出） */
export function interruptRun(convKey: string): Promise<{ success: boolean; error?: string }> {
  return jsonPost('/api/runs/interrupt', { convKey });
}

// ============================================================
// Agent 会话对（pair）只读历史 —— 矩阵格子点击进入的主区视角
// 复用 /api/history（chat~<lo>~<hi> 会话文件，from/to 可为任意两端点）
// ============================================================

/** pair 历史消息（宽松形态，按 role 渲染） */
export interface PairHistoryMessage {
  role: string;
  content: string | null;
  agent_id?: string;
  message_id?: string;
  timestamp?: string;
  label?: string;
  reasoning_content?: string;
}

export function fetchPairHistory(from: string, to: string, limit = 100, offset = 0): Promise<{ messages: PairHistoryMessage[] }> {
  return request(`/api/history?from=${encodeURIComponent(from)}&to=${encodeURIComponent(to)}&limit=${limit}&offset=${offset}`);
}
