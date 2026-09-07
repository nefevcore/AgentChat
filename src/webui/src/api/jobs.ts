// ============================================================
// api/jobs.ts —— 后台任务/子Agent 调用清单读面（DSH job_list 同款）
//
// M27 S3-1b：域契约（WireJob + fetchJobs/killJob）随行走迁
// ac-jobs/client（owning = 行包双半边）——本模块 re-export 维持旧
// import 路径；纯视图拆分（splitJobs/jobOutputPreview 等）留视图层。
// 实时性：job/started · job/settled 事件帧驱动域服务重拉（ac-jobs
// client 半边 ctx.jobBoard）。
// ============================================================

export type { WireJob } from 'ac-jobs/client';
export { fetchJobs, killJob } from 'ac-jobs/client';

import type { WireJob } from 'ac-jobs/client';

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
