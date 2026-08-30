// ============================================================
// @agentchat/agents/src/view.ts —— 群消息视图（re-export，正典已下沉契约层）
//
// `<msg from name group>` 封装的正典见 @agentchat/contracts/view.ts
// （2026-08-20 下沉：router/server/agent-session 三方共用，随 GroupFeed
// 契约同层）。本模块保留 re-export，router 等既有导入不动。
// ============================================================

export { escapeMsgAttr, wrapGroupMsg } from '@agentchat/contracts';
export type { GroupMsgViewParams } from '@agentchat/contracts';
