// ============================================================
// @agentchat/contracts/src/interrupt.ts —— 语义化中断契约
//
// 类型归契约包：loop、hooks、工具域共同依赖，不产生运行时引用。
// ToolInterrupt 类保留在 @agentchat/agent-loop（它是引擎的运行时控制流，
// 不是纯契约），此处只放 InterruptReason/ReloadScope。
// ============================================================

/** reload 范围（reload 工具 scope 参数） */
export type ReloadScope = 'self' | 'global' | 'all';

/** 中断原因（语义化，替代裸 boolean） */
export type InterruptReason =
  | { type: 'user-abort'; detail?: string }                 // 用户打断（AbortSignal）
  | { type: 'tool-interrupt'; tool: string; detail?: string } // 工具被中止（bash 杀进程等）
  | { type: 'reload-requested'; scope: ReloadScope }        // Agent 请求热重载
  | { type: 'restart-requested'; reason?: string }          // Agent 请求重启后端
  | { type: 'max-steps' };                                  // 自主推理达到最大步数
