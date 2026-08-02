import type { ConfigField } from '@discovery/config-types';
import { resolveNamespaceConfig } from '@core/config';

export const meta = {
  name: 'agent-memory',
  label: '记忆',
  description: '长期记忆管理：提取跨会话的偏好、决策、待办事项和用户画像。',
  ns: 'extension.agent_memory',
  configuration: [
    { name: 'memoryBudgetTokens', label: '记忆注入预算(token)', description: '注入系统提示词的记忆 token 预算。超出时截断保留头部，Agent 可通过 read 读取完整 memory.md。0 = 不限制', type: 'number', default: 600 },
  ] as ConfigField[],
};

export interface MemoryConfig {
  memoryBudgetTokens: number;
}
function defaults(): MemoryConfig { return { memoryBudgetTokens: 600 }; }
export function cfg(runtimeConfig?: Record<string, Record<string, unknown>>): MemoryConfig {
  return resolveNamespaceConfig(meta.ns, defaults(), runtimeConfig);
}
