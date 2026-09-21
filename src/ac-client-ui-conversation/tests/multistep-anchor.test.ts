// 多步轮步行锚点（2026-12 分支锚点修复回归）：带 steps 的收束行展开后，
// 每步 message_id = 收束行真实 id（服务端锚——fork/truncate 命中），sid 承担
// 渲染 key 唯一；mergeHistoryPage 双键去重不吞同锚步行。
import { describe, it, expect } from 'vitest';
import { toHistoryMessages } from 'ac-client-ui-conversation/client/historyApi.ts';
import { mergeHistoryPage } from 'ac-client-ui-conversation/client/feed.ts';

describe('多步轮步行锚点与去重', () => {
  it('步行 message_id = 收束行 id；sid 唯一；tool 行不受影响', () => {
    const rows = toHistoryMessages([
      {
        role: 'agent', content: '', message_id: 'real-anchor', timestamp: '2026-12-01T00:00:00Z',
        steps: [
          { content: '步一', reasoning: '想一', toolCalls: [{ id: 't1', name: 'bash', arguments: '{}', result: 'ok' }] },
          { content: '步二', reasoning: '想二' },
          { content: '终稿' },
        ],
      } as never,
    ], 'c1');
    const agentRows = rows.filter((r) => r.role === 'agent');
    expect(agentRows).toHaveLength(3);
    // 全部步行 message_id = 收束行真实 id（服务端锚点）
    expect(agentRows.every((r) => r.message_id === 'real-anchor')).toBe(true);
    // sid 唯一（渲染 key）
    const sids = agentRows.map((r) => r.sid);
    expect(new Set(sids).size).toBe(3);
    // tool 行沿用 tool_call_id
    expect(rows.find((r) => r.role === 'tool')?.message_id).toBe('t1');
  });

  it('mergeHistoryPage 双键去重：同锚步行不互吞；真重复（锚+id 同）仍去重', () => {
    const mk = (id: string, persisted: string | undefined) => ({
      id, role: 'agent' as const, content: 'x', timestamp: 1,
      ...(persisted ? { persistedMsgId: persisted } : {}),
    });
    // 同轮三条步行：锚相同、sid 各异 → 全保留
    const merged = mergeHistoryPage([mk('s0', 'a1'), mk('s1', 'a1'), mk('s2', 'a1')], [], true);
    expect(merged.merged).toHaveLength(3);
    // 历史行与直播行重复投递（锚+id 皆同）→ 去重
    const dup = mergeHistoryPage([mk('m1', 'a9'), mk('m1', 'a9')], [], true);
    expect(dup.merged).toHaveLength(1);
  });
});