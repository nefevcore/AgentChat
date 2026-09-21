// buildTurns final 派生透传 persistedMsgId（分支按钮门控回归——2026-12 分支功能）：
// 历史/收束行的 final 必须携带服务端锚点，否则按行定位的操作（分支）永远不可见。
import { describe, it, expect } from 'vitest';
import { buildTurns } from 'ac-client-ui-conversation/client/feed.ts';
import type { ChatMessage } from 'ac-client-ui-conversation/client/types.ts';

const base = { role: 'agent', isStreaming: false } as const;

describe('buildTurns：final 透传 persistedMsgId（分支按钮门控）', () => {
  it('历史行（带锚点）→ final.persistedMsgId 沿用；直播行（无锚点）→ 缺省', () => {
    const msgs: ChatMessage[] = [
      { id: 'u1', ...base, content: '问', agent_id: 'user', timestamp: 1, persistedMsgId: 'm-u1' },
      { id: 'a1', ...base, content: '答', agent_id: 'bot', timestamp: 2, persistedMsgId: 'm-a1' },
      // 直播行：本地合成无服务端 id
      { id: 'u2', ...base, content: '追问', agent_id: 'user', timestamp: 3 },
      { id: 'a2', ...base, content: '直播回复', agent_id: 'bot', timestamp: 4 },
    ];
    const turns = buildTurns(msgs, false);
    const finals = turns.map((t) => t.final);
    expect(finals[0]?.persistedMsgId).toBe('m-u1');
    expect(finals[1]?.persistedMsgId).toBe('m-a1');
    expect(finals[2]?.persistedMsgId).toBeUndefined();
    expect(finals[3]?.persistedMsgId).toBeUndefined();
  });
});