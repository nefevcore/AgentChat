// ============================================================
// loadHistory 悬空消息修复回归测试
//
// 回归背景：
//   历史上 query_history 等工具的结果曾以 role='trigger' + tool_call_id
//   的形式落盘。按旧逻辑 loadHistory 会把 trigger → user，导致
//   assistant.tool_calls 与其 tool 结果配对断裂，触发 OpenAI 过滤警告：
//     ⚠️ 已过滤孤立 tool 消息 …
//     已过滤悬空 tool_calls assistant …
//
// 修复：role='trigger' 但带 tool_call_id 的消息按 tool 加载，
//   保持 assistant.tool_calls → tool 配对完整。
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

import { loadHistory } from '@global/agent-core/extensions/agent-session/history';
import { resolveMessagePath } from '@global/agent-core/extensions/agent-session/paths';

describe('loadHistory 悬空消息修复（trigger+tool_call_id → tool）', () => {
  let tmpDir: string;

  beforeEach(() => {
    tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'agentchat-ht-'));
    mockState.sessionsDir = tmpDir;
  });

  afterEach(() => {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  });

  function writeSession(msgs: Record<string, unknown>[]) {
    const filePath = resolveMessagePath('test', 'test');
    fs.mkdirSync(path.dirname(filePath), { recursive: true });
    fs.writeFileSync(filePath, msgs.map(m => JSON.stringify(m)).join('\n') + '\n', 'utf-8');
    return filePath;
  }

  it('trigger+tool_call_id 消息按 tool 加载，配对完整', () => {
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
        role: 'trigger', // 异常落盘：query_history 结果被误标为 trigger
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

    const loaded = loadHistory('test', 'test');
    expect(loaded.length).toBe(3);

    const [assistant, triggerAsTool, tool] = loaded;
    expect(assistant.role).toBe('assistant');
    expect(assistant.tool_calls?.length).toBe(2);

    // trigger+tool_call_id → 应加载为 tool（而非 user），配对不打断
    expect(triggerAsTool.role).toBe('tool');
    expect(triggerAsTool.tool_call_id).toBe('call_00_abc');
    expect(triggerAsTool.name).toBe('query_history');

    expect(tool.role).toBe('tool');
    expect(tool.tool_call_id).toBe('call_01_def');

    // 配对完整性：assistant 的两个 tool_calls 均有对应 tool 结果
    const toolIds = loaded
      .filter(m => m.role === 'tool')
      .map(m => m.tool_call_id);
    expect(toolIds.sort()).toEqual(['call_00_abc', 'call_01_def'].sort());
    expect(filePath).toBeTruthy();
  });

  it('纯 trigger（无 tool_call_id）仍按 user 加载', () => {
    writeSession([
      {
        role: 'trigger',
        agent_id: 'system',
        content: '<trigger>[记忆审查] 你的会话刚归档……',
        timestamp: '2026-08-01T22:11:14.747Z',
      },
    ]);

    const loaded = loadHistory('test', 'test');
    expect(loaded.length).toBe(1);
    expect(loaded[0].role).toBe('user'); // 纯 trigger 视为外部提示
  });
});
