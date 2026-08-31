// ============================================================
// core/api/client.ts —— 统一 HTTP 客户端（全项目唯一 fetch 入口）
//
// 职责：
//   · 统一错误处理：非 2xx 抛 Error（body.error 或 HTTP status）
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


