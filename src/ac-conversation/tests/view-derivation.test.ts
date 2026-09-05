// ============================================================
// ac-conversation 视图派生化（M21 步骤 2 / D2+D3+D7+F1）：
// 视图 = 文件事件的按读者投影缓存——进程内 ≡ history(conv,{viewer})
// 重派生（字节级 golden）；重启/直答路径重播种（F1）；a⇄b 双视图同步；
// 归档 stale-惰性重派生（D7）。
// ============================================================
import { describe, it, expect, afterEach } from 'vitest';
import * as fs from 'node:fs';
import { Context, type Fiber } from '@agentchat/cordis';
import type { LlmChatInput, LlmStreamChunk } from 'ac-llm';
import * as agentsRow from 'ac-agents';
import * as llmRow from 'ac-llm';
import * as loopRow from 'ac-agent-loop';
import * as routerRow from 'ac-router';
import * as sessionRow from 'ac-session';
import * as toolsRow from 'ac-tools';
import * as conversationRow from '../src/index';

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

const tmps: string[] = [];
function tmpRoot(): string {
  // conversation/session 双行 root 一致（fs 真目录，os 模板）
  const dir = `${import.meta.dirname}/.tmp-view-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
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
      },
    },
    loopRow,
    agentsRow,
    routerRow,
    sessionRow,
    conversationRow,
  ];
  for (const row of rows) {
    const fiber = ctx.plugin(row as any, sessionRow === (row as any) ? { root } : undefined);
    await fiber;
    fibers.push(fiber);
  }
  for (let i = 0; i < 1000; i++) {
    if ((ctx as any).tools && (ctx as any).llm && (ctx as any).agentLoop &&
        (ctx as any).agents && (ctx as any).router && (ctx as any).session && (ctx as any).conversation) break;
    await sleep(1);
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
  for (const dir of tmps.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

describe('视图派生化（M21 步骤 2）', () => {
  it('golden 字节等价：进程内视图 ≡ history(conv,{viewer}) 重派生（多轮 + a⇄b 双向）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 字节等价不变量在**对话级路径**上锁定（replayTrajectory=off 读者：
    // 增量视图只投最终文本）；轨迹展开（2026-10 起缺省开）读者的等价性
    // 由下方"轨迹回放开"用例单独锁定（2026-09-05 修复：视图对 replay 开
    // 的读者按步展开，两态均与 history(conv,{viewer}) 字节一致）。
    ctx.agents.register({ id: 'a', model: 'mock-1', settings: { session: { replayTrajectory: false } } });
    ctx.agents.register({ id: 'b', model: 'mock-1', settings: { session: { replayTrajectory: false } } });
    // a⇄b 双向：a 发起→b 回复；b 发起→a 回复（同一共享桶）
    await ctx.conversation.deliver('b', 'a 的发起', { sender: 'a', source: 'agent', conversationId: 'a~b' });
    await ctx.conversation.deliver('a', 'b 的发起', { sender: 'b', source: 'agent', conversationId: 'a~b' });
    // b 视角探测 run：信封 history = b 视图快照（本条之前）
    await ctx.conversation.deliver('b', 'b 的探测', { sender: 'b', source: 'agent', conversationId: 'a~b' });
    const probeInput = captured.at(-1)!;
    expect(probeInput.messages.at(-1)).toMatchObject({ content: 'b 的探测' });
    // 字节级对拍：探测 run 的 history 快照 ≡ history(conv,{viewer:'b'})
    // 去掉探测入站/回复两行后的重派生
    const replay = await ctx.session.history('a~b', { viewer: 'b' });
    const expected = replay.slice(0, -2); // 末两行 = 探测入站 + 探测回复
    expect(JSON.stringify(probeInput.messages.slice(0, -1))).toBe(JSON.stringify(expected));
    // a 视角对称（视图双向同步——旧实现 b 视图缺 b 发起的半段，§8.2-B）
    await ctx.conversation.deliver('a', 'a 的探测', { sender: 'a', source: 'agent', conversationId: 'a~b' });
    const replayA = await ctx.session.history('a~b', { viewer: 'a' });
    expect(JSON.stringify(captured.at(-1)!.messages.slice(0, -1))).toBe(
      JSON.stringify(replayA.slice(0, -2)),
    );
  });

  it('轨迹回放开（缺省）：进程内视图含自有回复的工具轨迹 ≡ history() 字节等价（2026-09-05 singles 多轮失智修复）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    // 一个带工具步的 scripted provider：首次调用走工具，其后回文本
    let calls = 0;
    ctx.llm.register('mock-traj', () => ({
      stream: async function* (input: LlmChatInput): AsyncIterable<LlmStreamChunk> {
        captured.push(input);
        calls += 1;
        if (calls === 1) {
          yield { delta: '', toolCalls: [{ index: 0, id: 'tc1', name: 'hello' }] };
          yield { delta: '', toolCalls: [{ index: 0, argumentsDelta: '{"message":"探"}' }] };
          yield { delta: '', finish: 'tool_calls' };
        } else {
          yield { delta: `轨迹回复${calls}` };
          yield { delta: '', finish: 'stop', usage: { prompt: 1, completion: 1 } };
        }
      },
    }), { models: ['traj-1'] });
    ctx.tools.register({
      name: 'hello',
      description: '测试工具',
      parameters: { type: 'object', properties: { message: { type: 'string' } } },
      async execute() {
        return { ok: true, output: '轨迹工具结果' };
      },
    });
    // replayTrajectory 缺省开（2026-10 质量优先翻转）——不设 settings
    ctx.agents.register({ id: 'a', model: 'traj-1' });
    await ctx.conversation.deliver('a', '带工具的问题');
    // 第二轮：信封应携带第一轮的完整轨迹（assistant tool_calls + tool 结果行 + 终稿）
    await ctx.conversation.deliver('a', '第二轮问题');
    const msgs = captured.at(-1)!.messages;
    const toolRow = msgs.find((m) => m.role === 'tool');
    expect(toolRow).toMatchObject({ tool_call_id: 'tc1' });
    expect(String(toolRow!.content)).toContain('轨迹工具结果');
    const asstWithCalls = msgs.find((m) => m.role === 'assistant' && (m as { tool_calls?: unknown[] }).tool_calls);
    expect(asstWithCalls).toBeDefined();
    // 字节等价：进程内视图（去掉本轮入站）≡ history() 文件重派生（去掉本轮入站/回复）
    const replay = await ctx.session.history('a~user', { viewer: 'a' });
    const expected = replay.slice(0, -2);
    expect(JSON.stringify(msgs.slice(0, -1))).toBe(JSON.stringify(expected));
  });

  it('F1：直答路径无显式种子——重启（服务重建）后首跑上下文连续', async () => {
    const root = tmpRoot();
    const { ctx, fibers } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    // web 路径：deliver 不传 history（旧实现重启后首跑 LLM 上下文为空）
    await ctx.conversation.deliver('a', '第一句');
    await ctx.conversation.deliver('a', '第二句');
    expect(captured.at(-1)!.messages.map((m) => m.content)).toEqual(['第一句', '回复1', '第二句']);

    // 重启模拟：卸载 conversation 行 → 同 ctx 重新挂载（session 文件仍在）
    const convFiber = fibers.at(-1)!;
    await convFiber.dispose();
    const reFiber = ctx.plugin(conversationRow as any);
    await reFiber;
    for (let i = 0; i < 1000; i++) {
      if ((ctx as any).conversation) break;
      await sleep(1);
    }
    fibers.push(reFiber);
    await ctx.conversation.deliver('a', '重启后的问题');
    expect(captured.at(-1)!.messages.map((m) => m.content)).toEqual([
      '第一句', '回复1', '第二句', '回复2', '重启后的问题',
    ]);
  });

  it('D7：archive/completed → stale → 下次 startRun 从文件重派生（视图收缩）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'mock-1' });
    await ctx.conversation.deliver('a', '旧消息一');
    await ctx.conversation.deliver('a', '旧消息二');
    // 归档重建模拟：compact 清流留概要（ac-archive 漏斗的落盘面）+ 完成事件
    await ctx.session.compact('a~user', { summary: '此前讨论了归档。', keep: [] });
    ctx.emit('archive/completed', { conversationId: 'a~user', agentId: 'a', archived: 4, kept: 0 });
    // 下一轮：stale 视图重派生——概要头 + 新消息（旧消息不再进上下文）
    await ctx.conversation.deliver('a', '归档后的问题');
    const msgs = captured.at(-1)!.messages;
    expect(msgs[0]).toMatchObject({ role: 'system', content: '此前讨论了归档。' });
    expect(msgs.map((m) => m.content)).not.toContain('旧消息一');
    expect(msgs.at(-1)).toMatchObject({ content: '归档后的问题' });
  });

  it('错误收束投影：error 行按 user 语义位进视图（§2.4），随后续 run 喂回', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    ctx.agents.register({ id: 'a', model: 'no-such-model' }); // 触发 run 错误收束
    await ctx.conversation.deliver('a', '会出错的问题').catch(() => undefined);
    ctx.agents.register({ id: 'a2', model: 'mock-1' });
    // 换回可用模型继续同桶：错误行以 user 位在历史里
    ctx.agents.reassign({ id: 'a', model: 'mock-1' });
    await ctx.conversation.deliver('a', '恢复后的问题');
    const msgs = captured.at(-1)!.messages;
    const errorRow = msgs.find((m) => String(m.content).includes('model'));
    expect(errorRow).toBeDefined();
    expect(errorRow!.role).toBe('user');
  });
});
