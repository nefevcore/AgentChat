// ============================================================
// ac-client-ui-singles/client/sessionTimeBuckets.ts —— 会话列表
// 工作区内「按时间分批展开」的时间分桶纯函数
//
// 背景：工作区内会话增多后，「展开其余记录」一次铺出全量，长列表
// 难折叠也难定位。改为按最近活动分桶：今天/昨天/三天/一周/两周/
// 一个月/更早——首桶缺省展开、其余桶点击桶头各自开合，「更早」
// 聚拢一个月外的全部深史（收起时只占一行）。
//
// 口径与边界：
//   · 桶边界按自然日（本地时区 00:00）计算，忽略 DST 偏移的
//     ±1h 抖动——分桶展示语义下无需墙钟精确。
//   · 「N 天」桶 = 最近 N 个自然日中未被更近桶吃掉的部分：
//     今天＝今日 00:00 起；昨天＝昨日全天；三天＝2~3 天前；
//     一周＝4~7 天前；两周＝8~14 天前；一个月＝15~30 天前。
//   · 前置契约：items 已按 lastActivity 降序（调用方排序）；
//     无效时间戳（NaN）需调用方先行归一（比较恒 false 会直落
//     「更早」，且可能卡死游标把后续条目一并带入）。
//   · ts + now 由调用方注入（纯函数可测，不读系统时钟）。
// ============================================================

/** 时间桶（key/label + 桶内条目） */
export interface TimeBucket<T = unknown> {
  /** 桶标识（'today' | 'yesterday' | '3d' | '1w' | '2w' | '1m' | 'older'） */
  key: string;
  /** 展示标签 */
  label: string;
  /** 桶内条目（保持调用方顺序——分桶不重排） */
  items: T[];
}

/** 桶条目最小面：有最近活动时间戳即可分桶 */
export interface TimeBucketItem {
  lastActivity: number;
}

/** 分桶轴：days = 桶下界距「今天 00:00」的自然日数（今天=0，昨天=1，
 *  三天=3……）；数组顺序即桶顺序（近 → 远）。 */
const BUCKET_AXIS: ReadonlyArray<{ key: string; label: string; days: number }> = [
  { key: 'today', label: '今天', days: 0 },
  { key: 'yesterday', label: '昨天', days: 1 },
  { key: '3d', label: '三天', days: 3 },
  { key: '1w', label: '一周', days: 7 },
  { key: '2w', label: '两周', days: 14 },
  { key: '1m', label: '一个月', days: 30 },
];

/** 更早桶（一个月外全部深史聚拢；不在 BUCKET_AXIS——无有限下界） */
const OLDER_KEY = 'older';
const OLDER_LABEL = '更早';
const DAY_MS = 86_400_000;

/**
 * 按最近活动时间分桶（纯函数，不读系统时钟）。
 * 降序不变量 → 游标单调右移单趟完成（O(n)）；空桶不出现；
 * 全部桶界之外（含 NaN，见前置契约）落「更早」。
 *
 * @param items 已按 lastActivity 降序的条目
 * @param now   当前时刻（毫秒；桶边界锚「今天 00:00」由此推导）
 */
export function bucketByTime<T extends TimeBucketItem>(items: readonly T[], now: number): TimeBucket<T>[] {
  const todayStart = startOfToday(now);
  const out: TimeBucket<T>[] = [];
  let cursor = 0;
  for (const b of BUCKET_AXIS) {
    const lower = todayStart - b.days * DAY_MS;
    const start = cursor;
    while (cursor < items.length && items[cursor].lastActivity >= lower) cursor++;
    if (cursor > start) out.push({ key: b.key, label: b.label, items: items.slice(start, cursor) });
    if (cursor >= items.length) return out;
  }
  if (cursor < items.length) out.push({ key: OLDER_KEY, label: OLDER_LABEL, items: items.slice(cursor) });
  return out;
}

/** now 所在自然日的 00:00（本地时区） */
function startOfToday(now: number): number {
  const d = new Date(now);
  d.setHours(0, 0, 0, 0);
  return d.getTime();
}

// ============================================================
// 分批展开显式记录（group key → bucket key → 显示条数上限）
//
// 语义：桶展开 ≠ 桶内全量铺出——「显示条数上限」才是状态量：
// 0 = 收起；N = 展开且渲染前 N 条（桶头点击 = 一页/收起归 0；
// 桶内「展开更多」= 每次追加一页）。无记录 = 缺省规则（首桶 +
// 激活会话所在桶各一页，其余收起）；一旦有记录，显式值是唯一
// 事实源。首次交互时调用方以「当前缺省上限」播种——未被点击
// 的桶视觉不跳变。工作区节点折叠时调用方 resetGroupReveal 弃置
// 记录（再展开回到缺省态，不记住「展开全部/展开很多」）。
// ============================================================

/** 每桶缺省展开条数（空间效率：先看最近一页，渐进追加） */
export const BUCKET_PAGE_SIZE = 5;

/** group key → bucket key → 显示条数上限（无条目 = 该桶未交互过） */
export type RevealMap = Map<string, Map<string, number>>;

/** 桶当前显示上限：显式记录优先，无记录回落缺省值（0 = 收起） */
export function bucketLimitOf(reveal: RevealMap, groupKey: string, bucketKey: string, defaultLimit: number): number {
  return reveal.get(groupKey)?.get(bucketKey) ?? defaultLimit;
}

/** 桶头开合：展开态 → 记 0（显式收起；再展开回一页——不记住
 *  「展开很多」）；收起态 → 记一页。首次交互以 seed 播种该组
 *  （未被点击的桶保持当前视觉态不跳变） */
export function toggleBucketHead(
  reveal: RevealMap, groupKey: string, bucketKey: string, seed: ReadonlyMap<string, number>,
): RevealMap {
  const cur = reveal.get(groupKey)?.get(bucketKey) ?? seed.get(bucketKey) ?? 0;
  const next = new Map(reveal);
  const inner = new Map(next.get(groupKey) ?? seed);
  inner.set(bucketKey, cur > 0 ? 0 : BUCKET_PAGE_SIZE);
  next.set(groupKey, inner);
  return next;
}

/** 桶内「展开更多」：上限追加一页（夹到 bucketSize 防溢出记数——
 *  满额后闸门自然消失，按钮不再可点） */
export function growBucket(
  reveal: RevealMap, groupKey: string, bucketKey: string, bucketSize: number, seed: ReadonlyMap<string, number>,
): RevealMap {
  const cur = reveal.get(groupKey)?.get(bucketKey) ?? seed.get(bucketKey) ?? 0;
  const next = new Map(reveal);
  const inner = new Map(next.get(groupKey) ?? seed);
  inner.set(bucketKey, Math.min(cur + BUCKET_PAGE_SIZE, Math.max(bucketSize, BUCKET_PAGE_SIZE)));
  next.set(groupKey, inner);
  return next;
}

/** 弃置某组的展开记录（工作区节点折叠时调用——重开回缺省态）；
 *  无记录时原引用返回（幂等，不制造无谓的新响应） */
export function resetGroupReveal(reveal: RevealMap, groupKey: string): RevealMap {
  if (!reveal.has(groupKey)) return reveal;
  const next = new Map(reveal);
  next.delete(groupKey);
  return next;
}
