// ============================================================
// @agentchat/contracts —— 引擎与钩子契约（零运行时依赖）
//   · interrupt.ts   语义化中断契约（InterruptReason / ReloadScope）
//   · engine.ts      Tool / RunResult / AgentResult / CoreEventType
//   · context.ts     CurrentContext / 七类钩子 / 中断处理器 / chat.start meta 键
//   · group-feed.ts   群消息内容通道契约（GroupFeed，单通道化）
//   · group-contract.ts 群聊行为契约正典（GROUP_CONTRACT_TEXT，I11 锚定）
//   · dialog.ts      会话键纯函数（chat~/group~/single~ 三形态构造与解析）
//   · view.ts        群消息 `<msg>` 视图封装（wrapGroupMsg 单一事实源）
//   · source-tag.ts  来源标签钩子工厂（各域插件自带契约直接注册）
// ============================================================

export * from './interrupt';
export * from './engine';
export * from './context';
export * from './group-feed';
export * from './group-contract';
export * from './dialog';
export * from './view';
export * from './source-tag';
