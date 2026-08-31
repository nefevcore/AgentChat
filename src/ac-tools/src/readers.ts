// ============================================================
// ac-tools/src/readers.ts —— agentOf 命名读取器（M25 §3.2）
//
// 读取器住 owning 包、类型锚定自家 contract——载荷变形在【定义处】
// typecheck 红。after-execute 与 before-execute 同形（call 首参直读），
// 表内读取器覆盖 before-execute / transform-result（首期门控主人群）。
// ============================================================
import type { ToolCall, ToolExecution, ToolTransform } from './contract.ts';

/** tool/before-execute 载体 → 执行身份 Agent id */
export function agentOfExecution(execution: ToolExecution): string | undefined {
  return execution.call.agentId;
}

/** tool/transform-result 载体 → 执行身份 Agent id（after-execute 同形：call 首参直读） */
export function agentOfToolTransform(payload: ToolTransform): string | undefined {
  return payload.call.agentId;
}

/** tool/after-execute / tool/progress 首参（ToolCall）→ 执行身份 Agent id */
export function agentOfToolCall(call: ToolCall): string | undefined {
  return call.agentId;
}
