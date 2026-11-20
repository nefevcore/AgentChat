// ============================================================
// cr1162-gauge-key.test.ts —— 仪表视图键与开销归属判定（cr-1162）
//
// 根因：systemPromptContent/toolDefs 是 chatStore 全局单例（还与
// SystemPromptPanel 共用），而 TokenGauge 无锚点态分子 = tokenCount +
// 系统提示 + 工具定义。切换会话后旧开销留在分子里 → 占比不跟随切换、
// 读数系统性偏高。修法 = 归属键判定：只并入属于当前视图的开销。
// 本测锁定判据单源 gaugeViewKeyOf 的三形态归一（group/single/direct）。
// ============================================================
import { describe, it, expect } from 'vitest';
import { gaugeViewKeyOf } from '../client/tokens.ts';

describe('gaugeViewKeyOf（cr-1162 开销归属判据）', () => {
  it('group：键 = gid', () => {
    expect(gaugeViewKeyOf({ form: 'group', conversationId: 'g-abc', agentId: 'a1' })).toBe('g-abc');
  });

  it('single：键 = sid（优先于 agentId——同 Agent 多会话必须区分）', () => {
    expect(gaugeViewKeyOf({ form: 'single', single: { id: 'sid-1' }, agentId: 'a1' })).toBe('sid-1');
    // 同 Agent 的两个 single 会话键不同
    expect(gaugeViewKeyOf({ form: 'single', single: { id: 'sid-1' }, agentId: 'a1' }))
      .not.toBe(gaugeViewKeyOf({ form: 'single', single: { id: 'sid-2' }, agentId: 'a1' }));
  });

  it('direct：键 = direct:<agentId>（带前缀防与 sid 撞键）', () => {
    expect(gaugeViewKeyOf({ form: 'direct', agentId: 'a1' })).toBe('direct:a1');
    expect(gaugeViewKeyOf({ form: 'direct', agentId: 'sid-1' })).toBe('direct:sid-1');
  });

  it('无视图 → null（不并入开销）', () => {
    expect(gaugeViewKeyOf({ form: 'direct', agentId: null })).toBeNull();
    expect(gaugeViewKeyOf({ form: 'group', conversationId: null })).toBeNull();
    expect(gaugeViewKeyOf({})).toBeNull();
  });

  it('切换会话必然换键（归属判定失效 → 开销回落 0）', () => {
    const a = gaugeViewKeyOf({ form: 'direct', agentId: 'a1' });
    const b = gaugeViewKeyOf({ form: 'direct', agentId: 'a2' });
    expect(a).not.toBe(b);
    const s1 = gaugeViewKeyOf({ form: 'single', single: { id: 'sid-1' } });
    const s2 = gaugeViewKeyOf({ form: 'single', single: { id: 'sid-2' } });
    const g = gaugeViewKeyOf({ form: 'group', conversationId: 'g-1' });
    // 五种形态视图互不撞键（direct 带前缀，sid/gid 原样——同一字符串也不会相等）
    expect(new Set([a, b, s1, s2, g]).size).toBe(5);
    expect(gaugeViewKeyOf({ form: 'direct', agentId: 'sid-1' })).not.toBe(s1); // 前缀防撞实证
  });
});