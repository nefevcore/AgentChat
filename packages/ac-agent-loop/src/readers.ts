// ============================================================
// ac-agent-loop/src/readers.ts —— agentOf 命名读取器（M25 §3.2）
//
// 读取器住 owning 包、类型锚定自家 contract——载荷变形在【定义处】
// typecheck 红，而非散落消费者静默漂移（读取器读错载荷形状 →
// undefined → agentGate 门控 fail-open，最阴的失败形态以此缓解）。
// 每个一行、防御性短路（undefined → 门控 fail-open）。
// 无身份的事件不出读取器（agentGate 签名强制传 agentOf → 无身份
// 事件编译期不可门控——"不该门控"编码进类型）。
// ============================================================
import type {
  LoopRunCall,
  LoopRunRequest,
  LoopRunTransform,
  LoopStepCall,
  LoopStepTransform,
} from './contract.ts';

/** loop/before-run 载体 → 发起 Agent id */
export function agentOfRunCall(call: LoopRunCall): string | undefined {
  return call.request.agent;
}

/** loop/run-started · loop/after-run 首参（LoopRunRequest）→ 发起 Agent id */
export function agentOfRunRequest(request: LoopRunRequest): string | undefined {
  return request.agent;
}

/** loop/before-step 载体 → 发起 Agent id（M25 §3.1 补齐的步级身份通道） */
export function agentOfStepCall(call: LoopStepCall): string | undefined {
  return call.agent;
}

/** loop/transform-step 载体 → 发起 Agent id */
export function agentOfStepTransform(payload: LoopStepTransform): string | undefined {
  return payload.agent;
}

/** loop/transform-run 载体 → 发起 Agent id */
export function agentOfRunTransform(payload: LoopRunTransform): string | undefined {
  return payload.request.agent;
}
