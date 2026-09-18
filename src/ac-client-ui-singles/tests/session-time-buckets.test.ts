// ============================================================
// ac-client-ui-singles/tests/session-time-buckets.test.ts ——
// 会话列表工作区「按时间分批展开」纯函数单测
//
// 覆盖：分桶边界（自然日切分/桶区间归属/空桶不出现）、降序
// 前置契约、深史聚拢（「其他」）、分批展开显式记录状态机
// （缺省回落/播种不跳变/折叠重置回缺省）。
//
// now 由参数注入——不依赖真实墙钟；边界时刻（自然日 00:00）
// 用本地时区构造（与实现同口径）。
// ============================================================
import { describe, it, expect } from 'vitest';
import {
  bucketByTime, bucketLimitOf, toggleBucketHead, growBucket, resetGroupReveal, BUCKET_PAGE_SIZE,
  type RevealMap, type TimeBucketItem,
} from '../client/sessionTimeBuckets.ts';

/** 固定「现在」= 2026-10-15 14:30 本地时区（周中普通日，无 DST 切换邻近） */
function fixedNow(): number {
  return new Date(2026, 9, 15, 14, 30).getTime();
}

/** 距固定 now 指定天数的同时刻（days=0 → 今天；负数 = 未来） */
function atDays(days: number, hours = 10): number {
  return new Date(2026, 9, 15 - days, hours).getTime();
}

/** 今天 00:00（本地时区——与实现 startOfToday 同口径） */
function todayStart(): number {
  return new Date(2026, 9, 15, 0, 0, 0, 0).getTime();
}

function item(id: string, lastActivity: number): TimeBucketItem & { id: string } {
  return { id, lastActivity };
}

describe('bucketByTime：按自然日分桶', () => {
  it('空输入 → 无桶', () => {
    expect(bucketByTime([], fixedNow())).toEqual([]);
  });

  it('各日桶归属：今天/一周(昨天起 7 个自然日)边界精确，「其他」聚拢深史', () => {
    const items = [
      item('a-now', fixedNow()),            // 今天 14:30
      item('b-today-start', todayStart()),  // 今天 00:00（今天桶下界，含）
      item('c-yesterday', atDays(1)),       // 昨天 → 一周桶
      item('d-7d', atDays(7)),              // 7 天前 → 一周桶下界，含
      item('e-8d', atDays(8)),              // 8 天前 → 其他
      item('f-month', atDays(30)),          // 30 天前 → 其他
      item('g-year', new Date(2020, 0, 1).getTime()), // 深史 → 其他
    ];
    const buckets = bucketByTime(items, fixedNow());
    expect(buckets.map(b => b.key)).toEqual(['today', '1w', 'older']);
    const byId = new Map(buckets.flatMap(b => b.items.map(i => [(i as { id: string }).id, b.key])));
    expect(byId.get('a-now')).toBe('today');
    expect(byId.get('b-today-start')).toBe('today');
    expect(byId.get('c-yesterday')).toBe('1w');
    expect(byId.get('d-7d')).toBe('1w');
    expect(byId.get('e-8d')).toBe('older');
    expect(byId.get('f-month')).toBe('older');
    expect(byId.get('g-year')).toBe('older');
  });

  it('空桶不出现；桶内保持调用方顺序', () => {
    // 只有今天和更早 → 中间桶全部跳过
    const items = [item('t1', fixedNow()), item('t2', atDays(0, 9)), item('o1', atDays(100))];
    const buckets = bucketByTime(items, fixedNow());
    expect(buckets.map(b => b.key)).toEqual(['today', 'older']);
    expect(buckets[0].items.map(i => (i as { id: string }).id)).toEqual(['t1', 't2']);
  });

  it('无今天会话时缺省首桶顺延（如最新在一周内）——桶序列正确', () => {
    const items = [item('w1', atDays(1, 20)), item('w2', atDays(1, 8)), item('w3', atDays(5))];
    const buckets = bucketByTime(items, fixedNow());
    expect(buckets[0].key).toBe('1w'); // 首桶 = 首个非空桶
    expect(buckets[0].items).toHaveLength(3);
  });

  it('未来时间戳（时钟偏差/刚创建）落「今天」桶', () => {
    const items = [item('future', fixedNow() + 3600_000), item('now', fixedNow())];
    const buckets = bucketByTime(items, fixedNow());
    expect(buckets).toHaveLength(1);
    expect(buckets[0].key).toBe('today');
    expect(buckets[0].items).toHaveLength(2);
  });
});

describe('分批展开记录：缺省回落 + 播种 + 桶内分页 + 折叠重置', () => {
  const g = 'ws-a';

  it('无记录 → 走缺省规则（defaultLimit 由调用方给出；0 = 收起）', () => {
    const reveal: RevealMap = new Map();
    expect(bucketLimitOf(reveal, g, 'today', BUCKET_PAGE_SIZE)).toBe(5);
    expect(bucketLimitOf(reveal, g, 'older', 0)).toBe(0);
  });

  it('桶头开合：展开态点收起 → 0；再点开 → 回一页（不记住「展开很多」）', () => {
    let reveal: RevealMap = new Map();
    const seed = new Map([['today', BUCKET_PAGE_SIZE]]);
    // 先展开更多到两页
    reveal = growBucket(reveal, g, 'today', 12, seed);
    expect(bucketLimitOf(reveal, g, 'today', 0)).toBe(10);
    // 桶头收起 → 0
    reveal = toggleBucketHead(reveal, g, 'today', seed);
    expect(bucketLimitOf(reveal, g, 'today', 5)).toBe(0);
    // 再点开 → 回一页（非 10——不记住展开很多）
    reveal = toggleBucketHead(reveal, g, 'today', seed);
    expect(bucketLimitOf(reveal, g, 'today', 0)).toBe(5);
  });

  it('首次交互播种：未被点击的桶保持缺省视觉不跳变；显式记录成唯一事实源', () => {
    let reveal: RevealMap = new Map();
    // 缺省：today = 5（首桶），older = 0；用户点开 older
    const seed = new Map([['today', BUCKET_PAGE_SIZE], ['older', 0]]);
    reveal = toggleBucketHead(reveal, g, 'older', seed);
    expect(bucketLimitOf(reveal, g, 'older', 0)).toBe(5);      // 显式开一页
    expect(bucketLimitOf(reveal, g, 'today', 0)).toBe(5);      // 播种保持
    // 再收起 today（显式覆盖缺省）
    reveal = toggleBucketHead(reveal, g, 'today', seed);
    expect(bucketLimitOf(reveal, g, 'today', 5)).toBe(0);
  });

  it('桶内分页：展开更多每次追加一页；满额夹到桶大小（闸门消失）', () => {
    let reveal: RevealMap = new Map();
    const seed = new Map([['older', 0]]);
    reveal = toggleBucketHead(reveal, g, 'older', seed);        // 开一页 5
    expect(bucketLimitOf(reveal, g, 'older', 0)).toBe(5);
    reveal = growBucket(reveal, g, 'older', 12, seed);          // +5 → 10
    expect(bucketLimitOf(reveal, g, 'older', 0)).toBe(10);
    reveal = growBucket(reveal, g, 'older', 12, seed);          // +5 夹到 12
    expect(bucketLimitOf(reveal, g, 'older', 0)).toBe(12);
    reveal = growBucket(reveal, g, 'older', 12, seed);          // 已满：12 不再涨
    expect(bucketLimitOf(reveal, g, 'older', 0)).toBe(12);
  });

  it('小桶夹持：桶仅 3 条时上限记为页大小（render slice 天然夹持，记录不溢出）', () => {
    let reveal: RevealMap = new Map();
    const seed = new Map<string, number>();
    reveal = toggleBucketHead(reveal, g, 'today', seed);
    expect(bucketLimitOf(reveal, g, 'today', 0)).toBe(5); // 记 5（≥ 桶大小），渲染 slice(0,5) 只出 3 条
  });

  it('不同组记录互不影响', () => {
    let reveal: RevealMap = new Map();
    reveal = toggleBucketHead(reveal, 'ws-a', 'older', new Map());
    expect(bucketLimitOf(reveal, 'ws-b', 'older', 0)).toBe(0); // ws-b 无记录走缺省
    expect(bucketLimitOf(reveal, 'ws-a', 'older', 0)).toBe(5);
  });

  it('折叠重置：resetGroupReveal 弃置记录 → 回缺省规则；无记录幂等（同引用）', () => {
    let reveal: RevealMap = new Map();
    reveal = toggleBucketHead(reveal, g, 'older', new Map([['today', BUCKET_PAGE_SIZE]]));
    const after = resetGroupReveal(reveal, g);
    expect(after.has(g)).toBe(false);
    expect(bucketLimitOf(after, g, 'older', 0)).toBe(0); // 回缺省
    expect(resetGroupReveal(after, g)).toBe(after); // 幂等：原引用
  });
});
