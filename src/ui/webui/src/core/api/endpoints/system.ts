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

/** Token 用量统计（结构复杂，调用方自行断言） */
export function fetchUsageTokens(): Promise<any> {
  return request('/api/usage/tokens');
}

/** 上传文件（带当前对话 Agent → files/<agentId>/_tmp/；否则全局 _tmp/） */
export function uploadFile(formData: FormData, agentId?: string): Promise<{ hash?: string; storedName?: string; originalName?: string; size?: number; path?: string }> {
  if (agentId && agentId !== 'user') formData.append('agentId', agentId);
  return request('/api/upload', { method: 'POST', body: formData });
}
