// ============================================================
// ac-error-core/src/index.ts —— 错误描述纯库（零 cordis 依赖）
//
// 背景（2026-09-05 nana run 事故）：Node 全局 fetch（undici）失败时
// 抛出的 TypeError message 只有 "fetch failed"——真实原因（ECONNRESET/
// ETIMEDOUT/DNS/TLS…）在 err.cause 链上。只取 err.message 的错误记录
// 全部退化为裸 "fetch failed"，无法诊断。本库两个函数：
//   · describeError           展开 cause 链为单行诊断文本
//                            （"fetch failed ← ECONNRESET: …"）
//   · isTransientNetworkError 网络层瞬时故障判定（可安全重试的
//                            建连/握手/DNS 抖动；中止不是故障）
//
// 消费方：ac-llm（瞬时错误重试判定 + 重试日志）、ac-agent-loop
// （run 收束错误描述）、ac-mcp-core（连接失败诊断——原址迁入）。
// ============================================================

/**
 * 展开 err.cause 链为单行诊断文本（节点以 " ← " 连接）。
 * Node fetch 失败时真实原因在 cause；深度上限 3（防环/超长链），
 * 同文本去重，code 拼接为 `${code}: ${message}`。
 * 非 Error 输入不炸（String 兜底）。
 */
export function describeError(err: unknown): string {
  const e = err as { message?: string; cause?: unknown } | null;
  const parts: string[] = [e?.message ?? String(err)];
  let cause = e?.cause;
  let depth = 0;
  while (cause && depth < 3) {
    const c = cause as { code?: string; message?: string };
    const text = c.code ? `${c.code}: ${c.message ?? ''}` : (c.message ?? String(cause));
    if (text && !parts.includes(text)) parts.push(text);
    cause = (cause as { cause?: unknown }).cause;
    depth += 1;
  }
  return parts.filter(Boolean).join(' ← ').replace(/\s+$/, '');
}

/**
 * 网络层瞬时故障 code 清单：socket 断连/拒绝/超时 + DNS + undici
 * 内部码（UND_ERR_SOCKET/UND_ERR_CONNECT_TIMEOUT）。宁缺毋滥——
 * 语义不明的不进清单（不重试只是慢一点，误重试会放大故障）。
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
 * 判定错误是否网络层瞬时故障（可安全重试的建连/握手/DNS 抖动）：
 *   · cause 链任一节点是中止（AbortError——调用方主动取消或超时
 *     中止经 abort 透传）→ false：中止不是故障，重试违背调用方意图；
 *   · 链上任一节点 message 为 "fetch failed"（undici 网络层失败的
 *     统一外壳，真实原因在 cause）或 code 命中瞬时清单 → true；
 *   · HTTP 状态错误（如 "LLM HTTP 429: …"）/业务错误 → false。
 * 深度上限 5（cause 环/超长链防御）。
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
