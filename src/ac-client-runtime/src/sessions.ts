// ============================================================
// ac-client-runtime/src/sessions.ts —— 会话服务契约面（M27 S3-1b）
//
// conversation 基础件（webui clients/base/conversation.ts）提供的
// ctx.sessions 契约：行 client（groups/singles 等）与门面（stores/
// feed·chat）消费的结构子集。与 RpcClientFace 同款裁决——接口住
// 运行时包（行 client 不 import webui 内部），宿主实现（ConversationService
// 结构满足；feed/chat 富类型由 webui 门面侧 cast 取回）。
// D22 服务名查重：'sessions' 与服务端 'session' 单数占名无碰撞。
// ============================================================
import type { Ref } from 'vue';

/** feed 活跃分区协调面（会话上下文的唯一事实源） */
export interface SessionsFeedFace {
  activeGroupId: Ref<string>;
  activeSingleId: Ref<string>;
  setActiveGroup(groupId: string): void;
  clearActiveGroup(): void;
  setActiveSingle(sessionId: string): void;
  clearActiveSingle(): void;
}

/** 会话动作上下文面（single 模式激活/退出） */
export interface SessionsChatFace {
  setSingleContext(sessionId: string, agentId: string, model?: string): void;
  clearSingleContext(): void;
}

/** conversation 基础件会话服务契约（结构子集——富类型见 webui 实现） */
export interface SessionsClientFace {
  readonly feed: SessionsFeedFace;
  readonly chat: SessionsChatFace;
  /** 生命周期（幂等）：wire 订阅 + 名册启动链（装配序列显式发起） */
  init(): void;
  /** groups 域：重建群 presence 集（帧路由 group 会话键判别） */
  setKnownGroups(ids: string[]): void;
  /** singles 域：登记/摘除单个会话 presence（single~sid 帧路由判别） */
  trackKnownSingle(id: string, removed?: boolean): void;
}

declare module './context.ts' {
  interface ClientContext {
    /** conversation 基础件会话服务（webui 宿主实现本契约面） */
    sessions: SessionsClientFace;
  }
}
