// ============================================================
// send_group_from 拦截器 —— 自动注入发送方 Agent ID
//
// 框架强制约束：LLM 无法伪造 from 字段，
// 调用方 Agent ID 由拦截器自动注入。
// 覆盖 send_group 与 reply_group（两者都向群聊投递，需相同注入）。
// ============================================================

import { ToolInterceptor } from '@core/types';

const GROUP_TOOLS = new Set(['send_group', 'reply_group']);

export const interceptor: ToolInterceptor = (toolName, ctx) => {
  if (!GROUP_TOOLS.has(toolName)) {
    return { allow: true, args: ctx.args };
  }

  return {
    allow: true,
    args: {
      ...ctx.args,
      from: ctx.agentId,
    },
  };
};
