// ============================================================
// stores/chat.ts —— 会话动作门面（M27 S2：兼容桥接 ctx.sessions.chat）
//
// runtime 在场 → 绑 ConversationService 的 chat 核心（单一事实源）；
// 无 runtime（单测）→ 独立实例（feed 状态机测试族零改动）。
// ============================================================

import { defineStore } from 'pinia';
import { clientRuntime } from '../runtime/clientRuntime';
import { createChatCore } from '../clients/base/chat-core';
import { useFeedStore } from './feed';

export const useChatStore = defineStore('chat', () => {
  const svc = clientRuntime()?.sessions;
  if (svc) return svc.chat; // 服务面已构建（feed reactive 视图注入）；init 由装配序列显式发起
  // 独立实例：feed 门面（pinia store = reactive 解包视图，与核心同构）；
  // 创建即 init（旧行为原样：store 首用 = wire 订阅 + 名册启动链）
  const core = createChatCore(useFeedStore() as never);
  core.init();
  return core;
});
