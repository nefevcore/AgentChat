// ============================================================
// @agentchat/agent-datetime/src/datetime.ts —— 日期行生成
//
// 自 agent-prompt 的对话信息块拆出（v0.7.2）：system prompt 若含
// 每轮变化的时间会破坏前缀 token 缓存。独立插件改为按 Agent 显式
// 启用（清单钩子，无 automatic），runStart 一次性把仅日期的行
// 追加到 system prompt 尾部：
//   · 仅日期（YYYY-MM-DD 周X）——一天内 system prompt 稳定，
//     前缀缓存跨轮次持续命中；日期粒度的缓存重建每天至多一次
//   · 不触碰消息流——currentMessage 与落盘历史保持干净，
//     不向会话消息注入任何时间信息
//   · 独立会话（single~）由钩子硬性跳过（见 datetime-hook.ts）：
//     会话提示词全静态 → 最大 KV cache
// ============================================================

/** 生成日期行文本（仅日期 + 星期：[当前时间] YYYY-MM-DD 周X） */
export function datetimeLine(now: Date): string {
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const pad = (n: number): string => String(n).padStart(2, '0');
  const date = `${now.getFullYear()}-${pad(now.getMonth() + 1)}-${pad(now.getDate())}`;
  return `[当前时间] ${date} ${weekdays[now.getDay()]}`;
}
