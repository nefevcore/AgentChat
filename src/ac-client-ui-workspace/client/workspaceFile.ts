// ============================================================
// ac-client-ui-workspace/client/workspaceFile.ts —— workspace 文件
// REST 读取小件（M28 P1 自 tool 随域迁入：FilePreviewModal 本地消费 +
// tool 卡跨包消费〔P2 卡行拆分后收口〕）
//
// /api/workspace/file 端点的浏览器原生 fetch 同源直连；webui 侧
// 原 webui api/files 门面已退役〔M28 §4.2〕。
// ============================================================

export interface WorkspaceFile {
  path?: string;
  content?: string;
  base64?: boolean;
  contentType?: string;
  size?: number;
  error?: string;
}

/** 读面工作区推导上下文（M32）：agentId（说话者——Agent 沙箱基准）/
 *  conversationId（single 会话键——挂载工作区基准）。服务端数据根快
 *  路径未命中时按基准定位 Agent 回复中的相对路径引用。 */
export interface ReadContext {
  agentId?: string;
  conversationId?: string;
}

async function jsonFetch<T>(url: string): Promise<T> {
  const resp = await fetch(url);
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({} as Record<string, unknown>));
    throw new Error((data as { error?: string }).error || `HTTP ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

/** context → query 后缀（agentId/conversationId 可选透传；空 context = ''） */
function contextQuery(ctx?: ReadContext): string {
  if (!ctx) return '';
  const parts: string[] = [];
  if (ctx.agentId) parts.push(`agentId=${encodeURIComponent(ctx.agentId)}`);
  if (ctx.conversationId) parts.push(`conversationId=${encodeURIComponent(ctx.conversationId)}`);
  return parts.length ? `&${parts.join('&')}` : '';
}

/** 工作区文件内容（预览）；注入 binary = base64（图片分支硬依赖——preview 端点无此字段） */
export async function fetchWorkspaceFile(path: string, ctx?: ReadContext): Promise<WorkspaceFile & { binary: boolean }> {
  const body = await jsonFetch<WorkspaceFile>(`/api/workspace/file?path=${encodeURIComponent(path)}${contextQuery(ctx)}`);
  return { ...body, binary: body.base64 === true };
}

/** 浏览读取文件（ToolResultWrite 展开原文）：workspace/file 的别名（同 context 推导） */
export async function browseReadFile(path: string, ctx?: ReadContext): Promise<{ content?: string; error?: string }> {
  return fetchWorkspaceFile(path, ctx);
}
