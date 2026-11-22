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
import { routeEnvelope } from '../src/router.ts';
import { Outbox } from '../src/outbox.ts';
import { listenIpc, IpcClient } from 'ac-envelope-core';
import { PostOffice } from '../src/post-office.ts';

const ROOT = path.join('sandbox', 'test-po-' + process.pid);
beforeEach(() => fs.mkdirSync(ROOT, { recursive: true }));
afterEach(() => fs.rmSync(ROOT, { recursive: true, force: true }));

function msg(init: Partial<Pick<Envelope, 'uuid' | 'requestId' | 'sender' | 'to' | 'budget' | 'kind'>> & { text?: string } = {}): Envelope {
  return makeEnvelope({
    uuid: init.uuid ?? 'user~alpha',
    requestId: init.requestId ?? 'rq',
    sender: init.sender ?? 'user',
    to: init.to ?? 'alpha',
    ...(init.budget !== undefined ? { budget: init.budget } : {}),
    ...(init.kind !== undefined ? { kind: init.kind } : {}),
    payload: { text: init.text ?? 'hi' },
  });
}

// —— M4.1 单元面（cr-525 覆写事故后按源码重构） ——

describe('M4.1 registry：uuid 登记校验（cr-1213 键形权威制）', () => {
  it('1v1 键：名册 = 键两端；任一端发言 consistent；集外 sender conflict', () => {
    const reg = new ConversationRegistry();
    const r1 = reg.register('user~alpha', 'user');
    expect(r1.kind).toBe('registered');
    if (r1.kind === 'registered') expect(r1.entry.participants).toEqual(['alpha', 'user']); // 规范化排序
    expect(reg.register('user~alpha', 'alpha').kind).toBe('consistent'); // 键另一端发言
    expect(reg.register('user~alpha', 'beta').kind).toBe('conflict'); // 集外 sender fail-loud
  });

  it('键形反演免疫乱序首达：机制回投先于用户首信到达不毒化', () => {
    const reg = new ConversationRegistry();
    // host 回执先到（cr-1177 反序案例——修复前首见近似会登记 [alpha, host]，
    // 之后 user 首信撞 conflict，会话键被永久阻断）。新制：defer 不建条目 +
    // 首信键反演 [alpha, user]——毒化面不存在
    expect(reg.register('user~alpha', 'host').kind).toBe('consistent');
    expect(reg.register('user~alpha', 'user').kind).toBe('registered');
    expect(reg.lookup('user~alpha')?.participants).toEqual(['alpha', 'user']);
  });

  it('机制域 sender（host/@）恒放行（机制信投递语义）；普通 sender 集外 conflict', () => {
    const reg = new ConversationRegistry();
    reg.register('user~alpha', 'user'); // 先建立（键反演 [alpha, user]）
    expect(reg.register('user~alpha', 'host').kind).toBe('consistent'); // host 回投放行
    expect(reg.register('user~alpha', '@g-team').kind).toBe('consistent'); // @ 群地址同款豁免
    expect(reg.register('user~alpha', 'intruder').kind).toBe('conflict');
  });

  it('群流键：setRoster 权威注入名册；成员发言放行、集外 conflict；重放演化（join/leave）覆盖', () => {
    const reg = new ConversationRegistry();
    reg.setRoster('g1~m1', ['user', 'm1', 'm2']);
    expect(reg.register('g1~m1', 'm2').kind).toBe('consistent'); // 名册成员发言
    expect(reg.register('g1~m1', 'user').kind).toBe('consistent');
    expect(reg.register('g1~m1', 'intruder').kind).toBe('conflict');
    reg.setRoster('g1~m1', ['user', 'm1', 'm2', 'm3']); // join m3——无条件覆盖
    expect(reg.register('g1~m1', 'm3').kind).toBe('consistent');
    // 未注入名册的群流键（boot 窗口先达）：键形反演兜底登记 [g1, m1]，
    // 群行重放后矫正为权威名册
    const reg2 = new ConversationRegistry();
    expect(reg2.register('g2~mx', 'user').kind).toBe('registered');
    expect(reg2.lookup('g2~mx')?.participants).toEqual(['g2', 'mx']);
    reg2.setRoster('g2~mx', ['user', 'mx', 'my']);
    expect(reg2.register('g2~mx', 'my').kind).toBe('consistent');
  });

  it('机制前缀键（restart-host-<会话键>，词法上=两段键）：反演名册含幻影端点（惰性无害）；真 sender 放行', () => {
    const reg = new ConversationRegistry();
    expect(reg.register('restart-host-user~alpha', 'alpha').kind).toBe('registered');
    // 两段键反演 [alpha, restart-host-user]——幻影端点 restart-host-user 永不
    // 发言（机制域 sender 只有 host/@，走豁免面）、to 不参与校验 → 惰性无害
    expect(reg.lookup('restart-host-user~alpha')?.participants).toEqual(['alpha', 'restart-host-user']);
    expect(reg.register('restart-host-user~alpha', 'alpha').kind).toBe('consistent');
    expect(reg.register('restart-host-user~alpha', 'beta').kind).toBe('conflict');
    expect(reg.register('restart-host-user~alpha', 'host').kind).toBe('consistent'); // 机制域豁免
  });

  it('真非键形键（三段）：首用建立 [sender, to]（对话两端），两端放行、他人 conflict', () => {
    const reg = new ConversationRegistry();
    expect(reg.register('mech~a~b', 'alpha', 'beta').kind).toBe('registered');
    expect(reg.lookup('mech~a~b')?.participants).toEqual(['alpha', 'beta']);
    expect(reg.register('mech~a~b', 'beta').kind).toBe('consistent'); // 对端回信
    expect(reg.register('mech~a~b', 'gamma').kind).toBe('conflict');
  });

  it('UUIDv7 形会话键（R-1 原始形态——发送方签发）：首见 [sender, to] 双向对话放行', () => {
    const reg = new ConversationRegistry();
    const v7 = '01a2011e-54fe-7a4f-b1e3-3fcd8e58e174';
    expect(reg.register(v7, 'user', 'alpha').kind).toBe('registered');
    expect(reg.register(v7, 'alpha').kind).toBe('consistent'); // agent 终稿回信（e2e-user 场景）
    expect(reg.register(v7, 'beta').kind).toBe('conflict');
  });

  it('机制域 sender 首见 defer：不建条目（回执先于真实首信不毒化），真实首信正常建立', () => {
    const reg = new ConversationRegistry();
    expect(reg.register('user~alpha', 'host').kind).toBe('consistent'); // 未登记——defer 不建
    expect(reg.lookup('user~alpha')).toBeUndefined();
    expect(reg.register('user~alpha', 'user').kind).toBe('registered'); // 真实首信建立键反演名册
    expect(reg.register('user~alpha', 'host').kind).toBe('consistent'); // 再回投——已登记放行
  });

  it('单段键（含 UUIDv7/裸身份）：首见 [sender, to]（对话两端），两端放行、他人 conflict', () => {
    const reg = new ConversationRegistry();
    expect(reg.register('alpha', 'user', 'alpha').kind).toBe('registered'); // auth fallback 形：uuid=agent id
    expect(reg.lookup('alpha')?.participants).toEqual(['alpha', 'user']);
    expect(reg.register('alpha', 'alpha').kind).toBe('consistent'); // agent 终稿回信
    expect(reg.register('alpha', 'beta').kind).toBe('conflict');
  });

  it('空 uuid 拒绝', () => {
    expect(() => new ConversationRegistry().register('', 'a')).toThrow(/uuid/);
  });
});

describe('M4.1 registry：可达表', () => {
  it('markReachable → hintFor 命中；markGone → 不可达', () => {
    const reach = new ReachabilityTable();
    expect(reach.hintFor('alpha')).toBeUndefined();
    reach.markReachable('alpha', 'hint-a');
    expect(reach.hintFor('alpha')).toBe('hint-a');
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

  it('cr-1177 场景（键形权威制收编）：保留端点（host）回投会话键——恒放行（机制信非会话发言）；冒用照旧 conflict', () => {
    const reach = new ReachabilityTable();
    reach.markReachable('creator-1', 'sock-c');
    const registry = new ConversationRegistry();
    // 用户会话首信——键形反演登记 [creator-1, user]
    routeEnvelope(msg({ uuid: 'user~creator-1', requestId: 'u-1', sender: 'user', to: 'creator-1' }), { registry, reach });
    // 宿主回投（sender=host、uuid=同会话键、to=creator-1）——放行（infra 豁免）
    const receipt = msg({ uuid: 'user~creator-1', requestId: 'plugin-r1', sender: 'host', to: 'creator-1' });
    expect(() => routeEnvelope(receipt, { registry, reach })).not.toThrow();
    // 普通参与者冒用已登记会话键照旧 conflict（防冒用面不放宽）
    expect(() => routeEnvelope(msg({ uuid: 'user~creator-1', requestId: 'bad', sender: 'intruder', to: 'creator-1' }), { registry, reach })).toThrow(/uuid 登记冲突/);
  });

  it('多播扇出：群地址展开逐成员，跳过发送方；成员表 = setRoster 权威注入', () => {
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

// —— cr-885：转投失败诊断面 + 陈旧可达项摘除 ——

describe('cr-885 flushOutbox 失败面', () => {
  it('转投失败：摘陈旧可达项 + onLog 留痕 + 留箱重试', async () => {
    const logs: Array<[string, string]> = [];
    const po = new PostOffice({ dataRoot: ROOT, onLog: (level, message) => { logs.push([level, message]); } });
    // 现场形态：dispatch 直投失败已摘可达项（cr-648）+ 落箱；随后可达面
    // 被外部回登记（rescue/peek 壳探活）但端点 pipe 实际无人监听——flush
    // 撞死连接（此前的现场：转投失败静默留箱、可达项不摘，每拍重撞）
    const ghostAddr = socketPathFor(path.resolve(ROOT), 'ghost-shell');
    po.reach.markReachable('alpha', ghostAddr);
    const dispatched = await po.dispatch(msg({ requestId: 'stuck-1' }));
    expect(dispatched[0]).toMatchObject({ channel: 'outbox', ack: null });
    po.reach.markReachable('alpha', ghostAddr); // 外部回登记（壳探活面）
    const delivered = await po.flushOutbox();
    expect(delivered).toHaveLength(0);
    expect(po.reach.hintFor('alpha')).toBeUndefined(); // 陈旧项已摘——后续 flush 不再撞死 pipe
    expect(logs).toHaveLength(1);
    expect(logs[0][0]).toBe('W');
    expect(logs[0][1]).toContain('stuck-1');
    expect(fs.existsSync(path.join(ROOT, 'outbox', '1-stuck-1.json'))).toBe(true); // at-least-once 留箱
    // 端点真上线后（可达恢复）flush 转投成功——残留信救出
    const got: string[] = [];
    po.registerLocal('alpha', async (env) => { got.push(env.requestId); return { ack: env.requestId, fresh: true }; });
    const delivered2 = await po.flushOutbox();
    expect(delivered2).toHaveLength(1);
    expect(got).toEqual(['stuck-1']);
    expect(fs.existsSync(path.join(ROOT, 'outbox', '1-stuck-1.json'))).toBe(false);
    await po.close();
  });
});

// —— cr-962：不可达滞留目标周期补拉 ——

describe('cr-962 flushOutbox 不可达补拉', () => {
  it('滞留目标无可达项 → flushOutbox 触发 ensureHook（每目标一次）；可达目标不触发', async () => {
    const ensured: string[] = [];
    const po = new PostOffice({ dataRoot: ROOT });
    po.setEnsureHook((target) => { ensured.push(target); });
    // beta 不可达落箱 ×2（同目标去重）+ user 可达直投（uuid 逐封唯一——登记校验 R-1 键形权威制）
    let seq = 0;
    const env = (init: Parameters<typeof msg>[0]) => msg({ uuid: 'u-bp-' + (++seq), ...init });
    po.registerLocal('user', async (e) => ({ ack: e.requestId, fresh: true }));
    await po.dispatch(env({ to: 'beta', sender: 'user', requestId: 'r-b1' }));
    await po.dispatch(env({ to: 'beta', sender: 'user', requestId: 'r-b2' }));
    const dispatched = await po.dispatch(env({ to: 'user', sender: 'alpha', requestId: 'r-u1' }));
    expect(dispatched[0]).toMatchObject({ channel: 'local' });
    expect(ensured).toEqual(['beta', 'beta']); // dispatch 落箱逐封触发（原链——与补拉拍语义分立）
    ensured.length = 0;
    await po.flushOutbox(); // beta 仍不可达——补拉再触发；user 可达不触发
    expect(ensured).toEqual(['beta']);
    ensured.length = 0;
    await po.flushOutbox(); // 同拍同目标恒一次（去重）
    expect(ensured).toEqual(['beta']);
    await po.close();
  });
});

// —— cr-991：连接池陈旧客户端拒用 ——

describe('cr-991 连接池陈旧客户端', () => {
  it('现场剧本：壳死（池残留）→ 可达回登记 → flush 弃旧重连直达——不再「socket ended」', async () => {
    const logs: Array<[string, string]> = [];
    const po = new PostOffice({ dataRoot: ROOT, onLog: (level, message) => { logs.push([level, message]); } });
    // 第一代壳：真 ipc server，收信即 ack——dispatch 直投把客户端种进池
    const addr1 = socketPathFor(path.resolve(ROOT), 'shell-a1');
    let got: string[] = [];
    const srv1 = await listenIpc(addr1, (payload) => {
      const env = payload as Envelope;
      got.push(env.requestId);
      return { ack: env.requestId, fresh: true };
    });
    po.reach.markReachable('alpha', addr1);
    await po.dispatch(msg({ requestId: 'st-gen1', uuid: 'u-gen1' }));
    expect(got).toEqual(['st-gen1']); // 直投成功——池已缓存 addr1 客户端
    // 壳 idle 退出（对端关闭）+ 可达表被外部回登记（rescue/peek 探活面——现场链）
    await srv1.close();
    await new Promise((r) => setTimeout(r, 100)); // close 事件送达宿主侧
    const addr2 = socketPathFor(path.resolve(ROOT), 'shell-a2');
    const srv2 = await listenIpc(addr2, (payload) => {
      const env = payload as Envelope;
      got.push(env.requestId);
      return { ack: env.requestId, fresh: true };
    });
    po.reach.markReachable('alpha', addr2); // 新壳持新 pipe（bootId 换代）
    const delivered = await po.flushOutbox(); // 空箱快路径——不触投递，仅验可达面
    expect(delivered).toHaveLength(0);
    // 关键断言（修复前现场）：hint 换代时旧池项（连 addr1 的半死客户端）不再被信
    const dispatched = await po.dispatch(msg({ requestId: 'st-gen2', uuid: 'u-gen2' }));
    expect(dispatched[0].ack).not.toBe(null); // 直投成功——弃旧重连 addr2
    expect(got).toEqual(['st-gen1', 'st-gen2']);
    expect(logs).toHaveLength(0); // 全程零 W——不撞死 pipe
    await srv2.close();
    await po.close();
  });

  it('同 hint 复活：池内断开客户端 → 重连同地址新 server（close 摘 socket 而非只靠 hint 换代）', async () => {
    const po = new PostOffice({ dataRoot: ROOT });
    const addr = socketPathFor(path.resolve(ROOT), 'shell-b');
    let count = 0;
    let srv = await listenIpc(addr, (payload) => {
      const env = payload as Envelope;
      count += 1;
      return { ack: env.requestId, fresh: true };
    });
    po.reach.markReachable('beta', addr);
    await po.dispatch(msg({ to: 'beta', sender: 'user', requestId: 'st-same1', uuid: 'u-same1' }));
    // 壳死 + 同地址复活（同 hint 重启形态）
    await srv.close();
    await new Promise((r) => setTimeout(r, 100));
    srv = await listenIpc(addr, (payload) => {
      const env = payload as Envelope;
      count += 1;
      return { ack: env.requestId, fresh: true };
    });
    const dispatched = await po.dispatch(msg({ to: 'beta', sender: 'user', requestId: 'st-same2', uuid: 'u-same2' }));
    expect(dispatched[0].ack).not.toBe(null); // 池项已断开 → 弃旧重连
    expect(count).toBe(2);
    await srv.close();
    await po.close();
  });
});
