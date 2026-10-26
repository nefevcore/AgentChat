// ============================================================
// ac-conversation/src/events.ts —— 会话状态机域事件目录（声明合并，零运行时）
//
// 谁 emit 谁声明：conversation/* 事件的分发方是本包的 ConversationService。
// ============================================================
import type {} from '@agentchat/cordis';
import type { LlmMessage } from 'ac-llm';
import type { LoopSource } from 'ac-agent-loop';
import type { ConversationQueuedItem } from './contract.ts';

declare module '@agentchat/cordis' {
  interface Events {
    /**
     * run 启动前内容注入 seam（startRun 顶部、history 装配之前发）：
     * 订阅方（如 ac-memory 的 checkpoint/delta）在此直落 context 行——
     * 本 run 的 history 派生即含注入行（无延迟一轮问题），且注入位于
     * 文件尾部（KV 前缀稳定）。emit 时点会话门已注册（run 尚未开跑），
     * recordContext 的 journal 路径不会命中。
     * @mode emit
     * @scope run
     */
    'conversation/before-start'(
      agentId: string,
      conversationId: string,
    ): void;
    /**
     * 消息已注入活跃 run 的下一步（deliver 的 steer 分支成功后）。
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
     * next-turn 队列发生变更后的权威全量快照（排队 UI 数据面）。
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