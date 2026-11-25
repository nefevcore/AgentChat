// ============================================================
// fallback-probes.ts —— 兜底链命中计数探针（P2-C cr-1276 起）
//
// 在役探针：
//   inject-heuristic：isInjectEvent 未注册词兜底启发命中（feed.ts）——
//     服务「owning 行未装载」降级（插槽-插头架构特性，渲染管线计划 §三
//     护栏：不退役，仅存量词随迁移缩）。
//   inject-run-miss：注入卡 run 键在场但目标 run 不在窗口（cr-1285
//     P3-4）——窗口边界态长尾观察。
// 已退役：
//   event-quota / content-prefix（P3-1 cr-1281——观察窗关闭，机制已删）。
//   anchor-cover（cr-1294——双静态扫描零命中〔275 + 1440 会话〕，
//     coveredAnchors 同锚覆盖兜底 + shadowAssertNoKeyGuess 影子一并删除）。
// 双指标（cr-1299 观察窗判读力升级）：
//   hits —— 分支进入次数（含 derive 全量重扫对存量行的重复计数：流式
//     期每帧重跑 buildTurns 都重新评估全部注入行——口径画像 derive 成本，
//     数值随帧到达率虚增，勿作缺陷行数读）；
//   rows —— 曾走过该分支的去重行数（首见计数，行身份 = message id）——
//     「归零即删」判读的准确口径（不随重扫/重挂虚增；直播帧键驻留前的
//     瞬态首见也计——理想态是首帧即带键）。
// 计数器模块级、零 UI 副作用；单测断言 + 观察窗导出——浏览器经
// window.__AC_FALLBACK_PROBES__() 读（cr-1289 接线，feed-core 装配时挂）。
// ============================================================

/** 探针键（兜底链身份） */
export type FallbackProbeKey = 'inject-heuristic' | 'inject-run-miss';

interface ProbeCount { hits: number; rowIds: Set<string>; }

const stats = new Map<FallbackProbeKey, ProbeCount>();

/** 命中计数（兜底链分支进入即记；rowId 在场时行身份首见入册） */
export function probeHit(key: FallbackProbeKey, rowId?: string): void {
  let s = stats.get(key);
  if (s === undefined) { s = { hits: 0, rowIds: new Set() }; stats.set(key, s); }
  s.hits++;
  if (rowId !== undefined) s.rowIds.add(rowId);
}

/** 观察窗读面（键 → 双指标 {hits, rows}；无命中键缺席） */
export function readFallbackProbes(): Partial<Record<FallbackProbeKey, { hits: number; rows: number }>> {
  return Object.fromEntries([...stats].map(([k, s]) => [k, { hits: s.hits, rows: s.rowIds.size }]));
}

/** 测试复位 */
export function resetFallbackProbes(): void {
  stats.clear();
}
