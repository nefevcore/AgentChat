// ============================================================
// ac-error-core/tests/error.test.ts —— describeError / isTransientNetworkError
// / LlmHttpError 分类（cr-98）
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  describeError,
  isTransientNetworkError,
  LlmHttpError,
  classifyLlmHttpStatus,
  parseRetryAfter,
  isRetryableLlmHttpError,
  llmRetryWaitMs,
} from '../src/index';

/** undici 网络层失败的标准形状：TypeError "fetch failed" + cause 真实原因 */
function undiciError(code = 'ECONNRESET', message = `connect ${code} 1.2.3.4:443`): TypeError {
  const cause = Object.assign(new Error(message), { code });
  return new TypeError('fetch failed', { cause });
}

describe('describeError（cause 链展开）', () => {
  it('拼接 message + cause 链（code 拼接为 code: message）', () => {
    expect(describeError(undiciError('ECONNREFUSED', 'connect ECONNREFUSED'))).toBe(
      'fetch failed ← ECONNREFUSED: connect ECONNREFUSED',
    );
  });

  it('多级 cause 链逐层拼接，同文本去重', () => {
    const leaf = new Error('socket hang up');
    const mid = new Error('other side closed', { cause: leaf });
    const top = new Error('fetch failed', { cause: mid });
    expect(describeError(top)).toBe('fetch failed ← other side closed ← socket hang up');
  });

  it('cause 深度上限 3（顶层消息外最多 3 个节点，第 5 层截断）', () => {
    const e5 = new Error('fifth');
    const e4 = new Error('fourth', { cause: e5 });
    const e3 = new Error('third', { cause: e4 });
    const e2 = new Error('second', { cause: e3 });
    const e1 = new Error('first', { cause: e2 });
    expect(describeError(e1)).toBe('first ← second ← third ← fourth');
  });

  it('无 cause / 非 Error 输入不炸', () => {
    expect(describeError(new Error('x'))).toBe('x');
    expect(describeError('裸字符串')).toBe('裸字符串');
  });
});

describe('isTransientNetworkError（瞬时网络故障判定）', () => {
  it('undici 外壳（fetch failed）与 cause code 命中清单 → true', () => {
    expect(isTransientNetworkError(undiciError())).toBe(true);
    expect(isTransientNetworkError(undiciError('ETIMEDOUT'))).toBe(true);
    expect(isTransientNetworkError(undiciError('UND_ERR_CONNECT_TIMEOUT'))).toBe(true);
  });

  it('裸 fetch failed（无 cause）也判瞬时：undici 只在网络层失败抛此形状', () => {
    expect(isTransientNetworkError(new TypeError('fetch failed'))).toBe(true);
  });

  it('中止不是故障：AbortError 在链上任一位置 → false（中止优先于瞬时判定）', () => {
    // undici 中止形状：TypeError fetch failed ← AbortError
    const aborted = new TypeError('fetch failed', {
      cause: Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
    });
    expect(isTransientNetworkError(aborted)).toBe(false);
    const domAbort = new DOMException('This operation was aborted', 'AbortError');
    expect(isTransientNetworkError(domAbort)).toBe(false);
  });

  it('HTTP 状态错误 / 业务错误 / 普通错误 → false', () => {
    expect(isTransientNetworkError(new Error('LLM HTTP 429: quota exceeded'))).toBe(false);
    expect(isTransientNetworkError(new Error('LLM SSE 数据解析失败: oops'))).toBe(false);
    expect(isTransientNetworkError(new Error('provider boom'))).toBe(false);
  });

  it('非 Error 输入（字符串/null/undefined）不炸且非瞬时', () => {
    expect(isTransientNetworkError('fetch failed')).toBe(false); // 字符串无 message 属性
    expect(isTransientNetworkError(null)).toBe(false);
    expect(isTransientNetworkError(undefined)).toBe(false);
  });

  it('cause 环防御（深度上限 5 不死循环）', () => {
    const a: { cause?: unknown } = new Error('a');
    const b = new Error('b', { cause: a });
    a.cause = b;
    expect(() => isTransientNetworkError(a as Error)).not.toThrow();
  });
});

describe('LlmHttpError 分类（cr-98）', () => {
  it('状态码 → 分类映射（401/403=AUTH，429=RATE_LIMIT，402/文案=QUOTA，5xx=SERVER，其余=INVALID）', () => {
    expect(classifyLlmHttpStatus(401, '')).toBe('AUTH');
    expect(classifyLlmHttpStatus(403, '')).toBe('AUTH');
    expect(classifyLlmHttpStatus(429, '')).toBe('RATE_LIMIT');
    expect(classifyLlmHttpStatus(402, '')).toBe('QUOTA');
    expect(classifyLlmHttpStatus(400, 'insufficient_balance')).toBe('QUOTA');
    expect(classifyLlmHttpStatus(500, '')).toBe('SERVER');
    expect(classifyLlmHttpStatus(503, '')).toBe('SERVER');
    expect(classifyLlmHttpStatus(400, 'bad request')).toBe('INVALID');
    expect(classifyLlmHttpStatus(404, '')).toBe('INVALID');
  });

  it('构造器携带分类与 Retry-After；isRetryable 只认 RATE_LIMIT/SERVER', () => {
    const rateLimit = new LlmHttpError(429, 'LLM HTTP 429: slow down', 2000);
    expect(rateLimit.kind).toBe('RATE_LIMIT');
    expect(rateLimit.retryAfterMs).toBe(2000);
    expect(isRetryableLlmHttpError(rateLimit)).toBe(true);
    expect(isRetryableLlmHttpError(new LlmHttpError(503, 'oops'))).toBe(true);
    expect(isRetryableLlmHttpError(new LlmHttpError(401, 'bad key'))).toBe(false);
    expect(isRetryableLlmHttpError(new LlmHttpError(402, 'quota'))).toBe(false);
    expect(isRetryableLlmHttpError(new Error('plain'))).toBe(false);
  });

  it('parseRetryAfter：秒数与 HTTP 日期；上限 5 分钟；垃圾值 undefined', () => {
    expect(parseRetryAfter('2')).toBe(2000);
    expect(parseRetryAfter(' 3 ')).toBe(3000);
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter('')).toBeUndefined();
    expect(parseRetryAfter('soon')).toBeUndefined();
    // HTTP 日期形态：未来时间 → 正数毫秒（上限封顶）
    const future = new Date(Date.now() + 3600_000).toUTCString();
    expect(parseRetryAfter(future)).toBe(300_000);
    // 过大的秒数封顶 5 分钟
    expect(parseRetryAfter('99999')).toBe(300_000);
  });

  it('llmRetryWaitMs：Retry-After 优先，缺省回落 fallback', () => {
    expect(llmRetryWaitMs(new LlmHttpError(429, 'x', 7000), 500)).toBe(7000);
    expect(llmRetryWaitMs(new LlmHttpError(429, 'x'), 500)).toBe(500);
    expect(llmRetryWaitMs(new Error('net'), 1500)).toBe(1500);
  });
});
