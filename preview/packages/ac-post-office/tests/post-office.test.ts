// ============================================================
// ac-post-office 单元面：M4.1 纯函数（registry/router/outbox/ipc
// 回环）+ M8.4 投递执行器（dispatch 三通道 / local 直调 / 滞留
// 转投 / 多播 / ipc 中继）。
// 注：M4 原测试文件于 M8.4 会话被覆写（cr-525），本文件按源码
// 重构 M4 覆盖面 + 增补 M8.4 执行器面。
// ============================================================
import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import { makeEnvelope, socketPathFor, type Envelope } from 'ac-envelope-core';
import { ConversationRegistry, ReachabilityTable } from '../src/registry.ts';
import { routeEnvelope, inboxDecision } from '../src/router.ts';
import { Outbox } from '../src/outbox.ts';
import { listenIpc, IpcClient } from '../src/ipc.ts';
import { PostOffice } from '../src/post-office.ts';

const ROOT = path.join('preview', 'sandbox', 'test-po-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function msg(init: Partial<Pick<Envelope, 'uuid' | 'requestId' | 'sender' | 'to' | 'budget' | 'kind'>> & { text?: string } = {}): Envelope {
  return makeEnvelope({
    uuid: init.uuid ?? 'u-po',
    requestId: init.requestId ?? 'rq',
    sender: init.sender ?? 'user',
    to: init.to ?? 'alpha',
    ...(init.budget !== undefined ? { budget: init.budget } : {}),
    ...(init.kind !== undefined ? { kind: init.kind } : {}),
    payload: { text: init.text ?? 'hi' },
  });
}

// —— M4.1 单元面（cr-525 覆写事故后按源码重构） ——

describe('M4.1 registry：uuid 登记校验（R-1 序无关一致）', () => {
  it('首次登记 → registered；同集合异序 → consistent；异集合 → conflict', () => {
    const reg = new ConversationRegistry();
    const r1 = reg.register('u1', ['user', 'alpha']);
    expect(r1.kind).toBe('registered');
    if (r1.kind === 'registered') expect(r1.entry.participants).toEqual(['alpha', 'user']); // 规范化排序
    expect(reg.register('u1', ['alpha', 'user']).kind).toBe('consistent'); // 序无关
    const r3 = reg.register('u1', ['user', 'beta']);
    expect(r3.kind).toBe('conflict'); // 身份冒用 fail-loud
    // 子集一致（cr-576 群成员流）：来信端点全部已在登记名册内 = 同一群的
    // 另一参与方发言/回信——consistent；集外端点（真冒用）仍 conflict
    const reg2 = new ConversationRegistry();
    reg2.register('g1~m1', ['user', 'm1', 'm2']);
    expect(reg2.register('g1~m1', ['m1', 'm2']).kind).toBe('consistent');
    expect(reg2.register('g1~m1', ['user', 'm1']).kind).toBe('consistent');
    expect(reg2.register('g1~m1', ['user', 'm1', 'intruder']).kind).toBe('conflict');
  });

  it('空 uuid 拒绝', () => {
    expect(() => new ConversationRegistry().register('', ['a'])).toThrow(/uuid/);
  });
});

describe('M4.1 registry：可达表', () => {
  it('markReachable → hintFor 命中；markGone → 不可达', () => {
    const reach = new ReachabilityTable();
    expect(reach.hintFor('alpha')).toBeUndefined();
    reach.markReachable('alpha', 'hint-a');
    expect(reach.hintFor('alpha')).toBe('hint-a');
    expect(reach.reachable()).toEqual(['alpha']);
    reach.markGone('alpha');
    expect(reach.hintFor('alpha')).toBeUndefined();
  });
});

describe('M4.1 router：三通道决策', () => {
  it('可达 → direct（hop+1 中继）；无 hint → outbox 滞留', () => {
    const reach = new ReachabilityTable();
    reach.markReachable('alpha', 'sock-a');
    const env = msg({ uuid: 'u-r', requestId: 'rr' });
    const d = routeEnvelope(env, { registry: new ConversationRegistry(), reach });
    expect(d).toHaveLength(1);
    expect(d[0]).toMatchObject({ channel: 'direct', to: 'alpha', transportHint: 'sock-a' });
    if (d[0].channel === 'direct') expect(d[0].envelope.hop).toBe(1);
    const o = routeEnvelope(msg({ uuid: 'u-r', requestId: 'rr2', to: 'beta' }), { registry: new ConversationRegistry(), reach });
    expect(o[0]).toMatchObject({ channel: 'outbox', reason: 'no-hint' });
  });

  it('多播扇出：群地址展开逐成员，跳过发送方；登记面 = 全员集合', () => {
    const reach = new ReachabilityTable();
    reach.markReachable('alpha', 's-a');
    reach.markReachable('beta', 's-b');
    const out = routeEnvelope(msg({ uuid: 'u-g', requestId: 'rg', sender: 'user', to: 'g-team' }), {
      registry: new ConversationRegistry(),
      reach,
      multicast: { membersOf: (a) => a === 'g-team' ? ['user', 'alpha', 'beta'] : undefined },
    });
    expect(out.map((i) => i.to)).toEqual(['alpha', 'beta']); // user 发送方被跳过
  });

  it('inboxDecision（A4 + budget）：非 message → 不入 inbox；user 直发 → 重置满额；budget 0 → 只落账', () => {
    // receipt：不触发 run（不进 inbox）；sender=user 仍重置满额（预算之源与 kind 正交）
    expect(inboxDecision(msg({ kind: 'receipt', budget: 0 }))).toEqual({ entersInbox: false, budgetAfter: 3 });
    const reset = inboxDecision(msg({ sender: 'user', budget: 0 }));
    expect(reset.entersInbox).toBe(true); // 重置满额后 >0 → 入 inbox
    expect(reset.budgetAfter).toBe(3);
    expect(inboxDecision(msg({ sender: 'beta', budget: 0 }))).toEqual({ entersInbox: false, budgetAfter: 0 });
    expect(inboxDecision(msg({ sender: 'beta', budget: 2 }))).toEqual({ entersInbox: true, budgetAfter: 2 });
  });
});

describe('M4.1 outbox：FIFO 滞留 + flush 转投', () => {
  it('store → 落盘序号文件；list FIFO；flush 命中 hint 产出直投；remove 出箱', () => {
    const ob = new Outbox(ROOT);
    ob.store(msg({ requestId: 'ob-1' }), 'unreachable');
    ob.store(msg({ requestId: 'ob-2' }), 'no-hint');
    const list = ob.list();
    expect(list.map((e) => e.envelope.requestId)).toEqual(['ob-1', 'ob-2']);
    expect(list[0].seq).toBeLessThan(list[1].seq);
    // 全不可达 → flush 空；alpha 可达 → ob 两条均产出
    expect(ob.flush(() => undefined)).toHaveLength(0);
    const hits = ob.flush((id) => id === 'alpha' ? 's-a' : undefined);
    expect(hits.map((h) => h.entry.envelope.requestId)).toEqual(['ob-1', 'ob-2']);
    ob.remove(list[0].seq, 'ob-1');
    expect(ob.list().map((e) => e.envelope.requestId)).toEqual(['ob-2']);
  });
});

describe('M4.1 ipc：监听 + 帧回环', () => {
  it('listenIpc 回执帧（sync 回调）', async () => {
    const addr = socketPathFor(path.resolve(ROOT), 'echo');
    const srv = await listenIpc(addr, (payload) => ({ echoed: payload }));
    const client = new IpcClient();
    await client.connect(addr);
    expect(await client.send({ hello: 1 })).toEqual({ echoed: { hello: 1 } });
    client.close();
    await srv.close();
  });
});

// —— M8.4 投递执行器 ——

describe('M8.4 PostOffice 投递执行器', () => {
  it('local 通道：进程内端点直调（ack = 落账即确认）+ 注册即可达', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const got: Envelope[] = [];
    po.registerLocal('user', async (env) => {
      got.push(env);
      return { ack: env.requestId, fresh: true };
    });
    const out = await po.dispatch(msg({ to: 'user', sender: 'alpha', requestId: 'r1' }));
    expect(out).toEqual([{ to: 'user', channel: 'local', ack: { ack: 'r1', fresh: true } }]);
    expect(got).toHaveLength(1);
    await po.close();
  });

  it('ipc 通道：hint 命中直投（连接池复用）+ 重投幂等去重', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const addr = socketPathFor(path.resolve(ROOT), 'alpha'); // win32 自动映射 named pipe
    const seen: string[] = [];
    const srv = await listenIpc(addr, (payload) => {
      const env = payload as Envelope;
      const fresh = !seen.includes(env.requestId);
      if (fresh) seen.push(env.requestId);
      return { ack: env.requestId, fresh };
    });
    po.reach.markReachable('alpha', addr);
    const r1 = await po.dispatch(msg({ requestId: 'ra' }));
    expect(r1[0]).toMatchObject({ channel: 'direct', ack: { ack: 'ra', fresh: true } });
    const r2 = await po.dispatch(msg({ requestId: 'ra' })); // 同 requestId 重投
    expect(r2[0]).toMatchObject({ ack: { ack: 'ra', fresh: false } });
    await po.close(); // 先关池内连接——server.close 回调等连接断尽
    await srv.close();
  });

  it('outbox 通道：不可达滞留 → 端点转可达 flush 转投 → 出箱', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const r1 = await po.dispatch(msg({ requestId: 'rb' }));
    expect(r1[0]).toMatchObject({ channel: 'outbox', ack: null });
    expect(fs.existsSync(path.join(ROOT, 'outbox', '1-rb.json'))).toBe(true);
    // 端点上线（local 注册）→ flush 转投
    const got: string[] = [];
    po.registerLocal('alpha', async (env) => {
      got.push(env.requestId);
      return { ack: env.requestId, fresh: true };
    });
    const delivered = await po.flushOutbox();
    expect(delivered).toHaveLength(1);
    expect(got).toEqual(['rb']);
    expect(fs.existsSync(path.join(ROOT, 'outbox', '1-rb.json'))).toBe(false);
    await po.close();
  });

  it('ensure 钩子触发时信封已落箱（cr-647）：钩内同步回登记 + flush 可立即转投', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const addr = socketPathFor(path.resolve(ROOT), 'alpha');
    const got: string[] = [];
    const srv = await listenIpc(addr, (payload) => {
      const env = payload as Envelope;
      got.push(env.requestId);
      return { ack: env.requestId, fresh: true };
    });
    const seenAtHook: string[] = [];
    po.setEnsureHook((to) => {
      // 钩子运行时刻 = 信必须已落箱（宿主撞活锁救援在钩内同步 flush 的同款面）
      seenAtHook.push(...fs.readdirSync(path.join(ROOT, 'outbox')));
      po.reach.markReachable(to, addr); // 回登记可达后同步转投
      void po.flushOutbox();
    });
    const out = await po.dispatch(msg({ requestId: 'rc' }));
    expect(out[0]).toMatchObject({ channel: 'outbox', ack: null });
    expect(seenAtHook).toContain('1-rc.json'); // 钩子看到的是「已落箱」态
    await new Promise((r) => setTimeout(r, 50));
    expect(got).toEqual(['rc']); // 钩内 flush 已就地转投——不留死信
    expect(fs.existsSync(path.join(ROOT, 'outbox', '1-rc.json'))).toBe(false);
    await po.close();
    await srv.close();
  });

  it('直投失败（陈旧 transportHint）→ 摘可达项 + 落箱 + 触发 ensureHook（cr-648）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const addr = socketPathFor(path.resolve(ROOT), 'ghost'); // 管道无人监听
    po.reach.markReachable('ghost', addr);
    let hooks = 0;
    const seenAtHook: string[] = [];
    po.setEnsureHook(() => {
      hooks += 1;
      seenAtHook.push(...fs.readdirSync(path.join(ROOT, 'outbox')));
    });
    const out = await po.dispatch(msg({ to: 'ghost', requestId: 'rd' }));
    expect(out[0]).toMatchObject({ channel: 'outbox', ack: null });
    expect(po.reach.hintFor('ghost')).toBeUndefined(); // 陈旧项已摘——下次走 no-hint
    expect(hooks).toBe(1); // 触发按需拉起（壳死宿主不知情的恢复入口）
    expect(seenAtHook).toContain('1-rd.json'); // 钩子触发时信已落箱
    await po.close();
  });

  it('uuid 登记校验：冲突 fail-loud（防身份冒用——R-1）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    po.registerLocal('user', async (env) => ({ ack: env.requestId, fresh: true }));
    await po.dispatch(msg({ to: 'user', sender: 'alpha', requestId: 'x1' })); // 登记 [alpha,user]
    await expect(po.dispatch(msg({ to: 'beta', sender: 'gamma', requestId: 'x2' })))
      .rejects.toThrow(/uuid 登记冲突/);
    await po.close();
  });

  it('多播扇出：群地址 → 逐成员投递（跳发送方）——local + ipc 混合', async () => {
    const po = new PostOffice({ dataRoot: ROOT, multicast: { membersOf: (a) => a === 'g-team' ? ['user', 'alpha', 'beta'] : undefined } });
    const gotUser: string[] = [];
    po.registerLocal('user', async (env) => { gotUser.push(env.requestId); return { ack: env.requestId, fresh: true }; });
    const addr = socketPathFor(path.resolve(ROOT), 'beta');
    const gotBeta: string[] = [];
    const srv = await listenIpc(addr, (payload) => {
      const env = payload as Envelope;
      gotBeta.push(env.requestId);
      return { ack: env.requestId, fresh: true };
    });
    po.reach.markReachable('beta', addr);
    const out = await po.dispatch(msg({ to: 'g-team', sender: 'alpha', requestId: 'rm', text: '群播' }));
    // alpha 是发送方被跳过；user 走 local、beta 走 direct
    expect(out).toHaveLength(2);
    expect(out.find((d) => d.to === 'user')).toMatchObject({ channel: 'local' });
    expect(out.find((d) => d.to === 'beta')).toMatchObject({ channel: 'direct' });
    expect(gotUser).toEqual(['rm']);
    expect(gotBeta).toEqual(['rm']);
    await po.close();
    await srv.close();
  });

  it('ipc 监听中继：外部帧 → dispatch → dispatched 回执帧（壳回链入口）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    po.registerLocal('user', async (env) => ({ ack: env.requestId, fresh: true }));
    await po.listen();
    const client = new IpcClient();
    await client.connect(po.listeningAddress);
    const reply = await client.send(msg({ to: 'user', sender: 'alpha', requestId: 'ipc-1' }));
    expect(reply).toMatchObject({
      dispatched: [{ to: 'user', channel: 'local', ack: { ack: 'ipc-1', fresh: true } }],
    });
    client.close();
    await po.close();
  });
});
