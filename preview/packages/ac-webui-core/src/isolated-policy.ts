// ============================================================
// isolated-policy.ts —— iframe isolated 档白名单纯函数（8.5 收尾批）
//
// 主线 src/webui/src/core/extensions/p5.5-policy.ts 的 isolated 白名单段
// 平移进纯库（两侧共用单源）：宿主父窗口执行校验，iframe 无法绕过。
// rewriteGlobalStyle 段留主线 webui 应用层（样式消毒是宿主 UI 面关切，
// 与 isolated 装载解耦）。
// ============================================================

/** isolated request 白名单：iframe 隔离档只能请求只读 UI/版本/插件目录端点（GET 子集） */
const ISOLATED_REQUEST_ALLOWLIST: Array<{ method: 'GET'; path: RegExp }> = [
  { method: 'GET', path: /^\/api\/ui\/extensions$/ },
  { method: 'GET', path: /^\/api\/ui\/slots$/ },
  { method: 'GET', path: /^\/api\/config$/ },
  { method: 'GET', path: /^\/api\/version$/ },
  { method: 'GET', path: /^\/api\/plugins\/catalog$/ },
  { method: 'GET', path: /^\/api\/plugins\/permissions$/ },
  { method: 'GET', path: /^\/api\/plugins\/library$/ },
  { method: 'GET', path: /^\/api\/plugins\/assembly\/[a-z0-9_-]+$/ },
];

export function isAllowedIsolatedRequest(method: string, path: string): boolean {
  const normalizedPath = path.split('?')[0] ?? '';
  return ISOLATED_REQUEST_ALLOWLIST.some((entry) => entry.method === method && entry.path.test(normalizedPath));
}

const ISOLATED_EVENT_ALLOWLIST = new Set([
  'ui.extensions.changed',
  'plugin.catalog.changed',
  'plugin.reload',
  'agent.assembly.changed',
]);

export function isAllowedIsolatedEvent(type: string): boolean {
  return ISOLATED_EVENT_ALLOWLIST.has(type);
}
