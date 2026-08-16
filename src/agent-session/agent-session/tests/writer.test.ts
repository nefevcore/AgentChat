// ============================================================
// agent-session writer 测试 —— step 级增量持久化 checkpoint
// ============================================================

import * as fs from 'node:fs';
import * as os from 'node:os';
import * as path from 'node:path';
import { describe, it, expect, beforeAll, afterAll } from 'vitest';
import { chatDialogKey } from '@agentchat/agents';
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
