// ============================================================
// ac-client-ui-tool/client/workspaceFile.ts —— workspace 文件 REST
// 读取小件（M27.2-2 随 tool 件迁入：ToolResult 卡的数据管线）
//
// 自 webui api/files.ts 迁入（fetchWorkspaceFile/browseReadFile——
// /api/workspace/file 端点的浏览器原生 fetch 同源直连；webui 侧
// api/files re-export 维持旧路径供 FilePreviewModal 等消费）。
// ============================================================

export interface WorkspaceFile {
  path?: string;
  content?: string;
  base64?: boolean;
  contentType?: string;
  size?: number;
  error?: string;
}

async function jsonFetch<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({} as Record<string, unknown>));
    throw new Error((data as { error?: string }).error || `HTTP ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

/** 工作区文件内容（预览）；注入 binary = base64（图片分支硬依赖——preview 端点无此字段） */
export async function fetchWorkspaceFile(path: string): Promise<WorkspaceFile & { binary: boolean }> {
  const body = await jsonFetch<WorkspaceFile>(`/api/workspace/file?path=${encodeURIComponent(path)}`);
  return { ...body, binary: body.base64 === true };
}

/** 浏览读取文件（ToolResultWrite 展开原文）：workspace/file 的别名 */
export async function browseReadFile(path: string): Promise<{ content?: string; error?: string }> {
  return fetchWorkspaceFile(path);
}
