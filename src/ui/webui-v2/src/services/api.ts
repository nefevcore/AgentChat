// ============================================================
// services/api.ts —— REST API 客户端（纯 TS，零 Vue 依赖）
//
// 把散落在组件里的 fetch 调用收拢为类型化 API。组件只依赖
// 本模块导出的函数，不直接碰 fetch/URL。
// ============================================================

import type { AgentInfo, GroupInfo, GroupHistoryMessage } from '@/domain/types';

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(path, {
    headers: init?.body ? { 'Content-Type': 'application/json' } : undefined,
    ...init,
  });
  if (!resp.ok) {
    let message = `HTTP ${resp.status}`;
    try {
      const data = await resp.json();
      message = data?.error || message;
    } catch { /* ignore */ }
    throw new Error(message);
  }
  return resp.json() as Promise<T>;
}

// ── 群组 ──
export const groupApi = {
  list(): Promise<{ groups: GroupInfo[] }> {
    return request('/api/groups');
  },
  create(body: { name: string; description?: string; participants?: string[] }): Promise<{ group_id: string }> {
    return request('/api/groups', { method: 'POST', body: JSON.stringify(body) });
  },
  update(id: string, body: { name?: string; description?: string }): Promise<any> {
    return request(`/api/groups/${encodeURIComponent(id)}`, { method: 'PATCH', body: JSON.stringify(body) });
  },
  remove(id: string): Promise<any> {
    return request(`/api/groups/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  history(id: string, limit = 50, offset = 0): Promise<{ messages: GroupHistoryMessage[] }> {
    return request(`/api/groups/${encodeURIComponent(id)}/history?limit=${limit}&offset=${offset}`);
  },
};

// ── Agent ──
export const agentApi = {
  remove(id: string): Promise<any> {
    return request(`/api/agents/${encodeURIComponent(id)}`, { method: 'DELETE' });
  },
  avatar(id: string): string {
    return `/api/agents/${encodeURIComponent(id)}/avatar`;
  },
  tokens(id: string): Promise<any> {
    return request(`/api/sessions/${encodeURIComponent(id)}/tokens`);
  },
};

// ── 配置 ──
export const configApi = {
  get(): Promise<any> {
    return request('/api/config');
  },
  pools(): Promise<{ llmProviders?: Record<string, Record<string, unknown>> }> {
    return request('/api/config/pools');
  },
};

// ── 版本 ──
export const versionApi = {
  get(): Promise<any> {
    return request('/api/version');
  },
  changelog(): Promise<any> {
    return request('/api/version/changelog');
  },
};

// ── 用量 ──
export const usageApi = {
  tokens(): Promise<any> {
    return request('/api/usage/tokens');
  },
};

// ── 工作区 ──
export interface WorkspaceTreeNode {
  name: string;
  type: 'dir' | 'file' | 'more';
  size?: number;
  children?: WorkspaceTreeNode[];
}
export const workspaceApi = {
  tree(): Promise<{ path: string; children: WorkspaceTreeNode[] }> {
    return request('/api/workspace/tree');
  },
  file(path: string): Promise<any> {
    return request(`/api/workspace/file?path=${encodeURIComponent(path)}`);
  },
  raw(path: string): Promise<any> {
    return request(`/api/workspace/raw?path=${encodeURIComponent(path)}`);
  },
};

// ── 浏览 ──
export const browseApi = {
  file(path: string): Promise<any> {
    return request(`/api/browse/file?path=${encodeURIComponent(path)}`);
  },
  readFile(path: string): Promise<any> {
    return request(`/api/browse/read-file?path=${encodeURIComponent(path)}`);
  },
};

// ── 上传 ──
export function uploadFile(file: File, agentId?: string): Promise<{ hash: string; storedName?: string; originalName?: string; size: number; path?: string }> {
  const formData = new FormData();
  formData.append('file', file);
  if (agentId && agentId !== 'user') formData.append('agentId', agentId);
  return fetch('/api/upload', { method: 'POST', body: formData }).then(async (resp) => {
    if (!resp.ok) throw new Error(`上传失败: HTTP ${resp.status}`);
    return resp.json();
  });
}
