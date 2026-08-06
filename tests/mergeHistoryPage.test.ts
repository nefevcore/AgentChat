// ============================================================
// mergeHistoryPage 单元测试 —— 历史分页合并去重
//
// 背景（2026-08-04）：前端历史加载"往上翻打转/重复加载相同消息"。
// 后端分页（FileMessageQuery）实测不重叠（offset 按 user 链计），
// 但前端合并历史时若响应乱序/offset 倒退/归档二次去重错位，
// 可能收到重复消息 → 需按 message_id 去重。
// ============================================================

import { describe, it, expect } from 'vitest';
import { mergeHistoryPage } from '../src/ui/vue/src/stores/chat';
import type { ChatMessage } from '../src/ui/vue/src/types';

function msg(id: string, agentId = 'user'): ChatMessage {
  return { id, role: 'agent', content: `msg-${id}`, agent_id: agentId, persistedMsgId: id, timestamp: Date.now() } as ChatMessage;
}

describe('mergeHistoryPage', () => {
  it('初次加载（isFirstPage=true）：直接采用 incoming', () => {
    const incoming = [msg('a'), msg('b')];
    const { merged, userCount } = mergeHistoryPage(incoming, [], true);
    expect(merged.map(m => m.persistedMsgId)).toEqual(['a', 'b']);
    expect(userCount).toBe(2);
  });

  it('加载更多（isFirstPage=false）：incoming 在前 + existing 在后', () => {
    const incoming = [msg('a'), msg('b')]; // 较早
    const existing = [msg('c'), msg('d')]; // 较晚
    const { merged } = mergeHistoryPage(incoming, existing, false);
    expect(merged.map(m => m.persistedMsgId)).toEqual(['a', 'b', 'c', 'd']);
  });

  it('重复消息被去重（同一 message_id 只保留首次出现）', () => {
    // 模拟响应乱序：incoming 与 existing 有重叠
    const incoming = [msg('a'), msg('b'), msg('c')];
    const existing = [msg('b'), msg('c'), msg('d')]; // b/c 重复
    const { merged } = mergeHistoryPage(incoming, existing, false);
    expect(merged.map(m => m.persistedMsgId)).toEqual(['a', 'b', 'c', 'd']);
    expect(merged.length).toBe(4);
  });

  it('user 链数按 incoming 中 agent_id=user 统计', () => {
    const incoming = [msg('u1', 'user'), msg('u2', 'user'), msg('a1', 'agent_chat_dev')];
    const { userCount } = mergeHistoryPage(incoming, [], true);
    expect(userCount).toBe(2);
  });

  it('无 message_id 的消息不去重（保留所有）', () => {
    const noId = (i: number): ChatMessage => ({ id: `n${i}`, role: 'agent', content: `x${i}`, timestamp: Date.now() } as ChatMessage);
    const incoming = [noId(1), noId(2)];
    const existing = [noId(1)]; // 无 id 无法识别重复
    const { merged } = mergeHistoryPage(incoming, existing, false);
    expect(merged.length).toBe(3); // 全部保留
  });
});
