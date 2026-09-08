// ============================================================
// ac-client-ui-conversation/client/feedStore.ts —— 信息流门面
//（包内消费面：M27.2-2 视图半边组件用）
//
// runtime 在场 → 绑 ConversationService 的 feed 核心（单一事实源）；
// 无 runtime（单测）→ 独立实例 + 离线 rpc 桩（call 拒绝/订阅 noop）。
// 与 webui stores/feed.ts（wireFace 独立分支——feed 状态机测试族
// vi.mock wire 拦截面）同 pinia id 'feed'：app 内两定义均走 runtime
// 分支 = 同一 store 实例（先注册者生效）；单测族继续走 webui 门面。
// ============================================================

import { defineStore } from 'pinia';
import { clientRuntime, type RpcClientFace } from 'ac-client-runtime';
import { createFeedCore, type FeedCore } from './feed-core.ts';

/** 离线 rpc 桩（无 runtime 的独立实例用——call 拒绝 + 订阅 noop） */
export const offlineRpc: RpcClientFace = {
  call() {
    return Promise.reject(new Error('no rpc in standalone feed'));
  },
  onEvent() {
    return () => undefined;
  },
};

export const useFeedStore = defineStore('feed', () => {
  // ctx.sessions 契约面（SessionsClientFace）→ 富类型 cast（实现即 FeedCore）
  return (clientRuntime()?.sessions?.feed as FeedCore | undefined)
    ?? createFeedCore(offlineRpc);
});
