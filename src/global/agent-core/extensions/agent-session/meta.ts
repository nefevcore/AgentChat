import type { ConfigField } from '@discovery/config-types';
import { resolveNamespaceConfig } from '@core/config';

export const meta = {
  name: 'agent-session',
  label: '会话',
  description: '管理对话历史、上下文压缩和 Token 用量追踪。',
  ns: 'extension.agent_session',
  configuration: [
    { name: 'maxContextTokens', label: '最大上下文长度', description: '会话上下文硬上限（tokens），preHook 压缩兜底触发点', type: 'number', default: 1000000 },
    { name: 'archiveTokenRatio', label: '归档触发比例', description: 'Token 数超过 maxContextTokens × 此比例时触发归档', type: 'ratio', default: 0.5, min: 0.1, max: 0.9, step: 0.05, display: 'percent' },
    { name: 'keepRecentRatio', label: '归档保留比例', description: '归档后保留的最近消息比例（相对于 maxContextTokens）。Agent 会自动整理记忆，原始对话可激进截断', type: 'ratio', default: 0.03, min: 0.01, max: 0.3, step: 0.005, display: 'percent' },
    { name: 'summaryPreviewLen', label: '摘要长度上限', description: '摘要（上下文压缩 + 归档 SUMMARY.md）生成与注入的字数上限。统一配置：生成时按此字数总结，注入时超出截断取尾部', type: 'number', default: 4000 },
    { name: 'idleArchiveSec', label: '空闲归档时间', description: '无对话自动归档的等待时间（秒）', type: 'number', default: 14400 },
    { name: 'messageQueryDefaultLimit', label: '历史查询默认条数', description: '加载历史消息的默认数量', type: 'number', default: 50 },
    { name: 'groupArchiveTokens', label: '群聊归档阈值', description: '群聊消息总 token 数超过此值触发归档（多 Agent 共享，默认 50K 远低于 1:1，因每个参与者都加载全部）', type: 'number', default: 50000 },
    { name: 'groupLoadLimitTokens', label: '群聊单次加载上限', description: '单个 Agent 一次加载群聊历史的上限（tokens）。preHook 加载超限时立即触发归档并压缩历史，防止多参与者叠加 token 爆炸', type: 'number', default: 30000 },
  ] as ConfigField[],
};

export interface SessionConfig {
  maxContextTokens: number; archiveTokenRatio: number; keepRecentRatio: number;
  summaryPreviewLen: number; idleArchiveSec: number; messageQueryDefaultLimit: number;
  groupArchiveTokens: number; groupLoadLimitTokens: number;
}
function defaults(): SessionConfig {
  return {
    maxContextTokens: 1000000,
    archiveTokenRatio: 0.5,
    keepRecentRatio: 0.03,
    summaryPreviewLen: 4000,
    idleArchiveSec: 14400,
    messageQueryDefaultLimit: 50,
    groupArchiveTokens: 50000,
    groupLoadLimitTokens: 30000,
  };
}
export function cfg(runtimeConfig?: Record<string, Record<string, unknown>>): SessionConfig {
  return resolveNamespaceConfig(meta.ns, defaults(), runtimeConfig);
}
