// ============================================================
// ac-config-merge —— 配置 diff/merge 纯库（零 cordis 依赖）
//
// 原样继承 src agents/config-diff.ts 的语义（踩坑沉淀）：
//   · Agent/局部配置只存【与基准的差异项】——加载时 deepMerge(基准, diff)
//     合成有效配置；保存时 computeDiff(有效, 基准) 只写差异。
//   · 纯函数、零副作用、可独立单测；消费方（ac-agent-store 的差异写、
//     M14 ac-agent-admin 管理面）经 workspace 引用。
//
// 合并规则（src 语义原样）：
//   · 基本类型/数组：source 覆盖 target
//   · 普通对象：递归合并子键
//   · undefined：不覆盖（保留 target 值）
// ============================================================

/**
 * 深度合并：source 合并到 target 上（纯函数，返回新对象）。
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  const result: Record<string, unknown> = { ...target };
  for (const key of Object.keys(source)) {
    const sv = (source as Record<string, unknown>)[key];
    if (sv === undefined) continue; // 不覆盖
    const tv = result[key];
    if (
      sv !== null && typeof sv === 'object' && !Array.isArray(sv) &&
      tv !== null && typeof tv === 'object' && !Array.isArray(tv)
    ) {
      result[key] = deepMerge(tv as Record<string, unknown>, sv as Record<string, unknown>);
    } else {
      result[key] = sv; // 基本类型/数组/null/类型不匹配 → 覆盖
    }
  }
  return result as T;
}

/** computeDiff 中始终保留的身份键（无论是否与基准相同） */
const IDENTITY_KEYS = new Set(['id', 'agent_id', 'name']);

/**
 * 计算差异：返回仅包含与 base 不同（或 base 中不存在）的键。
 * 身份键（id/agent_id/name）始终保留。纯函数。
 */
export function computeDiff(
  subject: Record<string, unknown>,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};
  for (const key of Object.keys(subject)) {
    if (IDENTITY_KEYS.has(key)) {
      diff[key] = subject[key];
      continue;
    }
    const sv = subject[key];
    const bv = base[key];
    if (!(key in base)) {
      diff[key] = sv;
      continue;
    }
    if (
      sv !== null && typeof sv === 'object' && !Array.isArray(sv) &&
      bv !== null && typeof bv === 'object' && !Array.isArray(bv)
    ) {
      const subDiff = computeDiff(sv as Record<string, unknown>, bv as Record<string, unknown>);
      if (Object.keys(subDiff).length > 0) diff[key] = subDiff;
      continue;
    }
    if (JSON.stringify(sv) !== JSON.stringify(bv)) diff[key] = sv;
  }
  return diff;
}
