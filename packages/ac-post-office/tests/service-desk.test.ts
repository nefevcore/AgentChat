// ============================================================
// service-desk.test.ts —— cr-1175 批 1：服务帧通道单测
//
// 验收（设计 §五批 1）：帧往返（request/report 两档）/ 未知 verb 容错 /
// report 不等待 / 信封帧与服务帧同口共存。desk（ac-host-rows）+
// PostOffice.setServiceDesk 组合真链。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { IpcClient, makeEnvelope } from 'ac-envelope-core';
import { PostOffice } from '../src/post-office.ts';
import { HostServiceDesk } from '../../ac-host-rows/src/service-desk.ts'; // 相对路径绕 workspace 环（host-rows deps post-office）

const ROOT = path.join('sandbox', 'test-desk-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

async function bootDesk(opts?: { onLog?: (l: 'W' | 'E', m: string) => void }) {
  const po = new PostOffice({ dataRoot: ROOT, ...(opts?.onLog !== undefined ? { onLog: opts.onLog } : {}) });
  po.setServiceDesk(new HostServiceDesk(opts?.onLog));
  await po.listen();
  return po;
}

function connect(po: PostOffice): Promise<IpcClient> {
  const c = new IpcClient();
  return c.connect(po.listeningAddress).then(() => c);
}

describe('cr-1175 服务帧通道', () => {
  it('request 档：serviceCall → handler → ServiceAck 往返', async () => {
    const po = await bootDesk();
    const desk = (po.serviceDesk as HostServiceDesk);
    desk.register('host.restart', (payload) => ({ accepted: true, echo: payload }));
    const c = await connect(po);
    const result = await c.serviceCall('host.restart', { conversationId: 'a~b' });
    expect(result).toMatchObject({ accepted: true, echo: { conversationId: 'a~b' } });
    c.close();
    await po.close();
  });

  it('request 档：handler 抛错 → ok:false reject（调用方收错）', async () => {
    const po = await bootDesk();
    ((po.serviceDesk as HostServiceDesk)).register('boom', () => { throw new Error('炸了'); });
    const c = await connect(po);
    await expect(c.serviceCall('boom', {})).rejects.toThrow(/炸了/);
    c.close();
    await po.close();
  });

  it('未知 verb：request 档 ok:false（明确失败）；report 档 W 日志即丢不炸通道', async () => {
    const logs: string[] = [];
    const po = await bootDesk({ onLog: (l, m) => logs.push(l + ':' + m) });
    ((po.serviceDesk as HostServiceDesk)).register('known', () => 'ok');
    const c = await connect(po);
    await expect(c.serviceCall('nope', {})).rejects.toThrow(/未注册/);
    c.serviceReport('nope', { x: 1 });
    const r2 = await c.serviceCall('known', {});
    expect(r2).toBe('ok');
    c.close();
    await po.close();
    expect(logs.some((l) => l.includes('服务动词未注册：nope'))).toBe(true);
  });

  it('report 档：serviceReport 即返、不等待回执（handler 慢不阻塞）', async () => {
    const po = await bootDesk();
    let handled = 0;
    ((po.serviceDesk as HostServiceDesk)).register('usage.report', () => { handled++; });
    const c = await connect(po);
    c.serviceReport('usage.report', { subject: 'usage-run' });
    c.serviceReport('usage.report', { subject: 'usage-run' });
    await new Promise((r) => setTimeout(r, 200));
    expect(handled).toBe(2);
    c.close();
    await po.close();
  });

  it('同口共存：服务帧与信封帧走同一邮局 listen（信封面不回归）', async () => {
    const po = await bootDesk();
    ((po.serviceDesk as HostServiceDesk)).register('host.restart', () => ({ accepted: true }));
    po.registerLocal('stub-endpoint', async (env) => ({ ack: env.requestId, fresh: true }));
    const c = await connect(po);
    const dispatched = await c.send(makeEnvelope({
      uuid: 'u-mix', requestId: 'rq-mix', sender: 'a', to: 'stub-endpoint', kind: 'message', budget: 0, payload: { text: 'hi' },
    })) as { dispatched: Array<{ channel: string; to: string }> };
    expect(dispatched.dispatched[0]).toMatchObject({ channel: 'local', to: 'stub-endpoint' });
    const ack = await c.serviceCall('host.restart', {});
    expect(ack).toMatchObject({ accepted: true });
    c.close();
    await po.close();
  });

  it('服务台未注入：svc 帧 W 日志即弃（纯信封形态）', async () => {
    const logs: string[] = [];
    const po = new PostOffice({ dataRoot: ROOT, onLog: (l, m) => logs.push(l + ':' + m) });
    await po.listen();
    const c = await connect(po);
    await expect(c.serviceCall('host.restart', {})).rejects.toThrow(/未注入/);
    c.close();
    await po.close();
    expect(logs.some((l) => l.includes('服务台未注入'))).toBe(true);
  });
});
