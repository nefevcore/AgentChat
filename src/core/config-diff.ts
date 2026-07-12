// ============================================================
// Agent 配置 diff/merge 工具
//
// 设计原则：
//   - Agent config.json 只存储与全局配置的差异项
//   - 加载时 deepMerge(全局, agentDiff) 得到有效配置
//   - 保存时 computeDiff(有效配置, 全局) 只写入差异
// ============================================================

/**
 * 深度合并：将 source 合并到 target 上（纯函数，返回新对象）。
 *
 * 合并规则：
 *   - 基本类型/数组：source 覆盖 target
 *   - 普通对象：递归合并子键
 *   - null/undefined：source 为 undefined 时保留 target 值
 */
export function deepMerge<T extends Record<string, unknown>>(
  target: T,
  source: Partial<T>,
): T {
  const result = { ...target } as Record<string, unknown>;

  for (const key of Object.keys(source as Record<string, unknown>)) {
    const sv = (source as Record<string, unknown>)[key];
    const tv = result[key];

    if (sv === undefined) {
      // 不覆盖
      continue;
    }

    if (
      sv !== null &&
      typeof sv === 'object' &&
      !Array.isArray(sv) &&
      tv !== null &&
      typeof tv === 'object' &&
      !Array.isArray(tv)
    ) {
      // 两者都是普通对象 → 递归合并
      result[key] = deepMerge(
        tv as Record<string, unknown>,
        sv as Record<string, unknown>,
      );
    } else {
      // 其他情况（基本类型、数组、null、类型不匹配）→ source 覆盖
      result[key] = sv;
    }
  }

  return result as T;
}

/**
 * 计算差异：返回仅包含与 base 不同（或 base 中不存在）的字段。
 *
 * 只检出 agent 中有而 base 中没有 / 与 base 值不同的键。
 * agent 中与 base 值相同的键不会出现在结果中。
 *
 * @param agent  完整 Agent 有效配置
 * @param base   全局配置（基准）
 * @returns       仅包含差异项的对象（始终包含 agent_id 和 name）
 */
export function computeDiff(
  agent: Record<string, unknown>,
  base: Record<string, unknown>,
): Record<string, unknown> {
  const diff: Record<string, unknown> = {};

  for (const key of Object.keys(agent)) {
    // agent_id 和 name 始终保留
    if (key === 'agent_id' || key === 'name') {
      diff[key] = agent[key];
      continue;
    }

    const av = agent[key];
    const bv = base[key];

    // base 中不存在的键 → 直接纳入 diff
    if (!(key in base)) {
      diff[key] = av;
      continue;
    }

    // 两者都是普通对象 → 递归计算子 diff
    if (
      av !== null &&
      typeof av === 'object' &&
      !Array.isArray(av) &&
      bv !== null &&
      typeof bv === 'object' &&
      !Array.isArray(bv)
    ) {
      const subDiff = computeDiff(
        av as Record<string, unknown>,
        bv as Record<string, unknown>,
      );
      if (Object.keys(subDiff).length > 0) {
        diff[key] = subDiff;
      }
      continue;
    }

    // 值不同 → 纳入 diff（使用 JSON 比较）
    if (JSON.stringify(av) !== JSON.stringify(bv)) {
      diff[key] = av;
    }
  }

  return diff;
}
