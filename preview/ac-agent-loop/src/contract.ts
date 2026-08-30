// ============================================================
// ac-agent-loop/src/contract.ts —— Agent 循环域契约（纯类型，零运行时）
//
// 契约归属 owning package：谁提供 ctx.agentLoop，谁声明本域类型与
// loop/* 事件（events.ts）。跨域词汇（LlmMessage/LlmToolCall/
// LlmToolSpec/LlmUsage/ToolResult）type-import 自 owning 包——
// 类型层认识，运行时仍按服务 key 解耦（DSH 同款形态）。
//
// 设计要点：
//   · 循环是能力调用（ctx.agentLoop.run），不是事件接收方；
//   · 边界事件（before-run/before-step waterfall + after-run/after-step
//     emit）见 events.ts —— 拦截与通知分离；
//   · 工具执行走 ctx.tools.execute，自动获得 tool/before-execute
//     拦截链 —— 循环不重新实现工具拦截。
// ============================================================
import type { LlmMessage, LlmToolCall, LlmUsage } from 'ac-llm';
import type { ToolInterrupt, ToolResult } from 'ac-tools';

/**
 * 发送方拓扑类（信封：'user' 直答 / 'agent' 委托 / 'event' 机制触发）。
 * M19 起与身份分离——`sender` 携带端点 id，`source` 只标记来源语义
 * （ws-bridge 后台过滤 / MAX_AUTO_WAKES / session 事件行三个消费方依赖）。
 */
export type LoopSource = 'user' | 'agent' | 'event';

export interface LoopRunRequest {
  /** 发起方标识（Agent id 等；事件过滤/诊断用，可空；扩展插件经它查 AgentConfig.settings） */
  agent?: string;
  model: string;
  provider?: string;
  /** 完整会话历史（含最新 user 消息；system 建议放 request.system） */
  messages: LlmMessage[];
  /** 系统提示词（人设/框架块/记忆由扩展插件经 before-run 组装进本字段） */
  system?: string;
  /** 暴露给模型的工具名清单；缺省 = 全部已注册工具 */
  tools?: string[];
  /**
   * 最大步数（对齐 src trigger/receive 双模式）：
   *   · > 0 = trigger 模式上限（达到即 finish='max-steps'，防自主推理失控）
   *   · 缺省 / 0 = receive 模式不限步（靠"无工具调用"自然收束）
   */
  maxSteps?: number;
  /**
   * LLM 采样参数（M15：per-Agent 调参面——router 从 AgentConfig.llmParams
   * 解析注入；白名单键在每步 llm.chat 透传给 provider。键集见
   * ac-agents LLM_SAMPLING_KEYS——模型路由键（model/provider）不在此）。
   */
  llmParams?: Record<string, unknown>;
  /**
   * 信封拓扑（L3）：发送方身份 + 会话键。
   * M19 全对键桶模型：user 只是端点之一，不再特殊化——
   *   · sender = 发送方端点 id（用户直答 = viewer 虚拟 Agent id；
   *     委托 = 发起 Agent id；机制触发 = 目标自身，自会话语义）；
   *   · source = 拓扑类（'user' 直答 / 'agent' 委托 / 'event' 机制触发）；
   *   · conversationId 是会话归属键——对桶 `pairKey(a, b)`（排序 `~`
   *     连接，自会话 = a~a）、群 = 组 id、独立会话 = sid。
   */
  sender?: string;
  /** 发送方拓扑类（缺省按 sender 推导：未知 id 视作 'user'） */
  source?: LoopSource;
  /** 会话归属键（缺省 = pairKey(sender, agent) 即直答对桶；群/独立显式传键） */
  conversationId?: string;
  /**
   * 机制标记透明通道（M20，对齐 src META_ARCHIVE_REVIEW）：调用方（归档
   * 整理等机制 run）经它向下游消费者声明"本 run 不入会话账 / 不记
   * usage / 不进上下文视图"。已知键：ARCHIVE_REVIEW_META（本包导出，
   * 值 = 'archive-review'，约定值 true）。不外漏进 provider——loop 构造
   * llm.chat 的 meta 是显式字段，request.meta 不参与。
   */
  meta?: Record<string, unknown>;
  /**
   * 外部中止信号：循环在每个 step 边界检查（含首步之前）——已中止即
   * finish='interrupted' + interruptReason{type:'user-abort'}，已完成的步保留。
   * M11 起 signal 同时透传给工具调用（bash 超时/取消、长任务可中止）；
   * 进行中的 llm.chat 仍在 step 边界检查。
   */
  signal?: AbortSignal;
}

/**
 * 中断原因（finish='interrupted' 时必带）。
 * type 是开放词汇，已知值：'user-abort'（request.signal 中止）、
 * 'tool-interrupt'（工具体返回 ToolResult.interrupt，M11 通道——
 * interruptReason.toolInterrupt 携带工具请求原文，宿主据此执行
 * reload/restart/插件装卸后可续跑）。
 */
export interface LoopInterruptReason {
  type: string;
  /** 人类可读细节（如 signal.reason 的 message） */
  reason?: string;
  /** type='tool-interrupt' 时：工具的中断请求原文（宿主动作依据） */
  toolInterrupt?: ToolInterrupt;
}

/** run 的可变载体（loop/before-run waterfall 的事实对象） */
export interface LoopRunCall {
  request: LoopRunRequest;
}

export interface LoopStepRecord {
  /** 步序（0 起） */
  index: number;
  text: string;
  reasoning?: string;
  /** 本步模型产出的工具调用 */
  toolCalls: LlmToolCall[];
  /** 工具执行结果（与 toolCalls 一一对应） */
  toolResults: ToolResult[];
  usage?: LlmUsage;
  finish?: string;
}

/** step 的可变载体（loop/before-step waterfall：可改写本步消息） */
export interface LoopStepCall {
  /**
   * 发起 Agent id（查 AgentConfig.settings 用；宿主直调/子代理 = undefined）
   * ——与 LoopStepTransform.agent 同款步级身份通道（M25 §3.1 补齐：
   * 域内唯一身份缺口；不加 envelope——各按真实需要出生）。
   */
  agent: string | undefined;
  messages: LlmMessage[];
}

/**
 * 步记录变换载体（loop/transform-step waterfall 的事实对象）。
 * 安全审查/脱敏 seam：`step` 即最终入档/通知的步记录；
 * 变换器直接改写它后 `next()`，替换则整体赋值。
 */
export interface LoopStepTransform {
  /** 发起方 Agent id（查 AgentConfig.settings 用；可空） */
  agent: string | undefined;
  /** 变换中的步记录 */
  step: LoopStepRecord;
}

/**
 * 轮结果变换载体（loop/transform-run waterfall 的事实对象）。
 * 安全审查/脱敏 seam：`result` 即最终返回/通知的轮结果
 * （router 回复文本、ac-session 入账均取变换后的值）。
 */
export interface LoopRunTransform {
  /** 原始请求（只读参考） */
  request: LoopRunRequest;
  /** 变换中的轮结果 */
  result: LoopRunResult;
}

/**
 * run 级用量聚合（双轨制，src accumulateUsage 语义原样——资产 #10）：
 *   · 覆盖轨：prompt/total = 最后一步的值（当次上下文大小；归档阈值判断
 *     依据——累加会把各步上下文之和误判为单次大小）
 *   · 累加轨：promptAccumulated/totalAccumulated/completion/cache/steps
 *     （展示总用量；跨 step 计量才有意义）
 */
export interface LoopRunUsage {
  /** 当次上下文输入 token（覆盖 = 最后一步） */
  prompt: number;
  /** 补全输出 token（累加 = 全部步之和） */
  completion: number;
  /** 当次上下文总 token（覆盖 = 最后一步；无 usage 的步不计） */
  total?: number;
  /** 累加轨：全部步 prompt 之和 */
  promptAccumulated: number;
  /** 累加轨：全部步 total 之和 */
  totalAccumulated?: number;
  /** 缓存命中输入 token（累加；provider 归一化字段透传） */
  cacheHit?: number;
  /** 缓存未命中输入 token（累加） */
  cacheMiss?: number;
  /** ReAct 步数（有 usage 供给的步计数） */
  steps: number;
}

export interface LoopRunResult {
  steps: LoopStepRecord[];
  /** 最后一步的文本（无步时为空） */
  text: string;
  /**
   * stop 自然收束 · max-steps 步数预算耗尽 · veto before-run 拦截 ·
   * error 循环异常 · interrupted 外部 signal 中止（ADR-2 最小中断方案）
   */
  finish: 'stop' | 'max-steps' | 'veto' | 'error' | 'interrupted';
  error?: string;
  /** finish='interrupted' 时的中断原因（ADR-2） */
  interruptReason?: LoopInterruptReason;
  /** 全部步的用量聚合（双轨制，见 LoopRunUsage） */
  usage: LoopRunUsage;
}
