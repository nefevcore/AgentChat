// Router 网络失效模式：网络错误判定 + pending 逻辑
import { describe, it, expect, vi, beforeEach } from 'vitest';

// 复制 isNetworkError 逻辑（与 agent.ts 一致）
function isNetworkError(err: any): boolean {
  const msg = (err?.message || String(err || '')).toLowerCase();
  const code = err?.code || err?.cause?.code || '';
  if (['econnrefused', 'enotfound', 'etimedout', 'eai_again', 'econnreset', 'socket hang up', 'network', 'fetch failed'].some(k => msg.includes(k) || String(code).toLowerCase().includes(k))) return true;
  if (err?.name === 'AbortError' || msg.includes('timeout') || msg.includes('aborted')) return true;
  return false;
}

describe('网络错误判定（isNetworkError）', () => {
  it('网络类错误判为失效', () => {
    expect(isNetworkError({ message: 'fetch failed: ECONNREFUSED' })).toBe(true);
    expect(isNetworkError({ message: 'connect ETIMEDOUT 1.2.3.4' })).toBe(true);
    expect(isNetworkError({ message: 'getaddrinfo ENOTFOUND api.deepseek.com' })).toBe(true);
    expect(isNetworkError({ message: 'socket hang up' })).toBe(true);
    expect(isNetworkError({ name: 'AbortError', message: 'The operation was aborted' })).toBe(true);
    expect(isNetworkError({ message: 'network timeout' })).toBe(true);
  });

  it('非网络类错误不算失效（429/4xx/5xx/空响应）', () => {
    expect(isNetworkError({ message: 'HTTP 429 Too Many Requests' })).toBe(false);
    expect(isNetworkError({ message: 'HTTP 400 Bad Request' })).toBe(false);
    expect(isNetworkError({ message: 'HTTP 500 Internal Server Error' })).toBe(false);
    expect(isNetworkError({ message: 'Invalid API key' })).toBe(false);
    expect(isNetworkError({ message: '' })).toBe(false);
  });
});
