// ============================================================
// api/jobs.ts —— 后台任务/子Agent 调用清单读面（DSH job_list 同款）
//
// jobs/list · jobs/kill RPC 直连。bash 后台与 subagent 委派在服务端
// 已归一为任务词汇（ctx.jobs：kind 区分，subagent 的 name/parentId/
// 终态结果在 meta）——本模块只做线形解读与纯视图拆分：
//   · fetchJobs：清单拉取（服务未装载/后端旧版无 RPC → null 静默）
//   · splitJobs：running 在前（启动序）+ 终态在后（最新优先）
//   · jobOutputPreview：终态输出/详情预览（meta.output → detail）
// 实时性：job/started · job/settled WS 帧驱动 stores/jobs 重拉本面。
// ============================================================

import { wireRpc } from './wire.ts';

type Rpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

/** 任务快照线形（= ac-jobs JobSnapshot；meta.output 为 500 字预览） */
export interface WireJob {
  id: string;
  kind: string;
  label: string;
  status: 'running' | 'stopping' | 'completed' | 'killed' | 'failed';
  ownerAgentId?: string;
  conversationId?: string;
  detail?: string;
  startedAt: number;
  finishedAt?: number;
  meta?: Record<string, unknown>;
}

/** 运行中（running/stopping 都算未收束） */
export function jobIsRunning(j: WireJob): boolean {
  return j.status === 'running' || j.status === 'stopping';
}

/** subagent 委派任务（与 bash 后台同注册表、kind 区分） */
export function jobIsSubagent(j: WireJob): boolean {
  return j.kind === 'subagent';
}

/** 本会话清单（按发起会话键过滤——对桶键 / singles sid / 群 gid 同词表；
 *  无会话归属的任务（宿主机制任务等）归全局面板，不进会话头） */
export function jobsForConversation(jobs: WireJob[], conversationId: string | null | undefined): WireJob[] {
  if (!conversationId) return [];
  return jobs.filter((j) => j.conversationId === conversationId);
}

/** 状态 → 中文标签（清单行/弹层共用词汇） */
export function jobStatusLabel(s: WireJob['status']): string {
  const map: Record<WireJob['status'], string> = {
    running: '运行中', stopping: '停止中', completed: '完成', failed: '失败', killed: '已终止',
  };
  return map[s];
}

/** 状态 → 图标名（lucide；色类由组件按 `st-<status>` 自取） */
export function jobStatusIcon(s: WireJob['status']): string {
  const map: Record<WireJob['status'], string> = {
    running: 'zap', stopping: 'clock', completed: 'check-circle', failed: 'alert-circle', killed: 'ban',
  };
  return map[s];
}

/** 清单拆分：running 按启动序在前；终态最新优先在后（"最近 run"清单） */
export function splitJobs(jobs: WireJob[]): { running: WireJob[]; settled: WireJob[] } {
  const running = jobs.filter(jobIsRunning).sort((a, b) => a.startedAt - b.startedAt);
  const settled = jobs
    .filter((j) => !jobIsRunning(j))
    .sort((a, b) => (b.finishedAt ?? b.startedAt) - (a.finishedAt ?? a.startedAt));
  return { running, settled };
}

/** 终态输出预览（meta.output[settle 回写] → detail 兜底；截 max 字） */
export function jobOutputPreview(j: WireJob, max = 160): string {
  const src = typeof j.meta?.output === 'string' ? j.meta.output : (j.detail ?? '');
  const text = src.trim();
  return text.length > max ? `${text.slice(0, max)}…` : text;
}

/** subagent meta 视图（name/parentId/subagentId——producer 私有元数据） */
export function subagentMeta(j: WireJob): { name?: string; parentId?: string; subagentId?: string } {
  const meta = j.meta ?? {};
  return {
    ...(typeof meta.name === 'string' ? { name: meta.name } : {}),
    ...(typeof meta.parentId === 'string' ? { parentId: meta.parentId } : {}),
    ...(typeof meta.subagentId === 'string' ? { subagentId: meta.subagentId } : {}),
  };
}

/** 拉取任务清单（RPC 不可用 → null：面板静默隐藏，不报错） */
export async function fetchJobs(rpc: Rpc = wireRpc): Promise<WireJob[] | null> {
  try {
    const r = await rpc.call<{ jobs?: WireJob[] }>('jobs/list');
    return Array.isArray(r.jobs) ? r.jobs : [];
  } catch {
    return null;
  }
}

/** 请求取消（宿主全权；真正终态经 job/settled 帧回投后清单刷新） */
export async function killJob(
  id: string,
  rpc: Rpc = wireRpc,
): Promise<{ outcome?: string } | null> {
  try {
    return await rpc.call<{ outcome?: string }>('jobs/kill', { id });
  } catch {
    return null; // 失败静默：下轮事件帧对账
  }
}
