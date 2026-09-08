// ============================================================
// ac-client-ui-conversation/client/chatStore.ts —— 会话动作门面
//（包内消费面：M27.2-2 视图半边组件用）
//
// runtime 在场 → 绑 ConversationService 的 chat 核心（单一事实源）；
// 无 runtime（单测）→ 独立实例（离线 rpc 桩）。与 webui stores/chat.ts
//（wireFace 独立分支——测试族拦截面）同 pinia id 'chat'：app 内两定义
// 均走 runtime 分支 = 同一 store 实例；单测族继续走 webui 门面。
// ============================================================

import { defineStore } from 'pinia';
import { clientRuntime } from 'ac-client-runtime';
import { createChatCore, type ChatCore } from './chat-core.ts';
import { useFeedStore, offlineRpc } from './feedStore.ts';

export const useChatStore = defineStore('chat', () => {
  // ctx.sessions 契约面（SessionsClientFace）→ 富类型 cast（实现即 ChatCore）
  const svc = clientRuntime()?.sessions;
  if (svc) return svc.chat as ChatCore; // 服务面已构建（feed reactive 视图注入）；init 由装配序列显式发起
  // 独立实例：feed 门面（pinia store = reactive 解包视图，与核心同构）；
  // 创建即 init（旧行为原样：store 首用 = wire 订阅 + 名册启动链）
  const core = createChatCore(useFeedStore() as never, offlineRpc);
  core.init();
  return core;
});
