// ============================================================
// @agentchat/subagent/src/source-tag.ts —— 子Agent来源标签契约
//
// subagent 域自带的模型契约（标签工厂 + 协议小节）；由 plugin.ts 用
// ctx.hooks 注册成两个 ownerless automatic 钩子（机械部分来自
// @agentchat/contracts 的钩子工厂），随本插件行装载/停用。
// ============================================================
import type { SourceTagContract } from '@agentchat/contracts';

/** 子Agent汇报（kind='subagent'）：子 Agent 输出/通知的入站形态 */
export const SUBAGENT_SOURCE_TAG: SourceTagContract = {
  kind: 'subagent',
  tag: () => '[子Agent汇报]',
  contractSection: [
    '## 消息来源：子Agent',
    '- user 消息正文首行的 `[子Agent汇报]` 标签表示子 Agent 的输出/通知。',
    '- 无标签的 user 消息才是用户本人输入。',
  ].join('\n'),
};
