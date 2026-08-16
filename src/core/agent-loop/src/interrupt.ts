// ============================================================
// @agentchat/agent-loop/src/interrupt.ts —— 语义化中断
//
// InterruptReason/ReloadScope 契约已迁至 @agentchat/contracts；
// 本文件保留引擎运行时控制流 ToolInterrupt + 描述函数，并 re-export 契约。
//
// 把底层 AbortSignal 升级为 Agent 可感知的中断原因：
//   AbortSignal.abort() 在 Node kHybridDispatch 下监听器抛错会崩溃进程，
//   且中断原因丢失（boolean interrupted 无法区分"用户打断/工具被中止/
//   reload/restart"）。本模块引入 InterruptReason + ToolInterrupt：
//   工具不再"裸执行" reload/restart，而是抛 ToolInterrupt 表达请求，
//   loop 捕获后先走 postHook（消息落盘）再响应中断。
//
// 铁律：零外部依赖，仅使用标准 Error。
// ============================================================

import type { InterruptReason, ReloadScope } from '@agentchat/contracts';

export type { InterruptReason, ReloadScope };

/**
 * 工具中断异常 —— 不是错误，是"预期控制流"。
 * 工具通过抛出它表达"需要 Agent 先收尾再执行某操作"（reload/restart）
 * 或"我被外部中止了"（bash 被 abort）。
 * 与普通错误的关键区别：runTools 捕获它时不写入 error tool 消息。
 */
export class ToolInterrupt extends Error {
  readonly reason: InterruptReason;
  constructor(reason: InterruptReason) {
    super(`tool-interrupt:${reason.type}`);
    this.name = 'ToolInterrupt';
    this.reason = reason;
  }
}

/** 类型守卫：判断是否为 ToolInterrupt（兼容跨 bundle 实例） */
export function isToolInterrupt(err: any): err is ToolInterrupt {
  return err instanceof ToolInterrupt || err?.name === 'ToolInterrupt';
}

/** 中断原因的人类可读摘要（用于 postHook 持久化 / 前端显示） */
export function describeInterrupt(reason: InterruptReason | undefined): string {
  if (!reason) return '';
  switch (reason.type) {
    case 'user-abort': return '已由用户打断';
    case 'tool-interrupt': return `工具 ${reason.tool} 执行被中止${reason.detail ? `（${reason.detail}）` : ''}`;
    case 'reload-requested': return `已请求热重载（scope=${reason.scope}）`;
    case 'restart-requested': return '已请求后端重启';
    case 'max-steps': return '达到最大推理步数';
  }
}
