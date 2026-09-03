// ============================================================
// api/workspaces.ts + api/files.ts —— 用户工作区与文件面 Port B
//（阶段二第四梯：preview 真实 HTTP 面，浏览器直连 fetch）
// ============================================================
// workspaces：用户登记的本机文件夹（白名单区域）= 会话列表树的根节点
// 分组；files：工作区文件树/预览/原始直链/上传。binary 注入
//（FilePreviewModal 硬依赖）与上传路径登记（chat.send 附件行合成）
// 在此收口。
// ============================================================

import { chatPresence } from './chat-ops';
import { wireRpc } from './wire.ts';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({} as Record<string, unknown>));
    throw new Error((data as { error?: string }).error || `HTTP ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

// ---- 用户工作区 CRUD ----

export interface Workspace {
  id: string;
  name: string;
  /** 文件夹绝对路径（会话沙箱白名单根） */
  path: string;
  createdAt: string;
  updatedAt: string;
}

export function fetchWorkspaces(): Promise<{ workspaces: Workspace[] }> {
  return jsonFetch('/api/workspaces');
}

export function createWorkspace(payload: { path: string; name?: string }): Promise<{ workspace: Workspace }> {
  return jsonFetch('/api/workspaces', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function updateWorkspace(id: string, payload: { name?: string; path?: string }): Promise<{ workspace: Workspace }> {
  return jsonFetch(`/api/workspaces/${encodeURIComponent(id)}`, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(payload),
  });
}

export function deleteWorkspace(id: string): Promise<{ deleted: boolean }> {
  return jsonFetch(`/api/workspaces/${encodeURIComponent(id)}`, { method: 'DELETE' });
}

// ---- 工作区文件面 ----

export interface WorkspaceNode {
  name: string;
  type: 'dir' | 'file';
  size?: number;
  children?: WorkspaceNode[];
}

/** 工作区树（query：目录路径，空=根；懒加载） */
export function fetchWorkspaceTree(query: string): Promise<{ path?: string; children?: WorkspaceNode[] }> {
  return jsonFetch(`/api/workspace/tree${query}`);
}

interface WorkspaceFile {
  path?: string;
  content?: string;
  base64?: boolean;
  contentType?: string;
  size?: number;
  error?: string;
}

/** 工作区文件内容（预览）；注入 binary = base64（FilePreviewModal 图片分支硬依赖——preview 端点无此字段） */
export async function fetchWorkspaceFile(path: string): Promise<WorkspaceFile & { binary: boolean }> {
  const body = await jsonFetch<WorkspaceFile>(`/api/workspace/file?path=${encodeURIComponent(path)}`);
  return { ...body, binary: body.base64 === true };
}

/** 浏览读取文件（ToolResultWrite 展开原文）：workspace/file 的别名 */
export async function browseReadFile(path: string): Promise<{ content?: string; error?: string }> {
  return fetchWorkspaceFile(path);
}

// ---- 本机目录浏览（workspace/browse-dirs RPC；路径穿透白名单的文件夹选择弹窗） ----

/** workspace/browse-dirs 返回形状：path 空 = 快捷根清单；否则子目录列表
 *  （只列目录不列文件；无权限/不存在 → error 字符串，不抛错——弹窗降级显示）。
 *  files:true（opts）时附带常规文件清单（配置弹窗文件路径选择用） */
export interface BrowseDirsResult {
  path: string;
  parent?: string;
  roots?: Array<{ name: string; path: string }>;
  dirs: Array<{ name: string; path: string }>;
  files?: Array<{ name: string; path: string }>;
  error?: string;
}

type DirRpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

/** 浏览本机目录（path 空 = 快捷根；须为绝对路径；files = 附带文件清单） */
export function browseDirs(path = '', opts?: { files?: boolean }, rpc: DirRpc = wireRpc): Promise<BrowseDirsResult> {
  return rpc.call('workspace/browse-dirs', {
    ...(path ? { path } : {}),
    ...(opts?.files ? { files: true } : {}),
  });
}

// ---- 上传（multipart；响应指纹 → 路径登记，供 chat.send 附件行合成） ----

interface UploadResult {
  hash?: string;
  storedName?: string;
  originalName?: string;
  size?: number;
  path?: string;
}

export async function uploadFile(formData: FormData, agentId?: string): Promise<UploadResult> {
  if (agentId && agentId !== 'user') formData.append('agentId', agentId);
  const body = await jsonFetch<UploadResult>('/api/upload', { method: 'POST', body: formData });
  if (typeof body.path === 'string') {
    if (body.hash) chatPresence.uploadPaths.set(body.hash, body.path);
    if (body.storedName) chatPresence.uploadPaths.set(body.storedName, body.path);
    if (body.originalName) chatPresence.uploadPaths.set(body.originalName, body.path);
  }
  return body;
}
