// ============================================================
// core/api/endpoints/system.ts —— 系统类端点（备份/版本/用量/上传）
// ============================================================

import { request, jsonPost } from '../client';

export interface VersionInfo {
  current?: string;
  latest?: string;
  hasUpdate?: boolean;
  latestUrl?: string;
}

export function fetchVersion(simulate = false): Promise<VersionInfo> {
  return request(`/api/version${simulate ? '?simulate=true' : ''}`);
}

export function fetchChangelog(): Promise<{ content?: string }> {
  return request('/api/version/changelog');
}

export function runVersionUpdate(): Promise<{ status?: string; message?: string; steps?: string[] }> {
  return jsonPost('/api/version/update');
}

export function backupNow(): Promise<{ status?: string; file?: string; size?: number; keep?: number; error?: string }> {
  return jsonPost('/api/backup');
}

/** Token 用量统计的日期范围参数（都不传 = 全部历史） */
export interface UsageRangeParams {
  /** 最近 N 天（含今日），如 30 */
  days?: number;
  /** 自定义区间起（YYYY-MM-DD，含） */
  from?: string;
  /** 自定义区间止（YYYY-MM-DD，含） */
  to?: string;
}

/** Token 用量统计（结构复杂，调用方自行断言） */
export function fetchUsageTokens(params: UsageRangeParams = {}): Promise<any> {
  const qs = new URLSearchParams();
  if (params.days != null) qs.set('days', String(params.days));
  if (params.from) qs.set('from', params.from);
  if (params.to) qs.set('to', params.to);
  const q = qs.toString();
  return request(`/api/usage/tokens${q ? `?${q}` : ''}`);
}

/** 上传文件（带当前对话 Agent → files/<agentId>/_tmp/；否则全局 _tmp/） */
export function uploadFile(formData: FormData, agentId?: string): Promise<{ hash?: string; storedName?: string; originalName?: string; size?: number; path?: string }> {
  if (agentId && agentId !== 'user') formData.append('agentId', agentId);
  return request('/api/upload', { method: 'POST', body: formData });
}
