// ============================================================
// ac-event-policy/src/aggregate.ts —— fiber→顶层行聚合（M25 §3.5）
//
// 沿 fiber 祖先链定位挂载行；匿名 fiber 继承父名的假边在聚合时归并
// （fiber.name 自带"最近具名祖先"语义——聚合只需把行内多层 fiber 归到
// 顶层行名）。消费方：events/listeners owner 裸名 → 行名、plugin/rows
// 动态同名判据精确化、yml 行熔断归属、反依赖图行清单。
//
// **聚合只改呈现，不改任何键**（§3.4 双命中：治理键 = owner 原文，
// 策略行匹配对 fiber 名与聚合行名双命中——按行名书写的新键不失配）。
//
// 两条路径：
//   · 官方 boot（loader 服务在场）：沿 fiber 祖先链取**最近的 loader
//     entry**（entry.options.name ?? entry.id）。官方 boot 下全部 yml 行
//     嵌在 include 子树内、loader 根组只有 include 载体一行——「根组直接
//     entry」判定会把行 fiber 归属到 Loader 侧（P5 事故：事件叶节点全显
//     Loader）。entry 语义本就完备：行 fiber 自带 entry、行内子 fiber 经
//     internal/plugin 继承 fiber.entry——首个命中即归属行，无需顶层集合；
//   · 程序化组合（bootTree：无 loader）：顶层行 = root fiber 的直接
//     子 fiber（runtime 名即行名——模块行自带 name）。
// ============================================================
import type { Context, Fiber } from '@agentchat/cordis';

/** loader entry 最小形状（私有面窄化读——与 events/listeners 同款立场） */
interface EntryLike {
  id: string;
  options?: { name?: string };
  parent?: unknown;
}

/** fiber 的 loader entry（无则 undefined：动态/程序化 fiber） */
function entryOf(fiber: Fiber): EntryLike | undefined {
  return (fiber as unknown as { entry?: EntryLike }).entry;
}

/**
 * fiber → 顶层行名（label）。
 * 优先 loader entry 路径（官方 boot——含 cordis.patch 停用行的
 * options.name）；回落程序化路径（root 直接子 fiber 的 runtime 名）。
 */
export function rowOfFiber(ctx: Context, fiber: Fiber): string | undefined {
  const loader = ctx.get('loader', false);
  if (loader) {
    // 官方 boot：最近 entry 即归属行（含行内子 fiber 继承的 entry）
    let cursor: Fiber | undefined = fiber;
    while (cursor) {
      const entry = entryOf(cursor);
      if (entry) return entry.options?.name ?? entry.id;
      const parent: Fiber | undefined = cursor.parent?.fiber;
      if (parent === undefined || parent === cursor) break; // root 自指 → 终止
      cursor = parent;
    }
    return undefined;
  }
  // 程序化组合：root fiber 的直接子 fiber = 顶层行（runtime 名即行名）
  let cursor: Fiber | undefined = fiber;
  while (cursor) {
    const parentFiber: Fiber | undefined = cursor.parent?.fiber;
    if (parentFiber === undefined) break;
    if (parentFiber === ctx.root.fiber || parentFiber.uid === 0) {
      return cursor.runtime?.name ?? cursor.name;
    }
    cursor = parentFiber;
  }
  return undefined;
}

/**
 * 聚合映射：fiber/runtime 名 → 顶层行名（仅含需要改写的条目——
 * 模块行 fiber 名本就是行名，不进映射）。M25 §3.5：匿名 fiber 继承
 * 父名的假边在聚合时归并（fiber.name 语义）。
 */
export function computeRowAggregates(ctx: Context): Map<string, string> {
  const alias = new Map<string, string>();
  const seen = new Set<string>();
  for (const runtime of ctx.registry.values()) {
    if (!runtime.name) continue;
    for (const fiber of runtime.fibers) {
      if (fiber.uid === null) continue;
      const row = rowOfFiber(ctx, fiber);
      if (row === undefined || row === runtime.name) continue;
      const key = runtime.name;
      if (!seen.has(key)) {
        seen.add(key);
        alias.set(key, row);
      }
    }
  }
  return alias;
}
