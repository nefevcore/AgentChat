// ============================================================
// host-endpoint.ts —— webui 独立部署宿主端点发现 + hello 握手
//（webui-standalone-protocol §3.1/§3.2，cr-917 切片一）
//
// webui = 可独立部署前端产物：同源托管（现状）与跨源部署共用同一份
// 产物，差异仅在「宿主端点从哪来」。发现 = 端点单值注入，不做服务
// 发现；解析序前者赢：
//   ① URL 参数 ?host=<origin>（分享链接/调试——显式可审计）
//   ② localStorage 'ac.host'（设置 UI 写入——常规独立部署形态）
//   ③ 构建期注入 window.__AC_HOST__（固定部署点产物）
//   ④ location.origin（同源托管——现状行为零变化）
// 非同源时所有宿主请求（boot-graph / 通道资产 / WS / hello）经
// hostUrl() 加前缀；同源时 hostUrl 原样返回相对路径（逐字节等价——
// 切片一验收判据）。
//
// hello 握手：跨源部署连接前先 GET <host>/api/ui/hello——协议轴
// major 不匹配 = fail-loud 版本冲突页；不可达 = 交断连降级态处理
//（切片三接线；本层只如实回报）。同源形态跳过握手（零行为变化）。
// ============================================================

/** 端点解析输入（纯函数面——浏览器形态由 browserHostEndpoint 采集） */
export interface EndpointInputs {
  /** 页面地址（浏览器 = location；测试注入） */
  location: { origin: string; href: string };
  /** URL 查询参数取值（缺省层跳过） */
  queryHost?: string | null;
  /** localStorage 形态存储（缺省层跳过） */
  storage?: { getItem(key: string): string | null } | null;
  /** 构建期注入全局（window.__AC_HOST__） */
  injectedHost?: string | null;
}

/** 解析产物 */
export interface HostEndpoint {
  /** 宿主 origin（形如 'http://127.0.0.1:3830'；非法注入层值被忽略） */
  origin: string;
  /** 非同源 = true（独立部署形态——请求需前缀化 + 握手） */
  crossOrigin: boolean;
  /** 命中层（诊断/审计面） */
  source: 'url' | 'storage' | 'inject' | 'same-origin';
}

/** origin 合法性：URL 解析成功 + http/https + 无路径尾巴 */
function parseOrigin(value: string): string | null {
  if (!value) return null;
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    return null;
  }
  if (url.protocol !== 'http:' && url.protocol !== 'https:') return null;
  return url.origin;
}

/** 四层解析（前者赢；非法值忽略落下一层——显式配置错误不静默顶替同源） */
export function resolveHostEndpoint(inputs: EndpointInputs): HostEndpoint {
  const candidates: Array<{ source: HostEndpoint['source']; value: string | null | undefined }> = [
    { source: 'url', value: inputs.queryHost },
    { source: 'storage', value: inputs.storage?.getItem('ac.host') ?? null },
    { source: 'inject', value: inputs.injectedHost },
  ];
  for (const c of candidates) {
    if (c.value === null || c.value === undefined || c.value === '') continue;
    const origin = parseOrigin(c.value);
    if (origin === null) {
      console.warn('[host-endpoint] 忽略非法宿主端点值（' + c.source + '）：' + c.value);
      continue;
    }
    return { origin, crossOrigin: origin !== inputs.location.origin, source: c.source };
  }
  return { origin: inputs.location.origin, crossOrigin: false, source: 'same-origin' };
}

/** 浏览器形态解析（单例——页面生命周期内端点不变） */
let cachedBrowser: HostEndpoint | null = null;
export function browserHostEndpoint(): HostEndpoint {
  if (cachedBrowser !== null) return cachedBrowser;
  const loc = typeof location !== 'undefined'
    ? location
    : { origin: 'http://localhost', href: 'http://localhost/' };
  const globals = globalThis as Record<string, unknown>;
  cachedBrowser = resolveHostEndpoint({
    location: { origin: loc.origin, href: loc.href },
    queryHost: typeof URLSearchParams !== 'undefined' ? new URLSearchParams(loc.href.split('?')[1] ?? '').get('host') : null,
    storage: typeof localStorage !== 'undefined' ? localStorage : null,
    injectedHost: typeof globals.__AC_HOST__ === 'string' ? globals.__AC_HOST__ as string : null,
  });
  return cachedBrowser;
}

/** 测试收尾：清浏览器单例 */
export function resetHostEndpointForTest(): void {
  cachedBrowser = null;
}

/**
 * 宿主请求 URL：非同源 = origin + path；同源 = path 原样（现状相对
 * 路径逐字节等价——切片一回归锁的面）。
 */
export function hostUrl(path: string, endpoint: HostEndpoint = browserHostEndpoint()): string {
  return endpoint.crossOrigin ? endpoint.origin + path : path;
}

// ---- hello 握手（§3.2）----

/** hello 应答契约（宿主 /api/ui/hello 端点——webui-row 注册面） */
export interface HelloReply {
  protocol: number;
  hostVersion?: string;
  engines?: { agentchat?: string };
  surfaces?: { bootGraph?: boolean; assets?: boolean; ws?: boolean };
}

/** 本产物说出的协议轴 major（宿主不一致即 fail-loud） */
export const UI_PROTOCOL = 1;

export type HelloOutcome =
  | { kind: 'ok'; reply: HelloReply }
  /** 协议轴 major 不匹配——fail-loud 版本冲突页（禁止静默半工作） */
  | { kind: 'protocol-conflict'; remote: number }
  /** 宿主不可达——断连降级态输入（切片三接线） */
  | { kind: 'unreachable'; error: string };

/** 握手（跨源部署连接前调用；同源形态不需要） */
export async function helloHandshake(
  endpoint: HostEndpoint,
  fetchImpl: typeof fetch = fetch,
  timeoutMs = 5000,
): Promise<HelloOutcome> {
  let reply: HelloReply;
  try {
    const res = await fetchImpl(hostUrl('/api/ui/hello', endpoint), { signal: AbortSignal.timeout(timeoutMs) });
    if (!res.ok) return { kind: 'unreachable', error: 'hello ' + res.status };
    reply = await res.json() as HelloReply;
  } catch (err) {
    return { kind: 'unreachable', error: err instanceof Error ? err.message : String(err) };
  }
  if (typeof reply.protocol !== 'number' || Math.floor(reply.protocol) !== UI_PROTOCOL) {
    return { kind: 'protocol-conflict', remote: typeof reply.protocol === 'number' ? reply.protocol : Number.NaN };
  }
  return { kind: 'ok', reply };
}

/**
 * 协议冲突页（fail-loud——替换整窗内容，双向指引：宿主需升级 /
 * 产物需重建）。禁止静默半工作：boot 到此为止。
 */
export function showProtocolConflictPage(hostOrigin: string, remoteProtocol: number): void {
  if (typeof document === 'undefined') return;
  document.title = '协议版本不匹配 — AgentChat';
  document.body.innerHTML = ''
    + '<div style="font-family:system-ui;max-width:32rem;margin:15vh auto;padding:0 1rem;color:#222">'
    + '<h1>宿主协议版本不匹配</h1>'
    + '<p>宿主 <code>' + hostOrigin + '</code> 报告协议版本 <code>' + remoteProtocol + '</code>，'
    + '本界面产物协议版本 <code>' + UI_PROTOCOL + '</code>。</p>'
    + '<ul><li>宿主版本过旧 → 请升级宿主应用后重试</li>'
    + '<li>界面产物过旧 → 请重新构建 / 重新部署 webui 产物</li></ul>'
    + '</div>';
}
