// ============================================================
// send_agent_from 拦截器 —— 自动注入调用方 agentId
//
// 框架强制约束：send_agent 执行前自动将 this.agentId 写入 args.from，
// LLM 无需知晓自己的 ID，也无法伪造身份。
// ============================================================

import { ToolInterceptor } from '@core/types';

export const interceptor: ToolInterceptor = (toolName, ctx) => {
  if (toolName !== 'send_agent' && toolName !== 'list_groups'
    && toolName !== 'list_timers' && toolName !== 'set_timer' && toolName !== 'disable_timer'
    && toolName !== 'query_history'
    && toolName !== 'spawn_subagent' && toolName !== 'await_subagent'
    && toolName !== 'list_subagents' && toolName !== 'kill_subagent'
    && toolName !== 'list_tools' && toolName !== 'reload' && toolName !== 'manage_plugins'
    && toolName !== 'continue_turn') {
    return { allow: true, args: ctx.args };
  }

  if (!ctx.args.from) {
    ctx.args = { ...ctx.args, from: ctx.agentId };
  }

  // continue_turn 额外注入 sender（当前会话对方），作为自我续推的默认 target
  if (toolName === 'continue_turn' && !ctx.args.counterpart && ctx.sender) {
    ctx.args = { ...ctx.args, counterpart: ctx.sender };
  }

  // timer 工具额外注入 agent_id
  if (toolName === 'list_timers' || toolName === 'set_timer' || toolName === 'disable_timer') {
    ctx.args = { ...ctx.args, agent_id: ctx.agentId };
  }

  return { allow: true, args: ctx.args };
};
