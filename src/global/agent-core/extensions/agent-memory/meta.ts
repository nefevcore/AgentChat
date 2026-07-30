import type { ConfigField } from '@discovery/config-types';
import { resolveNamespaceConfig } from '@core/config';

export const meta = {
  name: 'agent-memory',
  label: '记忆',
  description: '长期记忆管理：提取跨会话的偏好、决策、待办事项和用户画像。',
  ns: 'extension.agent_memory',
  configuration: [] as ConfigField[],
};

export interface MemoryConfig {}
function defaults(): MemoryConfig { return {}; }
export function cfg(runtimeConfig?: Record<string, Record<string, unknown>>): MemoryConfig {
  return resolveNamespaceConfig(meta.ns, defaults(), runtimeConfig);
}
