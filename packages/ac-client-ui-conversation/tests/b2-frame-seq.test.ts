// ============================================================
// b2-frame-seq.test.ts —— B2 帧有序性：llm/delta 携带 meta.seq 的
// 步级配对去重（run 内重放不回退）。
//
// 前提事实：后端 delta 帧发射时刻 journal 步行 seq 尚未分配（步行在
// loop/after-step 才落盘——见 session-cache-and-frame-ordering-plan B2
// 调研结论），故当前生产帧不带 seq；本用例锁定的是前端消费契约——
// 帧带 seq 时按 stepId 配对去重，帧无 seq（旧后端）行为与现状恒一致。
// ============================================================
import { describe, it, expect, beforeAll } from 'vitest';
import { RosterCore } from 'ac-client-ui-agents/client';

let feedCore: typeof import('../client/feed-core.ts');
let offlineRpc: typeof import('../client/feedStore.ts').offlineRpc;

beforeAll(async () => {
  feedCore = await import('../client/feed-core.ts');
  offlineRpc = (await import('../client/feedStore.ts')).offlineRpc;
});

const CONV = 'alpha~user';
const DIALOG = 'pair:alpha|user';
const meta = { agent: 'alpha', conversationId: CONV, sender: 'user', source: 'user' };

function newFeed() {
  const feed = feedCore.createFeedCore(offlineRpc as never, () => new RosterCore());
  feed.init();
  return feed;
}

/** delta 帧构造（参数序 [input(投影), chunk, meta]——批帧解包后的前端形态） */
function delta(seq: number | undefined, text: string, stepId = 'r1:0'): [string, unknown[]] {
  return ['llm/delta', [{
    model: 'm',
    meta: { ...meta, runId: 'r1', stepId, ...(seq !== undefined ? { seq } : {}) },
  }, { delta: text }]];
}

/** 取指定 stepId 的流式载体正文（步级配对的判定面） */
function carrierText(feed: any, stepId?: string): string {
  const raw = feed.getRaw(DIALOG as never);
  const hit = stepId !== undefined
    ? [...raw].reverse().find((m: any) => m.role === 'agent' && m.stepId === stepId)
    : [...raw].reverse().find((m: any) => m.role === 'agent');
  return String(hit?.content ?? '');
}

describe('B2 帧有序性：llm/delta meta.seq 步级配对去重', () => {
  it('同 stepId 回退帧（seq < 已见）整帧丢弃——重放不回退', () => {
    const feed = newFeed();
    feed.ingestFrame('loop/run-started', [meta]);
    feed.ingestFrame('loop/step-started', ['alpha', 0, [], { ...meta, runId: 'r1', stepId: 'r1:0' }]);
    feed.ingestFrame(...delta(7, 'A'));
    feed.ingestFrame(...delta(6, '回放')); // 回退帧：丢弃
    feed.ingestFrame(...delta(7, 'C')); // 等值不回退：照常追加
    expect(carrierText(feed, 'r1:0')).toBe('AC');
  });

  it('帧无 seq（旧后端）：缺席回落，行为与现状完全一致', () => {
    const feed = newFeed();
    feed.ingestFrame('loop/step-started', ['alpha', 0, [], { ...meta, runId: 'r1', stepId: 'r1:0' }]);
    feed.ingestFrame(...delta(undefined, '旧'));
    feed.ingestFrame(...delta(undefined, '后端'));
    expect(carrierText(feed, 'r1:0')).toBe('旧后端');
  });

  it('有 seq 无 stepId：无配对键不丢弃（配对以 stepId 为准）', () => {
    const feed = newFeed();
    feed.ingestFrame('loop/step-started', ['alpha', 0, [], { ...meta, runId: 'r1', stepId: 'r1:0' }]);
    // stepId 缺席（旧式帧）时即使 seq 回退也不丢弃——回落启发式路径
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { ...meta, seq: 5 } }, { delta: 'x' }]);
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { ...meta, seq: 4 } }, { delta: 'y' }]);
    expect(carrierText(feed)).toBe('xy');
  });

  it('stepId 各自配对（run 内步级分段——stepId 前缀含 runId）', () => {
    const feed = newFeed();
    feed.ingestFrame('loop/step-started', ['alpha', 0, [], { ...meta, runId: 'r1', stepId: 'r1:0' }]);
    feed.ingestFrame(...delta(5, '步零', 'r1:0'));
    // 步零收束（终值替换语义——步一随后开场，步零水位驻留 st.lastStepSeq）
    feed.ingestFrame('loop/after-step', ['alpha', { index: 0, stepId: 'r1:0', text: '步零', toolCalls: [] }, { ...meta, runId: 'r1', stepId: 'r1:0' }]);
    feed.ingestFrame('loop/step-started', ['alpha', 1, [], { ...meta, runId: 'r1', stepId: 'r1:1' }]);
    feed.ingestFrame(...delta(6, '步一', 'r1:1'));
    feed.ingestFrame(...delta(4, '迟到的步零旧批', 'r1:0')); // 步零水位 5 → 回退丢弃
    expect(carrierText(feed, 'r1:0')).toBe('步零');
    expect(carrierText(feed, 'r1:1')).toBe('步一');
  });

  it('丢弃的回退帧不重点亮 streaming（过期帧不得复活光环）', () => {
    const feed = newFeed();
    feed.ingestFrame('loop/step-started', ['alpha', 0, [], { ...meta, runId: 'r1', stepId: 'r1:0' }]);
    feed.ingestFrame(...delta(5, 'A'));
    expect(feed.ensureById(DIALOG as never).streaming).toBe(true);
    // 模拟 run 收束后的重放窗口：分区已熄灭，过期 delta 到达不得复活
    feed.ensureById(DIALOG as never).streaming = false;
    feed.ingestFrame(...delta(4, '重放'));
    expect(feed.ensureById(DIALOG as never).streaming).toBe(false);
    expect(carrierText(feed, 'r1:0')).toBe('A');
  });

  describe('ledger/step-journaled 消费（B2 journal 锚帧）', () => {
    /** journal 锚帧构造（落盘后补发——载荷单对象） */
    const journaled = (seq: number, stepId = 'r1:0'): [string, unknown[]] =>
      ['ledger/step-journaled', [{ agent: 'alpha', conversationId: CONV, runId: 'r1', step: 0, seq, stepId }]];

    it('锚帧补记水位：晚到的回退 delta 被丢，等值照常', () => {
      const feed = newFeed();
      feed.ingestFrame('loop/step-started', ['alpha', 0, [], { ...meta, runId: 'r1', stepId: 'r1:0' }]);
      // delta 先行（生产时序：delta 全部到完后步行才落盘补发锚帧）
      feed.ingestFrame(...delta(9, 'A'));
      feed.ingestFrame(...journaled(9));
      feed.ingestFrame(...delta(8, '迟到旧批')); // < 锚水位 9 → 丢弃
      feed.ingestFrame(...delta(9, 'B')); // 等值 → 照常
      expect(carrierText(feed, 'r1:0')).toBe('AB');
    });

    it('seq 锚到本步流式载体（settlement 前直播行即获稳定身份）', () => {
      const feed = newFeed();
      feed.ingestFrame('loop/step-started', ['alpha', 0, [], { ...meta, runId: 'r1', stepId: 'r1:0' }]);
      feed.ingestFrame(...journaled(42));
      // 步收束后 carrier 索引已摘——锚帧晚到仍按消息尾 stepId 命中同一条
      feed.ingestFrame('loop/after-step', ['alpha', { index: 0, stepId: 'r1:0', text: '终值', toolCalls: [] }, { ...meta, runId: 'r1', stepId: 'r1:0' }]);
      feed.ingestFrame(...journaled(42));
      const raw = feed.getRaw(DIALOG as never);
      const hit = [...raw].reverse().find((m: any) => m.stepId === 'r1:0');
      expect(hit?.seq).toBe(42);
    });

    it('重放的旧锚不拉低水位（只进不退）', () => {
      const feed = newFeed();
      feed.ingestFrame('loop/step-started', ['alpha', 0, [], { ...meta, runId: 'r1', stepId: 'r1:0' }]);
      feed.ingestFrame(...journaled(9));
      feed.ingestFrame(...journaled(7)); // 旧锚重放：水位保持 9
      feed.ingestFrame(...delta(8, '应被丢弃'));
      expect(carrierText(feed, 'r1:0')).toBe('');
    });
  });
});
