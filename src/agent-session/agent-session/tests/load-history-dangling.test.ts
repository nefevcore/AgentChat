// ============================================================
// loadHistory 回归测试 —— 持久化读取归一化（trigger → user + source）
//
// loadHistory 返回「内存/LLM 格式」（role=agent/user/assistant/tool/error/system），
// 不做视角转换（由 provider 的 toProviderMessages 依据 viewer 解析）。
// 持久化层 role='event' 在读取时归一化为 user + source；
// 旧 role='trigger' 同样归一化为 user + source（legacyRole 诊断标记）。
//
// 回归背景：
//   历史上 query_history 等工具的结果曾以 role='trigger' + tool_call_id
//   的形式落盘。若按事件加载会打断 assistant.tool_calls → tool 配对，
//   触发 OpenAI 过滤警告：
//     ⚠️ 已过滤孤立 tool 消息 …
//     已过滤悬空 tool_calls assistant …
//   因此读取层对 trigger/event + tool_call_id 运行时兜底为 tool。
// ============================================================

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'fs';
import * as os from 'os';
import * as path from 'path';

// ---- Mock @core/config 指向临时会话目录 ----
const mockState = vi.hoisted(() => ({ sessionsDir: '' }));
vi.mock('@core/config', () => ({
  getGlobalConfig: () => ({ sessionsDir: mockState.sessionsDir, workspaceDir: 'C:/tmp' }),
}));

import { loadHistory, toPersistedRole } from '@agentchat/agent-session';
import { sessionFileOf } from '@agentchat/tools';
import { chatSessionFile } from '@agentchat/toolkit';
import { chatDialogKey } from '@agentchat/contracts';

describe('loadHistory 持久化读取归一化（trigger/event → user + source）', () => {
  let tmpDir: string;
  const dialogId = chatDialogKey('test', 'test');

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-ht-'));
    mockState.sessionsDir = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSession(msgs: Record<string, unknown>[]) {
    const filePath = chatSessionFile('test', 'test');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, msgs.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
    return filePath;
  }

  it('历史损坏（trigger+tool_call_id）运行时兜底为 tool，其余持久化发言原样加载', () => {
    const filePath = writeSession([
      {
        role: 'agent',
        agent_id: 'test',
        content: '收到记忆审查 trigger，先并行检索归档内容',
        tool_calls: [
          { id: 'call_00_abc', type: 'function', function: { name: 'query_history', arguments: '{}' } },
          { id: 'call_01_def', type: 'function', function: { name: 'bash', arguments: '{}' } },
        ],
        timestamp: '2026-08-01T22:11:14.747Z',
      },
      {
        role: 'trigger', // 历史异常数据：query_history 结果曾以 trigger 形式落盘（已由 migrate 迁移）
        agent_id: 'test',
        content: '与 test 的聊天记录：共 231 条……',
        name: 'query_history',
        tool_call_id: 'call_00_abc',
        timestamp: '2026-08-01T22:11:14.748Z',
      },
      {
        role: 'tool',
        agent_id: 'test',
        content: '{"status":"success"}',
        name: 'bash',
        tool_call_id: 'call_01_def',
        timestamp: '2026-08-01T22:11:14.749Z',
      },
    ]);

    const loaded = loadHistory(dialogId);
    expect(loaded.length).toBe(3);

    const [agentMsg, damagedMsg, tool] = loaded;
    // 持久化发言：role 原样（agent/tool），视角由 provider 依据 viewer 解析
    expect(agentMsg.role).toBe('agent');
    expect(agentMsg.agent_id).toBe('test');
    // tool_calls 保持 OpenAI 原生格式
    expect(agentMsg.tool_calls?.length).toBe(2);
    expect((agentMsg.tool_calls as any)[0]).toMatchObject({ id: 'call_00_abc', type: 'function', function: { name: 'query_history' } });

    // 历史损坏（trigger+tool_call_id）→ 运行时兜底为 tool，保持 assistant.tool_calls → tool 配对
    expect(damagedMsg.role).toBe('tool');
    expect(damagedMsg.tool_call_id).toBe('call_00_abc');

    expect(tool.role).toBe('tool');
    expect(tool.tool_call_id).toBe('call_01_def');

    expect(filePath).toBeTruthy();
  });

  it('旧纯 trigger（无 tool_call_id）归一化为 user + source，并解包 <trigger> 正文', () => {
    writeSession([
      {
        role: 'trigger',
        agent_id: 'system',
        content: '<trigger>[记忆审查] 你的会话刚归档……</trigger>',
        timestamp: '2026-08-01T22:11:14.747Z',
      },
    ]);

    const loaded = loadHistory(dialogId);
    expect(loaded.length).toBe(1);
    // 旧 trigger → user（LLM 入站语义）+ 来源元数据（保留 legacyRole 诊断标记）
    expect(loaded[0].role).toBe('user');
    expect(loaded[0].content).toBe('[记忆审查] 你的会话刚归档……');
    expect(loaded[0].source).toMatchObject({ kind: 'system', form: 'hint', legacyRole: 'trigger' });
  });

  it('新持久化 role=event 读取时归一化为 user + 原 source', () => {
    writeSession([
      {
        role: 'event',
        content: '到点检查新闻',
        source: { kind: 'timer', form: 'hint', summary: '到点检查新闻' },
        timestamp: '2026-08-15T10:00:00.000Z',
      },
    ]);

    const loaded = loadHistory(dialogId);
    expect(loaded.length).toBe(1);
    expect(loaded[0].role).toBe('user');
    expect(loaded[0].content).toBe('到点检查新闻');
    expect(loaded[0].source).toMatchObject({ kind: 'timer', form: 'hint' });
  });

  it('旧数据 user/assistant 原样加载（不运行时归一化，由 migrate 一次性迁移为 agent）', () => {
    writeSession([
      { role: 'user', agent_id: 'other', content: '早上好', timestamp: '2026-08-01T22:11:14.747Z' },
      { role: 'assistant', agent_id: 'test', content: '你好！', timestamp: '2026-08-01T22:11:14.748Z' },
    ]);

    const loaded = loadHistory(dialogId);
    expect(loaded.length).toBe(2);
    // A4：loadHistory 原样透传持久化 role，user/assistant 归一化由 migrate 迁移处理
    expect(loaded[0].role).toBe('user');
    expect(loaded[0].agent_id).toBe('other');
    expect(loaded[1].role).toBe('assistant');
    expect(loaded[1].agent_id).toBe('test');
  });
});

describe('toPersistedRole：内存角色 → 持久化角色（trigger → event）', () => {
  it('普通用户发言 → agent；带事件来源的 user → event', () => {
    expect(toPersistedRole('user')).toBe('agent');
    expect(toPersistedRole('user', { kind: 'user', form: 'prompt' })).toBe('agent');
    expect(toPersistedRole('user', { kind: 'agent', form: 'relay' })).toBe('agent');
    expect(toPersistedRole('user', { kind: 'timer', form: 'hint' })).toBe('event');
    expect(toPersistedRole('user', { kind: 'restart', form: 'resume' })).toBe('event');
  });

  it('assistant/tool/error/system 保持原有映射', () => {
    expect(toPersistedRole('assistant')).toBe('agent');
    expect(toPersistedRole('tool')).toBe('tool');
    expect(toPersistedRole('error')).toBe('error');
    expect(toPersistedRole('system')).toBe('system');
  });
});
