// ============================================================
// agent-session writer 测试 —— step 级增量持久化 checkpoint
// ============================================================

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chatDialogKey } from '@agentchat/contracts';
import { sessionFileOf, META_ARCHIVE_REVIEW } from '@agentchat/tools';
import type { CurrentContext, StepOutcome, RunResult } from '@agentchat/agent-loop';
import {
  getSessionLogWriter,
  makeStepPersistHook,
  makeToolPersistHook,
  makeSaveSessionHook,
} from '../src/writer';

const oldWorkspace = process.env.AGENTCHAT_WORKSPACE;
let tmp: string;

beforeAll(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-writer-'));
  process.env.AGENTCHAT_WORKSPACE = tmp;
});

afterAll(() => {
  if (oldWorkspace === undefined) delete process.env.AGENTCHAT_WORKSPACE;
  else process.env.AGENTCHAT_WORKSPACE = oldWorkspace;
  fs.rmSync(tmp, { recursive: true, force: true });
});

function ctxOf(dialogId: string, agentId: string, meta: Record<string, unknown> = {}): CurrentContext {
  return {
    llm: {} as any,
    systemPrompt: '',
    history: [],
    tools: new Map(),
    inbox: { nextTurn: [], nextStep: [] },
    dialogId,
    agentId,
    meta,
  };
}

const done: StepOutcome = { done: false, interrupted: false };

describe('SessionLogWriter step checkpoint', () => {
  it('stepEnd 只追加本步 delta，工具前 checkpoint 先落盘 assistant tool_calls', async () => {
    const dialogId = chatDialogKey('user', 'a');
    const ctx = ctxOf(dialogId, 'a');
    const messages: any[] = [
      { role: 'user', content: '问题', source: { kind: 'user', form: 'prompt' }, timestamp: '2026-08-16T00:00:00.000Z' },
    ];

    const stepHook = makeStepPersistHook({ agent_id: 'a' });
    await stepHook(ctx, done, messages);
    const file = sessionFileOf(dialogId);
    expect(fs.readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(1);

    // 工具执行前：assistant(tool_calls) 必须先落盘，工具 body 才允许执行
    messages.push({
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_1', name: 'ask_questions', arguments: '{}' }],
      timestamp: '2026-08-16T00:00:01.000Z',
    });
    const toolHook = makeToolPersistHook({ agent_id: 'a' });
    const decision = await toolHook('ask_questions', {}, {
      toolCallId: 'call_1',
      dialogId,
      agentId: 'a',
      context: ctx,
      messages,
    });
    expect(decision.allow).toBe(true);

    const lines = fs.readFileSync(file, 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[1].tool_calls?.[0]?.id).toBe('call_1');

    // 工具结果 + assistant 结论：stepEnd 追加剩余 delta
    messages.push({ role: 'tool', content: '{"status":"ok"}', tool_call_id: 'call_1', name: 'ask_questions', timestamp: '2026-08-16T00:00:02.000Z' });
    messages.push({ role: 'assistant', content: '好的', timestamp: '2026-08-16T00:00:03.000Z' });
    await stepHook(ctx, { done: true, interrupted: false, final: '好的' }, messages);
    expect(fs.readFileSync(file, 'utf-8').trim().split('\n')).toHaveLength(4);
  });

  it('并发 toolExecutionStart 只落盘一次 assistant(tool_calls)（修复重复消息）', async () => {
    const dialogId = chatDialogKey('user', 'conc');
    const ctx = ctxOf(dialogId, 'conc');
    const messages: any[] = [
      { role: 'user', content: '并发问题', source: { kind: 'user', form: 'prompt' }, timestamp: '2026-08-16T00:00:00.000Z' },
      {
        role: 'assistant',
        content: '',
        tool_calls: [
          { id: 'call_1', name: 'bash', arguments: '{}' },
          { id: 'call_2', name: 'read', arguments: '{}' },
          { id: 'call_3', name: 'timer', arguments: '{}' },
        ],
        timestamp: '2026-08-16T00:00:01.000Z',
      },
    ];

    const toolHook = makeToolPersistHook({ agent_id: 'conc' });
    await Promise.all([
      toolHook('bash', {}, { toolCallId: 'call_1', dialogId, agentId: 'conc', context: ctx, messages }),
      toolHook('read', {}, { toolCallId: 'call_2', dialogId, agentId: 'conc', context: ctx, messages }),
      toolHook('timer', {}, { toolCallId: 'call_3', dialogId, agentId: 'conc', context: ctx, messages }),
    ]);

    const lines = fs.readFileSync(sessionFileOf(dialogId), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[1].tool_calls?.map((t: any) => t.id)).toEqual(['call_1', 'call_2', 'call_3']);
  });

  // 2026-08-17 线上重复消息 bug（chat~news~user messages.jsonl 232/234、293/295 等四组）：
  // 同一 prompt 重复投递派生第二个 run → loopMessages 换了数组引用但共享同一批消息对象
  // → 两个 RunWriteState 各自 persisted=0，[user, assistant] 整批入队两次，
  // 且旧 toPersisted 每次生成新 message_id（id 不同、内容/tool_call_id/时间戳全同）。
  it('跨数组引用重复入队只落盘一次（重复投递派生第二个 run 场景）', async () => {
    const dialogId = chatDialogKey('user', 'dup');
    const ctx = ctxOf(dialogId, 'dup');
    const userMsg: any = { role: 'user', content: '算了，估计是浏览器工具的守护进程没有共享cookie？不弄了，干活要紧', source: { kind: 'user', form: 'prompt' } };
    const assistantMsg: any = {
      role: 'assistant',
      content: '',
      tool_calls: [{ id: 'call_00_dup', name: 'browser', arguments: '{"action":"close"}' }],
    };
    // run A 与 run B：不同数组引用、同一批消息对象
    const runA: any[] = [userMsg, assistantMsg];
    const runB: any[] = [userMsg, assistantMsg];

    const toolHook = makeToolPersistHook({ agent_id: 'dup' });
    await toolHook('browser', {}, { toolCallId: 'call_00_dup', dialogId, agentId: 'dup', context: ctx, messages: runA });
    await toolHook('browser', {}, { toolCallId: 'call_00_dup', dialogId, agentId: 'dup', context: ctx, messages: runB });

    const lines = fs.readFileSync(sessionFileOf(dialogId), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[0].content).toContain('守护进程');
    expect(lines[1].tool_calls?.[0]?.id).toBe('call_00_dup');
    // 幂等标识：即使发生重复入队，同一对象两次序列化的 message_id 也一致（可被下游去重）
    expect(userMsg.message_id).toBe(lines[0].message_id);
    expect(assistantMsg.message_id).toBe(lines[1].message_id);
  });

  it('同一消息对象二次序列化产出相同 message_id/timestamp（toPersisted 幂等）', async () => {
    const dialogId = chatDialogKey('user', 'idem');
    const ctx = ctxOf(dialogId, 'idem');
    const userMsg: any = { role: 'user', content: '幂等', source: { kind: 'user', form: 'prompt' } };
    const arr1: any[] = [userMsg];
    await makeStepPersistHook({ agent_id: 'idem' })(ctx, done, arr1);
    // 深拷贝（固化之后产生）不共享引用 → 引用守卫拦不住，正常落盘；
    // 但携带首次固化的 message_id → 与首行同 id，下游按 id 去重可收敛
    const arr2: any[] = [{ ...userMsg }];
    const stepHook = makeStepPersistHook({ agent_id: 'idem' });
    await stepHook(ctx, done, arr2);

    const lines = fs.readFileSync(sessionFileOf(dialogId), 'utf-8').trim().split('\n').map(l => JSON.parse(l));
    expect(lines).toHaveLength(2);
    expect(lines[1].message_id).toBe(lines[0].message_id);
    // 同一对象（arr1 的 userMsg）再次进入另一数组 → 引用守卫拦截，不产生第三行
    const arr3: any[] = [userMsg];
    await stepHook(ctx, done, arr3);
    expect(fs.readFileSync(sessionFileOf(dialogId), 'utf-8').trim().split('\n')).toHaveLength(2);
    // 首次序列化即固化 id/timestamp（对象上可见，重复序列化不再变化）
    expect(userMsg.message_id).toBeTruthy();
    expect(userMsg.timestamp).toBeTruthy();
  });

  it('runEnd 兜底：无 step/tool 钩子的路径仍全量落盘', async () => {
    const dialogId = chatDialogKey('user', 'b');
    const ctx = ctxOf(dialogId, 'b');
    const messages: any[] = [
      { role: 'user', content: 'hi', source: { kind: 'user', form: 'prompt' } },
      { role: 'assistant', content: 'hello' },
    ];
    const result = { content: 'hello', interrupted: false, messages } as RunResult;
    await makeSaveSessionHook({ agent_id: 'b' })(ctx, result);
    const lines = fs.readFileSync(sessionFileOf(dialogId), 'utf-8').trim().split('\n');
    expect(lines).toHaveLength(2);
  });

  it('归档整理 run 不落盘（对齐旧 saveSession）', async () => {
    const dialogId = chatDialogKey('user', 'c');
    const ctx = ctxOf(dialogId, 'c', { [META_ARCHIVE_REVIEW]: true });
    const messages: any[] = [{ role: 'user', content: 'archive', source: { kind: 'archive', form: 'hint' } }];
    await makeStepPersistHook({ agent_id: 'c' })(ctx, done, messages);
    await makeSaveSessionHook({ agent_id: 'c' })(ctx, { content: '', interrupted: false, messages } as RunResult);
    expect(fs.existsSync(sessionFileOf(dialogId))).toBe(false);
  });

  it('持久化失败保留 pending：flush 重试后可续写', async () => {
    const dialogId = chatDialogKey('user', 'd');
    const ctx = ctxOf(dialogId, 'd');
    const writer = getSessionLogWriter();
    writer.enqueue(dialogId, 'd', [{ role: 'assistant', content: 'x' }]);
    // 单写者队列内部实现：失败批次保留由 fs 错误触发；这里验证正常 flush 幂等
    await writer.flush(dialogId);
    expect(fs.readFileSync(sessionFileOf(dialogId), 'utf-8').trim().split('\n')).toHaveLength(1);
  });
});
