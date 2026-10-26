
import { describe, it, expect } from 'vitest';
import { CdpPage } from '../src/page.ts';

/** 构造带私有字段的测试实例（绕过 open——handleEvent/查询面是纯逻辑） */
function makePage() {
  // @ts-expect-error 测试直通构造（client/sessionId 未用到的纯诊断面）
  const p = new CdpPage(undefined, 'sess-1', 't-1', { bufferCapacity: 3, textTruncate: 10 });
  return p;
}

describe('CdpPage 诊断环形缓冲', () => {
  it('网络生命周期：requestWillBeSent → responseReceived → loadingFinished（状态/耗时归并）', () => {
    const p = makePage();
    p.handleEvent('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'GET', url: 'https://a/x' }, type: 'XHR' });
    p.handleEvent('Network.responseReceived', { requestId: 'r1', response: { status: 200 } });
    p.handleEvent('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 123 });
    const [e] = p.netEntries(0);
    expect(e).toMatchObject({ requestId: 'r1', state: 'done', status: 200, size: 123 });
  });

  it('loadingFailed → failed + errorText；errorOverview 计数', () => {
    const p = makePage();
    p.handleEvent('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'GET', url: 'https://a' } });
    p.handleEvent('Network.loadingFailed', { requestId: 'r1', errorText: 'net::ERR_FAILED' });
    p.handleEvent('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'boom' }] });
    expect(p.errorOverview(0)).toEqual({ consoleErrors: 1, failedRequests: 1 });
    expect(p.netEntries(0)[0]!.errorText).toBe('net::ERR_FAILED');
  });

  it('重定向链复用 requestId：条目更新为最终目的地（不重复计数）', () => {
    const p = makePage();
    p.handleEvent('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'GET', url: 'https://a/1' } });
    p.handleEvent('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'GET', url: 'https://a/2' }, redirectResponse: {} });
    expect(p.netEntries(0)).toHaveLength(1);
    expect(p.netEntries(0)[0]!.url).toBe('https://a/2');
  });

  it('环形容量：满 3 丢最旧；since 游标语义', () => {
    const p = makePage(); // cap 3
    for (let i = 0; i < 5; i++) {
      p.handleEvent('Network.requestWillBeSent', { requestId: 'r' + i, request: { method: 'GET', url: 'https://a/' + i } });
    }
    const all = p.netEntries(0);
    expect(all).toHaveLength(3);
    expect(all[0]!.url).toBe('https://a/2'); // 最旧两条已逐出
    expect(p.netEntries(all[0]!.seq)).toHaveLength(2);
  });

  it('console 级别映射 + level 过滤（error 起滤 = 仅 error）；文本截断', () => {
    const p = makePage();
    p.handleEvent('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'hello' }] });
    p.handleEvent('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'x'.repeat(50) }] });
    expect(p.consoleEntries(0, 'error')).toHaveLength(1);
    expect(p.consoleEntries(0, 'error')[0]!.text.length).toBeLessThanOrEqual(11); // 10 + …
    expect(p.consoleEntries(0)).toHaveLength(2);
  });

  it('exception 与 Log.entryAdded 归一（error/warning 级）', () => {
    const p = makePage();
    p.handleEvent('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught', exception: { description: 'TypeError: x is not a function' } } });
    p.handleEvent('Log.entryAdded', { entry: { level: 'error', text: 'blocked by CORS' } });
    const errs = p.consoleEntries(0, 'error');
    expect(errs).toHaveLength(2);
    expect(errs[1]!.text.startsWith('blocked by')).toBe(true); // 截断纪律：10 字符 + …
  });

  it('marker 单调递增（console/network 共用 seq 序）', () => {
    const p = makePage();
    const m0 = p.marker;
    p.handleEvent('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'GET', url: 'https://a' } });
    p.handleEvent('Runtime.consoleAPICalled', { type: 'log', args: [{ value: 'x' }] });
    expect(p.marker).toBeGreaterThan(m0);
    expect(p.netEntries(0)[0]!.seq).toBeLessThan(p.consoleEntries(0)[0]!.seq!);
  });
});
