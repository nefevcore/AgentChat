// ============================================================
// ac-permission-gate/src/notice.ts —— need 文案生成器（cr-1066 批1）
// 样板：ac-sandbox-core/notice.ts（纯文本零依赖）。approval 审批卡的
// 「为什么需要批准」段——工具 + 参数之外的操作语义说明（防审批疲劳的
// UX 责任在 ApprovalBar，文案责任在此单源）。
// ============================================================

/**
 * 审批卡 need 段文案（要素固定、措辞可调）。
 * @param tool 工具名（pwsh/bash/write/edit/browser 等）
 * @param args 本次调用参数（命令全文/目标路径等语义提取）
 */
export function approvalNeedText(tool: string, args: Record<string, unknown>): string {
  const head = `工具 ${tool} 请求执行以下操作，需要你批准：`;
  // 语义提取：命令全文 / 目标路径优先展示
  const command = args.command ?? args.url ?? args.file_path ?? args.path;
  if (typeof command === 'string' && command) {
    return `${head}\n${command}`;
  }
  // 兜底：参数摘要（首层键值截断）
  const keys = Object.keys(args);
  if (keys.length === 0) return head;
  const brief = keys.slice(0, 4).map((k) => `${k}=${summarize(args[k])}`).join('，');
  return `${head}\n${brief}${keys.length > 4 ? '…' : ''}`;
}

/** 参数值摘要（标量直显；长文本/对象 JSON 截断） */
function summarize(v: unknown): string {
  if (v === null || v === undefined) return '(空)';
  if (typeof v === 'string') return v.length > 60 ? v.slice(0, 60) + '…' : v;
  if (typeof v === 'number' || typeof v === 'boolean') return String(v);
  try {
    const s = JSON.stringify(v);
    return s.length > 60 ? s.slice(0, 60) + '…' : s;
  } catch {
    return '(不可序列化)';
  }
}
