// ============================================================
// stores/feed.ts —— 信息流门面（M27 S2：兼容桥接 ctx.sessions.feed）
//
// D13 bridge 同款：runtime 在场 → 绑 ConversationService 的 feed 核心
//（单一事实源，§0.3 conversation 基础件）；无 runtime（单测）→ 独立
// 实例（feed 状态机测试族零改动）。
// ============================================================

import { defineStore } from 'pinia';
import { clientRuntime } from '../runtime/clientRuntime';
import { createFeedCore } from '../clients/base/feed-core';

export const useFeedStore = defineStore('feed', () => {
  return clientRuntime()?.sessions?.feed ?? createFeedCore();
});
