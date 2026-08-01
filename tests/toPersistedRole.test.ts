// ============================================================
// toPersistedRole 单元测试 —— 归档重建 role 转换
//
// 回归背景（2026-08-02）：
//   归档重建曾按内容里的 <trigger> 子串把消息改写为 role=trigger，
//   导致 query_history 等工具结果（输出内嵌历史中的 <trigger> 文本）
//   被整条改写为 trigger（仍带 tool_call_id），破坏 assistant→tool 配对，
//   触发 OpenAI 过滤警告：
//     ⚠️ 已过滤孤立 tool 消息 …
//     已过滤悬空 tool_calls assistant …
//
// 修复：tool/error 结果必须保持原角色，仅对"入站触发提示"做内容检测。
// ============================================================

import { describe, it, expect } from 'vitest';
import { toPersistedRole } from '@global/agent-core/extensions/agent-session/archive';

function msg(role: string, content: string, extra: Record<string, unknown> = {}): any {
  return { role, content, ...extra };
}

describe('toPersistedRole 归档角色转换', () => {
  it('tool 结果即使内容含 <trigger> 也保持 tool（核心回归）', () => {
    // query_history 输出内嵌历史中的 <trigger> 文本
    expect(toPersistedRole(msg('tool', '与 test 的聊天记录：\n[2026/7/27] 🤖自己: <trigger>现在是…', { name: 'query_history', tool_call_id: 'call_00_abc' }))).toBe('tool');
    // 普通 tool 结果
    expect(toPersistedRole(msg('tool', '{"status":"success"}', { name: 'bash' }))).toBe('tool');
  });

  it('error 消息保持 error', () => {
    expect(toPersistedRole(msg('error', 'LLM 调用失败: timeout'))).toBe('error');
  });

  it('assistant 消息 → agent', () => {
    expect(toPersistedRole(msg('assistant', '好的，我来处理。'))).toBe('agent');
  });

  it('入站触发提示（user + <trigger>）→ trigger', () => {
    expect(toPersistedRole(msg('user', '<trigger>[记忆审查] 会话已归档…</trigger>'))).toBe('trigger');
    expect(toPersistedRole(msg('user', '<trigger>现在是 2026年8月2日 12:00。'))).toBe('trigger');
  });

  it('普通 user 消息不被改写为 trigger', () => {
    expect(toPersistedRole(msg('user', '早上好！'))).toBe('user');
  });

  it('system 消息保持 system', () => {
    expect(toPersistedRole(msg('system', '系统提示'))).toBe('system');
  });
});
