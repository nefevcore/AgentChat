// ============================================================
// loop-events.ts —— loop 事件载荷词汇（type-only 垫片）
//
// ledger/journal 消费 loop/after-step（步行落 journal-step）与
// loop/after-run（usage 计量——cr-538）。载荷类型从主线 owning 包
// type-import（类型层认识、运行时零依赖——契约出口即
// ac-agent-loop/src/contract.ts 的 LoopStepRecord；步级信封签名不在
// 主线契约出口内，本地声明最小面）。
// ============================================================
import type { LoopStepRecord, LoopRunResult } from 'ac-agent-loop';

/** loop/after-step 第三参（步级信封——runId/stepId/conversationId/sender/source） */
export interface LoopStepEnvelope {
  runId?: string;
  stepId?: string;
  conversationId?: string;
  sender?: string;
  source?: string;
}

/** loop/after-run 首参（LoopRunRequest 计量相关最小面） */
export interface LoopRunRequestLike {
  runId?: string;
  agent?: string;
  model: string;
  conversationId?: string;
}

export type { LoopStepRecord, LoopRunResult };
