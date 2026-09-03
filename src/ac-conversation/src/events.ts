// ============================================================
// ac-conversation/src/events.ts —— 会话状态机域事件目录（声明合并，零运行时）
//
// 谁 emit 谁声明：conversation/* 事件的分发方是本包的 ConversationService。
// 事件目录：steer 注入通知（M9 补齐——steer 不经 router，ac-session 靠
// 本事件入账）+ next-turn 队列权威快照（排队 UI 数据面）。
// ============================================================
import type {} from '@agentchat/cordis';
import type { LlmMessage } from 'ac-llm';
import type { LoopSource } from 'ac-agent-loop';
import type { ConversationQueuedItem } from './contract.ts';

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
    /**
     * next-turn 队列发生变更（入队 / 消费 / 删除 / 插话 / 预算放回）后
     * 发出，载荷 = 该会话队列变更后的**权威全量快照**（DSH session/queue
     * 姿势）——排队 UI 以本事件 + conversation.queue 服务方法为唯一
     * 事实源，不做客户端侧队列推导。观察型监听器无需返回值。
     * @mode emit
     * @scope run
     */
    'conversation/queue-changed'(
      agentId: string,
      conversationId: string,
      handle: string,
      items: ConversationQueuedItem[],
    ): void;
  }
}
