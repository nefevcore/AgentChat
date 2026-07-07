// ====================================================================
// datetime 扩展 —— preHook 时注入当前日期时间
//
//   在 systemPrompt 末尾追加：
//   [当前时间] 周四 2026-07-02 14:30
//
// ── 使用方式 ──
//   在 Agent 的 config.json 中配置：
//   { "pre_hooks": ["datetime", ...] }
// ====================================================================

import { AgentContext, Extension, PreProcessHook } from '../../../core/types';

/**
 * 获取格式化的当前时间信息块
 */
function buildTimeBlock(): string {
  const now = new Date();

  // 日期：2026-07-02
  const dateStr = now.toLocaleDateString('zh-CN', {
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });

  // 星期
  const weekdays = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'];
  const weekday = weekdays[now.getDay()];

  return `[当前时间] ${weekday} ${dateStr}`;
}

// ====================================================================
// preHook —— 在 systemPrompt 尾部注入时间信息
// ====================================================================

const preHook: PreProcessHook = async (ctx: AgentContext): Promise<AgentContext> => {
  const timeBlock = buildTimeBlock();

  const systemPrompt = `${ctx.systemPrompt}\n\n${timeBlock}`;

  return {
    ...ctx,
    systemPrompt,
  };
};

// ====================================================================
// Extension 统一入口
// ====================================================================

export const extension: Extension = {
  meta: {
    name: 'datetime',
    description: '在每次对话前注入当前日期。',
  },
  preHook,
};
