// ============================================================
// ac-session：事件积累 + 持久化落盘 + history() 回放 + 概要 + checkpoint
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as llmRow from 'ac-llm';
import { ARCHIVE_REVIEW_META } from 'ac-agent-loop';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import * as sessionRow from '../src/index.ts';
import { countWindowMessages } from '../src/index.ts';
import { maxSeqOf } from 'ac-core-utils';
import * as toolsRow from 'ac-tools';

const tmps: string[] = [];

function tmpRoot(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'ac-session-'));
  tmps.push(dir);
  return dir;
}

const booted: Array<{ ctx: Context; fibers: Fiber[] }> = [];
const captured: LlmChatInput[] = [];

function scriptedProvider() {
  return () => ({
    stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
      captured.push(input);
      const idx = captured.length;
      yield { delta: `回复${idx}` };
      yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
    },
  });
}

async function boot(root: string) {
  captured.length = 0;
  const ctx = new Context();
  const fibers: Fiber[] = [];
  const rows = [
    toolsRow,
    llmRow,
    {
      name: 'mock-provider',
      inject: ['llm'],
      apply(c: Context) {
        c.llm.register('mock', scriptedProvider(), { models: ['mock-1'] });
        // 工具轮脚本 provider：第 1 次出工具调用，第 2 次出终文本
        let toolCall = 0;
        c.llm.register(
          'mock-tool',
          () => ({
            stream: async function* (): AsyncIterable<LlmStreamChunk> {
              if (toolCall++ === 0) {
                yield { delta: '', toolCalls: [{ index: 0, id: 'c1', name: 'echo' }] };
                yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: '{}' }] };
                yield { delta: '', finish: 'tool_calls' };
              } else {
                yield { delta: '工具轮完成' };
                yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
              }
            },
          }),
          { models: ['mock-2'] },
        );
      },
    },
    loopRow,
    agentsRow,
    routerRow,
    sessionRow,
  ];
  for (const row of rows) {
    const fiber = ctx.plugin(row as any, { root });
    await fiber;
    fibers.push(fiber);
  }
  // 嵌套 Service fiber（row.apply 内 ctx.plugin(Service)）就绪可能落后于
  // 行 fiber——轮询等服务面可用（同文件多次 boot 时时序必现差异）
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).tools && (ctx as any).llm && (ctx as any).agentLoop &&
        (ctx as any).agents && (ctx as any).router && (ctx as any).session) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  booted.push({ ctx, fibers });
  return { ctx, fibers };
}

afterEach(async () => {
  for (const { fibers } of booted.splice(0)) {
    for (const fiber of [...fibers].reverse()) {
      if (fiber.uid !== null) await fiber.dispose();
    }
  }
  for (const dir of tmps.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

describe('ac-session 事件积累 + 回放 + 持久化', () => {
  it('send 两轮：history 自动携带前轮；消息流落盘（jsonl 中性行含 agent_id/message_id/timestamp）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 本用例聚焦持久化/投影：显式关轨迹回放（2026-10 起缺省开——差异层钉死 off 保 golden）
    ctx.agents.register({ id: 'a', model: 'mock-1', settings: { session: { replayTrajectory: false } } });
    await ctx.router.send('a', '第一句');
    await ctx.router.send('a', '第二句', { history: await ctx.session.history('a~user', { viewer: 'a' }) });
    const log = await ctx.session.history('a~user', { viewer: 'a' });
    expect(log.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    // viewer 投影（§2.4）：name = agent_id（说话人端点）
    expect(log[0]).toMatchObject({ role: 'user', name: 'user' });
    expect(log[1]).toMatchObject({ role: 'assistant', name: 'a' });
    // 第二轮到达 LLM 的消息 = 积累的完整历史；固化字段不随消息引用进请求体
    expect(captured[1].messages.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(captured[1].messages.every((m) => !('message_id' in m) && !('timestamp' in m))).toBe(true);
    // 落盘形态（D13 中性格式 + D8 版本锚点）：首行 session-header（v1），
    // 数据行 role:'agent' + agent_id + 单调 seq + 幂等标识
    const file = path.join(root, 'sessions', 'a~user', 'messages.jsonl');
    const rawLines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    const header = JSON.parse(rawLines[0]);
    expect(header).toMatchObject({ type: 'session-header', version: 1 });
    expect(typeof header.createdAt).toBe('string');
    const lines = rawLines.slice(1).map((l) => JSON.parse(l));
    expect(lines).toHaveLength(4);
    expect(lines.every((l) => l.role === 'agent')).toBe(true);
    expect(lines.map((l) => l.agent_id)).toEqual(['user', 'a', 'user', 'a']);
    expect(lines.map((l) => l.seq)).toEqual([1, 2, 3, 4]); // 单调 seq（D8）
    expect(lines.every((l) => typeof l.message_id === 'string' && l.message_id.startsWith('msg-'))).toBe(true);
    expect(lines.every((l) => typeof l.timestamp === 'string')).toBe(true);
    // stats 行计数排除头行（F4 门）
    const st = ctx.session.stats('a~user')!;
    expect(st.messageCount).toBe(4);
  });

  it('user⇄x 恒等门：viewer 投影与旧 baked 回放逐字节同构（零回归）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 手写旧 baked 格式文件（无 agent_id）：user/assistant + name
    const dir = path.join(root, 'sessions', 'legacy~user');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'messages.jsonl'),
      [
        JSON.stringify({ role: 'user', content: '旧问', name: 'user', message_id: 'm1', timestamp: 't1' }),
        JSON.stringify({ role: 'assistant', content: '旧答', name: 'legacy', message_id: 'm2', timestamp: 't2' }),
      ].join('\n') + '\n',
      'utf-8',
    );
    const log = await ctx.session.history('legacy~user', { viewer: 'legacy' });
    expect(log).toEqual([
      { role: 'user', content: '旧问', name: 'user' },
      { role: 'assistant', content: '旧答', name: 'legacy' },
    ]);
  });

  it('a⇄b 双侧视角正确（D1 golden）：自己说的话全 assistant、对方全 user', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // a→b 发起 + b 回复；b→a 发起 + a 回复（同桶四行，方向各半段）
    ctx.emit('router/message-received', 'b', { role: 'user', content: 'a 的发起' }, 'a~b', 'a', 'agent');
    ctx.emit('router/reply-completed', 'b', 'b 的回复', {
      steps: [], finish: 'stop',
      usage: { prompt: 1, completion: 1, promptAccumulated: 1, steps: 0 },
    } as never, 'a~b', 'a', 'agent');
    ctx.emit('router/message-received', 'a', { role: 'user', content: 'b 的发起' }, 'a~b', 'b', 'agent');
    ctx.emit('router/reply-completed', 'a', 'a 的回复', {
      steps: [], finish: 'stop',
      usage: { prompt: 1, completion: 1, promptAccumulated: 1, steps: 0 },
    } as never, 'a~b', 'b', 'agent');
    const byB = await ctx.session.history('a~b', { viewer: 'b' });
    expect(byB.map((m) => m.role)).toEqual(['user', 'assistant', 'assistant', 'user']);
    expect(byB.map((m) => m.name)).toEqual(['a', 'b', 'b', 'a']);
    const byA = await ctx.session.history('a~b', { viewer: 'a' });
    expect(byA.map((m) => m.role)).toEqual(['assistant', 'user', 'user', 'assistant']);
    expect(byA.map((m) => m.name)).toEqual(['a', 'b', 'b', 'a']);
  });

  it('重启回读：新服务实例从盘上恢复 history（持久化语义）', async () => {
    const root = tmpRoot();
    const first = await boot(root);
    first.ctx.agents.register({ id: 'a', model: 'mock-1' });
    await first.ctx.router.send('a', '第一句');
    await first.ctx.router.send('a', '第二句', { history: await first.ctx.session.history('a~user', { viewer: 'a' }) });

    const second = await boot(root); // 同 root 新实例（进程重启模拟）
    const log = await second.ctx.session.history('a~user', { viewer: 'a' });
    expect(log.map((m) => m.role)).toEqual(['user', 'assistant', 'user', 'assistant']);
    expect(log[0].content).toBe('第一句');
    expect(second.ctx.session.ids()).toEqual(['a~user']);
  });

  it('幂等：同一消息对象重复投递只落一行（WeakSet 引用守卫）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const message = { role: 'user' as const, content: '同一条消息' };
    ctx.emit('router/message-received', 'a', message, 'a');
    ctx.emit('router/message-received', 'a', message, 'a'); // 重复投递（跨数组场景）
    const log = await ctx.session.history('a');
    expect(log).toHaveLength(1);
    expect(log[0].content).toBe('同一条消息');
  });

  it('steer 注入入账：conversation/steered → 会话流可见（M10 补缺口）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.emit('conversation/steered', 'a', { role: 'user', content: '中途插入' }, 'a', 'a');
    const log = await ctx.session.history('a');
    expect(log).toEqual([{ role: 'user', content: '中途插入', name: 'a' }]);
  });

  it('不落盘（M20）：meta[archive-review] 标记的整理 run 三通道（入站/回复/steer）全部跳过入账', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const marker = { [ARCHIVE_REVIEW_META]: true };
    ctx.emit(
      'router/message-received',
      'a',
      { role: 'user', content: '[归档整理] 请在归档前完成整理' },
      'a~user',
      'a',
      'event',
      marker,
    );
    ctx.emit(
      'router/reply-completed',
      'a',
      '此前，整理完成',
      {
        steps: [{ index: 0, text: '此前，整理完成', toolCalls: [], toolResults: [] }],
        finish: 'stop',
        usage: { prompt: 1, completion: 1, promptAccumulated: 1, steps: 1 },
      } as never,
      'a~user',
      'a',
      'event',
      marker,
    );
    ctx.emit(
      'conversation/steered',
      'a',
      { role: 'user', content: '[归档整理] 中途注入' },
      'a~user',
      'a~user~a',
      'a',
      'event',
      marker,
    );
    const records = await ctx.session.records('a~user');
    expect(records).toHaveLength(0);
    expect(fs.existsSync(path.join(root, 'sessions', 'a~user', 'messages.jsonl'))).toBe(false);
  });

  it('Agent → 虚拟端点（viewer）私信：中性入账 role:agent + agent_id=说话人（D13 特判删除）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'user', virtual: true });
    ctx.agents.register({ id: 'writer', model: 'mock-1' });
    // send_agent → viewer：桶 = pairKey(writer, user)，sender=说话 agent。
    // 中性存储下无需猜方向：就是 writer 的发言，归属 writer（§2.3）
    ctx.emit('router/message-received', 'user', { role: 'user', content: '给用户的私信' }, 'user~writer', 'writer', 'agent');
    const records = await ctx.session.records('user~writer');
    expect(records[0]).toMatchObject({ role: 'agent', agent_id: 'writer', content: '给用户的私信' });
    expect(records[0]?.name).toBeUndefined(); // 新写不再产生 name
    // viewer 投影：writer 视角是自己的话（assistant）；用户侧 UI 读 records 自行投影
    const byWriter = await ctx.session.history('user~writer', { viewer: 'writer' });
    expect(byWriter).toEqual([{ role: 'assistant', content: '给用户的私信', name: 'writer' }]);
  });

  it('错误收束一等化（D12/F7）：finish=error → role:error 行；LLM 回放按 user 喂回', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.emit('router/reply-completed', 'a', '[error] 爆了', {
      steps: [], finish: 'error', error: 'LLM HTTP 500',
      usage: { prompt: 1, completion: 1, promptAccumulated: 1, steps: 0 },
    } as never, 'a~user', 'user', 'user');
    const records = await ctx.session.records('a~user');
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ role: 'context', source: 'error', content: 'LLM HTTP 500', agent_id: 'a' });
    // 回放语义位：user（告知"出了错"而无自他归因污染）
    const log = await ctx.session.history('a~user', { viewer: 'a' });
    expect(log).toEqual([{ role: 'user', content: 'LLM HTTP 500', name: 'a' }]);
  });

  it('reply-completed 步记录持久化：steps[] 含工具调用对（M18 #6——刷新后工具卡片不丢）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 聚焦持久化：viewer 'a' 未注册时差异层缺席——注册并显式关回放（缺省已翻转为开）
    ctx.agents.register({ id: 'a', model: 'none', settings: { session: { replayTrajectory: false } } });
    ctx.emit('router/reply-completed', 'a', '最终回答', {
      steps: [
        {
          index: 0,
          text: '',
          reasoning: '先想想',
          toolCalls: [{ id: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}' }],
          toolResults: [{ ok: true, output: { content: '...' } }],
        },
        { index: 1, text: '最终回答', reasoning: '', toolCalls: [], toolResults: [] },
      ],
      finish: 'stop',
      usage: { prompt: 1, completion: 1, promptAccumulated: 1, steps: 2 },
    } as never, 'a');
    const records = await ctx.session.records('a');
    const asst = records.find((r) => r.role === 'agent');
    expect(asst?.content).toBe('最终回答');
    // 终版裁决：reasoning_content 不落盘——replayTrajectory 关闭用户的
    // 整轮视图由前端从 steps[].reasoning 拼接（historyApi 投影）
    expect(asst?.reasoning_content).toBeUndefined();
    expect(asst?.steps).toHaveLength(2);
    expect(asst?.steps?.[0]).toMatchObject({
      content: '',
      reasoning: '先想想',
      toolCalls: [
        { id: 'c1', name: 'read', arguments: '{"file_path":"a.ts"}', result: { ok: true, output: { content: '...' } } },
      ],
    });
    expect(asst?.steps?.[1]).toMatchObject({ content: '最终回答' });
    // history()（LLM 回放）显式关时不消费 steps——对话级语义（viewer 投影）；
    // 缺省开时的展开形状见 replay-trajectory.test 两态 golden
    const replay = await ctx.session.history('a', { viewer: 'a' });
    expect(replay).toEqual([{ role: 'assistant', content: '最终回答', name: 'a' }]);
  });

  it('group 会话：多 agent 共享同一 conversationId 分桶（agent_id 标注来源 + viewer 投影）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'g-a', model: 'mock-1' });
    // viewer = g-b：差异层显式关回放（缺省已开），保本用例的分桶/投影 golden
    ctx.agents.register({ id: 'g-b', model: 'mock-1', settings: { session: { replayTrajectory: false } } });
    // 群投递真实形态：sender = 说话人端点 id（ac-group.send 同款）
    await ctx.router.send('g-a', '大家好', { sender: 'g-a', source: 'agent', conversationId: 'room-1' });
    await ctx.router.send('g-b', '继续', {
      sender: 'g-b',
      source: 'agent',
      conversationId: 'room-1',
      history: await ctx.session.history('room-1', { viewer: 'g-b' }),
    });
    // viewer 投影（g-b 视角）：g-a 的一切发言 = user，自己的 = assistant
    const log = await ctx.session.history('room-1', { viewer: 'g-b' });
    expect(log.map((m) => m.role)).toEqual(['user', 'user', 'assistant', 'assistant']);
    expect(log.map((m) => m.name)).toEqual(['g-a', 'g-a', 'g-b', 'g-b']);
    // 到达 g-b 的 LLM 的消息：历史（g-b 视角）+ 本条入站
    expect(captured[1].messages.map((m) => m.role)).toEqual(['user', 'user', 'user']);
  });

  it('M19 验收：第二个虚拟 Agent（user2）直答零代码走通——自动成桶/成流/进矩阵', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'user2', virtual: true, description: '第二用户' });
    // viewer = a：差异层显式关回放（缺省已开），保直答/成桶 golden
    ctx.agents.register({ id: 'a', model: 'mock-1', settings: { session: { replayTrajectory: false } } });
    // user2 直答：缺省对键 = pairKey('user2', 'a')（sender 进对键推导）
    await ctx.router.send('a', '来自 user2 的问题', { sender: 'user2' });
    const log = await ctx.session.history('a~user2', { viewer: 'a' });
    expect(log.map((m) => m.role)).toEqual(['user', 'assistant']);
    // 说话人标注（viewer 投影 name = agent_id；user 只是端点之一——无任何专属路径）
    expect(log[0]).toMatchObject({ role: 'user', name: 'user2' });
    expect(log[1]).toMatchObject({ role: 'assistant', name: 'a' });
    // 信封携带 sender 身份：dry-run 捕获 loop 请求侧
    const seen: string[] = [];
    ctx.on('loop/before-run', (call, next) => {
      seen.push(`${call.request.sender}/${call.request.conversationId}`);
      return next();
    });
    await ctx.router.send('a', '第二轮', { sender: 'user2', history: log });
    expect(seen).toEqual(['user2/a~user2']);
    // a → user2 私信（send_agent 同款）：同桶中性入账（agent_id=a）
    await ctx.router.send('user2', '给 user2 的私信', { sender: 'a', source: 'agent', conversationId: 'a~user2' });
    const log2 = await ctx.session.history('a~user2', { viewer: 'a' });
    expect(log2.at(-1)).toMatchObject({ role: 'assistant', name: 'a', content: '给 user2 的私信' });
  });

  it('compact：概要作为 system 头部注入，消息流截断', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    await ctx.router.send('a', '第一句');
    await ctx.session.compact('a~user', { summary: '此前讨论了 X' });
    expect(await ctx.session.history('a~user', { viewer: 'a' })).toEqual([{ role: 'system', content: '此前讨论了 X' }]);
    await ctx.router.send('a', '新问题', { history: await ctx.session.history('a~user', { viewer: 'a' }) });
    expect(captured[1].messages[0]).toEqual({ role: 'system', content: '此前讨论了 X' });
    expect(captured[1].messages[1].role).toBe('user');
  });

  it('clear：清空会话（目录删除）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    await ctx.router.send('a', 'q');
    ctx.session.clear('a~user');
    expect(await ctx.session.history('a~user')).toEqual([]);
    expect(fs.existsSync(path.join(root, 'sessions', 'a~user'))).toBe(false);
  });

  it('订阅即归属：卸载 session 行 → 积累停止（router 照常工作）', async () => {
    const root = tmpRoot();
    const { ctx, fibers } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    await ctx.router.send('a', '第一句');
    const sessionFiber = fibers.at(-1)!;
    await sessionFiber.dispose();
    await ctx.router.send('a', '第二句');
    expect((ctx as any).session).toBeUndefined();
    expect(captured).toHaveLength(2); // router 投递照常
    // 卸载时队列已排空（第一轮已 durable；头行 + 2 数据行）
    const file = path.join(root, 'sessions', 'a~user', 'messages.jsonl');
    expect(fs.readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(3);
  });

  it('conversationId 路径校验：分隔/遍历字符拒绝（C1 emit 隔离下不炸发射方）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 旧语义：监听器校验 throw 经 emit 上窜到发射方（fire-and-forget 发射
    // 场景即 uncaughtException）。C1 后 emit 逐回调隔离——校验照样生效
    // （消息不入账、目录不创建），但发射方不再被炸。
    expect(() =>
      ctx.emit('router/message-received', 'a', { role: 'user', content: 'x' }, '../evil'),
    ).not.toThrow();
    expect(() =>
      ctx.emit('router/message-received', 'a', { role: 'user', content: 'x' }, 'a/b'),
    ).not.toThrow();
    // 校验路径：record() 先 assert 再建队——非法 id 不产生任何目录/文件
    const sessionsDir = path.join(root, 'sessions');
    expect(fs.existsSync(sessionsDir) ? fs.readdirSync(sessionsDir) : []).toEqual([]);
  });

  // ---- B3 崩溃残留自愈（2026-08-31 审计：写盘中途死 → 尾部半行 → 拼接两行俱损） ----

  const sessionFileOf = (root: string, id = 'a~user') =>
    path.join(root, 'sessions', id, 'messages.jsonl');

  const headerJson = () =>
    JSON.stringify({ type: 'session-header', version: 1, createdAt: new Date().toISOString() });

  const recordJson = (content: string, seq: number) =>
    JSON.stringify({
      role: 'agent', agent_id: 'user', content, message_id: `m${seq}`,
      timestamp: new Date().toISOString(), seq,
    });

  it('B3 回归：尾部撕裂半行建队时截断——新 append 不再拼进半行', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const file = sessionFileOf(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, `${headerJson()}\n${recordJson('旧消息', 1)}\n{"role":"agent","content":"撕裂半`, 'utf-8');

    await ctx.session.append('a~user', 'user', { role: 'user', content: '新消息' });

    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter((l) => l.trim());
    const parsed = lines.map((l) => JSON.parse(l)); // 全部可解析（半行已截断，未与新行合并）
    expect(parsed.some((p) => p.content === '旧消息')).toBe(true);
    expect(parsed.some((p) => p.content === '撕裂半')).toBe(false);
    expect(parsed.some((p) => p.content === '新消息')).toBe(true);
    expect(fs.readFileSync(file, 'utf-8').endsWith('\n')).toBe(true);
  });

  it('B3 回归：撕裂点在换行前的完整记录被补换行救回', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const file = sessionFileOf(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    // 完整 JSON 记录但缺收尾换行（写完字节、没写 \n 就死）
    fs.writeFileSync(file, `${headerJson()}\n${recordJson('完整但缺换行', 1)}`, 'utf-8');

    await ctx.session.append('a~user', 'user', { role: 'user', content: '下一条' });

    const records = await ctx.session.records('a~user');
    expect(records.some((r) => r.content === '完整但缺换行')).toBe(true); // 记录本体保住
    expect(records.some((r) => r.content === '下一条')).toBe(true);
  });

  it('B3 回归：末行 seq 不可读时全文件扫描续号（不再重置 1 制造 seq 冲突）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const file = sessionFileOf(root);
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(
      file,
      `${headerJson()}\n${recordJson('一', 1)}\n${recordJson('二', 2)}\n{"role":"agent","content":"三但撕`,
      'utf-8',
    );

    await ctx.session.append('a~user', 'user', { role: 'user', content: '四' });

    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n');
    const last = JSON.parse(lines[lines.length - 1]);
    expect(last.content).toBe('四');
    expect(last.seq).toBe(3); // 扫描出的 max seq(2) + 1，而非重置 1
  });

  // ---- B1 重写窗口（2026-08-31 审计：归档/删除 run 期间新到消息被 tmp+rename 覆盖） ----

  it('B1 回归：compact 窗口——快照后新到记录并入保留，不被重写覆盖', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    await ctx.session.append('a~user', 'user', { role: 'user', content: '旧1' });
    await ctx.session.append('a~user', 'user', { role: 'user', content: '旧2' });
    // 调用方（归档）快照：maxSeq = 2；决定归档旧1、保留尾部 [旧2]
    const snapshot = await ctx.session.records('a~user');
    const keep = snapshot.slice(-1);
    // 快照后、compact 前：新消息落账（steer 注入/群成员并发发言的窗口）
    await ctx.session.append('a~user', 'user', { role: 'user', content: '窗口新到' });
    await ctx.session.compact('a~user', {
      summary: '已归档。',
      keep,
      baselineSeq: maxSeqOf(snapshot),
    });
    const after = await ctx.session.records('a~user');
    // 旧1 被归档掉；旧2 保留；窗口新到不丢（此前被 tmp+rename 静默覆盖）
    expect(after.map((r) => r.content)).toEqual(['旧2', '窗口新到']);
  });

  it('B1 回归：deleteMessage/truncateAfter 窗口——删除不连带吞掉快照后新记录', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const id1 = await ctx.session.append('a~user', 'user', { role: 'user', content: 'A' });
    await ctx.session.append('a~user', 'user', { role: 'user', content: 'B' });
    await ctx.session.append('a~user', 'user', { role: 'user', content: '窗口C' });
    expect(await ctx.session.deleteMessage('a~user', id1)).toBe(true);
    expect((await ctx.session.records('a~user')).map((r) => r.content)).toEqual(['B', '窗口C']);

    const idB = (await ctx.session.records('a~user')).find((r) => r.content === 'B')!.message_id;
    await ctx.session.append('a~user', 'user', { role: 'user', content: '窗口D' });
    // truncateAfter(B) = 删 B 及其后（快照内 B/C/D 三行；快照后无新到）→ 返回 3；
    // 若快照后有新到（本测试无）由窗口并入——删除意图只覆盖快照
    expect(await ctx.session.truncateAfter('a~user', idB)).toBe(3);
    expect((await ctx.session.records('a~user')).map((r) => r.content)).toEqual([]);
  });
});

describe('ac-session fail-closed checkpoint（工具执行前 durable）', () => {
  it('落盘失败 → 工具执行被 veto，错误可读；run 仍收束', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 占位文件堵死会话目录（mkdir ENOTDIR → write 失败）
    fs.writeFileSync(path.join(root, 'sessions'), 'blocker', 'utf-8');
    ctx.agents.register({ id: 'a', model: 'mock-2' });
    ctx.tools.register({ name: 'echo', execute: () => ({ ok: true, output: '不应执行' }) });
    const run = await ctx.router.send('a', '请用工具');
    expect(run.steps[0].toolResults[0]).toMatchObject({ ok: false });
    expect((run.steps[0].toolResults[0] as { error?: string }).error).toContain('会话持久化 checkpoint 失败');
    expect(run.finish).toBe('stop'); // 循环照常收束（失败信息回填给模型）
  });

  it('落盘正常 → 工具放行；工具执行前入站消息已 durable', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'mock-2' });
    ctx.tools.register({ name: 'echo', execute: () => ({ ok: true, output: 'ok' }) });
    const run = await ctx.router.send('a', '请用工具');
    expect(run.steps[0].toolResults[0]).toEqual({ ok: true, output: 'ok' });
    // checkpoint 已把入站消息刷到盘上（工具执行前 durable；桶 = a~user；
    // 中性格式：首行头行，次行 role:'agent' + agent_id=说话人 user）
    const file = path.join(root, 'sessions', 'a~user', 'messages.jsonl');
    const raw = fs.readFileSync(file, 'utf-8').split('\n');
    expect(JSON.parse(raw[0])).toMatchObject({ type: 'session-header', version: 1 });
    expect(JSON.parse(raw[1])).toMatchObject({ role: 'agent', agent_id: 'user', content: '请用工具' });
  });

  it('M11 定向 checkpoint：带 conversationId 只排当前会话；无身份退回 flushAll', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.tools.register({ name: 'echo', execute: () => ({ ok: true }) });
    // 入站即落盘（2026-09-18 修复）：两行各自在 message-received 时已 durable，
    // 不再依赖 checkpoint——定向 flush 的「不串台」仍以队列隔离验证（下方）
    ctx.emit('router/message-received', 'a', { role: 'user', content: '会话A' }, 'a');
    ctx.emit('router/message-received', 'b', { role: 'user', content: '会话B' }, 'b');
    await new Promise((r) => setTimeout(r, 20));
    // 带 a 身份执行工具：定向 flush 只涉及 a（行为不变，b 的落盘已由入站即时落盘完成）
    await ctx.tools.execute({ name: 'echo', args: {}, conversationId: 'a' });
    const fileA = path.join(root, 'sessions', 'a', 'messages.jsonl');
    const fileB = path.join(root, 'sessions', 'b', 'messages.jsonl');
    expect(fs.existsSync(fileA)).toBe(true);
    expect(fs.readFileSync(fileA, 'utf-8')).toContain('会话A');
    expect(fs.existsSync(fileB)).toBe(true); // b 的入站行已即时落盘（不再测「定向不碰 b」——该前提随即时落盘消失）
    // 无身份（宿主直调）→ flushAll 兜底
    await ctx.tools.execute({ name: 'echo', args: {} });
    expect(fs.existsSync(fileB)).toBe(true);
    expect(fs.readFileSync(fileB, 'utf-8')).toContain('会话B');
  });
});

describe('ac-session 上架（shelving）+ 热力窗口', () => {
  it('setShelf：现存目录迁移 + 寻址不变（append/history/stats 走新路径）+ 索引持久化', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    await ctx.router.send('a', '上架前的一句');
    expect(fs.existsSync(path.join(root, 'sessions', 'a~user', 'messages.jsonl'))).toBe(true);

    ctx.session.setShelf('a~user', 'singles/ws-1');
    // 目录已迁移；shelf 根带标记
    expect(fs.existsSync(path.join(root, 'sessions', 'a~user'))).toBe(false);
    expect(fs.existsSync(path.join(root, 'sessions', 'singles', 'ws-1', 'a~user', 'messages.jsonl'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'sessions', 'singles', '.shelf'))).toBe(true);
    // ids() 不把 shelf 根当会话，且仍列出上架会话
    expect(ctx.session.ids()).toContain('a~user');
    expect(ctx.session.ids()).not.toContain('singles');
    // 寻址不变：history 回放 + 新消息落新路径
    const log = await ctx.session.history('a~user');
    expect(log.map((m) => m.content)).toEqual(['上架前的一句', expect.stringContaining('回复')]);
    await ctx.router.send('a', '上架后的一句', { history: log, conversationId: 'a~user' });
    const shelved = fs.readFileSync(path.join(root, 'sessions', 'singles', 'ws-1', 'a~user', 'messages.jsonl'), 'utf-8');
    expect(shelved).toContain('上架后的一句');

    // 索引持久化：新服务实例（同 root）按索引寻址
    const ctx2 = new Context();
    const f2 = ctx2.plugin(sessionRow as any, { root });
    await f2;
    for (let i = 0; i < 1000; i++) {
      if ((ctx2 as any).session) break;
      await new Promise((r) => setTimeout(r, 1));
    }
    expect((await ctx2.session.history('a~user')).length).toBeGreaterThan(0);
    expect(ctx2.session.ids()).toContain('a~user');
    await f2.dispose();
  });

  it('setShelf 幂等 + 换架（workspaceId 变更迁移）+ shelf 校验', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.session.setShelf('sid-1', 'singles/ungrouped');
    expect(ctx.session.shelfOf('sid-1')).toBe('singles/ungrouped');
    ctx.session.setShelf('sid-1', 'singles/ungrouped'); // 同架重复：无副作用
    ctx.session.setShelf('sid-1', 'singles/ws-2'); // 换架
    expect(fs.existsSync(path.join(root, 'sessions', 'singles', 'ws-2', 'sid-1'))).toBe(true);
    expect(fs.existsSync(path.join(root, 'sessions', 'singles', 'ungrouped', 'sid-1'))).toBe(false);
    expect(() => ctx.session.setShelf('sid-2', '../evil')).toThrow(/非法/);
  });

  it('stats：热力窗口按记录时间戳统计（h1/d30），mtime 缓存', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const dir = path.join(root, 'sessions', 'w');
    fs.mkdirSync(dir, { recursive: true });
    const now = Date.now();
    const mk = (ageMs: number): string =>
      JSON.stringify({ role: 'user', content: 'x', message_id: `m${ageMs}`, timestamp: new Date(now - ageMs).toISOString() });
    fs.writeFileSync(path.join(dir, 'messages.jsonl'), [
      mk(10 * 60_000),   // 10 分钟前 → h1..d30
      mk(2 * 86_400_000), // 2 天前 → d3..d30
      mk(40 * 86_400_000), // 40 天前 → 全窗外
    ].join('\n') + '\n', 'utf-8');
    const st = ctx.session.stats('w')!;
    expect(st.messageCount).toBe(3);
    expect(st.windows).toEqual({ h1: 1, d1: 1, d3: 2, d7: 2, d30: 2 });
    // 未变更再查：缓存命中（同对象引用语义不可断言，值等价即可）
    expect(ctx.session.stats('w')!.windows).toEqual({ h1: 1, d1: 1, d3: 2, d7: 2, d30: 2 });
    // 纯函数：空行数组/坏行容忍（行数组签名——stats 与行计数共享 split）
    expect(countWindowMessages([''], now)).toEqual({ h1: 0, d1: 0, d3: 0, d7: 0, d30: 0 });
    expect(countWindowMessages(['not-json', '{"timestamp":"bad"}'], now)).toEqual({ h1: 0, d1: 0, d3: 0, d7: 0, d30: 0 });
  });

  it('stats 增量：追加段追加计数，与全量口径一致；rewrite 后基线失效重扫', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const dir = path.join(root, 'sessions', 'inc');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, 'messages.jsonl');
    const now = Date.now();
    const mk = (ageMs: number, id: string): string =>
      JSON.stringify({ role: 'user', content: 'x', message_id: id, timestamp: new Date(now - ageMs).toISOString() });

    // 首轮：全量基线
    fs.writeFileSync(file, [mk(10 * 60_000, 'm1'), mk(2 * 86_400_000, 'm2')].join('\n') + '\n', 'utf-8');
    const st1 = ctx.session.stats('inc')!;
    expect(st1.messageCount).toBe(2);
    expect(st1.windows).toEqual({ h1: 1, d1: 1, d3: 2, d7: 2, d30: 2 });

    // 追加（mtime 变）→ 增量路径：只读新增段，旧值 + 新行计数
    fs.appendFileSync(file, mk(30 * 60_000, 'm3') + '\n' + mk(3 * 86_400_000, 'm4') + '\n', 'utf-8');
    const st2 = ctx.session.stats('inc')!;
    expect(st2.messageCount).toBe(4);
    // m3（30 分钟前 → h1..d30）+ m4（3 天前 < 7 天 → d7..d30）
    expect(st2.windows).toEqual({ h1: 2, d1: 2, d3: 3, d7: 4, d30: 4 });

    // 未变更再查：mtime 门命中
    const st2b = ctx.session.stats('inc')!;
    expect(st2b.messageCount).toBe(4);

    // compact（rewriteMessages）：基线失效 → 全量重扫（清 shrink 场景的偏移不可信）
    await ctx.session.compact('inc', {
      keep: [
        { role: 'user', content: 'kept', message_id: 'm4', timestamp: new Date(now - 3 * 86_400_000).toISOString() },
      ],
      baselineSeq: undefined,
    });
    const st3 = ctx.session.stats('inc')!;
    expect(st3.messageCount).toBe(1);
    // m4 = 3 天前：d3 边界外（不小于 3 天）、d7 内
    expect(st3.windows).toEqual({ h1: 0, d1: 0, d3: 0, d7: 1, d30: 1 });

    // rewrite 后再追加：新基线上增量继续正确
    fs.appendFileSync(file, mk(5 * 60_000, 'm5') + '\n', 'utf-8');
    const st4 = ctx.session.stats('inc')!;
    expect(st4.messageCount).toBe(2);
    expect(st4.windows.h1).toBe(1);
  });
});

describe('ac-session 步级部分行（src step-persist 平移：ask_questions 等待期刷新不丢思维链）', () => {
  /** 驱动一个"第一步带工具调用、工具阻塞等待用户回答"的 run 形态（步带 ts 时序锚） */
  function emitToolStepPending(ctx: Context, conv = 'a~user', agent = 'a'): void {
    ctx.emit('router/message-received', agent, { role: 'user', content: '帮我决定' }, conv, 'user', 'user');
    ctx.emit('loop/run-started', { agent, conversationId: conv, sender: 'user', source: 'user' } as never);
    ctx.emit('loop/after-step', agent, {
      index: 0,
      text: '',
      reasoning: '需要先问用户',
      ts: 1_000,
      toolCalls: [{ id: 'call-42', name: 'ask_questions', arguments: '{"questions":[{"question":"选哪个","options":["A","B"]}]}' }],
      toolResults: [],
    } as never, { conversationId: conv, sender: 'user', source: 'user' });
  }

  it('工具步 checkpoint：pending 期 records()/原始文件可见部分行（含思维链+调用对），history() 不消费', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'none', settings: { session: { replayTrajectory: true } } });
    emitToolStepPending(ctx);
    // 无收束行（工具阻塞中）→ 部分行保留：刷新后的历史首屏据此恢复思维链
    const mid = await ctx.session.records('a~user');
    expect(mid).toHaveLength(2);
    expect(mid[1]).toMatchObject({
      partial: true, role: 'agent', agent_id: 'a', content: '',
      reasoning_content: '需要先问用户',
    });
    expect(mid[1]!.steps![0]).toMatchObject({
      content: '',
      reasoning: '需要先问用户',
      ts: 1_000,
      toolCalls: [{ id: 'call-42', name: 'ask_questions', result: null }],
    });
    expect(typeof mid[1]!.run).toBe('string');
    // LLM 回放不消费部分行（工具结果未回——展开即悬空 tool_calls）
    const replay = await ctx.session.history('a~user', { viewer: 'a' });
    expect(replay).toEqual([{ role: 'user', content: '帮我决定', name: 'user' }]);
    // 原始文件确实落盘（tool/before-execute checkpoint 同款 flush 语义）
    // partials 摘除（2026-09-20）：partial 步行落 partials.jsonl，主文件零死重
    const file = path.join(root, 'sessions', 'a~user', 'partials.jsonl');
    expect(fs.readFileSync(file, 'utf-8')).toContain('"partial":true');
    // stats/tail 排除部分行：消息计数 1（仅入站行），名册预览不入中间步
    expect(ctx.session.stats('a~user')!.messageCount).toBe(1);
    expect(ctx.session.tail('a~user')).toMatchObject({ role: 'agent', content: '帮我决定', agent_id: 'user' });
  });

  it('收束吸收：reply-completed 落收束行（同 run 键）→ records() 部分行不可见，形态与步级落盘前一致', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'none', settings: { session: { replayTrajectory: false } } });
    emitToolStepPending(ctx);
    ctx.emit('router/reply-completed', 'a', '选 A 的话就…', {
      steps: [
        {
          index: 0, text: '', reasoning: '需要先问用户', ts: 1_000,
          toolCalls: [{ id: 'call-42', name: 'ask_questions', arguments: '{"questions":[…]}' }],
          toolResults: [{ ok: true, output: { answers: ['A'] } }],
        },
        { index: 1, text: '选 A 的话就…', reasoning: '', ts: 2_000, toolCalls: [], toolResults: [] },
      ],
      finish: 'stop',
      usage: { prompt: 1, completion: 1, promptAccumulated: 1, steps: 2 },
    } as never, 'a~user', 'user', 'user');
    const done = await ctx.session.records('a~user');
    // 入站行 + 收束行；部分行被吸收（物理行仍在文件，读侧投影不可见）
    expect(done).toHaveLength(2);
    expect(done[1]).toMatchObject({ role: 'agent', agent_id: 'a', content: '选 A 的话就…' });
    expect(done[1]!.partial).toBeUndefined();
    expect(typeof done[1]!.run).toBe('string');
    // 收束行带完整工具结果（部分行的 result:null 不泄漏进最终形态）+ 步级 ts 时序锚
    expect(done[1]!.steps![0]!.toolCalls![0]).toMatchObject({ result: { ok: true, output: { answers: ['A'] } } });
    expect(done[1]!.steps!.map((s) => s.ts)).toEqual([1_000, 2_000]);
    // stats 口径同样排除物理残留的部分行
    expect(ctx.session.stats('a~user')!.messageCount).toBe(2);
  });

  it('中断收束（工具 interrupt / max-steps）：末步无终文本但有步 → 仍入账（content 空 + steps 携带思维链/结果）并吸收部分行；空 run 不入账', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    emitToolStepPending(ctx);
    // 中断收束（text 空，但 run 有已完成的工具步——send_agent/restart 等场景）
    ctx.emit('router/reply-completed', 'a', '', {
      steps: [
        {
          index: 0, text: '', reasoning: '需要先问用户',
          toolCalls: [{ id: 'call-42', name: 'ask_questions', arguments: '{}' }],
          toolResults: [{ ok: false, error: '等待被中止' }],
        },
      ],
      finish: 'interrupted',
      interruptReason: { type: 'tool-interrupt', reason: '工具 ask_questions 请求 system-restart' },
      usage: { prompt: 1, completion: 0, promptAccumulated: 1, steps: 1 },
    } as never, 'a~user', 'user', 'user');
    const after = await ctx.session.records('a~user');
    // 入站行 + 收束行（部分行被吸收）；content 空、steps 携带全部内容
    expect(after).toHaveLength(2);
    expect(after[1]).toMatchObject({ role: 'agent', agent_id: 'a', content: '' });
    expect(after[1]!.partial).toBeUndefined();
    expect(typeof after[1]!.run).toBe('string');
    // reasoning 单份存储（2026-09-20 终版）：正源 = steps[].reasoning
    expect(after[1]!.steps![0]).toMatchObject({ reasoning: '需要先问用户' });
    expect(after[1]!.steps![0]!.toolCalls![0]).toMatchObject({ result: { ok: false, error: '等待被中止' } });
    // LLM 回放：空 content 但 steps 结果齐全 + viewer 轨迹回放 → 展开轨迹
    //（2026-09-04 语义升级：中断 run 已见前缀字节保真——KV 命中 + 完成步
    // 记忆；旧语义整体跳过该 run）
    const replay2 = await ctx.session.history('a~user', { viewer: 'a' });
    expect(replay2).toEqual([
      { role: 'user', content: '帮我决定', name: 'user' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'call-42', type: 'function', function: { name: 'ask_questions', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'call-42', content: JSON.stringify({ ok: false, error: '等待被中止' }) },
    ]);
    // 完全空 run（首步前中断，无任何步产出）→ 不入账
    ctx.emit('router/reply-completed', 'a', '', {
      steps: [], finish: 'interrupted',
      usage: { prompt: 0, completion: 0, promptAccumulated: 0, steps: 0 },
    } as never, 'a~user', 'user', 'user');
    expect(await ctx.session.records('a~user')).toHaveLength(2);
  });

  it('错误收束不吸收：run 已产出的思维链部分行保留（会话事实）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    emitToolStepPending(ctx);
    // 错误收束：error 行不盖章 → 部分行保留 + 错误行可见
    ctx.emit('router/reply-completed', 'a', '', {
      steps: [], finish: 'error', error: 'LLM HTTP 500',
      usage: { prompt: 1, completion: 0, promptAccumulated: 1, steps: 0 },
    } as never, 'a~user', 'user', 'user');
    const afterError = await ctx.session.records('a~user');
    console.log('AFTER_ERR:', JSON.stringify(afterError.map((r) => ({ role: r.role, partial: r.partial === true, run: r.run, ts: r.timestamp }))));
    expect(afterError).toHaveLength(3);
    expect(afterError[1]!.partial).toBe(true);
    expect(afterError[2]).toMatchObject({ role: 'context', source: 'error', content: 'LLM HTTP 500' });
  });

  it('纯文本步不落部分行（无工具 run 落盘形态零漂移）；机制 run（archive-review）跳过', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'none', settings: { session: { replayTrajectory: false } } });
    // 纯文本 run：after-step 无工具调用
    ctx.emit('router/message-received', 'a', { role: 'user', content: '在吗' }, 'a~user', 'user', 'user');
    ctx.emit('loop/run-started', { agent: 'a', conversationId: 'a~user', source: 'user' } as never);
    ctx.emit('loop/after-step', 'a', { index: 0, text: '在的', reasoning: '', toolCalls: [], toolResults: [] } as never, { conversationId: 'a~user' });
    ctx.emit('router/reply-completed', 'a', '在的', {
      steps: [{ index: 0, text: '在的', reasoning: '', toolCalls: [], toolResults: [] }],
      finish: 'stop',
      usage: { prompt: 1, completion: 1, promptAccumulated: 1, steps: 1 },
    } as never, 'a~user', 'user', 'user');
    const plain = await ctx.session.records('a~user');
    expect(plain).toHaveLength(2);
    expect(plain.every((r) => r.partial === undefined && r.run === undefined)).toBe(true);
    // 机制 run：meta[archive-review] → 部分行门控
    ctx.emit('loop/run-started', { agent: 'a', conversationId: 'a~user', source: 'event', meta: { [ARCHIVE_REVIEW_META]: true } } as never);
    ctx.emit('loop/after-step', 'a', {
      index: 0, text: '', reasoning: '整理中',
      toolCalls: [{ id: 'c9', name: 'read', arguments: '{}' }], toolResults: [],
    } as never, { conversationId: 'a~user', source: 'event' });
    const afterMech = await ctx.session.records('a~user');
    expect(afterMech).toHaveLength(2); // 无新行
    const file = path.join(root, 'sessions', 'a~user', 'messages.jsonl');
    expect(fs.readFileSync(file, 'utf-8')).not.toContain('整理中');
  });

  // ---- 工具结果补记（2026-09-04：部分行 result 覆盖 + KV 前缀保真）----

  /** 驱动"工具步已落部分行、工具执行完毕（补行到达）、run 未收束"形态 */
  function emitSupplementedPending(ctx: Context): void {
    ctx.emit('router/message-received', 'a', { role: 'user', content: '查状态' }, 'a~user', 'user', 'user');
    ctx.emit('loop/run-started', { agent: 'a', conversationId: 'a~user', sender: 'user', source: 'user' } as never);
    ctx.emit('loop/after-step', 'a', {
      index: 0, text: '', reasoning: '先查', ts: 1_000,
      toolCalls: [{ id: 'call-7', name: 'read', arguments: '{"file_path":"a.ts"}' }],
      toolResults: [],
    } as never, { conversationId: 'a~user', sender: 'user', source: 'user' });
    ctx.emit('tool/after-execute', {
      name: 'read', agentId: 'a', conversationId: 'a~user', toolCallId: 'call-7',
    }, { ok: true, output: { path: 'a.ts', content: '1:x', total_lines: 1 } }, undefined);
  }

  it('工具结果补记：补行落盘 → records() 覆盖部分行 result；轨迹回放字节保真（KV 前缀）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'none', settings: { session: { replayTrajectory: true } } });
    emitSupplementedPending(ctx);
    await new Promise((r) => setTimeout(r, 10)); // flushBestEffort 尽力而为 → 等落盘

    // 补行物理存在（type 判别行，非消息行）——partials 摘除后落 partials.jsonl
    const file = path.join(root, 'sessions', 'a~user', 'partials.jsonl');
    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).toContain('"type":"tool-result"');
    expect(raw).toContain('"tool_call_id":"call-7"');
    // stats/tail 口径不受补行影响（仅 1 条入站消息）
    expect(ctx.session.stats('a~user')!.messageCount).toBe(1);

    // records()：部分行 result 被补行覆盖（不再是 null）
    const mid = await ctx.session.records('a~user');
    expect(mid[1]!.steps![0]!.toolCalls![0]!.result).toEqual({
      ok: true, output: { path: 'a.ts', content: '1:x', total_lines: 1 },
    });

    // history() 轨迹回放：结果齐全的部分行展开——工具 content = 终值
    // JSON.stringify（与 loop 回填模型的字节一致 → provider KV 前缀命中）
    const replay = await ctx.session.history('a~user', { viewer: 'a' });
    expect(replay).toEqual([
      { role: 'user', content: '查状态', name: 'user' },
      {
        role: 'assistant', content: '',
        tool_calls: [{ id: 'call-7', type: 'function', function: { name: 'read', arguments: '{"file_path":"a.ts"}' } }],
      },
      {
        role: 'tool', tool_call_id: 'call-7',
        content: JSON.stringify({ ok: true, output: { path: 'a.ts', content: '1:x', total_lines: 1 } }),
      },
    ]);

    // 正常收束：收束行吸收部分行——补行失效（records 不再产出），形态与
    // 步级落盘前一致
    ctx.emit('router/reply-completed', 'a', '查完了', {
      steps: [{
        index: 0, text: '', reasoning: '先查', ts: 1_000,
        toolCalls: [{ id: 'call-7', name: 'read', arguments: '{"file_path":"a.ts"}' }],
        toolResults: [{ ok: true, output: { path: 'a.ts', content: '1:x', total_lines: 1 } }],
      }, { index: 1, text: '查完了', reasoning: '', ts: 2_000, toolCalls: [], toolResults: [] }],
      finish: 'stop',
      usage: { prompt: 1, completion: 1, promptAccumulated: 1, steps: 2 },
    } as never, 'a~user', 'user', 'user');
    const done = await ctx.session.records('a~user');
    expect(done).toHaveLength(2);
    expect(done[1]!.partial).toBeUndefined();
    expect(done[1]!.steps![0]!.toolCalls![0]!.result).toEqual({
      ok: true, output: { path: 'a.ts', content: '1:x', total_lines: 1 },
    });
  });

  it('补行不齐（并行双工具仅一个返回）→ 部分行不进轨迹回放（悬空 tool_calls 防线保留）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'none', settings: { session: { replayTrajectory: true } } });
    ctx.emit('router/message-received', 'a', { role: 'user', content: '并行查' }, 'a~user', 'user', 'user');
    ctx.emit('loop/run-started', { agent: 'a', conversationId: 'a~user', sender: 'user', source: 'user' } as never);
    ctx.emit('loop/after-step', 'a', {
      index: 0, text: '', reasoning: '',
      toolCalls: [
        { id: 'call-x', name: 'read', arguments: '{}' },
        { id: 'call-y', name: 'read', arguments: '{}' },
      ],
      toolResults: [],
    } as never, { conversationId: 'a~user', sender: 'user', source: 'user' });
    // 仅 call-x 返回（call-y 执行中进程死亡）
    ctx.emit('tool/after-execute', { name: 'read', agentId: 'a', conversationId: 'a~user', toolCallId: 'call-x' }, { ok: true, output: 'x' }, undefined);
    await new Promise((r) => setTimeout(r, 10));

    const mid = await ctx.session.records('a~user');
    const tcs = mid[1]!.steps![0]!.toolCalls!;
    expect(tcs[0]!.result).toEqual({ ok: true, output: 'x' }); // UI 可见已回结果
    expect(tcs[1]!.result).toBeNull(); // 未回仍是 null
    // 轨迹回放跳过（结果不齐 → 悬空 tool_calls 会破坏 provider 消息序）
    const replay = await ctx.session.history('a~user', { viewer: 'a' });
    expect(replay).toEqual([{ role: 'user', content: '并行查', name: 'user' }]);
  });

  it('无活跃 run 的 after-execute（宿主直调/收束后迟到）不落补行', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'none' });
    ctx.emit('tool/after-execute', { name: 'read', agentId: 'a', conversationId: 'a~user', toolCallId: 'c-late' }, { ok: true, output: 'late' }, undefined);
    ctx.emit('tool/after-execute', { name: 'read', conversationId: 'a~user', toolCallId: 'c-late' }, { ok: true, output: 'late' }, undefined);
    await new Promise((r) => setTimeout(r, 10));
    const file = path.join(root, 'sessions', 'a~user', 'messages.jsonl');
    expect(fs.existsSync(file)).toBe(false); // 连会话文件都未建
  });

  it('run_code 子调用补行带 subcall 标记 + name/arguments（方向 B：前端复原完整卡片）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'none' });
    // 活跃 run + 两个补记：模型直调（无标记）与 run_code 子调用（带标记 + 参数）
    ctx.emit('router/message-received', 'a', { role: 'user', content: '跑' }, 'a~user', 'user', 'user');
    ctx.emit('loop/run-started', { agent: 'a', conversationId: 'a~user', sender: 'user', source: 'user' } as never);
    ctx.emit('tool/after-execute', { name: 'read', agentId: 'a', conversationId: 'a~user', toolCallId: 'call-1' }, { ok: true, output: 'x' }, undefined);
    ctx.emit('tool/after-execute', { name: 'edit', agentId: 'a', conversationId: 'a~user', toolCallId: 'call-0#1', runCodeSubcall: true, args: { file_path: 'a.ts', old_string: 'x', new_string: 'y' } }, { ok: true, output: { path: 'a.ts', diff_added: 1, diff_removed: 1 } }, undefined);
    await new Promise((r) => setTimeout(r, 10));
    // 三文件（2026-09-20 partials 摘除）：subcall 补行落 subcalls.jsonl；直调补行落 partials.jsonl
    const file = path.join(root, 'sessions', 'a~user', 'messages.jsonl');
    const raw = fs.readFileSync(file, 'utf-8');
    const partRaw = fs.readFileSync(path.join(root, 'sessions', 'a~user', 'partials.jsonl'), 'utf-8');
    const subFile = path.join(root, 'sessions', 'a~user', 'subcalls.jsonl');
    const subRaw = fs.readFileSync(subFile, 'utf-8');
    const subcallLines = subRaw.split('\n').filter((l) => l.includes('"tool_call_id":"call-0#1"'));
    const directLines = partRaw.split('\n').filter((l) => l.includes('"tool_call_id":"call-1"'));
    expect(raw).not.toContain('call-0#1'); // 主文件无 subcall 行（直调补行也在 partials）
    expect(subcallLines.length).toBe(1);
    const sub = JSON.parse(subcallLines[0]);
    expect(sub.subcall).toBe(true);
    expect(sub.name).toBe('edit'); // 工具名随行（复原卡片）
    expect(sub.arguments).toBe(JSON.stringify({ file_path: 'a.ts', old_string: 'x', new_string: 'y' })); // 参数随行
    expect(directLines.length).toBe(1);
    expect(directLines[0]).not.toContain('"subcall"'); // 模型直调不带标记（参数已在 steps）
  });

  it('records({subcalls:true}) 投影：run_code 子调用平铺进宿主步 toolCalls（方向 B：历史复原 + diff 追踪）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'none' });
    ctx.emit('router/message-received', 'a', { role: 'user', content: '跑' }, 'a~user', 'user', 'user');
    ctx.emit('loop/run-started', { agent: 'a', conversationId: 'a~user', sender: 'user', source: 'user' } as never);
    // 宿主 run_code 部分行（步级落盘：toolCalls[{id:'call-0', name:'run_code', result:null}]）+ 两个子调用补行
    ctx.emit('loop/after-step', 'a', {
      text: '', reasoning: '',
      toolCalls: [{ id: 'call-0', name: 'run_code', arguments: { code: 'return 1;' }, result: null }],
    } as never, { conversationId: 'a~user', sender: 'user', source: 'user' } as never);
    ctx.emit('tool/after-execute', { name: 'edit', agentId: 'a', conversationId: 'a~user', toolCallId: 'call-0#1', runCodeSubcall: true, args: { file_path: 'a.ts' } }, { ok: true, output: { diff_added: 1 } }, undefined);
    ctx.emit('tool/after-execute', { name: 'read', agentId: 'a', conversationId: 'a~user', toolCallId: 'call-0#2', runCodeSubcall: true, args: { file_path: 'a.ts' } }, { ok: true, output: {} }, undefined);
    await new Promise((r) => setTimeout(r, 30));
    // 投影开：子调用注入宿主步（run_code 调用之后，按 seq 序）
    const withSubs = await ctx.session.records('a~user', { subcalls: true });
    const partialWithSubs = withSubs.find((r: any) => r.partial === true && r.run !== undefined);
    const tcs = (partialWithSubs?.steps?.[0] as any)?.toolCalls ?? [];
    expect(tcs.map((t: any) => t.id)).toEqual(['call-0', 'call-0#1', 'call-0#2']);
    expect(tcs[1]).toMatchObject({ name: 'edit', subcall: true, arguments: JSON.stringify({ file_path: 'a.ts' }) });
    expect(tcs[2]).toMatchObject({ name: 'read', subcall: true });
    // 投影关（默认）：纯净形——宿主步只有模型直调（LLM 回放面不受污染）
    const pure = await ctx.session.records('a~user');
    const partialPure = pure.find((r: any) => r.partial === true && r.run !== undefined);
    expect(((partialPure?.steps?.[0] as any)?.toolCalls ?? []).map((t: any) => t.id)).toEqual(['call-0']);
  });

  it('steer 入账双态（2026-09-02 反馈：机制通知忙时注入不丢事件语义）：source=event → 事件行；普通注入 → 说话人 agent 行', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 会话忙时机制通知走 steer 通道注入（后台任务完成唤醒等）——与
    // message-received 空闲路径同形：role:'event' + source:'event'
    ctx.emit(
      'conversation/steered',
      'a',
      { role: 'user', content: '[系统通知] 后台任务 bash-1（bash）完成：exit code: 0。' },
      'a~user',
      'a~user~a',
      'a',
      'event',
    );
    // 普通注入（busy 时用户/Agent 的消息）：说话人 agent 行
    ctx.emit(
      'conversation/steered',
      'a',
      { role: 'user', content: '忙时的追加指令' },
      'a~user',
      'a~user~a',
      'user',
      'user',
    );
    const records = await ctx.session.records('a~user');
    expect(records).toHaveLength(2);
    expect(records[0]).toMatchObject({
      role: 'context', source: 'event', agent_id: 'a',
      content: '[系统通知] 后台任务 bash-1（bash）完成：exit code: 0。',
    });
    expect(records[1]).toMatchObject({ role: 'agent', agent_id: 'user', content: '忙时的追加指令' });
    // 事件行 LLM 回放按 user 语义位（§2.4）
    const log = await ctx.session.history('a~user', { viewer: 'a' });
    expect(log[0]).toMatchObject({ role: 'user', name: 'a' });
    // hint 视点过滤（2026-09-02）：event 行只喂给目标读者——共享对桶里
    // 发给 a 的 hint 不进对端 b 的回放上下文；agent 行照常按视点投影
    const byPeer = await ctx.session.history('a~user', { viewer: 'b' });
    expect(byPeer.some((m) => m.content?.includes('[系统通知]'))).toBe(false);
    expect(byPeer.some((m) => m.content === '忙时的追加指令')).toBe(true);
  });

  it('入站消息即时落盘（2026-09-18 send_agent 静默丢失）：投递后无任何后续 run/读访问，文件上消息行已存在', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'none' });
    // 复现现场：Agent 经 send_agent 投递虚拟端点 user——目标桶此后无 run、
    // 无 reply-completed、无工具 checkpoint，此前 pending 滞留内存直到
    // 用户读访问/优雅退出才落盘（UI 读文件不可见、非优雅退出即丢）
    ctx.emit('router/message-received', 'user', { role: 'user', content: '给用户的私信' }, 'a~user', 'a', 'agent');
    // 不做任何读访问（records/history 才会 flush）——只等 fire-and-forget 排空
    await new Promise((r) => setTimeout(r, 20));
    const file = path.join(root, 'sessions', 'a~user', 'messages.jsonl');
    expect(fs.existsSync(file)).toBe(true);
    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).toContain('给用户的私信');
    expect(raw).toContain('"agent_id":"a"');
    // steer 通道同语义（忙时注入路径）：注入行同样即时 durable
    ctx.emit('conversation/steered', 'user', { role: 'user', content: '忙时注入的私信' }, 'a~user', 'a~user~user', 'a', 'agent');
    await new Promise((r) => setTimeout(r, 20));
    const raw2 = fs.readFileSync(file, 'utf-8');
    expect(raw2).toContain('忙时注入的私信');
  });

  it('入站事件行即时落盘（source=event：机制通知同样不等后续 run）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'none' });
    ctx.emit('router/message-received', 'a', { role: 'user', content: '[系统通知] 任务完成' }, 'a~a', 'a', 'event');
    await new Promise((r) => setTimeout(r, 20));
    const file = path.join(root, 'sessions', 'a~a', 'messages.jsonl');
    expect(fs.existsSync(file)).toBe(true);
    const raw = fs.readFileSync(file, 'utf-8');
    expect(raw).toContain('"role":"context"');
    expect(raw).toContain('"source":"event"');
    expect(raw).toContain('[系统通知] 任务完成');
  });
});
