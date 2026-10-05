// ============================================================
// ac-remote-link/src/http-bridge.ts —— 宿主 HTTP 面的远程转发（M3.4）
//
// 问题：远程 WebView 只见 loopback（回环桥），而 webui 除 RPC 面外还依赖若干
// **同源 HTTP 端点**（/api/ui/boot-graph、/api/ui/extensions、/api/workspace/*、
// /api/workspaces、/api/upload …）。逐个端点 bridge 会持续追着 webui 新增端点跑
// （M3.2 的 boot-graph、M3.3 的 extensions/workspace 已是同一模式两次），
// 因此这里做**通用转发**：任意 /api/* 请求原样投到核心端自身的 web-server。
//
// 为什么是「向自己发一次回环 HTTP」而不是「直接调路由处理器」：
//   · RouteCall 需要真实的 req/res（Node IncomingMessage/ServerResponse），
//     伪造它们比一次回环请求更重且更易与真实行为分叉；
//   · 回环请求复用**完全同一条**代码路径（路由匹配、body 解析、二进制直出、
//     错误码），远程与本地行为不可能走散。
//
// 安全（远程可控输入的三道闸）：
//   1. /api/ 前缀 = 动态面；其余 = 静态面（cr-108：顶层白名单退役——web-server
//      静态托管是唯一目标，新 dist 文件自动可达，逃逸形态仍拒）；
//   2. 主机由**核心端自己**决定（127.0.0.1 + 自身监听口），远程无法指定目标
//      ——从结构上排除 SSRF；
//   3. 方法/路径里的任何 URL 形态（://、//）一律拒绝，防拼接逃逸。
//
// 方法面：read/static 两个 method 桥在注册处硬校验 GET-only（cr-105 起
// scopes 档位闸退役——方法闸在桥层自身，不依赖设备权限）。
// ============================================================

import { gzip as gzipCb } from 'node:zlib';
import { promisify } from 'node:util';

const gzipAsync = promisify(gzipCb);

/** 允许转发的 HTTP 方法（webui 实际用到的全集） */
const ALLOWED_METHODS = new Set(['GET', 'POST', 'PUT', 'PATCH', 'DELETE']);

/** 桥侧压缩阈值（cr-257）：小于它的应答压缩收益不抵 CPU 与帧包装开销 */
const GZIP_MIN_BYTES = 2048;

/** 可压缩 content-type 前缀白名单（文本类；字体/图片自带压缩或二进制敏感） */
const COMPRESSIBLE_PREFIXES = [
  'application/json',
  'application/javascript',
  'text/',
  'image/svg+xml',
];

/** 响应体上限：relay 单帧 8MB + base64 膨胀 4/3 + JSON 包装——留余量取 6MB。
 *  超限返回 413 并说明（大文件分片是已知后续项，见 M3.4 文档）。 */
export const MAX_PROXY_BODY_BYTES = 6 * 1024 * 1024;

export interface HttpBridgeParams {
  method?: string;
  /** 含 query 的路径；必须 /api/ 开头 */
  path?: string;
  /** 原样透传的 Content-Type（multipart 边界靠它） */
  contentType?: string;
  /** 条件请求 If-None-Match（cr-82）：WebView 缓存重协商上行——命中即 304 零字节 */
  ifNoneMatch?: string;
  /** 请求体原文（**base64url**）——JSON 与 multipart 一视同仁，桥侧无需理解语义。
   *  必须 base64url：手机侧 unb64u 只认 url 字符集，标准 base64 的 +/= 会被拒

   *  （M3.4 实测：用 base64 时桥侧抛 `bad base64url char`）。 */
  bodyB64?: string;
  /** 对端壳支持 gzip 解压（cr-257 协商位）：旧壳不认 gzip 标记却会拿到压缩字节
   *  当原文——JSON 解析全挂。只有显式 true 才启用桥侧压缩，新壳缺省向上兼容。 */
  supportsGzip?: boolean;
}

export interface HttpBridgeResult {
  status: number;
  /** 响应 Content-Type（缺省 application/octet-stream） */
  contentType: string;
  /** 响应体原文（base64）——文本/二进制一视同仁 */
  bodyB64: string;
  /** 缓存协商头透传（cr-82）：远程 WebView 原生 HTTP 缓存的全部前提——此前
   *  协议只回 status/contentType/bodyB64，核心端设的 ETag/Cache-Control 到
   *  不了手机，缓存从协议上不可能生效（每次冷启全量重拉头像等 /api/* 资源）。
   *  白名单采集而非全量透传：远程面最小信任面。旧壳不认此字段 = 现状。 */
  cacheHeaders?: Record<string, string>;
  /** 响应体已是 gzip（cr-257）：桥侧对 >2KB 可压缩类应答主动压缩，远程链路
   *  （WAN/移动网络）带宽是首要瓶颈——160KB JSON 压到 ~25KB。仅当请求带
   *  supportsGzip 协商位时产生（旧壳拿压缩字节当原文会全挂）。 */
  gzip?: boolean;
}

//（cr-108：顶层静态白名单 STATIC_TOP_DIRS/FILES 退役——cr-103「新 dist 文件忘加
// 白名单真机 404」事故类别根除。GET-only 钉在注册处；web-server 静态托管为唯一
// 目标，404 与否由它回答——桥只挡逃逸形态。）

/** 校验并规范出待转发的路径（失败即抛——错误信息对远程可见，故写明原因）。
 *  /api/ = 动态面；其余 = web-server 静态托管面（GET-only 由注册处钉死）。 */
function safePath(raw: string): string {
  if (!raw.startsWith('/')) {
    throw new Error('remote http: path must start with /');
  }
  if (raw.includes('://') || raw.includes('\\') || raw.split('/').includes('..')) {
    throw new Error('remote http: malformed path');
  }
  return raw;
}

/**
 * 把远程来的 HTTP 请求投到核心端自身的 web-server。
 *
 * @param port 核心端 web-server 的**实际**监听口（service.ready()）
 */
export async function proxyToSelf(port: number, params: HttpBridgeParams): Promise<HttpBridgeResult> {
  const method = (params.method ?? 'GET').toUpperCase();
  if (!ALLOWED_METHODS.has(method)) {
    throw new Error(`remote http: method ${method} not allowed`);
  }
  const path = safePath(params.path ?? '');
  const url = `http://127.0.0.1:${port}${path}`;

  const headers: Record<string, string> = {};
  if (params.contentType) headers['content-type'] = params.contentType;
  // 条件请求上行（cr-82）：桥转发 WebView 的 If-None-Match → 核心端路由才能回
  // 304 零字节应答（回程同为 cacheHeaders 白名单帧，304 不带 bodyB64 开销更小）。
  if (params.ifNoneMatch) headers['if-none-match'] = params.ifNoneMatch;
  // GET/HEAD 带 body 会被 fetch 拒绝——按方法决定是否附体
  const body = method === 'GET' || !params.bodyB64
    ? undefined
    : Buffer.from(params.bodyB64, 'base64url');
  if (body && body.byteLength > MAX_PROXY_BODY_BYTES) {
    return {
      status: 413,
      contentType: 'application/json',
      bodyB64: Buffer.from(JSON.stringify({
        error: `remote http: request body exceeds ${MAX_PROXY_BODY_BYTES} bytes`,
      })).toString('base64url'),
    };
  }

  const res = await fetch(url, { method, headers, body });
  const buf = Buffer.from(await res.arrayBuffer());
  // 缓存协商头白名单（小写——Node/fetch 头名大小写不敏感，桥侧单源）
  const cacheHeaders: Record<string, string> = {};
  for (const name of ['etag', 'last-modified', 'cache-control']) {
    const v = res.headers.get(name);
    if (v) cacheHeaders[name] = v;
  }
  // 桥侧压缩（cr-257）：undici fetch 已把 web-server 的压缩应答自动解压——统一在
  // 桥出口按阈值决策，web-server 侧行为不进方程。只压文本类（JSON/JS/CSS/SVG…），
  // 字体/图片类自带压缩或二进制敏感，前缀白名单判定。
  const contentType = res.headers.get('content-type') ?? 'application/octet-stream';
  let respBody = buf;
  let gzipped = false;
  if (params.supportsGzip === true
    && buf.byteLength > GZIP_MIN_BYTES && COMPRESSIBLE_PREFIXES.some((p) => contentType.startsWith(p))) {
    respBody = await gzipAsync(buf);
    gzipped = true;
  }
  if (respBody.byteLength > MAX_PROXY_BODY_BYTES) {
    return {
      status: 413,
      contentType: 'application/json',
      bodyB64: Buffer.from(JSON.stringify({
        error: `remote http: response exceeds ${MAX_PROXY_BODY_BYTES} bytes`,
      })).toString('base64url'),
    };
  }
  return {
    status: res.status,
    contentType,
    bodyB64: respBody.toString('base64url'),
    ...(gzipped ? { gzip: true } : {}),
    ...(Object.keys(cacheHeaders).length > 0 ? { cacheHeaders } : {}),
  };
}

