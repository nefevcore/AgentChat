// ============================================================
// stores/feed.ts —— 信息流门面（兼容桥接 ctx.sessions.feed）
//
// D13 bridge 同款：runtime 在场 → 绑 ConversationService 的 feed 核心
//（单一事实源，§0.3 conversation 基础件）；无 runtime（单测）→ 独立
// 实例（feed 状态机测试族零改动——传 wireRpc，vi.mock('../src/api/wire')
// 拦截面不变）。owning = ac-client-ui-conversation/client/feed-core.ts +
// 包内 feedStore.ts（M27.2-2 视图半边：包组件消费包内门面——同 pinia
// id 'feed'，app 内两定义均走 runtime 分支 = 同一 store 实例；本
// webui 门面保留 wireFace 独立分支供既有测试族）。
// ============================================================

import { defineStore } from 'pinia';
import { clientRuntime } from '../runtime/clientRuntime';
import { createFeedCore, type FeedCore } from 'ac-client-ui-conversation/client/feed-core.ts';
import { wireFace } from '../runtime/wireFace';

export const useFeedStore = defineStore('feed', () => {
  // ctx.sessions 契约面（SessionsClientFace）→ 富类型 cast（实现即 FeedCore）
  return (clientRuntime()?.sessions?.feed as FeedCore | undefined)
    ?? createFeedCore(wireFace);
});
