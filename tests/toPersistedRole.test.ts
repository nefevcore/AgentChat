// ============================================================
// toPersistedRole 单元测试 —— 归档重建 role 转换
//
// 回归背景（2026-08-02）：
//   归档重建曾按内容里的 <trigger> 子串把消息改写为 role=trigger，导致：
//   1. query_history 等工具结果（输出内嵌历史中的 <trigger> 文本）
//      被整条改写为 trigger（仍带 tool_call_id），破坏 assistant→tool 配对
//   2. **agent 回复**因内容讨论/引用 <trigger> 字样被误存成 trigger
//      （如"归档重建用 <trigger> 子串做检测"这类回复）——用户观察到
//      "归档后 agent 消息变成 trigger 消息"
//
// 2026-08-02 重构：trigger 成为一等内存角色（role='trigger'，由 _doTrigger
//   标记、loadHistory 原样加载、LLM provider 映射为 user 提示）。归档时
//   角色判定一律依据 role 字段，不再嗅探正文。tool/error/trigger 保持原角色，
//   user/assistant → agent，system → system。
// ============================================================

import { describe, it, expect } from 'vitest';
import { toPersistedRole } from '@plugins/builtin/hooks/session';

function msg(role: string, content: string, extra: Record<string, unknown> = {}): any {
  return { role, content, ...extra };
}

describe('toPersistedRole 归档角色转换', () => {
  it('tool 结果即使内容含 <trigger> 也保持 tool', () => {
    // query_history 输出内嵌历史中的 <trigger> 文本
    expect(toPersistedRole('tool')).toBe('tool');
    expect(toPersistedRole('tool')).toBe('tool');
  });

  it('error 消息保持 error', () => {
    expect(toPersistedRole('error')).toBe('error');
  });

  it('assistant 回复即使内容含 <trigger> 也保持 agent（核心回归）', () => {
    // agent 回复讨论/引用 <trigger> 字样，不得被改写为 trigger
    expect(toPersistedRole('assistant')).toBe('agent');
    expect(toPersistedRole('assistant')).toBe('agent');
  });

  it('trigger 角色消息 → trigger（一等角色直接映射，2026-08-02 重构）', () => {
    expect(toPersistedRole('trigger')).toBe('trigger');
    expect(toPersistedRole('trigger')).toBe('trigger');
  });

  it('持久化格式 role=agent 消息 → agent（原样保留，2026-08-02）', () => {
    expect(toPersistedRole('agent')).toBe('agent');
    expect(toPersistedRole('agent')).toBe('agent');
  });

  it('普通 user 消息 → agent（持久化格式无 user，存 agent + agent_id 还原）', () => {
    expect(toPersistedRole('user')).toBe('agent');
    // 内容提到 trigger 但非包裹式入站提示，也按 agent 处理
    expect(toPersistedRole('user')).toBe('agent');
    // 即使正文以 <trigger> 开头，只要内存 role 是 user（非 trigger），仍按 agent 处理
    // （角色判定依据 role 字段，不再嗅探正文 —— 2026-08-02 重构）
    expect(toPersistedRole('user')).toBe('agent');
  });

  it('system 消息保持 system', () => {
    expect(toPersistedRole('system')).toBe('system');
  });
});
