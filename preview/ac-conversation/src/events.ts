// ============================================================
// ac-conversation/src/events.ts —— 会话状态机域事件目录（声明合并，零运行时）
//
// 谁 emit 谁声明：conversation/* 事件的分发方是本包的 ConversationService。
// M10 起 Minimal 目录：仅 steer 注入通知（补齐 M9 已知缺口——steer 注入
// 的消息不经 router，ac-session 靠本事件入账，会话事件流不断流）。
// ============================================================
import type {} from '@agentchat/cordis';
import type { LlmMessage } from 'ac-llm';
import type { LoopSource } from 'ac-agent-loop';

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * 消息已注入活跃 run 的下一步（deliver 的 steer 分支成功后）。
     * steer 走 ctx.agentLoop.steer 能力调用，不经 router——历史持久化
     * （ac-session 入账）、WS 广播等订阅方靠本事件看到这条消息。
     * sender/source（M19 加位）：注入消息的发送方端点 id 与拓扑类——
     * ac-session 据此标注说话人（name）。
     * meta（M20 加位）：deliver 的机制标记透明通道——携带
     * ARCHIVE_REVIEW_META 时 ac-session 跳过入账（机制 run 不落盘）。
     * @mode emit
     * @scope run
     */
    'conversation/steered'(
      agentId: string,
      message: LlmMessage,
      conversationId: string,
      handle: string,
      sender?: string,
      source?: LoopSource,
      meta?: Record<string, unknown>,
    ): void;
  }
}
