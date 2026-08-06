// ============================================================
// loadHistory 回归测试 —— 持久化格式加载（2026-08-02）
//
// loadHistory 返回「持久化消息格式」（role=agent/tool/trigger/error/system），
// 不做视角转换（由 provider 的 toProviderMessages 依据 viewer 解析）。
//
// 回归背景：
//   历史上 query_history 等工具的结果曾以 role='trigger' + tool_call_id
//   的形式落盘。若按 trigger 加载会打断 assistant.tool_calls → tool 配对，
//   触发 OpenAI 过滤警告：
//     ⚠️ 已过滤孤立 tool 消息 …
//     已过滤悬空 tool_calls assistant …
//
// 2026-08-02（A4）：历史损坏（trigger+tool_call_id）与旧角色（user/assistant）
//   已由 session-maint.js migrate 一次性迁移；loadHistory 不再做运行时归一化，
//   原样透传持久化 role。本测试锁定"原样加载"契约。
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

import { loadHistory } from '@plugins/builtin/extensions/agent-session/history';
import { resolveMessagePath } from '@plugins/builtin/extensions/agent-session/paths';

describe('loadHistory 持久化格式加载（trigger+tool_call_id → tool）', () => {
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

  it('持久化格式原样加载：role 不转换，tool_calls 保持 OpenAI 原生格式', () => {
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

    const loaded = loadHistory('test', 'test');
    expect(loaded.length).toBe(3);

    const [agentMsg, triggerMsg, tool] = loaded;
    // 持久化格式：role 原样（agent/trigger/tool），视角由 provider 依据 viewer 解析
    expect(agentMsg.role).toBe('agent');
    expect(agentMsg.agent_id).toBe('test');
    // tool_calls 保持 OpenAI 原生格式
    expect(agentMsg.tool_calls?.length).toBe(2);
    expect((agentMsg.tool_calls as any)[0]).toMatchObject({ id: 'call_00_abc', type: 'function', function: { name: 'query_history' } });

    // 2026-08-02（A4）：loadHistory 不再做运行时修复——trigger+tool_call_id 原样按 trigger 加载，
    // 历史损坏由 session-maint.js migrate/scan 一次性迁移（migrate: trigger+tool_call_id→tool）。
    expect(triggerMsg.role).toBe('trigger');
    expect(triggerMsg.tool_call_id).toBe('call_00_abc');

    expect(tool.role).toBe('tool');
    expect(tool.tool_call_id).toBe('call_01_def');

    expect(filePath).toBeTruthy();
  });

  it('纯 trigger（无 tool_call_id）按 trigger 加载（一等角色，2026-08-02）', () => {
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
    // 纯 trigger 保持 trigger 角色，由 LLM provider 的 toProviderMessages 映射为 user 提示
    expect(loaded[0].role).toBe('trigger');
  });

  it('旧数据 user/assistant 原样加载（不运行时归一化，由 migrate 一次性迁移为 agent）', () => {
    writeSession([
      { role: 'user', agent_id: 'other', content: '早上好', timestamp: '2026-08-01T22:11:14.747Z' },
      { role: 'assistant', agent_id: 'test', content: '你好！', timestamp: '2026-08-01T22:11:14.748Z' },
    ]);

    const loaded = loadHistory('test', 'test');
    expect(loaded.length).toBe(2);
    // A4：loadHistory 原样透传持久化 role，user/assistant 归一化由 migrate 迁移处理
    expect(loaded[0].role).toBe('user');
    expect(loaded[0].agent_id).toBe('other');
    expect(loaded[1].role).toBe('assistant');
    expect(loaded[1].agent_id).toBe('test');
  });
});
