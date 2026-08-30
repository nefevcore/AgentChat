// ============================================================
// @agentchat/timer/src/source-tag.ts —— 定时来源标签契约
//
// timer 域自带的模型契约（标签工厂 + 协议小节）；由 plugin.ts 用
// ctx.hooks 注册成两个 ownerless automatic 钩子（机械部分来自
// @agentchat/contracts 的钩子工厂），随本插件行装载/停用。
// ============================================================
import type { SourceTagContract } from '@agentchat/contracts';

/** 定时触发（kind='timer'）：到点任务的入站形态 */
export const TIMER_SOURCE_TAG: SourceTagContract = {
  kind: 'timer',
  tag: () => '[定时触发]',
  contractSection: [
    '## 消息来源：定时任务',
    '- user 消息正文首行的 `[定时触发]` 标签表示定时任务到点触发：按任务设定自主跟进，无需回复用户。',
    '- 无标签的 user 消息才是用户本人输入。',
  ].join('\n'),
};
