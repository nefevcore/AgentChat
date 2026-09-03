// ============================================================
// ac-router/src/readers.ts —— agentOf 命名读取器（M25 §3.2）
//
// router/* 事件首参直读（emit 双事件）或载体字段直读（before-deliver）。
// 读取器住 owning 包、类型锚定自家事件签名——载荷变形在【定义处】
// typecheck 红。run 域才有 agentOf 读取器——门控可用性由作用域结构性编码
// （无身份的事件出不了读取器 → agentGate 编译期不可门控）。
// ============================================================
import type { RouterDeliverCall } from './service.ts';

/** router/message-received / router/reply-completed 首参 → 投递目标 Agent id */
export function agentOfMessage(agentId: string): string | undefined {
  return agentId;
}

/** router/before-deliver 载体 → 投递目标 Agent id */
export function agentOfDeliver(call: RouterDeliverCall): string | undefined {
  return call.agentId;
}
