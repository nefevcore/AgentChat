// ============================================================
// resolveRole 单元测试 —— loadHistory 视角转换核心逻辑
//
// 回归背景：
//   loadHistory(A, B) 时，B 发起的工具轮次被 resolveRole 转成 user，
//   但消息仍携带 tool_calls → 其后的 tool 响应被判为"孤立"。
//   修复：仅当前 Agent 自己（role=assistant）保留 tool_calls。
//   本测试锁定 resolveRole 的视角转换规则。
// ============================================================

import { describe, it, expect } from 'vitest';
import { resolveRole } from '@global/agent-core/extensions/agent-session/history';

describe('resolveRole 视角转换', () => {
  it('tool/error/trigger 角色无歧义直接返回', () => {
    expect(resolveRole('tool', 'any_agent', 'me')).toBe('tool');
    expect(resolveRole('error', 'any_agent', 'me')).toBe('tool');
    expect(resolveRole('trigger', 'any_agent', 'me')).toBe('user');
  });

  it('agent_id=user 的人类用户永远 user', () => {
    expect(resolveRole('agent', 'user', 'me')).toBe('user');
    expect(resolveRole('user', 'user', 'me')).toBe('user');
    expect(resolveRole('assistant', 'user', 'me')).toBe('user');
  });

  it('agent role：自己发的 = assistant，别人发的 = user（核心视角转换）', () => {
    // 自己（loadingAgent）发的消息 → assistant
    expect(resolveRole('agent', 'me', 'me')).toBe('assistant');
    // 对端 Agent 发的消息 → user（视角转换！）
    expect(resolveRole('agent', 'soul_designer', 'news')).toBe('user');
    // 反向视角：soul_designer 加载时，自己的消息是 assistant
    expect(resolveRole('agent', 'soul_designer', 'soul_designer')).toBe('assistant');
  });

  it('旧数据兼容：无 agent_id 时保持原始 role', () => {
    expect(resolveRole('agent', undefined, 'me')).toBe('user'); // 无归属的 agent 视为对端
    expect(resolveRole('user', undefined, 'me')).toBe('user');
    expect(resolveRole('assistant', undefined, 'me')).toBe('assistant');
  });

  it('旧格式 role=user/assistant 按 agent_id 校正', () => {
    expect(resolveRole('user', 'me', 'me')).toBe('assistant'); // 自己的消息
    expect(resolveRole('user', 'other', 'me')).toBe('user');    // 别人的消息
    expect(resolveRole('assistant', 'me', 'me')).toBe('assistant');
    expect(resolveRole('assistant', 'other', 'me')).toBe('user');
  });
});
