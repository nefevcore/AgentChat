import type { ConfigField } from '@discovery/config-types';
import { resolveNamespaceConfig } from '@core/config';

export const meta = {
  name: 'agent-session',
  label: '会话',
  description: '管理对话历史、上下文压缩和 Token 用量追踪。',
  ns: 'extension.agent_session',
  configuration: [
    { name: 'maxContextTokens', label: '最大上下文长度', description: '会话上下文硬上限（tokens），preHook 压缩兜底触发点', type: 'number', default: 1000000 },
    { name: 'archiveTokenThreshold', label: '归档触发阈值', description: 'Token 数超过此时触发归档（应 < maxContextTokens，建议 50%~80%）', type: 'number', default: 500000 },
    { name: 'keepRecentRatio', label: '归档保留比例', description: '归档后保留的最近消息比例（相对于 maxContextTokens）', type: 'number', default: 0.2 },
    { name: 'summaryPreviewLen', label: '摘要长度上限', description: '上下文压缩时生成的摘要字数上限', type: 'number', default: 1000 },
    { name: 'idleArchiveSec', label: '空闲归档时间', description: '无对话自动归档的等待时间（秒）', type: 'number', default: 14400 },
    { name: 'messageQueryDefaultLimit', label: '历史查询默认条数', description: '加载历史消息的默认数量', type: 'number', default: 50 },
  ] as ConfigField[],
};

export interface SessionConfig {
  maxContextTokens: number; archiveTokenThreshold: number; keepRecentRatio: number;
  summaryPreviewLen: number; idleArchiveSec: number; messageQueryDefaultLimit: number;
}
function defaults(): SessionConfig {
  return {
    maxContextTokens: 1000000,
    archiveTokenThreshold: 500000,
    keepRecentRatio: 0.2,
    summaryPreviewLen: 1000,
    idleArchiveSec: 14400,
    messageQueryDefaultLimit: 50,
  };
}
export function cfg(runtimeConfig?: Record<string, Record<string, unknown>>): SessionConfig {
  return resolveNamespaceConfig(meta.ns, defaults(), runtimeConfig);
}
