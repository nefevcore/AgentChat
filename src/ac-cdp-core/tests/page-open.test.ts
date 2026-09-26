
import { describe, it, expect, afterEach } from 'vitest';
import { CdpClient } from '../src/client.ts';
import { CdpPage } from '../src/page.ts';
import { FakeCdpServer } from '../src/fake-cdp.ts';

const cleanup: Array<() => Promise<void>> = [];
afterEach(async () => { for (const fn of cleanup.splice(0)) await fn(); });

describe('CdpPage.open + navigate 全链路（fake ws）', () => {
  it('open：createTarget → attachToTarget(flatten) → 域启用 → Emulation 一致性初始化', async () => {
    const s = new FakeCdpServer();
    await s.listen();
    cleanup.push(() => s.close());
    s.handlers.set('Target.createTarget', () => ({ targetId: 't-1' }));
    s.handlers.set('Target.attachToTarget', () => ({ sessionId: 'sess-1' }));
    // evaluate 断言插桩：navigate 后的 location.href / document.title
    s.handlers.set('Runtime.evaluate', (p) => {
      if (String(p.expression).includes('location.href')) return { result: { value: 'https://example.com/' } };
      if (String(p.expression).includes('document.title')) return { result: { value: 'Example' } };
      return { result: { value: null } };
    });
    const c = await CdpClient.connect(s.url());
    cleanup.push(() => Promise.resolve(c.close()));
    const page = await CdpPage.open(c, { locale: 'zh-CN', timezone: 'Asia/Shanghai', viewport: { width: 1280, height: 720 } });
    expect(page.sessionId).toBe('sess-1');
    const methods = s.calls.map((x) => x.method);
    expect(methods).toContain('Page.enable');
    expect(methods).toContain('Runtime.enable');
    expect(methods).toContain('Network.enable');
    expect(methods).toContain('Log.enable');
    // Emulation 一致性初始化（locale/timezone/viewport 都在）
    const emu = s.calls.filter((x) => x.method.startsWith('Emulation.'));
    expect(emu.map((x) => x.method).sort()).toEqual([
      'Emulation.setDeviceMetricsOverride', 'Emulation.setLocaleOverride', 'Emulation.setTimezoneOverride',
    ]);
    // 全部 enable 命令带 sessionId（flat session 路由）
    expect(s.calls.filter((x) => x.method === 'Page.enable').every((x) => x.sessionId === 'sess-1')).toBe(true);
    // navigate：loadEventFired 等待 + href/title 回读
    s.handlers.set('Page.navigate', () => {
      setTimeout(() => s.emit('Page.loadEventFired', {}, 'sess-1'), 20);
      return { frameId: 'f-1' };
    });
    const nav = await page.navigate('https://example.com/', 5000);
    expect(nav).toEqual({ url: 'https://example.com/', title: 'Example' });
  });

  it('事件流喂入诊断缓冲（ws 事件 → handleEvent 自动接驳）', async () => {
    const s = new FakeCdpServer();
    await s.listen();
    cleanup.push(() => s.close());
    s.handlers.set('Target.createTarget', () => ({ targetId: 't-1' }));
    s.handlers.set('Target.attachToTarget', () => ({ sessionId: 'sess-1' }));
    s.handlers.set('Runtime.evaluate', () => ({ result: { value: 'https://a/' } }));
    s.handlers.set('Page.navigate', () => {
      setTimeout(() => {
        s.emit('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'GET', url: 'https://a' }, type: 'Document' }, 'sess-1');
        s.emit('Network.loadingFailed', { requestId: 'r1', errorText: 'net::ERR_CONNECTION_REFUSED' }, 'sess-1');
        s.emit('Page.loadEventFired', {}, 'sess-1');
      }, 20);
      return { frameId: 'f-1' };
    });
    const c = await CdpClient.connect(s.url());
    cleanup.push(() => Promise.resolve(c.close()));
    const page = await CdpPage.open(c, {});
    // 事件接驳：owner 职责（BrowserService wireEvents 同款）
    c.on('event', (ev) => { if (ev.sessionId === page.sessionId) page.handleEvent(ev.method, ev.params); });
    await page.navigate('https://a/', 5000);
    for (let i = 0; i < 100 && page.errorOverview(0).failedRequests < 1; i++) {
      await new Promise((r) => setTimeout(r, 20)); // CI 慢机：ws 环回到达轮询
    }
    expect(page.errorOverview(0).failedRequests).toBe(1);
  });

  it('responseBody 硬门槛：pending → 如实拒绝；done → 取体截断', async () => {
    const s = new FakeCdpServer();
    await s.listen();
    cleanup.push(() => s.close());
    s.handlers.set('Target.createTarget', () => ({ targetId: 't-1' }));
    s.handlers.set('Target.attachToTarget', () => ({ sessionId: 'sess-1' }));
    s.handlers.set('Network.getResponseBody', () => ({ body: 'x'.repeat(100), base64Encoded: false }));
    const c = await CdpClient.connect(s.url());
    cleanup.push(() => Promise.resolve(c.close()));
    const page = await CdpPage.open(c, {});
    c.on('event', (ev) => { if (ev.sessionId === page.sessionId) page.handleEvent(ev.method, ev.params); });
    // pending 拒绝
    s.emit('Network.requestWillBeSent', { requestId: 'r1', request: { method: 'GET', url: 'https://a' } }, 'sess-1');
    await new Promise((r) => setTimeout(r, 50)); // ws 环回异步到达
    await expect(page.responseBody('r1', 4000)).rejects.toThrow(/尚未完成/);
    // done → 取体（截断语义）
    s.emit('Network.responseReceived', { requestId: 'r1', response: { status: 200 } }, 'sess-1');
    s.emit('Network.loadingFinished', { requestId: 'r1', encodedDataLength: 100 }, 'sess-1');
    await new Promise((r) => setTimeout(r, 50));
    const body = await page.responseBody('r1', 50);
    expect(body.truncated).toBe(true);
    expect(body.body.length).toBe(50); // maxLen 截断
    // 未知 requestId
    await expect(page.responseBody('nope', 4000)).rejects.toThrow(/无此请求/);
  });
});
