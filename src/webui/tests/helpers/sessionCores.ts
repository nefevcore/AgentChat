// ============================================================
// tests/helpers/sessionCores.ts —— feed/chat/roster 核心直连构造
//（M28 §4.2：agentsStore pinia 门面与 webui stores 门面退役，状态机
// 测试族显式注入 roster/rpc——每实例独立隔离，替代旧 per-pinia 缓存）
//
// 形态对齐 ConversationService：chat 消费 reactive(feed) 视图；feed/chat
// 对外均暴露 reactive 视图（属性访问自动解包——与旧 pinia store 消费
// 语义同构，断言零改写）。rpc 由调用方传（多数测试 = wireFace——
// vi.mock('../src/api/wire') 拦截面不变）。chat 按需 init（旧 webui chat
// 门面「store 创建即 init」语义）；仅消费 feed 的测试不 init chat，
// 保持旧「显式 feed.init()」行为（chat init 会拉 interaction/list
// 恢复——rpc mock 严格时防扰）。
// ============================================================

import { reactive, type UnwrapRef } from 'vue';
import { RosterCore } from 'ac-client-ui-agents/client';
import { createFeedCore, type FeedCore, type FeedView } from 'ac-client-ui-conversation/client/feed-core.ts';
import { createChatCore, type ChatCore } from 'ac-client-ui-conversation/client/chat-core.ts';
import type { RpcClientFace } from 'ac-client-runtime';

/** chat 核心 reactive 视图（属性解包——与旧 pinia store 消费语义同构） */
export type ChatView = { [K in keyof ChatCore]: UnwrapRef<ChatCore[K]> };

export interface SessionCores {
  roster: RosterCore;
  feed: FeedView;
  chat: ChatView;
}

/** 核心三件直连构造（每调用 = 全新独立实例）；initChat = 构造即
 *  chat.init()（旧 useChatStore 门面首用语义）。 */
export function createSessionCores(rpc: RpcClientFace, initChat = false): SessionCores {
  const roster = new RosterCore();
  const byRef = () => roster; // 取用器形态（对齐 createFeedCore/createChatCore 签名）
  const feedCore = createFeedCore(rpc, byRef);
  const feed = reactive(feedCore) as unknown as FeedView;
  const chatCore = createChatCore(feed, rpc, byRef);
  const chat = reactive(chatCore) as unknown as ChatView;
  if (initChat) chat.init();
  return { roster, feed, chat };
}
