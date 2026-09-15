// ============================================================
// webui/tests/api-client-retry.test.ts —— 统一 HTTP 客户端
// 瞬时网络故障退避重试验收。
//
// 语义与后端 ac-llm dispatch() 同款（2026-09-05 nana 事故对策的
// 前端镜像）：仅幂等请求（GET/HEAD，无 body）且仅在响应到达前
// 失败（fetch reject——断网/连接重置）按退避重试；非 2xx 应答与
// 非幂等方法不重试。判定函数与 ac-error-core 对拍锁定防漂移。
// ============================================================
import { describe, it, expect, vi, afterEach } from 'vitest';
import {
  request,
  isTransientNetworkError,
  setApiFetcher,
} from '../src/core/api/client';
import {
  isTransientNetworkError as isTransientBackend,
} from '../../ac-error-core/src/index.ts';

/** 浏览器侧网络失败形态：TypeError('fetch failed')（真实原因不可见） */
function browserNetworkError(): Error {
  return new TypeError('fetch failed');
}

/** undici 侧网络失败形态：外壳 fetch failed + cause 链带 code */
function undiciNetworkError(code = 'ECONNRESET'): Error {
  const cause = Object.assign(new Error(`connect ${code} 127.0.0.1:3830`), { code });
  return new TypeError('fetch failed', { cause });
}

function jsonResponse(body: unknown, status = 200): Response {
  return { ok: status >= 200 && status < 300, status, json: async () => body } as unknown as Response;
}

afterEach(() => {
  setApiFetcher(null);
  vi.restoreAllMocks();
});

describe('isTransientNetworkError（前端镜像判定 × 后端 ac-error-core 对拍）', () => {
  it('两端口径一致：瞬时 code / fetch failed 外壳 / AbortError / 业务错误', () => {
    const cases: Array<{ err: unknown; expected: boolean; label: string }> = [
      { err: undiciNetworkError(), expected: true, label: 'undici ECONNRESET cause 链' },
      { err: undiciNetworkError('ETIMEDOUT'), expected: true, label: 'undici ETIMEDOUT cause 链' },
      { err: undiciNetworkError('UND_ERR_CONNECT_TIMEOUT'), expected: true, label: 'undici 连接超时内部码' },
      { err: browserNetworkError(), expected: true, label: '浏览器裸 fetch failed 外壳' },
      { err: new Error('HTTP 502'), expected: false, label: 'HTTP 状态错误（服务器已应答）' },
      { err: new Error('LLM HTTP 429: quota exceeded'), expected: false, label: '限流业务错误' },
      { err: Object.assign(new Error('The operation was aborted'), { name: 'AbortError' }), expected: false, label: '顶层中止' },
      {
        err: new TypeError('fetch failed', {
          cause: Object.assign(new Error('This operation was aborted'), { name: 'AbortError' }),
        }),
        expected: false,
        label: 'cause 链中止（中止优先——重试违背调用方意图）',
      },
      { err: new Error('provider boom'), expected: false, label: '普通业务错误' },
      { err: null, expected: false, label: 'null 不炸' },
    ];
    for (const { err, expected, label } of cases) {
      expect(isTransientNetworkError(err), label).toBe(expected);
      expect(isTransientBackend(err), `后端同判定：${label}`).toBe(expected);
    }
  });
});

describe('request 瞬时故障退避重试（与后端 ac-llm transientRetry 同轴）', () => {
  it('GET 首次 fetch reject → 退避重试后成功（不重放：成功值原样返回）', async () => {
    let calls = 0;
    setApiFetcher(async () => {
      calls += 1;
      if (calls === 1) throw browserNetworkError();
      return jsonResponse({ extensions: ['a'] });
    });
    const out = await request<{ extensions: string[] }>('/api/ui/extensions', undefined, { backoffMs: [1, 1] });
    expect(out).toEqual({ extensions: ['a'] });
    expect(calls).toBe(2);
  });

  it('重试耗尽仍失败 → 抛最后一次错误（总调用 = 1 + retries）', async () => {
    const fetchMock = vi.fn(async () => { throw undiciNetworkError(); });
    setApiFetcher(fetchMock as unknown as typeof fetch);
    await expect(
      request('/api/x', undefined, { retries: 2, backoffMs: [1, 1] }),
    ).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(3);
  });

  it('退避节奏按次序取用（真实计时下界：50+100ms 后第三次才发出）', async () => {
    const stamps: number[] = [];
    setApiFetcher(async () => {
      stamps.push(Date.now());
      if (stamps.length < 3) throw browserNetworkError();
      return jsonResponse({});
    });
    const start = Date.now();
    await request('/api/x', undefined, { retries: 2, backoffMs: [50, 100] });
    expect(stamps).toHaveLength(3);
    expect(Date.now() - start).toBeGreaterThanOrEqual(150);
  });

  it('POST 不重试（重放可能重复执行）——立即抛出', async () => {
    const fetchMock = vi.fn(async () => { throw browserNetworkError(); });
    setApiFetcher(fetchMock as unknown as typeof fetch);
    await expect(
      request('/api/x', { method: 'POST', body: '{"a":1}' }, { backoffMs: [1, 1] }),
    ).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('GET 带 body 同样不重试（幂等性以实际请求形态判定）', async () => {
    const fetchMock = vi.fn(async () => { throw browserNetworkError(); });
    setApiFetcher(fetchMock as unknown as typeof fetch);
    await expect(
      request('/api/x', { method: 'GET', body: 'x' }, { backoffMs: [1, 1] }),
    ).rejects.toThrow('fetch failed');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('非 2xx 应答（含 502/503——后端重启窗口）不重试：服务器已应答', async () => {
    const fetchMock = vi.fn(async () => jsonResponse({ error: '重启中' }, 503));
    setApiFetcher(fetchMock as unknown as typeof fetch);
    await expect(request('/api/x', undefined, { backoffMs: [1, 1] })).rejects.toThrow('重启中');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('AbortError 不重试（中止不是故障——重试违背调用方意图）', async () => {
    const fetchMock = vi.fn(async () => {
      throw Object.assign(new Error('The operation was aborted'), { name: 'AbortError' });
    });
    setApiFetcher(fetchMock as unknown as typeof fetch);
    await expect(request('/api/x', undefined, { backoffMs: [1, 1] })).rejects.toThrow('aborted');
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('退避等待中被 signal 中止 → 中止原因上抛（不再继续重试）', async () => {
    let calls = 0;
    setApiFetcher(async () => {
      calls += 1;
      throw browserNetworkError();
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(new Error('用户离开页面')), 20);
    await expect(
      request('/api/x', { signal: ac.signal }, { retries: 2, backoffMs: [500, 500] }),
    ).rejects.toThrow('用户离开页面');
    expect(calls).toBe(1); // 只发了首次请求，未进入第二次
  });

  it('每次重试走 console.warn 留痕（与后端 logger.warn 同姿势）', async () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    let calls = 0;
    setApiFetcher(async () => {
      calls += 1;
      if (calls < 3) throw browserNetworkError();
      return jsonResponse({});
    });
    await request('/api/x', undefined, { retries: 2, backoffMs: [1, 1] });
    expect(warn).toHaveBeenCalledTimes(2);
    expect(warn.mock.calls[0][0]).toContain('重试 1/2');
    expect(warn.mock.calls[1][0]).toContain('重试 2/2');
  });
});
