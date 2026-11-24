// ============================================================
// signature-single-source.test.ts —— P3-2 keyed store 派生回归
//（cr-1282；前史：P1-1 cr-1267 签名单源化 + P1-2 cr-1268 滚动哈希——
//  随签名系统整体退役，本文件改锁引用 diff 派生行为）。
// 覆盖锁退役依据：Object.freeze 构造性防线取代字段枚举——任何未换身的
// 原地变异当场 throw（冻结对象只读），不存在「漏枚举字段静默 stale」。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';

let feedTypes: typeof import('../client/feed.ts');

beforeAll(async () => {
  feedTypes = await import('../client/feed.ts');
});

const t0 = Date.parse('2026-01-01T00:00:00Z');

describe('P3-2 deriveTurns 引用 diff（cr-1282）', () => {
  it('前缀引用相同 ⇒ 前缀 Turn 对象身份复用（props 稳定）', () => {
    const mk = (id: string, content: string, streaming = false) => ({
      id, role: 'agent' as const, content, timestamp: t0, agent_id: 'a', isStreaming: streaming,
    });
    const base = [
      { id: 'u0', role: 'user' as const, content: 'q', timestamp: t0, agent_id: 'user' },
      mk('a0', '第一轮答'),
      { id: 'u1', role: 'user' as const, content: 'q2', timestamp: t0 + 5000, agent_id: 'user' },
      mk('a1', '步0'),
      mk('a2', '流式尾部', true),
    ];
    const s1 = feedTypes.deriveTurns(null, base as any, true);
    // 末条变化（换身）：前缀轮复用
    const next = [...base.slice(0, 4), { ...mk('a2', '流式尾部更多'), isStreaming: true }];
    const s2 = feedTypes.deriveTurns(s1, next as any, true);
    const first1 = s1.turns.find((t) => t.final?.content === '第一轮答');
    const first2 = s2.turns.find((t) => t.final?.content === '第一轮答');
    expect(first1).toBe(first2); // 同一对象
    expect(s2.turns[s2.turns.length - 1].final).toBe(null); // 流式悬置
  });

  it('中段消息换身 ⇒ 从变化点起全量重建（引用不同即重建）', () => {
    const mk = (id: string, content: string) => ({ id, role: 'agent' as const, content, timestamp: t0, agent_id: 'a' });
    const base = [
      { id: 'u0', role: 'user' as const, content: 'q', timestamp: t0, agent_id: 'user' },
      mk('a0', '答一'),
      { id: 'u1', role: 'user' as const, content: 'q2', timestamp: t0 + 5000, agent_id: 'user' },
      mk('a1', '答二'),
    ];
    const s1 = feedTypes.deriveTurns(null, base as any, false);
    // 中段工具结果回填（换身）——签名版的「中段 tool result 更新」场景
    const next = [base[0], { ...mk('a0', '答一'), toolCalls: [{ id: 'tc1', name: 'read' }] }, base[2], base[3]];
    const s2 = feedTypes.deriveTurns(s1, next as any, false);
    const first1 = s1.turns.find((t) => t.final?.content === '答一');
    const first2 = s2.turns.find((t) => t.final?.content === '答一');
    expect(first1).not.toBe(first2); // 变化轮重建
  });

  it('streaming 翻转 ⇒ 全量重建（final 悬置/物化生命周期）', () => {
    const mk = (id: string, content: string) => ({ id, role: 'agent' as const, content, timestamp: t0, agent_id: 'a', isStreaming: true });
    const base = [
      { id: 'u0', role: 'user' as const, content: 'q', timestamp: t0, agent_id: 'user' },
      mk('a0', '流式中'),
    ];
    const s1 = feedTypes.deriveTurns(null, base as any, true);
    const closed = base.map((m) => (m.id === 'a0' ? { ...m, isStreaming: false } : m));
    const s2 = feedTypes.deriveTurns(s1, closed as any, false);
    expect(s2.turns[s2.turns.length - 1].final?.content).toBe('流式中'); // 物化
    const last1 = s1.turns[s1.turns.length - 1];
    const last2 = s2.turns[s2.turns.length - 1];
    expect(last1).not.toBe(last2); // streaming 翻转全量重建
  });

  it('冻结构造性防线：入位后原地变异当场 throw', () => {
    const m = feedTypes.freezeMsg({ id: 'x', role: 'agent', content: 'a', timestamp: t0, agent_id: 'a' });
    expect(() => { (m as any).content = 'b'; }).toThrow();
  });
});
