// ============================================================
// ac-ws-bridge：emit 面 → WS 帧（事件名直转）+ 后台会话过滤
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import WebSocket from 'ws';
import { Context } from '@agentchat/cordis';
import { WebServerService } from 'ac-web-server';
import { parseFrame, WS_READY } from 'ac-ws-protocol';
import { GROUP_HINT_META } from 'ac-core-utils';
import * as bridgeRow from '../src/index.ts';

const servers: WebServerService[] = [];
const sockets: WebSocket[] = [];
const frames: import('ac-ws-protocol').WsFrame[] = [];

async function boot(options: Record<string, unknown> = {}) {
  const ctx = new Context();
  const svc = new WebServerService(ctx, { port: 0, heartbeatMs: 0 });
  servers.push(svc);
  const port = await svc.ready();
  ctx.plugin(bridgeRow as any, options);
  return { ctx, svc, port };
}

function connect(port: number): Promise<WebSocket> {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`ws://127.0.0.1:${port}`);
    sockets.push(ws);
    ws.on('error', reject);
    ws.on('message', (raw) => {
      const frame = parseFrame(raw.toString());
      if (frame?.type === WS_READY) resolve(ws);
    });
  });
}

/** 等待指定 type 的帧到达 */
function waitFor(type: string): Promise<unknown> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      const hit = frames.find((f) => f.type === type);
      if (hit) {
        clearInterval(timer);
        resolve(hit.data);
      }
    }, 10);
    setTimeout(() => {
      clearInterval(timer);
      resolve(undefined);
    }, 2000).unref?.();
  });
}

afterEach(async () => {
  frames.length = 0;
  for (const ws of sockets.splice(0)) ws.close();
  for (const svc of servers.splice(0)) await svc.stop();
});

describe('ac-ws-bridge 桥接', () => {
  it('emit 事件 → 帧 type=事件名直转 + {args} 载荷', async () => {
    const { ctx, port } = await boot();
    const ws = await connect(port);
    ws.on('message', (raw) => {
      const frame = parseFrame(raw.toString());
      if (frame && frame.type !== WS_READY) frames.push(frame);
    });

    ctx.emit('group/message-posted', 'g1', { id: 'm1', groupId: 'g1', from: 'alice', content: 'hi', at: 1 } as never);
    ctx.emit('group/memory-owner-set', 'g1', 'a', { id: 'g1', members: ['a', 'b'], memoryOwner: 'a' } as never);
    ctx.emit('config/changed', '/x');
    ctx.emit('job/settled', { id: 'j1', status: 'ok' } as never);

    expect(await waitFor('group/message-posted')).toMatchObject({
      args: ['g1', { from: 'alice', content: 'hi' }],
    });
    // 群主变更直转（owner 末态 + 整群配置；前端刷新群列表用）
    expect(await waitFor('group/memory-owner-set')).toEqual({
      args: ['g1', 'a', { id: 'g1', members: ['a', 'b'], memoryOwner: 'a' }],
    });
    expect(await waitFor('config/changed')).toEqual({ args: ['/x'] });
    expect(await waitFor('job/settled')).toMatchObject({ args: [{ id: 'j1' }] });
  });

  it('后台过滤：source=event 的【自会话桶 a~a】run 的 step/delta/tool 不广播；边界事件仍广播', async () => {
    const { ctx, port } = await boot();
    const ws = await connect(port);
    ws.on('message', (raw) => {
      const frame = parseFrame(raw.toString());
      if (frame && frame.type !== WS_READY) frames.push(frame);
    });

    const request = {
      agent: 'a1',
      model: 'm',
      messages: [],
      sender: 'a1',
      source: 'event' as const,
      conversationId: 'a1~a1', // 自会话桶（定时自唤醒等机制面）
    };
    ctx.emit('loop/run-started', request);
    ctx.emit('loop/step-started', 'a1', 0, [], { conversationId: 'a1~a1', sender: 'a1', source: 'event' });
    ctx.emit('llm/delta', { model: 'm', messages: [] }, { delta: 'x' }, { agent: 'a1', conversationId: 'a1~a1', sender: 'a1', source: 'event' });
    ctx.emit('tool/after-execute', { name: 't', agentId: 'a1', conversationId: 'a1~a1' }, { ok: true });
    ctx.emit('loop/after-run', request, { steps: [], text: '', finish: 'stop', usage: null as never });

    expect(await waitFor('loop/run-started')).toBeDefined(); // 边界广播
    expect(await waitFor('loop/after-run')).toBeDefined(); // 边界广播
    await new Promise((r) => setTimeout(r, 100));
    expect(frames.find((f) => f.type === 'loop/step-started')).toBeUndefined(); // 后台抑制
    expect(frames.find((f) => f.type === 'llm/delta')).toBeUndefined();
    expect(frames.find((f) => f.type === 'tool/after-execute')).toBeUndefined(); // 登记表兜底
  });

  it('机制唤醒（source=event）在【用户可见会话】照常流式广播（2026-09-02 反馈：job 通知/插件回触/重载续跑不刷新看不到流式）', async () => {
    const { ctx, port } = await boot();
    const ws = await connect(port);
    ws.on('message', (raw) => {
      const frame = parseFrame(raw.toString());
      if (frame && frame.type !== WS_READY) frames.push(frame);
    });

    // 插件回触/job 通知唤醒：conversation = a1~user（用户直答对桶）
    ctx.emit('loop/run-started', { agent: 'a1', model: 'm', messages: [], sender: 'a1', source: 'event', conversationId: 'a1~user' });
    ctx.emit('loop/step-started', 'a1', 0, [], { conversationId: 'a1~user', sender: 'a1', source: 'event' });
    ctx.emit('llm/delta', { model: 'm', messages: [] }, { delta: '续跑输出' }, { agent: 'a1', conversationId: 'a1~user', sender: 'a1', source: 'event' });
    ctx.emit('tool/after-execute', { name: 't', agentId: 'a1', conversationId: 'a1~user' }, { ok: true });

    expect(await waitFor('loop/step-started')).toBeDefined();
    expect(await waitFor('llm/delta')).toBeDefined();
    expect(await waitFor('tool/after-execute')).toBeDefined(); // run 登记（可见）→ 放行
  });

  it('归档整理 run（meta[archive-review]，用户会话内）流式仍隐藏（维护 run 不扰民）', async () => {
    const { ctx, port } = await boot();
    const ws = await connect(port);
    ws.on('message', (raw) => {
      const frame = parseFrame(raw.toString());
      if (frame && frame.type !== WS_READY) frames.push(frame);
    });

    ctx.emit('loop/run-started', { agent: 'a1', model: 'm', messages: [], sender: 'a1', source: 'event', conversationId: 'a1~user', meta: { 'archive-review': true } });
    ctx.emit('llm/delta', { model: 'm', messages: [] }, { delta: '整理中' }, { agent: 'a1', conversationId: 'a1~user', sender: 'a1', source: 'event' });
    ctx.emit('tool/after-execute', { name: 't', agentId: 'a1', conversationId: 'a1~user' }, { ok: true });

    await new Promise((r) => setTimeout(r, 100));
    expect(frames.find((f) => f.type === 'llm/delta')).toBeUndefined();
    expect(frames.find((f) => f.type === 'tool/after-execute')).toBeUndefined();
  });

  it('前台（source=user）：step/delta 正常广播', async () => {
    const { ctx, port } = await boot();
    const ws = await connect(port);
    ws.on('message', (raw) => {
      const frame = parseFrame(raw.toString());
      if (frame && frame.type !== WS_READY) frames.push(frame);
    });

    ctx.emit('loop/run-started', { agent: 'a1', model: 'm', messages: [], sender: 'user', source: 'user', conversationId: 'c2' });
    ctx.emit('llm/delta', { model: 'm', messages: [] }, { delta: 'hi' }, { agent: 'a1', conversationId: 'c2', sender: 'user' });
    ctx.emit('tool/after-execute', { name: 't', agentId: 'a1', conversationId: 'c2' }, { ok: true });

    expect(await waitFor('llm/delta')).toBeDefined();
    expect(await waitFor('tool/after-execute')).toBeDefined(); // run 登记为前台 → 桥接放行
  });

  it('llm/delta-* 帧载荷瘦身：input 只保留 model/meta，不带 messages/tools（2026-09-05 OOM 回归锚）', async () => {
    const { ctx, port } = await boot();
    const ws = await connect(port);
    ws.on('message', (raw) => {
      const frame = parseFrame(raw.toString());
      if (frame && frame.type !== WS_READY) frames.push(frame);
    });

    // 事件面 input 携带全量上下文（messages/tools）——帧面不得放大直转
    const meta = { agent: 'a1', conversationId: 'a1~user', sender: 'user', source: 'user' };
    const input = {
      model: 'm',
      messages: [{ role: 'user' as const, content: '大上下文'.repeat(100) }],
      tools: [{ type: 'function' as const, function: { name: 't', description: 'd', parameters: { type: 'object' } } }],
      meta,
    };
    ctx.emit('loop/run-started', { agent: 'a1', model: 'm', messages: [], sender: 'user', source: 'user', conversationId: 'a1~user' });
    ctx.emit('llm/delta-start', input, meta);
    ctx.emit('llm/delta', input, { delta: 'hi' }, meta);
    ctx.emit('llm/delta-end', input, meta);

    const start = (await waitFor('llm/delta-start')) as { args: Record<string, unknown>[] };
    const delta = (await waitFor('llm/delta')) as { args: Record<string, unknown>[] };
    const end = (await waitFor('llm/delta-end')) as { args: Record<string, unknown>[] };
    const slim = { model: 'm', meta };
    expect(start.args[0]).toEqual(slim);
    expect(delta.args[0]).toEqual(slim);
    expect(delta.args[1]).toEqual({ delta: 'hi' });
    expect(end.args[0]).toEqual(slim);
    // 大载荷字段绝不进逐 chunk 帧（O(历史 × chunk 数) 放大器）
    for (const frame of [start, delta, end]) {
      expect(frame.args[0]).not.toHaveProperty('messages');
      expect(frame.args[0]).not.toHaveProperty('tools');
    }
  });

  it('backgroundFilter=false：全部广播（诊断模式）', async () => {
    const { ctx, port } = await boot({ backgroundFilter: false });
    const ws = await connect(port);
    ws.on('message', (raw) => {
      const frame = parseFrame(raw.toString());
      if (frame && frame.type !== WS_READY) frames.push(frame);
    });
    ctx.emit('llm/delta', { model: 'm', messages: [] }, { delta: 'x' }, { sender: 'x', source: 'event' });
    expect(await waitFor('llm/delta')).toBeDefined();
  });

  it('无连接时广播静默（不抛错）', async () => {
    const { ctx } = await boot();
    expect(() => ctx.emit('config/changed', '/x')).not.toThrow();
  });
});

describe('ac-ws-bridge M7 补齐面', () => {
  async function wired(options: Record<string, unknown> = {}) {
    const { ctx, port } = await boot(options);
    const ws = await connect(port);
    ws.on('message', (raw) => {
      const frame = parseFrame(raw.toString());
      if (frame && frame.type !== WS_READY) frames.push(frame);
    });
    return { ctx, port, ws };
  }

  it('群 hint 投递帧不广播（message-received / steered 携带 GROUP_HINT_META；群内容唯一源 = group/message-posted）', async () => {
    const { ctx } = await wired();
    // 逐成员 hint 投递（idle → message-received；busy → steered）
    ctx.emit('router/message-received', 'nana', { role: 'user', content: '<msg from="nana">大家好</msg>\n\n[当前时间] …' }, 'g1', 'nana', 'agent', { [GROUP_HINT_META]: true });
    ctx.emit('conversation/steered', 'neko', { role: 'user', content: '<msg from="nana">大家好</msg>' }, 'g1', 'g1~neko', 'nana', 'agent', { [GROUP_HINT_META]: true });
    // 非 hint 入站照常广播（agent→viewer 私信 live 通道）
    ctx.emit('router/message-received', 'nana', { role: 'user', content: '私信' }, 'nana~user', 'nana', 'agent');
    ctx.emit('conversation/steered', 'nana', { role: 'user', content: '注入' }, 'nana~user', 'nana~user~nana', 'user', 'user');

    expect(await waitFor('router/message-received')).toMatchObject({ args: ['nana', { content: '私信' }, 'nana~user', 'nana', 'agent'] });
    expect(await waitFor('conversation/steered')).toMatchObject({ args: ['nana', { content: '注入' }, 'nana~user', 'nana~user~nana', 'user', 'user'] });
    await new Promise((r) => setTimeout(r, 100));
    // 群 hint 帧一条不出（曾渲染成 N-1 条幽灵消息，刷新即消失）
    expect(frames.filter((f) => f.type === 'router/message-received')).toHaveLength(1);
    expect(frames.filter((f) => f.type === 'conversation/steered')).toHaveLength(1);
  });

  it('tool/progress 转发（前台）+ 后台过滤沿用 run 登记表', async () => {
    const { ctx } = await wired();
    ctx.emit('loop/run-started', { agent: 'a1', model: 'm', messages: [], sender: 'user', source: 'user', conversationId: 'c1' });
    ctx.emit('tool/progress', { name: 'bash', agentId: 'a1', conversationId: 'c1' }, '输出一行\n');
    expect(await waitFor('tool/progress')).toMatchObject({ args: [{ name: 'bash' }, '输出一行\n'] });

    // 后台 run（自会话桶）：progress 抑制（登记表兜底）
    ctx.emit('loop/run-started', { agent: 'a2', model: 'm', messages: [], sender: 'a2', source: 'event', conversationId: 'a2~a2' });
    ctx.emit('tool/progress', { name: 'bash', agentId: 'a2', conversationId: 'a2~a2' }, '后台输出\n');
    ctx.emit('loop/after-run', { agent: 'a2', model: 'm', messages: [], sender: 'a2', source: 'event', conversationId: 'a2~a2' }, { steps: [], text: '', finish: 'stop', usage: null as never });
    await new Promise((r) => setTimeout(r, 100));
    expect(frames.filter((f) => f.type === 'tool/progress')).toHaveLength(1);
  });

  it('archive/completed 与 agents/updated 直转', async () => {
    const { ctx } = await wired();
    ctx.emit('archive/completed', { conversationId: 'c1', agentId: 'a1', archived: 3, kept: 2, segment: 'history_1.jsonl' });
    ctx.emit('agents/updated', { id: 'a1', model: 'm' }, 'updated');

    expect(await waitFor('archive/completed')).toMatchObject({
      args: [{ conversationId: 'c1', archived: 3, segment: 'history_1.jsonl' }],
    });
    expect(await waitFor('agents/updated')).toEqual({ args: [{ id: 'a1', model: 'm' }, 'updated'] });
  });

  it('durable-interaction/opened wire 整形：ask_questions 上提 questions；他 kind 原样', async () => {
    const { ctx } = await wired();
    ctx.emit('durable-interaction/opened', {
      id: 'dur-1',
      key: 'c1',
      kind: 'ask_questions',
      payload: { questions: [{ question: '选哪个？', options: ['A', 'B'] }] },
      state: 'pending',
      correlationId: 'tc-1',
      owner: 'a1',
      createdAt: 1,
      updatedAt: 1,
    } as never);
    ctx.emit('durable-interaction/opened', {
      id: 'dur-2',
      key: 'c1',
      kind: 'approval',
      payload: { note: '自定义' },
      state: 'pending',
      createdAt: 2,
      updatedAt: 2,
    } as never);

    expect(await waitFor('durable-interaction/opened')).toBeDefined();
    await new Promise((r) => setTimeout(r, 50));
    const opened = frames
      .filter((f) => f.type === 'durable-interaction/opened')
      .flatMap((f) => (f.data as { args: Array<Record<string, unknown>> }).args);
    const askWire = opened.find((a) => a.id === 'dur-1')!;
    expect(askWire.questions).toEqual([{ question: '选哪个？', options: ['A', 'B'] }]);
    expect(askWire.payload).toBeUndefined(); // 已上提，不再内嵌
    expect(askWire.correlationId).toBe('tc-1');

    const other = opened.find((a) => a.id === 'dur-2')!;
    expect(other.payload).toEqual({ note: '自定义' });
    expect(other.questions).toBeUndefined();
  });
});
