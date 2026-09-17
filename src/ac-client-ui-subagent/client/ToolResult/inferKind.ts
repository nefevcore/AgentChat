// ============================================================
// inferKind.ts —— subagent 工具 output → 卡片 kind 判定（纯函数）
//
// 单源判定逻辑，卡片组件与测试共用。两级：
//   ① 显式 action 键（后端 2026-01 起每条 output 必带）——精确分发；
//   ② 历史记录结构猜（无 action 键的旧 output 回落）——修复两处
//     旧误判：await idle 态落 spawn 兜底、sync send 带结果落 await。
// kill 分支已删（后端 enum 无 kill，action=kill 走 ok:false 纯文本）。
// ============================================================

export type SubagentCardKind = 'spawn' | 'send' | 'await' | 'list' | 'stop' | 'delete';

/** 历史结构猜（无 action 键的旧 output）——判定顺序即优先级 */
function inferByShape(d: Record<string, unknown>): SubagentCardKind {
  if (Array.isArray(d.subagents) || d.active_count !== undefined) return 'list';
  // sync send 带结果（delivered 存在）优先于 await——旧版被 result/error
  // 抢先判走 await，丢"已发送"语义
  if (d.delivered !== undefined) return 'send';
  if (d.result !== undefined || d.error !== undefined) return 'await';
  if (d.stopped === true) return 'stop';
  if (d.deleted === true) return 'delete';
  // 无 result/error 的消息态：await idle（status:'idle'）与 spawn 未启动
  // （status:'idle'）同形——按 idle 归 await（"尚未运行过"比"已创建"更贴切）
  return 'spawn';
}

export function inferKind(data: Record<string, unknown> | undefined | null): SubagentCardKind {
  if (!data) return 'spawn';
  const a = String(data.action ?? '');
  if (a === 'spawn' || a === 'send' || a === 'await' || a === 'list' || a === 'stop' || a === 'delete') {
    return a;
  }
  return inferByShape(data);
}
