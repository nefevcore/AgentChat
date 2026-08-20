// ============================================================
// core/api/endpoints/workspace.ts —— 工作区 / 文件 / 浏览 端点
// ============================================================

import { request, jsonPost } from '../client';

export interface WorkspaceNode {
  name: string;
  type: 'dir' | 'file';
  size?: number;
  children?: WorkspaceNode[];
}

/** 工作区树（query：目录路径，空=根） */
export function fetchWorkspaceTree(query: string): Promise<{ path?: string; children?: WorkspaceNode[] }> {
  return request(`/api/workspace/tree${query}`);
}

/** 工作区文件内容（预览；base64/contentType 供截图类文件） */
export function fetchWorkspaceFile(path: string): Promise<{ path?: string; content?: string; base64?: boolean; contentType?: string; error?: string }> {
  return request(`/api/workspace/file?path=${encodeURIComponent(path)}`);
}

/** 浏览读取文件（文件选择器选中后读内容） */
export function browseReadFile(path: string): Promise<{ content?: string; error?: string }> {
  return request(`/api/browse/read-file?path=${encodeURIComponent(path)}`);
}

/** 打开原生文件夹选择对话框（用户工作区登记用；取消 → success:false + cancelled） */
export function browseFolder(title?: string): Promise<{ success: boolean; path?: string; cancelled?: boolean; error?: string }> {
  return jsonPost('/api/browse/folder', { title });
}
