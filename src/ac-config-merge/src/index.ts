// ============================================================
// ac-config-merge —— 配置 diff/merge 纯库（零 cordis 依赖）
//
// 语义源自 src agents/config-diff.ts 的踩坑沉淀；写侧形态已迁移：
//   · deepMerge：合成口径——ac-agents settingsOf 全局层 ∪ Agent 差异层
//     合成有效配置；ac-agent-admin updateAgent 局部补丁合成新档
//     （deepMerge(现值, 补丁)）。
//   · computeDiff：变更键报告——ac-agent-admin changedKeysOf 以
//     computeDiff(新档, 现值) 报告实际变化键。src 时代「保存只写差异
//     项」的差异存档叙事已退役：写侧（agentStore）存 AgentConfig 全量。
//   · 纯函数、零副作用、可独立单测；消费方经 workspace 引用。
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

/** computeDiff 中始终保留的身份键（无论是否与基准相同）。id/name 系
 * AgentConfig 身份/显示名字段；agent_id 为 src 残留词条已删（cr-418）——
 * 其不在管理面白名单（写口不可达），若旧档残留该键，「恒保留」语义会
 * 使变更键报告恒虚报 → 零变更保存恒重写盘；残留键按普通键 diff 即可。 */
const IDENTITY_KEYS = new Set(['id', 'name']);

/**
 * 计算差异：返回仅包含与 base 不同（或 base 中不存在）的键。
 * 身份键（id/name）始终保留。纯函数。
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
