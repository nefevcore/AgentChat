// ============================================================
// core/api/client.ts —— 统一 HTTP 客户端（全项目唯一 fetch 入口）
//
// 职责：
//   · 统一错误处理：非 2xx 抛 Error（body.error 或 HTTP status）
//   · 瞬时网络故障退避重试（与后端 ac-llm 同款语义，2026-09-05 nana
//     事故的对策前移到前端）：仅幂等请求（GET/HEAD）且仅在响应
//     到达【之前】失败（fetch reject——断网/连接重置/DNS 抖动）按
//     500ms/1500ms 退避重试 2 次。判定逻辑 isTransientNetworkError
//     与后端 ac-error-core 同源镜像（浏览器 TypeError('fetch failed')
//     vs undici cause 链形态差异适配，对拍测试锁定防漂移）。
//     非 2xx（服务器已应答，包括 502/503——后端重启窗口由 WS 通道
//     的重连恢复链兜底）与非幂等方法（POST——重放可能重复执行）
//     不重试。
// 约束：业务代码禁止直接 fetch —— 一律经此层或 endpoints/。
// ============================================================

/**
 * 网络层瞬时故障 code 清单（镜像 ac-error-core TRANSIENT_NETWORK_CODES）：
 * socket 断连/拒绝/超时 + DNS + undici 内部码。宁缺毋滥——语义不明的
 * 不进清单（不重试只是慢一点，误重试会放大故障）。
 */
const TRANSIENT_NETWORK_CODES = new Set([
  'ECONNRESET',
  'ECONNREFUSED',
  'ECONNABORTED',
  'EPIPE',
  'ETIMEDOUT',
  'ENOTFOUND',
  'EAI_AGAIN',
  'EHOSTUNREACH',
  'ENETUNREACH',
  'ENETDOWN',
  'UND_ERR_SOCKET',
  'UND_ERR_CONNECT_TIMEOUT',
]);

/**
 * 瞬时网络故障判定（镜像 ac-error-core isTransientNetworkError 的
 * 浏览器侧形态）：cause 链任一节点为 AbortError（调用方主动取消）→
 * false——中止不是故障，重试违背调用方意图；链上 message 为
 * "fetch failed" 或 code 命中瞬时清单 → true。深度上限 5（环防御）。
 */
export function isTransientNetworkError(err: unknown): boolean {
  let node: unknown = err;
  let depth = 0;
  let transient = false;
  while (node != null && depth < 5) {
    const e = node as { name?: unknown; message?: unknown; code?: unknown };
    if (e.name === 'AbortError') return false;
    if (e.message === 'fetch failed') transient = true;
    if (typeof e.code === 'string' && TRANSIENT_NETWORK_CODES.has(e.code)) transient = true;
    node = (node as { cause?: unknown }).cause;
    depth += 1;
  }
  return transient;
}

/** 重试策略（缺省 2 次：500ms/1500ms——与后端 ac-llm transientRetry 同轴） */
export interface TransientRetryPolicy {
  retries?: number;
  backoffMs?: number[];
}

const DEFAULT_RETRY: Required<TransientRetryPolicy> = {
  retries: 2,
  backoffMs: [500, 1500],
};

/** fetch 注入口（生产 = 全局构造器；测试注入假退避/假 fetch） */
let fetchFn: ((url: string, init?: RequestInit) => Promise<Response>) | null = null;

/** 保留注入点（测试/诊断）；收口后缺省即全局 fetch（每调用时读取——stubGlobal 语义可期） */
export function setApiFetcher(fn: typeof fetchFn): void {
  fetchFn = fn;
}

/** 可中止的退避等待：signal 中止即抛（中止优先于重试） */
function sleep(ms: number, signal?: AbortSignal | null): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(signal.reason);
    function onAbort(): void {
      clearTimeout(timer);
      reject(signal!.reason);
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener('abort', onAbort);
      resolve();
    }, ms);
    signal?.addEventListener('abort', onAbort, { once: true });
  });
}

function doFetch(url: string, init?: RequestInit): Promise<Response> {
  return (fetchFn ?? globalThis.fetch)(url, init);
}

export async function request<T>(url: string, init?: RequestInit, retry?: TransientRetryPolicy): Promise<T> {
  // 仅幂等方法重试（缺省 GET）；带 body 的请求一律不重放（重放可能重复执行）
  const method = (init?.method ?? 'GET').toUpperCase();
  const idempotent = (init?.body == null) && (method === 'GET' || method === 'HEAD');
  const { retries, backoffMs } = retry ? { ...DEFAULT_RETRY, ...retry } : DEFAULT_RETRY;
  for (let attempt = 0; ; attempt++) {
    let resp: Response;
    try {
      resp = await doFetch(url, init);
    } catch (err) {
      // 响应未到达 + 瞬时网络故障 + 幂等 + 次数未尽 → 退避重试（等待中
      // 被调用方 signal 中止时 sleep 直接以中止原因上抛——中止优先于重试）
      if (!idempotent || attempt >= retries || !isTransientNetworkError(err)) throw err;
      const wait = backoffMs[Math.min(attempt, backoffMs.length - 1)];
      const reason = (err as Error | undefined)?.message ?? String(err);
      console.warn(`[api] 瞬时网络错误（${reason}），${wait}ms 后重试 ${attempt + 1}/${retries}`);
      await sleep(wait, init?.signal);
      continue;
    }
    if (!resp.ok) {
      const data = await resp.json().catch(() => ({} as Record<string, unknown>));
      throw new Error((data as { error?: string }).error || `HTTP ${resp.status}`);
    }
    return resp.json() as Promise<T>;
  }
}
