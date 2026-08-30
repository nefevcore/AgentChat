// ============================================================
// @agentchat/agent-tools/src/source-tag.ts —— 协作/群聊来源标签契约
//
// 协作域（send_agent/send_group 是这两个 kind 的生产入口）自带的
// 模型契约；由 plugin.ts 用 ctx.hooks 注册成 ownerless automatic
// 钩子（机械部分来自 @agentchat/contracts 的钩子工厂），
// 随本插件行装载/停用。
// ============================================================
import type { SourceTagContract } from '@agentchat/contracts';

/** Agent 间消息（kind='agent'）：send_agent / 对方回复的入站形态 */
export const AGENT_SOURCE_TAG: SourceTagContract = {
  kind: 'agent',
  tag: (_s, agentId) => (agentId ? `[来自 Agent "${agentId}" 的消息]` : '[来自其他 Agent 的消息]'),
  contractSection: [
    '## 消息来源：Agent 协作',
    '- user 消息正文首行的 `[来自 Agent "id" 的消息]` 标签表示其他 Agent 发来的消息：回复将送达对方。',
    '- 无标签的 user 消息才是用户本人输入。',
  ].join('\n'),
};

/** 群聊消息（kind='group'）：群聊事件送达的入站形态 */
export const GROUP_SOURCE_TAG: SourceTagContract = {
  kind: 'group',
  tag: () => '[群聊消息]',
  contractSection: [
    '## 消息来源：群聊',
    '- user 消息正文首行的 `[群聊消息]` 标签表示群聊事件送达（正文含发言者与时间）：回复面向群内可见。',
    '- 无标签的 user 消息才是用户本人输入。',
  ].join('\n'),
};
