// ============================================================
// stores/chat.ts —— 会话动作门面（兼容桥接 ctx.sessions.chat）
//
// runtime 在场 → 绑 ConversationService 的 chat 核心（单一事实源）；
// 无 runtime（单测）→ 独立实例（feed 状态机测试族零改动——传
// wireFace，vi.mock('../src/api/wire') 拦截面不变）。
// owning = ac-client-ui-conversation/client/chat-core.ts + 包内
// chatStore.ts（M27.2-2 视图半边：包组件消费包内门面——同 pinia
// id 'chat'，app 内两定义均走 runtime 分支 = 同一 store 实例；
// 本 webui 门面保留 wireFace 独立分支供既有测试族）。
// ============================================================

import { defineStore } from 'pinia';
import { clientRuntime } from '../runtime/clientRuntime';
import { createChatCore, type ChatCore } from 'ac-client-ui-conversation/client/chat-core.ts';
import { wireFace } from '../runtime/wireFace';
import { useFeedStore } from './feed';

export const useChatStore = defineStore('chat', () => {
  // ctx.sessions 契约面（SessionsClientFace）→ 富类型 cast（实现即 ChatCore）
  const svc = clientRuntime()?.sessions;
  if (svc) return svc.chat as ChatCore; // 服务面已构建（feed reactive 视图注入）；init 由装配序列显式发起
  // 独立实例：feed 门面（pinia store = reactive 解包视图，与核心同构）；
  // 创建即 init（旧行为原样：store 首用 = wire 订阅 + 名册启动链）
  const core = createChatCore(useFeedStore() as never, wireFace);
  core.init();
  return core;
});
