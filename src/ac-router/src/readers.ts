// ============================================================
// ac-router/src/readers.ts —— agentOf 命名读取器（M25 §3.2）
//
// router/* 双事件首参直读（agentId）。读取器住 owning 包、类型锚定
// 自家事件签名——载荷变形在【定义处】typecheck 红。
// ============================================================
/** router/message-received / router/reply-completed 首参 → 投递目标 Agent id */
export function agentOfMessage(agentId: string): string | undefined {
  return agentId;
}
