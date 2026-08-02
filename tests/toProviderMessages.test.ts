// ============================================================
// toProviderMessages / fromProviderMessages 单元测试
// —— LLM provider 双向消息转换（2026-08-02 重构）
//
// 重构背景：消息转换全部收拢在 LLM provider 内（Agent 层不再拼装 API 消息）。
//   · toProviderMessages：项目消息（持久化/内存格式）→ LLM API 原生消息
//     （含 role='agent' 的视角转换，依据 viewer=当前视角 Agent ID）
//   · fromProviderMessages：LLM API 原生消息 → 项目消息（反向，对称转换）
//
// 核心职责：
//   · role 映射：system/user/assistant/tool → API 角色；trigger → user；error → tool
//   · 视角转换：agent + agent_id===viewer → assistant；agent_id≠viewer → user
//   · 防御过滤：空 assistant / 孤立 tool / 悬空 tool_calls（防 API 400）
//   · 工具序列化 + reasoning_content（仅最后一条 assistant 回传）
// ============================================================

import { describe, it, expect } from 'vitest';
import { OpenAIChatLLM } from '@llm/openai';
import type { Message } from '@core/types';

function makeLLM(): OpenAIChatLLM {
  return new OpenAIChatLLM({ apiKey: 'test', baseURL: 'http://localhost:1', model: 'test-model' });
}

function m(role: Message['role'], content: string, extra: Record<string, unknown> = {}): Message {
  return { role, content, ...extra } as Message;
}

describe('toProviderMessages 消息转换', () => {
  it('trigger → user（正文透传，真实 trigger 由 Agent 以 role 标记）', () => {
    const llm = makeLLM();
    const out = llm.toProviderMessages([
      m('trigger', '<trigger>现在是 2026年8月2日 12:00。</trigger>'),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
    expect(out[0].content).toBe('<trigger>现在是 2026年8月2日 12:00。</trigger>');
  });

  it('system/user/assistant 原样映射', () => {
    const llm = makeLLM();
    const out = llm.toProviderMessages([
      m('system', '你是助手'),
      m('user', '你好'),
      m('assistant', '你好！有什么可以帮你？'),
    ]);
    expect(out.map(x => x.role)).toEqual(['system', 'user', 'assistant']);
  });

  it('tool 消息序列化 name + tool_call_id', () => {
    const llm = makeLLM();
    const out = llm.toProviderMessages([
      m('assistant', '调用工具', { tool_calls: [{ id: 'call_00_abc', name: 'query_history', arguments: {} }] }),
      m('tool', '查询结果', { name: 'query_history', tool_call_id: 'call_00_abc' }),
    ]);
    expect(out).toHaveLength(2);
    expect(out[1]).toMatchObject({ role: 'tool', name: 'query_history', tool_call_id: 'call_00_abc' });
  });

  it('tool_calls 序列化为 OpenAI 格式', () => {
    const llm = makeLLM();
    const out = llm.toProviderMessages([
      m('user', '执行命令'),
      m('assistant', '', { tool_calls: [{ id: 'call_00_abc', name: 'bash', arguments: { cmd: 'ls' } }] }),
      m('tool', '结果', { name: 'bash', tool_call_id: 'call_00_abc' }),
    ]);
    expect(out[1].tool_calls).toEqual([
      { id: 'call_00_abc', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } },
    ]);
  });

  it('空 assistant（无 content/tool_calls/reasoning）被过滤', () => {
    const llm = makeLLM();
    const out = llm.toProviderMessages([
      m('user', '你好'),
      m('assistant', ''),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
  });

  it('孤立 tool（tool_call_id 不匹配）被过滤', () => {
    const llm = makeLLM();
    const out = llm.toProviderMessages([
      m('user', '你好'),
      m('tool', '孤儿结果', { name: 'bash', tool_call_id: 'call_orphan' }),
    ]);
    expect(out).toHaveLength(1);
    expect(out[0].role).toBe('user');
  });

  it('悬空 tool_calls assistant（缺 tool 结果）及其孤儿 tool 被过滤', () => {
    const llm = makeLLM();
    const out = llm.toProviderMessages([
      m('user', '你好'),
      m('assistant', '', { tool_calls: [
        { id: 'call_00_abc', name: 'bash', arguments: {} },
        { id: 'call_01_def', name: 'bash', arguments: {} },
      ] }),
      // 只有一个 tool 结果 → 悬空 assistant 整体移除，孤儿 tool 一并移除
      m('tool', '结果', { name: 'bash', tool_call_id: 'call_00_abc' }),
    ]);
    expect(out.map(x => x.role)).toEqual(['user']);
  });

  it('reasoning_content 仅最后一条 assistant 回传', () => {
    const llm = makeLLM();
    const out = llm.toProviderMessages([
      m('user', '你好'),
      m('assistant', '第一轮', { reasoning_content: '思考1' }),
      m('assistant', '第二轮', { reasoning_content: '思考2' }),
    ]);
    expect(out).toHaveLength(3);
    expect(out[1].reasoning_content).toBeUndefined();
    expect(out[2].reasoning_content).toBe('思考2');
  });

  it('trigger 与 tool 配对场景：trigger 映射为 user，不打断 tool 配对', () => {
    const llm = makeLLM();
    const out = llm.toProviderMessages([
      m('trigger', '<trigger>[记忆审查] 开始审查</trigger>'),
      m('assistant', '开始检索', { tool_calls: [{ id: 'call_00_abc', name: 'query_history', arguments: {} }] }),
      m('tool', '结果', { name: 'query_history', tool_call_id: 'call_00_abc' }),
    ]);
    expect(out.map(x => x.role)).toEqual(['user', 'assistant', 'tool']);
  });

  // ============================================================
  // 持久化格式 + assistant 视角转换（2026-08-02 收窄）
  // ============================================================

  it('持久化 role=agent：自己发的（agent_id===assistant）→ assistant', () => {
    const llm = makeLLM();
    const out = llm.toProviderMessages([
      { role: 'agent', agent_id: 'me', content: '我来处理' },
      { role: 'agent', agent_id: 'me', content: '已完成', tool_calls: [{ id: 'call_00_abc', type: 'function', function: { name: 'bash', arguments: '{}' } }] },
      { role: 'tool', agent_id: 'me', content: 'ok', name: 'bash', tool_call_id: 'call_00_abc' },
    ], 'me');
    expect(out.map(x => x.role)).toEqual(['assistant', 'assistant', 'tool']);
  });

  it('持久化 role=agent：对方发的（agent_id!==assistant）→ user，且丢弃 tool_calls', () => {
    const llm = makeLLM();
    const out = llm.toProviderMessages([
      { role: 'agent', agent_id: 'other', content: '早上好' },
      // 对方的消息带 tool_calls → 视角转为 user 时丢弃（其后续 tool 为孤立，被过滤）
      { role: 'agent', agent_id: 'other', content: '检索一下', tool_calls: [{ id: 'call_00_abc', type: 'function', function: { name: 'query_history', arguments: '{}' } }] },
      { role: 'tool', agent_id: 'other', content: '结果', name: 'query_history', tool_call_id: 'call_00_abc' },
    ], 'me');
    expect(out.map(x => x.role)).toEqual(['user', 'user']);
    expect(out[1].tool_calls).toBeUndefined();
  });

  it('持久化 role=agent：agent_id=user 的人类用户 → user', () => {
    const llm = makeLLM();
    const out = llm.toProviderMessages([
      { role: 'agent', agent_id: 'user', content: '你好' },
    ], 'me');
    expect(out.map(x => x.role)).toEqual(['user']);
  });

  it('持久化格式 tool_calls（LLMToolCall）序列化为 API 格式', () => {
    const llm = makeLLM();
    const out = llm.toProviderMessages([
      { role: 'agent', agent_id: 'me', content: '', tool_calls: [{ id: 'call_00_abc', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }] },
      { role: 'tool', agent_id: 'me', content: 'ok', name: 'bash', tool_call_id: 'call_00_abc' },
    ], 'me');
    expect(out[0].role).toBe('assistant');
    expect(out[0].tool_calls).toEqual([
      { id: 'call_00_abc', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } },
    ]);
  });

  it('无 viewer 时持久化 role=agent 一律视为 user（视角未知安全回退）', () => {
    const llm = makeLLM();
    const out = llm.toProviderMessages([
      { role: 'agent', agent_id: 'me', content: '未传 viewer' },
    ]);
    expect(out.map(x => x.role)).toEqual(['user']);
  });

  // ============================================================
  // fromProviderMessages —— 反向转换（LLM API 消息 → 项目消息）
  // ============================================================

  it('反向转换：OpenAI 格式 tool_calls → 简化 ToolCall（arguments 解析为对象）', () => {
    const llm = makeLLM();
    const out = llm.fromProviderMessages([
      { role: 'assistant', content: '我调用工具', tool_calls: [{ id: 'call_00_abc', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }] },
      { role: 'tool', content: 'ok', name: 'bash', tool_call_id: 'call_00_abc' },
    ]);
    expect(out).toHaveLength(2);
    expect(out[0].role).toBe('assistant');
    expect(out[0].tool_calls).toEqual([{ id: 'call_00_abc', name: 'bash', arguments: { cmd: 'ls' } }]);
    expect(out[1].role).toBe('tool');
    expect(out[1].tool_call_id).toBe('call_00_abc');
  });

  it('反向转换：非法 arguments JSON 安全回退为空对象', () => {
    const llm = makeLLM();
    const out = llm.fromProviderMessages([
      { role: 'assistant', content: 'x', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'bash', arguments: '{bad json' } }] },
    ]);
    expect(out[0].tool_calls).toEqual([{ id: 'c1', name: 'bash', arguments: {} }]);
  });

  it('反向转换：未知角色安全回退为 user；保留 reasoning_content', () => {
    const llm = makeLLM();
    const out = llm.fromProviderMessages([
      { role: 'weird', content: '?', reasoning_content: '思考' },
    ]);
    expect(out[0].role).toBe('user');
    expect(out[0].reasoning_content).toBe('思考');
  });

  it('双向对称：toProviderMessages 输出可被 fromProviderMessages 还原为项目 ToolCall', () => {
    const llm = makeLLM();
    const api = llm.toProviderMessages([
      { role: 'agent', agent_id: 'me', content: '执行', tool_calls: [{ id: 'call_00_abc', type: 'function', function: { name: 'bash', arguments: '{"cmd":"ls"}' } }] },
      { role: 'tool', agent_id: 'me', content: 'ok', name: 'bash', tool_call_id: 'call_00_abc' },
    ], 'me');
    const back = llm.fromProviderMessages(api);
    expect(back.map(x => x.role)).toEqual(['assistant', 'tool']);
    expect(back[0].tool_calls).toEqual([{ id: 'call_00_abc', name: 'bash', arguments: { cmd: 'ls' } }]);
    expect(back[1].tool_call_id).toBe('call_00_abc');
  });
});
