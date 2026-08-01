// ============================================================
// truncateTail 单元测试 —— 归档截断不切割 tool-call/response 对
//
// 回归背景：归档/压缩按 token 预算截断历史时，若在 tool 响应中间
// 截断，残留的孤立 tool 消息会在下次加载时触发 OpenAI 400。
// truncateTail 保证从尾部向前保留，安全分割点不拆 tool 对。
// ============================================================

import { describe, it, expect } from 'vitest';
import { truncateTail } from '@global/agent-core/extensions/agent-session/archive';

function asst(content: string, toolCallIds: string[] = []): any {
  return {
    role: 'assistant',
    content,
    tool_calls: toolCallIds.map(id => ({ id, name: 'read', arguments: {} })),
  };
}
function tool(id: string, content = 'result'): any {
  return { role: 'tool', tool_call_id: id, content };
}

describe('truncateTail 归档截断', () => {
  it('预算足够时保留全部', () => {
    const msgs = [asst('hi'), asst('hello')];
    const out = truncateTail(msgs, 10_000);
    expect(out).toHaveLength(2);
  });

  it('预算不足时丢弃早期消息', () => {
    const msgs = [asst('A'), asst('B'), asst('C')];
    const out = truncateTail(msgs, 1);
    expect(out.length).toBeLessThan(3);
  });

  it('不切割 tool-call/response 对：assistant 带 tool_calls 时必须连带其 tool 响应', () => {
    const msgs = [asst('step1'), asst('calling tool', ['call_1']), tool('call_1'), asst('final')];
    const out = truncateTail(msgs, 1000); // 预算极小，应只保留尾部
    // 如果保留 assistant(带 tool_calls)，必须同时保留其 tool 响应
    const kept = new Set(out.map(m => m.tool_call_id || m.content));
    const hasToolAsst = out.some(m => m.role === 'assistant' && m.tool_calls?.length);
    if (hasToolAsst) {
      const ids = out.flatMap(m => m.tool_calls?.map((tc: any) => tc.id) ?? []);
      for (const id of ids) {
        expect(out.some(m => m.role === 'tool' && m.tool_call_id === id)).toBe(true);
      }
    }
  });

  it('纯 tool 消息不保留（必须附着在 assistant 前）', () => {
    const msgs = [asst('hi'), tool('orphan')];
    const out = truncateTail(msgs, 1000);
    // 输出不应以 tool 开头（tool 前无 assistant）
    expect(out[0]?.role).not.toBe('tool');
  });
});
