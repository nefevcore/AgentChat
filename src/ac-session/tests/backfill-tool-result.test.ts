import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import { Context } from '@agentchat/cordis';
import * as sessionRow from 'ac-session';

/** 重启后作答对账（2026-09-15 会话丢失事故）：late-reply 场景的补记口 */

function tmpRoot(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'ac-session-backfill-'));
}

async function boot(root: string) {
  const ctx = new Context();
  const fiber = ctx.plugin(sessionRow, { root });
  await fiber;
  for (let i = 0; i < 1000; i++) {
    if ((ctx as unknown as Record<string, unknown>).session) break;
    await new Promise((r) => setTimeout(r, 1));
  }
  return { ctx, fiber };
}

/** 落一条「run 死亡残留」形态的部分行到会话文件（重启后读侧视角） */
function writeDeadPartial(root: string, conv: string, run: string, toolCallId: string, content: string): void {
  const file = path.join(root, 'sessions', conv, 'messages.jsonl');
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const lines = [
    JSON.stringify({ type: 'session-header', version: 1, createdAt: new Date(0).toISOString() }),
    JSON.stringify({
      role: 'agent', content: '帮我决定', agent_id: 'user',
      message_id: 'm1', timestamp: new Date(0).toISOString(), seq: 1,
    }),
    JSON.stringify({
      role: 'agent', content, agent_id: 'a',
      message_id: 'm2', timestamp: new Date(1).toISOString(), seq: 2,
      reasoning_content: '先问用户', run, partial: true,
      steps: [{
        content, reasoning: '先问用户', ts: 1,
        toolCalls: [{ id: toolCallId, name: 'ask_questions', arguments: '{"questions":[…]}', result: null }],
      }],
    }),
  ];
  fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf-8');
}

describe('ac-session backfillToolResult（重启后作答对账——2026-09-15 上下文丢失事故修复）', () => {
  it('run 死亡残留部分行：补记后 history() 展开完整轨迹（正文 + 悬空 tool_calls 获结果）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    writeDeadPartial(root, 'a~user', 'run-r1', 'call-42', '完整分析正文（事故现场：重启后丢失的 2471 字）');
    // 修复前：history() 的 stepsComplete 门把整段轨迹拦在回放外（上下文丢失）
    const before = await ctx.session.history('a~user', { viewer: 'a' });
    expect(before).toEqual([{ role: 'user', content: '帮我决定', name: 'user' }]);

    // late-reply 补记：答案以 tool-result 补行落盘（result 与 ask_questions 工具
    // 正常返回同形——answers/interaction_id），读侧覆盖部分行 result:null
    const ok = await ctx.session.backfillToolResult('a~user', 'call-42', {
      ok: true,
      output: { answers: ['全部做'], interaction_id: 'dur-1' },
    });
    expect(ok).toBe(true);

    const after = await ctx.session.history('a~user', { viewer: 'a' });
    // 事故语义的恢复：完整分析正文（2471 字）+ 提问调用 + 答案结果全部可见
    expect(after).toEqual([
      { role: 'user', content: '帮我决定', name: 'user' },
      { role: 'assistant', content: '完整分析正文（事故现场：重启后丢失的 2471 字）', tool_calls: [{ id: 'call-42', type: 'function', function: { name: 'ask_questions', arguments: '{"questions":[…]}' } }] },
      { role: 'tool', tool_call_id: 'call-42', content: JSON.stringify({ ok: true, output: { answers: ['全部做'], interaction_id: 'dur-1' } }) },
    ]);
  });

  it('幂等：同一 toolCallId 重复补记 → 第二次返回 false，回放形状不变（无重复补行）', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    writeDeadPartial(root, 'a~user', 'run-r1', 'call-42', '正文');
    expect(await ctx.session.backfillToolResult('a~user', 'call-42', { ok: true, output: { answers: ['A'] } })).toBe(true);
    const once = await ctx.session.history('a~user', { viewer: 'a' });
    expect(await ctx.session.backfillToolResult('a~user', 'call-42', { ok: true, output: { answers: ['A'] } })).toBe(false);
    expect(await ctx.session.history('a~user', { viewer: 'a' })).toEqual(once);
    // 物理补行也只有一条
    const text = fs.readFileSync(path.join(root, 'sessions', 'a~user', 'messages.jsonl'), 'utf-8');
    expect(text.split('\n').filter((l) => l.includes('"type":"tool-result"')).length).toBe(1);
  });

  it('无落点（toolCallId 无未收束部分行匹配）→ 返回 false 不落行；部分行含 null 结果跳过不补', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    writeDeadPartial(root, 'a~user', 'run-r1', 'call-42', '正文');
    expect(await ctx.session.backfillToolResult('a~user', 'call-none', { ok: true, output: {} })).toBe(false);
    // 部分行里该调用已带非 null 结果（收束/已补记形态）→ 不再补
    const file = path.join(root, 'sessions', 'a~user', 'messages.jsonl');
    const lines = fs.readFileSync(file, 'utf-8').split('\n').filter(Boolean);
    const partial = JSON.parse(lines[2]!) as { steps: Array<{ toolCalls: Array<{ id: string; result: unknown }> }> };
    partial.steps[0]!.toolCalls[0]!.result = { ok: true, output: { answers: ['B'] } };
    lines[2] = JSON.stringify(partial);
    fs.writeFileSync(file, `${lines.join('\n')}\n`, 'utf-8');
    expect(await ctx.session.backfillToolResult('a~user', 'call-42', { ok: true, output: {} })).toBe(false);
  });

  it('无补行门控不放宽：仍是 result:null 的部分行（工具执行中进程死亡、无作答）→ 回放继续跳过', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    writeDeadPartial(root, 'a~user', 'run-r1', 'call-42', '正文');
    const before = await ctx.session.history('a~user', { viewer: 'a' });
    ctx.session.backfillToolResult('a~user', 'call-none', { ok: true, output: {} });
    expect(await ctx.session.history('a~user', { viewer: 'a' })).toEqual(before);
  });

  it('多工具步残留：同 run 多条部分行、目标调用在末条——补记后整 run 按步序展开', async () => {
    const root = tmpRoot();
    const { ctx } = await boot(root);
    const file = path.join(root, 'sessions', 'a~user', 'messages.jsonl');
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, [
      JSON.stringify({ type: 'session-header', version: 1, createdAt: new Date(0).toISOString() }),
      JSON.stringify({ role: 'agent', content: '分析下', agent_id: 'user', message_id: 'm1', timestamp: new Date(0).toISOString(), seq: 1 }),
      JSON.stringify({
        role: 'agent', content: '', agent_id: 'a', message_id: 'm2', timestamp: new Date(1).toISOString(), seq: 2,
        run: 'run-r1', partial: true,
        steps: [{ content: '', reasoning: '先搜', ts: 1, toolCalls: [
          { id: 'c1', name: 'grep', arguments: '{}', result: { ok: true, output: 'hits' } },
        ] }],
      }),
      JSON.stringify({
        role: 'agent', content: '分析完毕，待确认', agent_id: 'a', message_id: 'm3', timestamp: new Date(2).toISOString(), seq: 3,
        run: 'run-r1', partial: true,
        steps: [{ content: '分析完毕，待确认', reasoning: '问一下', ts: 2, toolCalls: [
          { id: 'c2', name: 'ask_questions', arguments: '{"questions":[…]}', result: null },
        ] }],
      }),
    ].join('\n') + '\n', 'utf-8');
    const before = await ctx.session.history('a~user', { viewer: 'a' });
    // stepsComplete 逐行判：c1 行结果齐全本就回放，被拦的只有 c2 悬空行
    expect(before).toEqual([
      { role: 'user', content: '分析下', name: 'user' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ ok: true, output: 'hits' }) },
    ]);

    expect(await ctx.session.backfillToolResult('a~user', 'c2', { ok: true, output: { answers: ['全部做'] } })).toBe(true);
    expect(await ctx.session.history('a~user', { viewer: 'a' })).toEqual([
      { role: 'user', content: '分析下', name: 'user' },
      { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'grep', arguments: '{}' } }] },
      { role: 'tool', tool_call_id: 'c1', content: JSON.stringify({ ok: true, output: 'hits' }) },
      { role: 'assistant', content: '分析完毕，待确认', tool_calls: [{ id: 'c2', type: 'function', function: { name: 'ask_questions', arguments: '{"questions":[…]}' } }] },
      { role: 'tool', tool_call_id: 'c2', content: JSON.stringify({ ok: true, output: { answers: ['全部做'] } }) },
    ]);
  });
});
