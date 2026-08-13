// ============================================================
// core/api/client.ts —— 统一 HTTP 客户端（全项目唯一 fetch 入口）
//
// 职责：
//   · 统一错误处理：非 2xx 抛 Error（body.error 或 HTTP status）
//   · JSON 方法封装：jsonPost / jsonPatch / jsonDelete
//   · stripEmpty：清理空值（保存前）
// 约束：业务代码禁止直接 fetch —— 一律经此层或 endpoints/。
// ============================================================

export async function request<T>(url: string, init?: RequestInit): Promise<T> {
  const resp = await fetch(url, init);
  if (!resp.ok) {
    const data = await resp.json().catch(() => ({} as Record<string, unknown>));
    throw new Error((data as { error?: string }).error || `HTTP ${resp.status}`);
  }
  return resp.json() as Promise<T>;
}

export function jsonPost<T>(url: string, body?: unknown): Promise<T> {
  return request<T>(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function jsonPatch<T>(url: string, body?: unknown): Promise<T> {
  return request<T>(url, {
    method: 'PATCH',
    headers: { 'Content-Type': 'application/json' },
    body: body === undefined ? undefined : JSON.stringify(body),
  });
}

export function jsonDelete<T = Record<string, unknown>>(url: string): Promise<T> {
  return request<T>(url, { method: 'DELETE' });
}

/** 清理空值（undefined/null 删除键），保存前统一处理 */
export function stripEmpty(raw: Record<string, unknown>): Record<string, unknown> {
  return JSON.parse(JSON.stringify(raw, (k, v) => v ?? undefined));
}
