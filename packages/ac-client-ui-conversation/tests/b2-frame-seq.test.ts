// ============================================================
// b2-frame-seq.test.ts —— B2 帧有序性：llm/delta 携带 meta.seq 的
// 步级配对去重（run 内重放不回退）+ step/journaled 锚语义。
//
// cr-976 B 案：步级 durable 事实以 step/journaled 投影帧到达（相位行批
// + seq 锚），承载原 ledger/step-journaled 锚帧职责（seq 水位补记 +
// 直播行 seq 身份锚）；步载体由首个带 stepId 的 delta 惰性建卡
//（step-started 帧退役）。
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

/** 空载荷 delta（只建步载体不进内容——新步空占位的直播源等价物） */
function emptyDelta(stepId: string): [string, unknown[]] {
  return ['llm/delta', [{ model: 'm', meta: { ...meta, runId: 'r1', stepId } }, {}]];
}

/** step/journaled 帧构造（落盘相位行批投影——载荷单对象） */
function journaled(seq: number, rows: Array<Record<string, unknown>>, stepId = 'r1:0', step = 0): [string, unknown[]] {
  return ['step/journaled', [{ agent: 'alpha', conversationId: CONV, run: 'r1', step, stepId, seq, rows }]];
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
    // 首个带 stepId 的 delta 惰性建卡（step-started 退役）
    feed.ingestFrame(...delta(7, 'A'));
    feed.ingestFrame(...delta(6, '回放')); // 回退帧：丢弃
    feed.ingestFrame(...delta(7, 'C')); // 等值不回退：照常追加
    expect(carrierText(feed, 'r1:0')).toBe('AC');
  });

  it('帧无 seq（旧后端）：缺席回落，行为与现状完全一致', () => {
    const feed = newFeed();
    feed.ingestFrame(...delta(undefined, '旧'));
    feed.ingestFrame(...delta(undefined, '后端'));
    expect(carrierText(feed, 'r1:0')).toBe('旧后端');
  });

  it('有 seq 无 stepId：无配对键不丢弃（配对以 stepId 为准）', () => {
    const feed = newFeed();
    // 先用带 stepId 的空载荷 delta 建本步载体（keyless 帧回落 lastStreaming 的前提）
    feed.ingestFrame(...emptyDelta('r1:0'));
    // stepId 缺席（旧式帧）时即使 seq 回退也不丢弃——回落启发式路径
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { ...meta, seq: 5 } }, { delta: 'x' }]);
    feed.ingestFrame('llm/delta', [{ model: 'm', meta: { ...meta, seq: 4 } }, { delta: 'y' }]);
    expect(carrierText(feed)).toBe('xy');
  });

  it('stepId 各自配对（run 内步级分段——stepId 前缀含 runId）', () => {
    const feed = newFeed();
    feed.ingestFrame(...delta(5, '步零', 'r1:0'));
    // 步零收束（step/journaled 终值替换 + seq 锚——水位驻留 st.lastStepSeq）
    feed.ingestFrame(...journaled(5, [{ type: 'step/content', text: '步零', ts: 1 }]));
    feed.ingestFrame(...delta(6, '步一', 'r1:1'));
    feed.ingestFrame(...delta(4, '迟到的步零旧批', 'r1:0')); // 步零水位 5 → 回退丢弃
    expect(carrierText(feed, 'r1:0')).toBe('步零');
    expect(carrierText(feed, 'r1:1')).toBe('步一');
  });

  it('丢弃的回退帧不重点亮 streaming（过期帧不得复活光环）', () => {
    const feed = newFeed();
    feed.ingestFrame(...delta(5, 'A'));
    expect(feed.ensureById(DIALOG as never).streaming).toBe(true);
    // 模拟 run 收束后的重放窗口：分区已熄灭，过期 delta 到达不得复活
    feed.ensureById(DIALOG as never).streaming = false;
    feed.ingestFrame(...delta(4, '重放'));
    expect(feed.ensureById(DIALOG as never).streaming).toBe(false);
    expect(carrierText(feed, 'r1:0')).toBe('A');
  });

  describe('step/journaled 锚语义（B2 durable 锚帧——原 ledger/step-journaled 职责）', () => {
    it('锚帧补记水位：晚到的回退 delta 被丢，等值照常（落入新载体）', () => {
      const feed = newFeed();
      // delta 先行（生产时序：delta 全部到完后步行才落盘投影）
      feed.ingestFrame(...delta(9, 'A'));
      feed.ingestFrame(...journaled(9, [{ type: 'step/content', text: 'A', ts: 1 }]));
      feed.ingestFrame(...delta(8, '迟到旧批')); // < 锚水位 9 → 丢弃
      feed.ingestFrame(...delta(9, 'B')); // 等值 → 不丢弃（步已收束，落新载体）
      const raw = feed.getRaw(DIALOG as never);
      const texts = raw.filter((m: any) => m.role === 'agent' && m.stepId === 'r1:0').map((m: any) => String(m.content));
      expect(texts).toEqual(['A', 'B']); // 回退帧未落任何载体
    });

    it('seq 锚到本步流式载体（settlement 前直播行即获稳定身份）', () => {
      const feed = newFeed();
      // 生产时序：delta 先建载体（步收束前直播行在场），锚帧到达即锚定
      feed.ingestFrame(...delta(undefined, 'A'));
      feed.ingestFrame(...journaled(42, [{ type: 'step/content', text: '终值', ts: 1 }]));
      const raw = feed.getRaw(DIALOG as never);
      const hit = [...raw].reverse().find((m: any) => m.stepId === 'r1:0');
      expect(hit?.seq).toBe(42);
      expect(hit?.content).toBe('终值');
    });

    it('重放的旧锚不拉低水位（只进不退）', () => {
      const feed = newFeed();
      feed.ingestFrame(...journaled(9, [{ type: 'step/content', text: '', ts: 1 }]));
      feed.ingestFrame(...journaled(7, [{ type: 'step/content', text: '', ts: 1 }])); // 旧锚重放：水位保持 9
      feed.ingestFrame(...delta(8, '应被丢弃'));
      expect(carrierText(feed, 'r1:0')).toBe('');
    });
  });
});
