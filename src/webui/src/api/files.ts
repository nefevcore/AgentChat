// ============================================================
// api/workspaces.ts + api/files.ts —— 用户工作区与文件面 Port B
//（阶段二第四梯：preview 真实 HTTP 面，浏览器直连 fetch）
// ============================================================
// workspaces：用户登记的本机文件夹（白名单区域）= 会话列表树的根节点
// 分组；files：工作区文件树/预览/原始直链/上传。binary 注入
//（FilePreviewModal 硬依赖）与上传路径登记（chat.send 附件行合成）
// 在此收口。
// ============================================================

import { wireRpc } from './wire.ts';

async function jsonFetch<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({} as Record<string, unknown>));
    throw new Error((data as { error?: string }).error || `HTTP ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

// ---- 用户工作区 CRUD（已随 UI 行走迁 ac-client-ui-workspace/client
//      ——M27.1 前端行拆包；本模块 re-export 维持旧路径） ----

export type { Workspace } from 'ac-client-ui-workspace/client';
export {
  fetchWorkspaces,
  createWorkspace,
  updateWorkspace,
  deleteWorkspace,
} from 'ac-client-ui-workspace/client';

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

// ---- 工作区文件读取（已随 tool 件迁 ac-client-ui-tool/client/
//      workspaceFile.ts——M27.2-2 出包；本模块 re-export 维持旧路径
//      供 FilePreviewModal 等消费） ----

export type { WorkspaceFile } from 'ac-client-ui-tool/client/workspaceFile.ts';
export { fetchWorkspaceFile, browseReadFile } from 'ac-client-ui-tool/client/workspaceFile.ts';

// ---- 本机目录浏览（workspace/browse-dirs RPC；路径穿透白名单的文件夹选择弹窗）
// owning = ac-client-ui-conversation/client/fileApi.ts（M27.2-2 视图半边
// 随件迁——薄包装补 wireRpc 缺省维持旧签名）

export type { BrowseDirsResult } from 'ac-client-ui-conversation/client/fileApi.ts';
import { browseDirs as pkgBrowseDirs, type BrowseDirsResult } from 'ac-client-ui-conversation/client/fileApi.ts';

type DirRpc = { call<T>(method: string, params?: Record<string, unknown>): Promise<T> };

/** 浏览本机目录（path 空 = 快捷根；须为绝对路径；files = 附带文件清单） */
export function browseDirs(path = '', opts?: { files?: boolean }, rpc: DirRpc = wireRpc): Promise<BrowseDirsResult> {
  return pkgBrowseDirs(path, opts, rpc);
}

// ---- 上传（multipart；响应指纹 → 路径登记，供 chat.send 附件行合成） ----

export { uploadFile } from 'ac-client-ui-conversation/client/fileApi.ts';
