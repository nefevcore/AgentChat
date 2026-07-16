// ============================================================
// send_to_room_from 拦截器 —— 自动注入发送方 Agent ID
//
// 框架强制约束：LLM 无法伪造 from 字段，
// 调用方 Agent ID 由拦截器自动注入。
// ============================================================

import { ToolInterceptor } from '@core/types';

export const interceptor: ToolInterceptor = (toolName, ctx) => {
  if (toolName !== 'send_to_room') {
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
