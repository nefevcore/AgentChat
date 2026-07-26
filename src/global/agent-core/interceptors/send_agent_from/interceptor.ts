// ============================================================
// send_agent_from 拦截器 —— 自动注入调用方 agentId
//
// 框架强制约束：send_agent 执行前自动将 this.agentId 写入 args.from，
// LLM 无需知晓自己的 ID，也无法伪造身份。
// ============================================================

import { ToolInterceptor } from '@core/types';

export const interceptor: ToolInterceptor = (toolName, ctx) => {
  if (toolName !== 'send_agent' && toolName !== 'list_rooms'
    && toolName !== 'list_timers' && toolName !== 'set_timer' && toolName !== 'disable_timer'
    && toolName !== 'query_history') {
    return { allow: true, args: ctx.args };
  }

  if (!ctx.args.from) {
    ctx.args = { ...ctx.args, from: ctx.agentId };
  }

  // timer 工具额外注入 agent_id
  if (toolName === 'list_timers' || toolName === 'set_timer' || toolName === 'disable_timer') {
    ctx.args = { ...ctx.args, agent_id: ctx.agentId };
  }

  return { allow: true, args: ctx.args };
};
