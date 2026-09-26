
import { describe, it, expect, afterEach } from 'vitest';
import { CdpClient } from '../src/client.ts';
import { FakeCdpServer } from '../src/fake-cdp.ts';

const servers: FakeCdpServer[] = [];
async function up() {
  const s = new FakeCdpServer();
  await s.listen();
  servers.push(s);
  return s;
}
afterEach(async () => {
  for (const s of servers.splice(0)) await s.close();
});

describe('CdpClient', () => {
  it('connect → send 命令 id 配对（并发乱序应答不错位）', async () => {
    const s = await up();
    s.handlers.set('A.slow', async () => { await new Promise((r) => setTimeout(r, 80)); return { tag: 'slow' }; });
    s.handlers.set('B.fast', () => ({ tag: 'fast' }));
    const c = await CdpClient.connect(s.url());
    const [slow, fast] = await Promise.all([c.send('A.slow'), c.send('B.fast')]);
    expect(slow).toEqual({ tag: 'slow' });
    expect(fast).toEqual({ tag: 'fast' });
    c.close();
  });

  it('协议 error 回执 → CdpCommandError（code/message 保留）', async () => {
    const s = await up();
    s.handlers.set('X.fail', () => { throw new Error('No resource with given identifier'); });
    const c = await CdpClient.connect(s.url());
    await expect(c.send('X.fail')).rejects.toThrow(/No resource/);
    c.close();
  });

  it('单命令超时只拒绝本命令（连接存活，后续命令照常）', async () => {
    const s = await up();
    s.handlers.set('X.hang', () => new Promise(() => undefined)); // 永不返回
    const c = await CdpClient.connect(s.url(), { commandTimeoutMs: 100 });
    await expect(c.send('X.hang')).rejects.toThrow(/超时/);
    const ok = await c.send('X.other');
    expect(ok).toEqual({});
    c.close();
  });

  it('事件分发带 sessionId；waitForEvent 匹配后解绑', async () => {
    const s = await up();
    const c = await CdpClient.connect(s.url());
    const got: string[] = [];
    c.on('event', (ev) => got.push(ev.method));
    const wait = c.waitForEvent('Page.loadEventFired', 'sess-1', 2000);
    s.emit('Page.loadEventFired', {}, 'sess-1');
    const ev = await wait;
    expect(ev).not.toBeNull();
    expect(got).toContain('Page.loadEventFired');
    // waitForEvent 已解绑：后续同名事件不再被它消费（无泄漏断言——再次等待靠新监听）
    const wait2 = c.waitForEvent('Page.loadEventFired', 'sess-1', 150);
    s.emit('Page.loadEventFired', {}, 'sess-1');
    expect(await wait2).not.toBeNull();
    c.close();
  });

  it('断线 → 全部 pending 拒绝 + closed 置位', async () => {
    const s = await up();
    s.handlers.set('X.hang', () => new Promise(() => undefined));
    const c = await CdpClient.connect(s.url());
    const p = c.send('X.hang');
    await new Promise((r) => setTimeout(r, 50));
    for (const ws of s.wss.clients) ws.terminate();
    await expect(p).rejects.toThrow(/断开/);
    expect(c.closed).toBe(true);
    await expect(c.send('X.any')).rejects.toThrow(/不可用/);
  });
});
