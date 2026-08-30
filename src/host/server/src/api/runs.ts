// ============================================================
// Runs API — /api/runs（Agent 运行跟踪模块数据源）
//
// GET  /api/runs            运行跟踪快照（矩阵成员 + 全部会话盘存 + 运行中 run + 子 Agent）
// POST /api/runs/interrupt  中断指定会话键的运行中 run（router.abortDialog 软中断）
//
// 设计（对齐需求「Agent运行跟踪」三页签）：
//   · 页签1 Agent运行：members（agent清单/群组清单/system + 会话中出现但
//     已无法解析的 unknown 端点）× pairs/groups → 两两正交三角矩阵；
//   · 页签2 Session运行：running（router running Map 全量快照，含 single~）；
//   · 页签3 SubAgent运行：subagents（活跃 + 最近完成缓存）。
//
// 覆盖面分析（需求 1.2 的服务端事实源）：
//   · chat~<lo>~<hi>（pair）/ group~<gid>（群本体）可映射为矩阵格子；
//   · single~<sid>（独立会话）没有两两端点 → 结构上在矩阵之外，
//     coverage.singleSessions 单独上报，前端呈现"未覆盖"提示；
//   · 会话键端点在 registry/群组中无匹配（Agent 已删除 / 'self' 等）→
//     unknown 成员入轴（不丢数据），coverage.unknownMembers 上报。
//
// 薄传输层：快照构造为纯函数 buildRunsSnapshot（测试直接覆盖），路由只做 IO。
// ============================================================

import { Router } from 'express';
import type { Request, Response } from 'express';
import * as fs from 'fs';
import * as path from 'path';
import type { AgentRouter, RunningSessionInfo } from '@agentchat/router';
import type { SubAgentManager, SubAgentHandle } from '@agentchat/subagent';

const SYSTEM_MEMBER_ID = 'system';
/** 旧群会话键前缀（`__` 分隔时代）：chat~group__<gid>~<aid> */
const LEGACY_GROUP_PREFIX = 'group__';

// ============================================================
// DTO（前端契约；与 webui core/api/endpoints/runs.ts 保持一致）
// ============================================================

/** 矩阵轴成员 */
export interface RunsMember {
  id: string;
  name: string;
  /** agent=实体 Agent；virtual=虚拟端点（如 user）；preset=预设 Agent；group=群组；system=无主触发端点；unknown=会话残留端点（已删除 Agent / self 等） */
  kind: 'agent' | 'virtual' | 'preset' | 'group' | 'system' | 'unknown';
  /** 群组成员（kind=group） */
  participants?: string[];
}

/** pair 会话（chat~<lo>~<hi>；a/b 为排序后端点） */
export interface RunsPairSession {
  key: string;
  a: string;
  b: string;
  messageCount: number;
  /** 最后活动（消息文件 mtime，ms） */
  lastActivity: number;
  bytes: number;
  /** 时间窗口内消息数（活跃度热力数据源） */
  windows: WindowCounts;
}

/** 群聊本体会话（group~<gid>） */
export interface RunsGroupSession {
  key: string;
  groupId: string;
  messageCount: number;
  lastActivity: number;
  bytes: number;
  /** 时间窗口内消息数 */
  windows: WindowCounts;
}

/** 群聊 per-Agent 周归档目录存在性（group~<gid>~<aid>；矩阵 agent×group 格子的参与证据） */
export interface RunsGroupArchive {
  groupId: string;
  agentId: string;
  lastActivity: number;
}

/** 独立会话（single~<sid>；不在矩阵内，页签2/覆盖分析呈现） */
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

/** 运行中 run（router running Map 快照 + 会话键解析） */
export interface RunsRunningEntry extends RunningSessionInfo {
  kind: 'chat' | 'group' | 'single';
}

/** 子 Agent 句柄（result 截断；与 @agentchat/subagent SubAgentHandle 同构） */
export interface RunsSubagent {
  id: string;
  parentId: string;
  name: string;
  status: SubAgentHandle['status'];
  task: string;
  startedAt: number;
  finishedAt?: number;
  result?: string;
  error?: string;
}

/** 覆盖面分析（需求 1.2：矩阵是否囊括全部会话） */
export interface RunsCoverage {
  /** 矩阵可表达的会话数（pair + 群本体） */
  matrixSessions: number;
  pairSessions: number;
  groupSessions: number;
  /** 独立会话数（结构上在两两矩阵之外） */
  singleSessions: number;
  /** 运行中 run 总数 / 其中 single~ 会话数 */
  runningTotal: number;
  runningSingles: number;
  /** 会话键中出现但无法解析为 agent/群组的端点（残留数据） */
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

// ============================================================
// 依赖（最小结构面；测试可桩）
// ============================================================

export interface RunsRegistryLike {
  get(id: string): { agent_id: string; virtual?: boolean; preset?: boolean } | undefined;
  listIds(): string[];
  getAgentName(id: string): string;
  isVirtual(id: string): boolean;
  isPreset(id: string): boolean;
}

export interface RunsGroupLike {
  group_id: string;
  name: string;
  participants: string[];
}

export interface RunsSinglesLike {
  get(sessionId: string): {
    id: string; agentId: string; title?: string; status?: string; workspaceId?: string;
  } | null;
}

export interface RunsDeps {
  router: Pick<AgentRouter, 'listRunning' | 'abortDialog'>;
  registry: RunsRegistryLike;
  groups: () => RunsGroupLike[];
  singles: RunsSinglesLike;
  subAgent?: Pick<SubAgentManager, 'listAll'> | null;
  wsRoot: string;
}

// ============================================================
// 消息文件统计（mtime+size 缓存，轮询友好）
// ============================================================

/** 时间窗口消息计数（活跃度热力的数据源；总行数 = messageCount 另计） */
export interface WindowCounts {
  h1: number; d1: number; d3: number; d7: number; d30: number;
}

interface FileStatCache { mtimeMs: number; size: number; lines: number; windows: WindowCounts }
const lineCountCache = new Map<string, FileStatCache>();

/** 窗口边界（ms） */
const WIN = { h1: 3600_000, d1: 86_400_000, d3: 3 * 86_400_000, d7: 7 * 86_400_000, d30: 30 * 86_400_000 };

/** 统计 messages.jsonl：行数 + 各时间窗口内消息数 + mtime；文件变化才重算 */
function messageFileStats(dir: string): { messageCount: number; lastActivity: number; bytes: number; windows: WindowCounts } {
  const empty = { messageCount: 0, lastActivity: 0, bytes: 0, windows: { h1: 0, d1: 0, d3: 0, d7: 0, d30: 0 } satisfies WindowCounts };
  const file = path.join(dir, 'messages.jsonl');
  try {
    const stat = fs.statSync(file);
    if (!stat.isFile()) return empty;
    const cached = lineCountCache.get(file);
    if (cached && cached.mtimeMs === stat.mtimeMs && cached.size === stat.size) {
      return { messageCount: cached.lines, lastActivity: stat.mtimeMs, bytes: stat.size, windows: cached.windows };
    }
    // 流式按行读：数行 + 解析 timestamp 按时间窗口分桶（无 timestamp 的旧行只计入总行数）
    const now = Date.now();
    let lines = 0;
    let carry = '';
    const windows: WindowCounts = { h1: 0, d1: 0, d3: 0, d7: 0, d30: 0 };
    const consume = (line: string) => {
      lines++;
      try {
        const ts = (JSON.parse(line) as { timestamp?: string }).timestamp;
        if (!ts) return;
        const age = now - Date.parse(ts);
        if (Number.isNaN(age) || age < 0) { windows.h1++; return; } // 时钟偏差的未来消息按最新计
        if (age <= WIN.h1) windows.h1++;
        if (age <= WIN.d1) windows.d1++;
        if (age <= WIN.d3) windows.d3++;
        if (age <= WIN.d7) windows.d7++;
        if (age <= WIN.d30) windows.d30++;
      } catch { /* 损坏行只计行数 */ }
    };
    const fd = fs.openSync(file, 'r');
    try {
      const buf = Buffer.alloc(64 * 1024);
      while (true) {
        const n = fs.readSync(fd, buf, 0, buf.length, null);
        if (n <= 0) break;
        carry += buf.toString('utf-8', 0, n);
        const parts = carry.split('\n');
        carry = parts.pop() ?? '';
        for (const line of parts) {
          if (line.trim()) consume(line);
        }
      }
      if (carry.trim()) consume(carry);
    } finally {
      fs.closeSync(fd);
    }
    lineCountCache.set(file, { mtimeMs: stat.mtimeMs, size: stat.size, lines, windows });
    return { messageCount: lines, lastActivity: stat.mtimeMs, bytes: stat.size, windows };
  } catch {
    return empty;
  }
}

/** 目录 mtime（无消息文件时归档子目录等活动证据兜底） */
function dirMtime(dir: string): number {
  try { return fs.statSync(dir).mtimeMs; } catch { return 0; }
}

// ============================================================
// 快照构造（纯函数）
// ============================================================

/** 会话键解析出的端点 → 轴成员 kind 归一 */
function resolveMemberKind(endpoint: string, deps: RunsDeps, groupIds: Set<string>): RunsMember['kind'] | null {
  if (endpoint === SYSTEM_MEMBER_ID) return 'system';
  if (groupIds.has(endpoint)) return 'group';
  if (endpoint.startsWith(LEGACY_GROUP_PREFIX) && groupIds.has(endpoint.slice(LEGACY_GROUP_PREFIX.length))) return 'group';
  const agent = deps.registry.get(endpoint);
  if (agent) {
    if (deps.registry.isPreset(endpoint)) return 'preset';
    if (deps.registry.isVirtual(endpoint)) return 'virtual';
    return 'agent';
  }
  return null; // unknown（调用方决定是否入轴）
}

function toRunsSubagent(h: SubAgentHandle): RunsSubagent {
  return {
    id: h.id,
    parentId: h.parentId,
    name: h.name,
    status: h.status,
    task: h.task.length > 120 ? `${h.task.slice(0, 120)}…` : h.task,
    startedAt: h.startedAt,
    ...(h.finishedAt !== undefined ? { finishedAt: h.finishedAt } : {}),
    ...(h.result !== undefined ? { result: h.result.length > 200 ? `${h.result.slice(0, 200)}…` : h.result } : {}),
    ...(h.error !== undefined ? { error: h.error } : {}),
  };
}

/** 构造运行跟踪快照（GET /api/runs 响应体；纯读操作） */
export function buildRunsSnapshot(deps: RunsDeps): RunsSnapshot {
  const groups = deps.groups();
  const groupIds = new Set(groups.map(g => g.group_id));

  // ── 轴成员：agent（含虚拟 user）→ 群组 → system；unknown 端点随后按发现补入 ──
  const members: RunsMember[] = [];
  const memberIds = new Set<string>();
  const pushMember = (m: RunsMember) => {
    if (memberIds.has(m.id)) return;
    memberIds.add(m.id);
    members.push(m);
  };
  for (const id of deps.registry.listIds()) {
    if (deps.registry.isPreset(id)) continue; // 预设不占轴（仅当被 single 引用时补入）
    const cfg = deps.registry.get(id);
    if (!cfg) continue;
    pushMember({
      id,
      name: deps.registry.getAgentName(id) || id,
      kind: deps.registry.isVirtual(id) ? 'virtual' : 'agent',
    });
  }
  for (const g of groups) {
    pushMember({ id: g.group_id, name: g.name || g.group_id, kind: 'group', participants: g.participants });
  }
  pushMember({ id: SYSTEM_MEMBER_ID, name: 'system（无主触发）', kind: 'system' });

  const unknownEndpoints = new Set<string>();
  /** pair 端点解析：可识别 → 归一（legacy group__gid → gid）；不可识别 → unknown 入轴 */
  const normalizeEndpoint = (endpoint: string): string => {
    if (endpoint.startsWith(LEGACY_GROUP_PREFIX)) {
      const gid = endpoint.slice(LEGACY_GROUP_PREFIX.length);
      if (groupIds.has(gid)) return gid;
    }
    return endpoint;
  };
  const ensureEndpointMember = (endpoint: string): void => {
    const kind = resolveMemberKind(endpoint, deps, groupIds);
    if (kind) return;
    if (unknownEndpoints.has(endpoint) || memberIds.has(endpoint)) return;
    unknownEndpoints.add(endpoint);
    pushMember({ id: endpoint, name: `${endpoint}（未知端点）`, kind: 'unknown' });
  };

  // ── 会话目录盘存 ──
  const pairs: RunsPairSession[] = [];
  const groupSessions: RunsGroupSession[] = [];
  const groupArchives: RunsGroupArchive[] = [];
  const singles: RunsSingleSession[] = [];

  const sessionsRoot = path.join(deps.wsRoot, 'sessions');
  let entries: fs.Dirent[] = [];
  try { entries = fs.readdirSync(sessionsRoot, { withFileTypes: true }); } catch { /* 无 sessions 目录 */ }

  for (const ent of entries) {
    if (!ent.isDirectory()) continue;
    const dir = path.join(sessionsRoot, ent.name);
    const seg = ent.name.split('~');
    if (ent.name.startsWith('chat~') && seg.length >= 3) {
      // chat~<lo>~<hi>（lo/hi 排序端点；可能含 legacy group__gid 端点）
      const stats = messageFileStats(dir);
      if (stats.bytes === 0) continue; // 空目录（无消息）不入盘存，端点也不入轴
      const a0 = normalizeEndpoint(seg[1]);
      const b0 = normalizeEndpoint(seg.slice(2).join('~'));
      // 'self' 端点 = Agent 与自身的自会话（chat~neko~self → neko×neko）：
      // 归一为该 Agent 本身（落矩阵对角线），不单独成轴
      const a = a0 === 'self' && b0 !== 'self' ? b0 : a0;
      const b = b0 === 'self' && a0 !== 'self' ? a0 : b0;
      ensureEndpointMember(a);
      ensureEndpointMember(b);
      pairs.push({ key: ent.name, a, b, ...stats });
    } else if (ent.name.startsWith('group~')) {
      if (seg.length === 2) {
        // 群本体 group~<gid>：messages.jsonl（功能历史）+ archive/<aid>/（per-Agent 周归档
        // = 该 Agent 参与过群会话的证据，agent×group 格子点亮依据；见 @agentchat/tools paths.ts）
        const stats = messageFileStats(dir);
        if (stats.bytes > 0) {
          groupSessions.push({ key: ent.name, groupId: seg[1], ...stats });
        }
        const archiveRoot = path.join(dir, 'archive');
        try {
          for (const sub of fs.readdirSync(archiveRoot, { withFileTypes: true })) {
            if (!sub.isDirectory()) continue;
            ensureEndpointMember(sub.name);
            groupArchives.push({
              groupId: seg[1],
              agentId: sub.name,
              lastActivity: dirMtime(path.join(archiveRoot, sub.name)),
            });
          }
        } catch { /* 无 archive 子目录 */ }
      } else {
        // 兜底：三段式 group~<gid>~<aid> 目录（convKey 形态；现行写入为 archive/ 子目录，
        // 历史数据若存在同样按参与证据收集）
        ensureEndpointMember(seg.slice(2).join('~'));
        groupArchives.push({ groupId: seg[1], agentId: seg.slice(2).join('~'), lastActivity: dirMtime(dir) });
      }
    } else if (ent.name.startsWith('single~') && seg.length === 2) {
      // 独立会话 single~<sid>
      const id = seg[1];
      const meta = deps.singles.get(id);
      const stats = messageFileStats(dir);
      if (!meta && stats.bytes === 0) continue;
      if (meta?.agentId) {
        // single 引用的 Agent（可能是预设）不在轴上时补入（preset 成员；矩阵外引用完整性）
        const kind = resolveMemberKind(meta.agentId, deps, groupIds);
        if (!kind && !memberIds.has(meta.agentId)) {
          pushMember({ id: meta.agentId, name: `${meta.agentId}（预设）`, kind: 'preset' });
        } else if (kind === 'preset') {
          pushMember({ id: meta.agentId, name: deps.registry.getAgentName(meta.agentId) || meta.agentId, kind: 'preset' });
        }
      }
      singles.push({
        key: ent.name,
        id,
        agentId: meta?.agentId ?? '',
        ...(meta?.title ? { title: meta.title } : {}),
        ...(meta?.status ? { status: meta.status } : {}),
        ...(meta?.workspaceId ? { workspaceId: meta.workspaceId } : {}),
        ...stats,
      });
    }
    // 其余：旧 canonical 嵌套目录等非现行形态 → 忽略（现行盘存为平铺三形态）
  }

  pairs.sort((x, y) => y.lastActivity - x.lastActivity);
  groupSessions.sort((x, y) => y.lastActivity - x.lastActivity);
  singles.sort((x, y) => y.lastActivity - x.lastActivity);

  // ── 运行中 run（running Map 快照 + 会话键分类）──
  const running: RunsRunningEntry[] = deps.router.listRunning().map(r => {
    const kind: RunsRunningEntry['kind'] = r.convKey.startsWith('group~')
      ? 'group'
      : r.convKey.startsWith('single~') ? 'single' : 'chat';
    return { ...r, kind };
  });

  // ── 子 Agent ──
  let subagents: RunsSnapshot['subagents'] = { active: [], completed: [] };
  if (deps.subAgent) {
    try {
      const all = deps.subAgent.listAll();
      subagents = {
        active: all.active.map(toRunsSubagent),
        completed: all.completed.map(toRunsSubagent),
      };
    } catch { /* 子 Agent 服务异常不阻断快照 */ }
  }

  // ── 覆盖面分析（需求 1.2）──
  const coverage: RunsCoverage = {
    matrixSessions: pairs.length + groupSessions.length,
    pairSessions: pairs.length,
    groupSessions: groupSessions.length,
    singleSessions: singles.length,
    runningTotal: running.length,
    runningSingles: running.filter(r => r.kind === 'single').length,
    unknownMembers: [...unknownEndpoints],
  };

  return {
    generatedAt: new Date().toISOString(),
    members,
    pairs,
    groups: groupSessions,
    groupArchives,
    singles,
    running,
    subagents,
    coverage,
  };
}

// ============================================================
// 路由
// ============================================================

export function createRunsRouter(deps: RunsDeps): Router {
  const router = Router();

  /** GET /api/runs — 运行跟踪快照 */
  router.get('/', (_req: Request, res: Response) => {
    try {
      res.json(buildRunsSnapshot(deps));
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  /** POST /api/runs/interrupt — 中断指定会话（body: { convKey }；软中断，run 走完 runEnd 落盘后退出） */
  router.post('/interrupt', (req: Request, res: Response) => {
    const convKey = typeof req.body?.convKey === 'string' ? req.body.convKey : '';
    if (!convKey) {
      res.status(400).json({ error: '需要 convKey（会话键）' });
      return;
    }
    try {
      const ok = deps.router.abortDialog(convKey);
      res.json({ success: ok, ...(ok ? {} : { error: `会话 "${convKey}" 不在运行中` }) });
    } catch (err: any) {
      res.status(500).json({ error: err?.message ?? String(err) });
    }
  });

  return router;
}
