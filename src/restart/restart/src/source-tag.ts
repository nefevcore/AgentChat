// ============================================================
// @agentchat/restart/src/source-tag.ts —— 重启恢复来源标签契约
//
// restart 域自带的模型契约（标签工厂 + 协议小节）；由 plugin.ts 用
// ctx.hooks 注册成两个 ownerless automatic 钩子（机械部分来自
// @agentchat/contracts 的钩子工厂），随本插件行装载/停用。
// ============================================================
import type { SourceTagContract } from '@agentchat/contracts';

/** 重启恢复（kind='restart'）：重启后自动恢复触发的入站形态 */
export const RESTART_SOURCE_TAG: SourceTagContract = {
  kind: 'restart',
  tag: () => '[重启恢复]',
  contractSection: [
    '## 消息来源：重启恢复',
    '- user 消息正文首行的 `[重启恢复]` 标签表示系统重启后的恢复触发：恢复中断前的工作。',
    '- 无标签的 user 消息才是用户本人输入。',
  ].join('\n'),
};
