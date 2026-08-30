// ============================================================
// ac-conversation/src/contract.ts —— 会话状态机域契约（纯类型，零运行时）
//
// ADR-1：src router 的有状态调度（convKey 串行化门、inbox 双队列、
// placement steer|next-run、MAX_AUTO_WAKES 防自激）全部移入本包；
// ac-router 保持"纯转发、零会话状态"。steer 注入走 Service 方法
// ctx.agentLoop.steer(handle, msg)（能力调用铁律），非事件。
//
// 寻址（与 ac-agent-loop 的 runAddress 同一词汇）：
//   · 会话桶 conversationId（session/事件归属）：缺省 = agentId；群 = 组 id
//   · 串行化门 handle = runAddress(agentId, conversationId)：
//     1v1 = agentId；群 = `${gid}~${agentId}`（每参与者独立 run，
//     对齐 src group~gid~aid——组内参与者并发、单个参与者串行）
// ============================================================
import type { LlmMessage } from 'ac-llm';
import type { LoopRunResult, LoopSource } from 'ac-agent-loop';

/** 入站消息走向：next-step = 注入当前 run；next-turn = 当前 run 结束后的独立 run */
export type ConversationLane = 'next-step' | 'next-turn';

/** 会话繁忙时的投放策略（lane=next-step） */
export type ConversationPlacement = 'steer' | 'next-run';

export interface ConversationDeliverOptions {
  /** 发送方端点 id（信封身份，M19）：直答 = viewer 虚拟 Agent id、委托 = 发起 Agent id、机制触发 = 目标自身。缺省 'user' */
  sender?: string;
  /** 发送方拓扑类（'user' 直答 / 'agent' 委托 / 'event' 机制触发；MAX_AUTO_WAKES 按 it 判定自激）。缺省 'user' */
  source?: LoopSource;
  /**
   * 会话桶键（M19 对桶模型）：对桶 = pairKey(a, b)（缺省 =
   * pairKey(sender, agentId) 即直答对桶）；群 = 组 id；独立会话 = sid。
   */
  conversationId?: string;
  /** 缺省 'next-step'；busy 时 next-step 走 placement、next-turn 入队 */
  lane?: ConversationLane;
  /** busy + next-step 时的策略：缺省 'steer'（注入活跃 run） */
  placement?: ConversationPlacement;
  /**
   * 会话首跑的历史种子（仅会话尚无内存上下文视图时生效；此后由本服务
   * 自行积累：每 run 追加入站消息与回复，跨 run 延续）。
   */
  history?: LlmMessage[];
  /**
   * 会话级模型覆盖（singles 引用语义）：透传 router.send → 信封 model
   * 取代 Agent 原配置。缺省 = Agent 原配置。
   */
  model?: string;
  /**
   * run 级步数上限覆盖（M20）：透传 router.send → 信封 maxSteps（缺省 =
   * Agent 原配置/不限步）。归档整理 run 的失控防线①经它注入硬闸。
   */
  maxSteps?: number;
  /**
   * 机制标记透明通道（M20）：透传 router.send → 信封 meta。携带
   * ARCHIVE_REVIEW_META（ac-agent-loop 导出）时本服务跳过会话上下文
   * 视图积累（整理提示词/回复不泄漏进后续 run 的 history），ac-session /
   * ac-usage 各查同键跳过入账/记账。
   */
  meta?: Record<string, unknown>;
  /** 本 deliver 启动的 run 的外部中止信号（steer/queued 路径无新 run，忽略） */
  signal?: AbortSignal;
  /** placement='next-run' 等待会话空闲的上限 ms（缺省 190s，对齐 LLM 超时兜底+余量） */
  timeoutMs?: number;
}

/** 投递结果 */
export type ConversationOutcome =
  /** 本条消息（直接或等空闲后）驱动的 run 已完成；链跑时 = 首个 run 的结果 */
  | { kind: 'run'; result: LoopRunResult }
  /** 已注入活跃 run 的下一步（placement='steer' 且会话繁忙） */
  | { kind: 'steered'; handle: string }
  /** 已入 next-turn 队列（lane='next-turn' 且会话繁忙；当前 run 结束后消费） */
  | { kind: 'queued'; handle: string }
  /** placement='next-run' 等待空闲超时放弃（消息未投递） */
  | { kind: 'timeout'; handle: string };

/** 运行中会话快照（listRunning/stats） */
export interface ConversationRunInfo {
  agentId: string;
  conversationId: string;
  /** 串行化门地址（= runAddress(agentId, conversationId)） */
  handle: string;
  startedAt: number;
}
