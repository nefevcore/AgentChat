import type { ConfigField } from '@discovery/config-types';
import { resolveNamespaceConfig } from '@core/config';

export const meta = {
  name: 'agent-session',
  label: '会话',
  description: '管理对话历史、上下文压缩和 Token 用量追踪。',
  ns: 'extension.agent_session',
  configuration: [
    { name: 'maxContextTokens', label: '最大上下文长度', description: '设定会话上下文长度', type: 'number', default: 1000000 },
    { name: 'keepRecentRatio', label: '留存消息比例', description: '归档时保留的最近消息比例', type: 'number', default: 0.025 },
    { name: 'summaryPreviewLen', label: '摘要长度上限', description: '上下文压缩时生成的摘要字数上限', type: 'number', default: 1000 },
    { name: 'archiveMinMessages', label: '最短归档消息数', description: '消息数超过此阈值时触发归档', type: 'number', default: 200 },
    { name: 'idleArchiveSec', label: '空闲归档时间', description: '无对话自动归档的等待时间（秒）', type: 'number', default: 14400 },
    { name: 'messageQueryDefaultLimit', label: '历史查询默认条数', description: '加载历史消息的默认数量', type: 'number', default: 50 },
  ] as ConfigField[],
};

export interface SessionConfig {
  maxContextTokens: number; keepRecentRatio: number; summaryPreviewLen: number; archiveMinMessages: number;
  idleArchiveSec: number; messageQueryDefaultLimit: number;
}
function defaults(): SessionConfig {
  return { maxContextTokens: 1000000, keepRecentRatio: 0.025, summaryPreviewLen: 1000, idleArchiveSec: 14400, archiveMinMessages: 200, messageQueryDefaultLimit: 50 };
}
export function cfg(runtimeConfig?: Record<string, Record<string, unknown>>): SessionConfig {
  return resolveNamespaceConfig(meta.ns, defaults(), runtimeConfig);
}
