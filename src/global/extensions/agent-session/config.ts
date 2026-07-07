// ====================================================================
// agent-session config —— 配置合并
// ====================================================================

import { AgentContext, RuntimeConfig } from '../../../core/types';
import { getGlobalConfig, AppConfig } from '../../../core/config';

/**
 * 获取当前生效配置。
 * 优先级：Agent 级 runtimeConfig > 全局 config > 默认值
 */
export function cfg(ctx?: AgentContext): AppConfig {
  const base = getGlobalConfig();
  const overrides = ctx?.runtimeConfig;
  if (!overrides) return base;
  // 浅合并 runtimeConfig 中的非 undefined 字段
  const merged = { ...base };
  for (const key of Object.keys(overrides) as (keyof RuntimeConfig)[]) {
    const val = overrides[key];
    if (val !== undefined) {
      (merged as any)[key] = val;
    }
  }
  return merged;
}
